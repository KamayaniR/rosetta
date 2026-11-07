// Tracer: runs inputs against the target in the sandbox and records observations.
import { runBatch, type RunOptions } from "./sandbox/runner.ts";
import { safeRead } from "./safeRead.ts";
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import type { CallInput, Observation, ObservationSource } from "./types.ts";

export const TARGET_PATH = "target/ms.min.js";

export async function trace(args: {
  sessionId: string;
  round: number;
  source: ObservationSource;
  inputs: CallInput[];
  targetPath?: string;
  run?: RunOptions;
}): Promise<Observation[]> {
  const path = args.targetPath ?? TARGET_PATH;
  const code = safeRead(path);
  const results = await runBatch(code, path, args.inputs, args.run);
  const store = await getStore();
  const first = await store.nextSeq(`${args.sessionId}:run`, args.inputs.length);
  const now = new Date();
  const obs: Observation[] = results.map((r, i) => ({
    runId: `R${String(first + i).padStart(4, "0")}`,
    sessionId: args.sessionId,
    input: args.inputs[i],
    outcome: r.outcome,
    nondeterministic: r.nondeterministic,
    ...(r.altOutcomes ? { altOutcomes: r.altOutcomes } : {}),
    sideEffects: r.sideEffects,
    durationMs: Math.round(r.durationMs * 1000) / 1000,
    env: r.env,
    source: args.source,
    round: args.round,
    createdAt: now,
  }));
  await store.insertMany("observations", obs);
  await emit(args.sessionId, "observation_added", {
    count: obs.length, source: args.source, round: args.round, runIds: obs.map((o) => o.runId),
  });
  return obs;
}
