// Pipeline steps, shared by both orchestrators:
//  - node:  runPipeline() below calls them in order (provenance recorded as "unsigned-fallback")
//  - fetch: the uAgents Bureau calls them through signed POST /internal/:step (provenance verified + signed)
// Each step returns IDs only (agents pass IDs, data stays in MongoDB).
import { randomBytes } from "node:crypto";
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import { expandSeeds, generateSeeds } from "./seeds.ts";
import { trace, TARGET_PATH } from "./tracer.ts";
import { experimentRound, safeHypothesize, withDefaults } from "./loop.ts";
import { archivistStep } from "./archivist-step.ts";
import { detectQuirks } from "./quirks.ts";
import { build } from "./builder.ts";
import { verify } from "./verify.ts";
import { listHypotheses } from "./hypotheses.ts";
import { buildReport } from "./report.ts";

export type StepName = "seed" | "hypothesize" | "experiment" | "archivist" | "quirks" | "build" | "verify" | "done";
/** Which agent may perform each step (signature must come from this agent). */
export const STEP_AGENT: Record<StepName, string> = {
  seed: "tracer", hypothesize: "theorist", experiment: "theorist", archivist: "archivist",
  quirks: "skeptic", build: "builder", verify: "skeptic", done: "coordinator",
};

const log = (sessionId: string) => (s: string) => { console.log(`[${sessionId}] ${s}`); };

export async function createSession(opts: { orchestrator: "node" | "fetch"; source?: { kind: "web" | "agentverse"; caller?: string; request?: string } }) {
  const store = await getStore();
  const sessionId = `s_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}_${randomBytes(2).toString("hex")}`;
  await store.insertMany("sessions", [{ sessionId, target: TARGET_PATH, createdAt: new Date(), store: store.kind, orchestrator: opts.orchestrator, source: opts.source ?? { kind: "web" }, phase: "trace", done: false }]);
  await emit(sessionId, "session_started", { target: TARGET_PATH, orchestrator: opts.orchestrator, source: opts.source ?? { kind: "web" } });
  return sessionId;
}

export async function setPhase(sessionId: string, phase: string) {
  await (await getStore()).updateOne("sessions", { sessionId }, { phase });
  await emit(sessionId, "phase", { phase });
}

type Args = { sessionId: string; round?: number; topN?: number; feedback?: string; repair?: boolean };

/** Run one step. Returns a small JSON result (IDs and counts). */
export async function runStep(step: StepName, a: Args): Promise<Record<string, unknown>> {
  const { sessionId } = a;
  const L = log(sessionId);
  const opts = withDefaults({ sessionId, topN: a.topN ?? 8, archivist: false, log: L });
  switch (step) {
    case "seed": {
      await setPhase(sessionId, "trace");
      const seeds = await generateSeeds(sessionId);
      const obs = await trace({ sessionId, round: 0, source: "seed", inputs: expandSeeds(seeds.inputs) });
      return { runIds: obs.map((o) => o.runId), count: obs.length };
    }
    case "hypothesize": {
      await setPhase(sessionId, "hypothesize");
      const created = await safeHypothesize(opts, a.round ?? 1);
      return { hids: created.map((h) => h.hid), count: created.length };
    }
    case "experiment": {
      await setPhase(sessionId, "experiment");
      const r = await experimentRound(opts, a.round ?? 1);
      return { ...r };
    }
    case "archivist": {
      const added = await archivistStep(sessionId, a.round ?? 1, L);
      return { added };
    }
    case "quirks": {
      await setPhase(sessionId, "quirk_court");
      const q = await detectQuirks(sessionId);
      return { hids: q.map((x) => x.hid), count: q.length };
    }
    case "build": {
      await setPhase(sessionId, "port");
      const p = await build({ sessionId, feedback: a.feedback, log: L });
      return { portVersion: p.version, compileOk: p.compileOk, agreement: p.agreement, evidence: p.evidenceSummary };
    }
    case "verify": {
      await setPhase(sessionId, "verify");
      const v = await verify({ sessionId, fuzzSeed: a.repair ? 43 : 42, log: L });
      const fuzzMiss = v.mismatches.filter((m) => m.phase === "fuzz" && m.severity === "high");
      return {
        portVersion: v.portVersion, fuzz: v.fuzz, heldout: v.heldout, mismatches: v.mismatches.length,
        repairFeedback: fuzzMiss.length
          ? `Differential fuzzing found inputs where your previous port differs from the original. Fix the general logic (do not special-case these inputs):\n${fuzzMiss.map((m) => `- ${m.call}: original ${m.original} | port ${m.port}`).join("\n")}`
          : null,
      };
    }
    case "done": {
      await setPhase(sessionId, "contract");
      const report = await buildReport(sessionId);
      const store = await getStore();
      await store.insertMany("reports", [report]);
      await store.updateOne("sessions", { sessionId }, { done: true, finishedAt: new Date() });
      await emit(sessionId, "session_done", { rules: report.rules, heldout: report.verify?.heldout?.matchRate ?? null });
      return { rules: report.rules };
    }
  }
}

/** Record provenance for a step run without agents (node fallback): never claims a signature it doesn't have. */
async function unsignedStep(step: StepName, a: Args) {
  const result = await runStep(step, a);
  await (await getStore()).insertMany("provenance", [{
    sessionId: a.sessionId, step, round: a.round ?? null, signerName: STEP_AGENT[step], signer: null, signature: null,
    payloadHash: null, verified: "unsigned-fallback", result, ts: new Date(),
  }]);
  return result;
}

/** Node orchestrator: the full loop in-process (spec fallback `ORCHESTRATOR=node`). */
export async function runPipeline(sessionId: string, o: { rounds?: number; topN?: number } = {}) {
  const rounds = o.rounds ?? 6, topN = o.topN ?? 8;
  await unsignedStep("seed", { sessionId });
  await unsignedStep("hypothesize", { sessionId, round: 1 });
  let stable = 0;
  for (let round = 1; round <= rounds; round++) {
    const r = (await unsignedStep("experiment", { sessionId, round, topN })) as { changes: number; empty?: boolean; skipped?: boolean };
    const added = ((await unsignedStep("archivist", { sessionId, round })) as { added: number }).added;
    if (r.empty && !added) break;
    stable = (r.changes ?? 0) === 0 && added === 0 ? stable + 1 : 0;
    if (stable >= 2) break;
    if (round < rounds) await unsignedStep("hypothesize", { sessionId, round: round + 1 });
  }
  await unsignedStep("quirks", { sessionId });
  await unsignedStep("build", { sessionId });
  const v = (await unsignedStep("verify", { sessionId })) as { repairFeedback: string | null };
  if (v.repairFeedback) {
    await unsignedStep("build", { sessionId, feedback: v.repairFeedback });
    await unsignedStep("verify", { sessionId, repair: true });
  }
  await unsignedStep("done", { sessionId });
  return (await listHypotheses(sessionId)).length;
}
