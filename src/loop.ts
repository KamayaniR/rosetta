// Steps 2-3: hypothesize -> experiment -> update statuses, until stable for 2 rounds or round cap.
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import { trace } from "./tracer.ts";
import { evalExpr, predictionMatches, type ExprResult } from "./predicate.ts";
import { createHypotheses, listHypotheses, setChallenge, updateHypothesis, validateEvidence, type Hypothesis, type Status } from "./hypotheses.ts";
import { archivistStep } from "./archivist-step.ts";
import { designExperiments, fmtCall, fmtHyp, theorize, type Experiment, type PlannedInput } from "./theorist.ts";
import { show, showOutcome } from "./tagged.ts";
import type { Observation } from "./types.ts";

export type LoopOptions = {
  sessionId: string; roundCap?: number; topN?: number; maxObsInPrompt?: number; log?: (s: string) => void;
  startRound?: number;  // continue numbering in an existing session
  archivist?: boolean;  // run the Archivist full-history review after every round
};

const MIN_CONF = 0.3, MAX_CONF = 0.85;

async function allObs(sessionId: string) {
  return (await getStore()).find<Observation>("observations", { sessionId }, { sort: { runId: 1 } });
}

function promptObs(obs: Observation[], round: number, max: number) {
  if (obs.length <= max) return obs;
  const current = obs.filter((o) => o.round >= round - 1);
  const older = obs.filter((o) => o.round < round - 1).slice(-(Math.max(0, max - current.length)));
  return [...older, ...current].slice(-max);
}

/** Theorize, validate cited run IDs (re-ask once), store, then pre-check expr rules against existing data. */
async function hypothesize(opts: Required<LoopOptions>, round: number) {
  const { sessionId, log } = opts;
  const obs = await allObs(sessionId);
  const ledger = await listHypotheses(sessionId);
  const shown = promptObs(obs, round, opts.maxObsInPrompt);
  let { drafts } = await theorize({ sessionId, round, hypotheses: ledger, observations: shown });
  let { ok, rejected } = await validateEvidence(sessionId, drafts);
  if (rejected.length) {
    log(`  rejected ${rejected.length} hypotheses citing unknown run IDs (${rejected.flatMap((r) => r.missing).slice(0, 6).join(", ")}); re-asking once`);
    await emit(sessionId, "agent_error", { agent: "theorist", error: "hallucinated evidence", rejected: rejected.map((r) => ({ claim: r.draft.claim, missing: r.missing })) });
    const feedback = `Your previous reply cited run IDs that do not exist: ${[...new Set(rejected.flatMap((r) => r.missing))].join(", ")}.
Re-send ONLY these claims, citing run IDs that appear in the observations above:\n${rejected.map((r) => `- ${r.draft.claim}`).join("\n")}`;
    ({ drafts } = await theorize({ sessionId, round, hypotheses: ledger, observations: shown, feedback }));
    const second = await validateEvidence(sessionId, drafts);
    ok = [...ok, ...second.ok];
    if (second.rejected.length) log(`  dropped ${second.rejected.length} more with bad evidence`);
  }
  const created = await createHypotheses(sessionId, round, ok, "theorist", obs);
  // Cheap pre-check: an expr rule already contradicted by existing observations is disproven immediately.
  for (const h of created) {
    if (h.predicate.kind !== "expr") continue;
    const r = evalExpr(h.predicate, obs);
    if (r.fail.length) await updateHypothesis(h, round, "disproven", 0.05, `contradicted by existing runs ${r.fail.slice(0, 5).join(", ")}`);
  }
  if (ok.length > created.length) log(`  dropped ${ok.length - created.length} duplicates of existing rules`);
  log(`  +${created.length} hypotheses (${created.filter((h) => h.status === "disproven").length} contradicted by existing data)`);
  return created;
}

export async function safeHypothesize(opts: Required<LoopOptions>, round: number) {
  try { return await hypothesize(opts, round); }
  catch (e: any) { opts.log(`  hypothesize failed (${e?.message ?? e}); skipping`); return []; }
}

function selectTargets(hyps: Hypothesis[], n: number) {
  const band = (h: Hypothesis) => (h.confidence >= MIN_CONF && h.confidence <= MAX_CONF ? 0 : h.confidence > MAX_CONF ? 1 : 2);
  const challenged = hyps.filter((h) => h.status === "proven" && h.challenge);
  return [...challenged, ...hyps
    .filter((h) => h.status === "inferred")
    .sort((a, b) => a.testedRounds.length - b.testedRounds.length || band(a) - band(b) || b.confidence - a.confidence)]
    .slice(0, n);
}

