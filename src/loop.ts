// Steps 2-3: hypothesize -> experiment -> update statuses, until stable for 2 rounds or round cap.
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import { trace } from "./tracer.ts";
import { evalExpr, predictionMatches, type ExprResult } from "./predicate.ts";
import { createHypotheses, listHypotheses, updateHypothesis, validateEvidence, type Hypothesis, type Status } from "./hypotheses.ts";
import { designExperiments, fmtHyp, theorize, type PlannedInput } from "./theorist.ts";
import { show, showOutcome } from "./tagged.ts";
import type { Observation } from "./types.ts";

export type LoopOptions = { sessionId: string; roundCap?: number; topN?: number; maxObsInPrompt?: number; log?: (s: string) => void };

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
  const created = await createHypotheses(sessionId, round, ok);
  // Cheap pre-check: an expr rule already contradicted by existing observations is disproven immediately.
  for (const h of created) {
    if (h.predicate.kind !== "expr") continue;
    const r = evalExpr(h.predicate, obs);
    if (r.fail.length) await updateHypothesis(h, round, "disproven", 0.05, `contradicted by existing runs ${r.fail.slice(0, 5).join(", ")}`);
  }
  log(`  +${created.length} hypotheses (${created.filter((h) => h.status === "disproven").length} contradicted by existing data)`);
  return created;
}

function selectTargets(hyps: Hypothesis[], n: number) {
  const band = (h: Hypothesis) => (h.confidence >= MIN_CONF && h.confidence <= MAX_CONF ? 0 : h.confidence > MAX_CONF ? 1 : 2);
  return hyps
    .filter((h) => h.status === "inferred")
    .sort((a, b) => a.testedRounds.length - b.testedRounds.length || band(a) - band(b) || b.confidence - a.confidence)
    .slice(0, n);
}

type Planned = PlannedInput & { hid: string };

export async function runLoop(o: LoopOptions) {
  const opts: Required<LoopOptions> = { roundCap: 4, topN: 5, maxObsInPrompt: 300, log: console.log, ...o };
  const { sessionId, log } = opts;
  let stable = 0;

  if (!(await listHypotheses(sessionId)).length) {
    log("round 1: hypothesize");
    await hypothesize(opts, 1);
  }

  for (let round = 1; round <= opts.roundCap; round++) {
    const hyps = await listHypotheses(sessionId);
    const targets = selectTargets(hyps, opts.topN);
    if (!targets.length) { log(`round ${round}: nothing left to test`); break; }
    log(`round ${round}: experiment on ${targets.map((h) => h.hid).join(", ")}`);
    await emit(sessionId, "experiment_started", { round, hids: targets.map((h) => h.hid) });

    const experiments = await designExperiments({ sessionId, round, targets, ledger: hyps });
    const planned: Planned[] = experiments.flatMap((e) => e.inputs.map((p) => ({ ...p, hid: e.hid })));
    // examples-kind predicates contribute their own examples as predictions on first test
    for (const h of targets) {
      if (h.predicate.kind === "examples" && !h.testedRounds.length) {
        for (const ex of h.predicate.examples) planned.push({ hid: h.hid, input: ex.input, expected: ex.expected, disproving: false, why: "predicate example" });
      }
    }
    const newObs = planned.length ? await trace({ sessionId, round, source: "experiment", inputs: planned.map((p) => p.input) }) : [];
    log(`  ran ${newObs.length} experiment inputs`);
    const obs = await allObs(sessionId);
    const newIds = new Set(newObs.map((x) => x.runId));

    let changes = 0;
    for (const h of hyps) {
      if (h.status === "disproven") continue;
      const isTarget = targets.includes(h);
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
    }
    log(`  ${changes} status changes`);
    stable = changes === 0 ? stable + 1 : 0;
    if (stable >= 2) { log("  stable for 2 rounds, stopping"); break; }
    if (round < opts.roundCap) {
      log(`round ${round + 1}: hypothesize (revisions + unexplained)`);
      await hypothesize(opts, round + 1);
    }
  }

  const final = await listHypotheses(sessionId);
  const counts = { proven: 0, inferred: 0, disproven: 0 };
  for (const h of final) counts[h.status]++;
  await emit(sessionId, "loop_done", counts);
  return { hypotheses: final, counts, ledger: final.map(fmtHyp) };
}
