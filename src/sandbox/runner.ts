// Spawns a worker per batch with a hard batch timeout. If a worker dies or hangs,
// the in-flight input is recorded as crash/timeout and a fresh worker takes the rest.
import { Worker } from "node:worker_threads";

// Timezone is process-wide in Node (the Worker env option does not change it), so pin it here.
process.env.TZ = "UTC";
process.env.LANG = "en_US.UTF-8";
import { compareOutcomes } from "../tagged.ts";
import type { CallInput, Env, Outcome } from "../types.ts";

export type RunResult = {
  outcome: Outcome;
  nondeterministic: boolean;
  altOutcomes?: Outcome[];
  durationMs: number;
  sideEffects: string[];
  env: Env;
};

export type RunOptions = { callTimeoutMs?: number; repeats?: number };

const FALLBACK_ENV: Env = { tz: "UTC", lang: "en_US.UTF-8", node: process.version };

function fold(outcomes: Outcome[]): Pick<RunResult, "outcome" | "nondeterministic" | "altOutcomes"> {
  const [first, ...rest] = outcomes;
  const differs = rest.filter((o) => !compareOutcomes(first, o).equal);
  return differs.length ? { outcome: first, nondeterministic: true, altOutcomes: differs } : { outcome: first, nondeterministic: false };
}

export async function runBatch(code: string, filename: string, inputs: CallInput[], opts: RunOptions = {}): Promise<RunResult[]> {
  const callTimeoutMs = opts.callTimeoutMs ?? 200;
  const repeats = opts.repeats ?? 3;
  const results: (RunResult | undefined)[] = new Array(inputs.length);
  let pending = inputs.map((_, i) => i);

  while (pending.length) {
    const jobs = pending.map((idx) => ({ idx, input: inputs[idx] }));
    const batchMs = jobs.length * repeats * (callTimeoutMs + 50) + 3000;
    let inFlight: number | undefined;

    const failure = await new Promise<"done" | "timeout" | "crash">((resolveP) => {
      const worker = new Worker(new URL("./worker.ts", import.meta.url), {
        workerData: { code, filename, callTimeoutMs, repeats },
        env: { ...process.env, TZ: "UTC", LANG: "en_US.UTF-8" },
        resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
      });
      let settled = false;
      const finish = (r: "done" | "timeout" | "crash") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => {});
        resolveP(r);
      };
      const timer = setTimeout(() => finish("timeout"), batchMs);
      worker.on("message", (m: any) => {
        if (m.type === "start") inFlight = m.idx;
        else if (m.type === "result") {
          results[m.idx] = { ...fold(m.outcomes), durationMs: m.durationMs, sideEffects: m.sideEffects, env: m.env };
          inFlight = undefined;
        } else if (m.type === "done") finish("done");
      });
      worker.on("error", () => finish("crash"));
      worker.on("exit", () => finish("crash"));
      worker.postMessage(jobs);
    });

    if (failure !== "done") {
      const victim = inFlight ?? pending.find((i) => !results[i]);
      if (victim !== undefined && !results[victim]) {
        results[victim] = {
          outcome: failure === "timeout" ? { kind: "timeout" } : { kind: "crash", errorMessage: "worker died" },
          nondeterministic: false,
          durationMs: 0,
          sideEffects: [],
          env: FALLBACK_ENV,
        };
      }
    }
    pending = pending.filter((i) => !results[i]);
  }
  return results as RunResult[];
}