type Planned = PlannedInput & { hid: string };

export type RoundResult = { changes: number; tested: string[]; ran: number; empty?: boolean; skipped?: boolean };

/** Step 3, one round: select targets, design experiments (declared-call guard), trace, update statuses. */
export async function experimentRound(opts: Required<LoopOptions>, round: number): Promise<RoundResult> {
  const { sessionId, log } = opts;
  const hyps = await listHypotheses(sessionId);
  const targets = selectTargets(hyps, opts.topN);
  if (!targets.length) {
    log(`round ${round}: nothing left to test`);
    return { changes: 0, tested: [], ran: 0, empty: true };
  }
  log(`round ${round}: experiment on ${targets.map((h) => h.hid).join(", ")}`);
  await emit(sessionId, "experiment_started", { round, hids: targets.map((h) => h.hid) });

  let experiments: Experiment[] = [];
  let tested = targets;
  try {
    const first = await designExperiments({ sessionId, round, targets, ledger: hyps });
    experiments = first.valid;
    if (first.invalid.length) {
      // Guard: declared call != structured input. Don't run it, don't touch the rule, re-ask once.
      log(`  ${first.invalid.length} invalid experiments (${first.invalid.map((x) => `${x.hid}: ${x.problems[0]}`).join("; ").slice(0, 200)}); re-asking once`);
      await emit(sessionId, "experiment_invalid", { round, attempt: 1, invalid: first.invalid });
      const retryTargets = targets.filter((h) => first.invalid.some((x) => x.hid === h.hid));
      const feedback = `Your previous experiments for ${retryTargets.map((h) => h.hid).join(", ")} were rejected because "call" did not match "input":\n${first.invalid.map((x) => `- ${x.hid}: ${x.problems.slice(0, 3).join("; ")}`).join("\n")}\nMake each structured input encode exactly the declared call.`;
      const second = await designExperiments({ sessionId, round, targets: retryTargets, ledger: hyps, feedback });
      experiments.push(...second.valid);
      if (second.invalid.length) {
        await emit(sessionId, "experiment_invalid", { round, attempt: 2, invalid: second.invalid });
        for (const x of second.invalid) {
          const h = targets.find((t) => t.hid === x.hid)!;
          await updateHypothesis(h, round, h.status, h.confidence, `experiment invalid (${x.problems[0]}), status unchanged`);
        }
        log(`  still invalid after re-ask: ${second.invalid.map((x) => x.hid).join(", ")} (status unchanged)`);
      }
    }
    tested = targets.filter((h) => experiments.some((e) => e.hid === h.hid));
  } catch (e: any) {
    // Spec §10b: malformed after retry -> skip the step and log. Mark targets tested so the next round moves on.
    log(`  experiment design failed (${e?.message ?? e}); skipping round ${round}`);
    for (const h of targets) await updateHypothesis(h, round, h.status, h.confidence, "experiment design failed, skipped");
    return { changes: 0, tested: [], ran: 0, skipped: true };
  }
  const planned: Planned[] = experiments.flatMap((e) => e.inputs.map((p) => ({ ...p, hid: e.hid })));
  // examples-kind predicates contribute their own examples as predictions on first test
  for (const h of tested) {
    if (h.predicate.kind === "examples" && !h.testedRounds.length) {
      for (const ex of h.predicate.examples) planned.push({ hid: h.hid, input: ex.input, expected: ex.expected, disproving: false, why: "predicate example" });
    }
  }
  const newObs = planned.length ? await trace({ sessionId, round, source: "experiment", inputs: planned.map((p) => p.input) }) : [];
  log(`  ran ${newObs.length} experiment inputs`);
  // Experiment records: the description is generated from what actually ran, never from the Theorist's text.
  if (newObs.length) {
    await (await getStore()).insertMany("experiments", planned.map((p, i) => ({
      sessionId, round, hid: p.hid, runId: newObs[i].runId, description: fmtCall(newObs[i].input),
      expected: p.expected, actual: newObs[i].outcome, matched: predictionMatches(p.expected, newObs[i].outcome),
      disproving: p.disproving, declared: p.declared ?? null, rationale: p.why ?? null,
    })));
  }
  const obs = await allObs(sessionId);
  const newIds = new Set(newObs.map((x) => x.runId));

  let changes = 0;
  for (const h of hyps) {
    if (h.status === "disproven") continue;
    const isTarget = tested.includes(h);
    const mine = planned.map((p, i) => ({ p, ob: newObs[i] })).filter((x) => x.p.hid === h.hid);
    const match = mine.filter((x) => predictionMatches(x.p.expected, x.ob.outcome));
    const miss = mine.filter((x) => !predictionMatches(x.p.expected, x.ob.outcome));
    const hadDisproving = mine.some((x) => x.p.disproving);

    let expr: ExprResult | null = null;
    if (h.predicate.kind === "expr") {
      expr = evalExpr(h.predicate, obs);
      if (expr.invalid || expr.errors > expr.applicable) expr = null;
    }
    const exprFails = expr?.fail ?? [];
    const newExprFails = exprFails.filter((r) => newIds.has(r));

    if (!isTarget) {
      // Re-check other live rules against the new evidence only.
      if (newExprFails.length) {
        await updateHypothesis(h, round, "disproven", 0.05, `new runs contradict it: ${newExprFails.slice(0, 5).join(", ")}`);
        changes++;
      }
      continue;
    }

    let status: Status, conf: number, note: string;
    if (miss.length || exprFails.length) {
      status = "disproven"; conf = 0.05;
      const ex = miss[0] ? `${miss[0].ob.runId} predicted ${miss[0].p.expected.kind}${miss[0].p.expected.value ? ` ${show(miss[0].p.expected.value)}` : ""}, got ${showOutcome(miss[0].ob.outcome).slice(0, 60)}` : "";
      note = [ex, exprFails.length ? `expr fails on ${exprFails.slice(0, 5).join(", ")}` : ""].filter(Boolean).join("; ");
    } else if (h.status === "proven") {
      // a challenged proven rule that survived its re-test stays proven
      status = "proven"; conf = Math.max(h.confidence, 0.95);
      note = `challenged (${h.challenge?.reason ?? "re-test"}), held: ${match.length} predictions`;
    } else if (match.length >= 3 && hadDisproving) {
      status = "proven"; conf = Math.min(0.99, 0.95 + 0.005 * match.length);
      note = `${match.length} predictions held incl. disproving attempts${expr ? `; expr holds on ${expr.applicable} runs` : ""}`;
    } else {
      status = "inferred";
      conf = match.length ? Math.min(MAX_CONF, h.confidence + 0.1) : Math.max(0.1, h.confidence - 0.1);
      note = `${match.length} predictions held, not enough to prove${hadDisproving ? "" : " (no disproving input)"}`;
    }
    const support = [...match.map((x) => x.ob.runId), ...(expr?.pass.filter((r) => newIds.has(r)) ?? [])];
    if (status !== h.status) changes++;
    await updateHypothesis(h, round, status, conf, note, status === "disproven" ? [] : support);
    if (h.challenge) await setChallenge(h, null);
  }
  log(`  ${changes} status changes`);
  return { changes, tested: tested.map((h) => h.hid), ran: newObs.length };
}

export const withDefaults = (o: LoopOptions): Required<LoopOptions> =>
  ({ roundCap: 4, topN: 5, maxObsInPrompt: 300, log: console.log, startRound: 1, archivist: false, ...o });

export async function runLoop(o: LoopOptions) {
  const opts = withDefaults(o);
  const { sessionId, log } = opts;
  let stable = 0;

  if (!(await listHypotheses(sessionId)).length) {
    log("round 1: hypothesize");
    await safeHypothesize(opts, 1);
  }

  const first = opts.startRound, last = opts.startRound + opts.roundCap - 1;
  for (let round = first; round <= last; round++) {
    const r = await experimentRound(opts, round);
    if (r.empty) {
      if (opts.archivist && round < last && (await archivistStep(sessionId, round, log)) > 0) continue;
      break;
    }
    if (r.skipped) continue;
    const changes = r.changes;
    let archivistAdded = 0;
    if (opts.archivist) archivistAdded = await archivistStep(sessionId, round, log);
    stable = changes === 0 && archivistAdded === 0 ? stable + 1 : 0;
    if (stable >= 2) { log("  stable for 2 rounds, stopping"); break; }
    if (round < last) {
      log(`round ${round + 1}: hypothesize (revisions + unexplained)`);
      await safeHypothesize(opts, round + 1);
    }
  }

  const final = await listHypotheses(sessionId);
  const counts = { proven: 0, inferred: 0, disproven: 0 };
  for (const h of final) counts[h.status]++;
  await emit(sessionId, "loop_done", counts);
  return { hypotheses: final, counts, ledger: final.map(fmtHyp) };
}
