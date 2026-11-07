// Runs inside a worker thread. Fresh vm context per call; no host globals leak in.
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";
import { decode, encode } from "../tagged.ts";
import type { CallInput, Env, Outcome } from "../types.ts";

type Job = { idx: number; input: CallInput };
const { code, filename, callTimeoutMs, repeats } = workerData as {
  code: string; filename: string; callTimeoutMs: number; repeats: number;
};

const moduleScript = new vm.Script(code, { filename });
const callScript = new vm.Script("__rosetta_result = Reflect.apply(module.exports, undefined, __rosetta_args)");

const env: Env = {
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  lang: process.env.LANG ?? "",
  node: process.version,
};

// Globals the target might touch. Access is recorded as a side effect.
const WATCHED = ["console", "process", "require", "Date", "setTimeout", "setInterval", "setImmediate",
  "queueMicrotask", "fetch", "performance", "crypto", "Buffer", "global"] as const;

function makeContext(effects: Set<string>) {
  const module = { exports: {} as unknown };
  const sandbox: Record<string, unknown> = { module, exports: module.exports };
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const innerDate = vm.runInContext("Date", ctx);
  const stubConsole = vm.runInContext("({log(){},warn(){},error(){},info(){},debug(){}})", ctx);
  for (const name of WATCHED) {
    const value = name === "Date" ? innerDate : name === "console" ? stubConsole : undefined;
    Object.defineProperty(sandbox, name, {
      get() { effects.add(name); return value; },
      configurable: true,
    });
  }
  return { sandbox, ctx };
}

function runOnce(input: CallInput): { outcome: Outcome; ms: number; effects: string[] } {
  const effects = new Set<string>();
  const t0 = performance.now();
  let outcome: Outcome;
  try {
    const { sandbox, ctx } = makeContext(effects);
    const mkFn = (src: string) => vm.runInContext(`(${src})`, ctx, { timeout: callTimeoutMs });
    moduleScript.runInContext(ctx, { timeout: callTimeoutMs });
    const args: unknown[] = [];
    if (input.val !== undefined) args.push(decode(input.val, mkFn));
    if (input.options !== undefined || input.extra?.length) {
      if (input.val === undefined) args.push(undefined);
      args.push(input.options === undefined ? undefined : decode(input.options, mkFn));
    }
    for (const e of input.extra ?? []) args.push(decode(e, mkFn));
    sandbox.__rosetta_args = args;
    callScript.runInContext(ctx, { timeout: callTimeoutMs });
    outcome = { kind: "return", value: encode(sandbox.__rosetta_result) };
  } catch (e: any) {
    if (e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") outcome = { kind: "timeout" };
    else if (e?.name === "RangeError" && /call stack/i.test(String(e?.message))) {
      outcome = { kind: "crash", errorName: "RangeError", errorMessage: String(e.message) };
    } else if (e !== null && typeof e === "object" && "name" in e && "message" in e) {
      outcome = { kind: "throw", errorName: String(e.name), errorMessage: String(e.message) };
    } else {
      outcome = { kind: "throw", value: encode(e) };
    }
  }
  return { outcome, ms: performance.now() - t0, effects: [...effects] };
}

parentPort!.on("message", (jobs: Job[]) => {
  for (const { idx, input } of jobs) {
    parentPort!.postMessage({ type: "start", idx });
    const runs = Array.from({ length: repeats }, () => runOnce(input));
    parentPort!.postMessage({
      type: "result",
      idx,
      outcomes: runs.map((r) => r.outcome),
      durationMs: runs.reduce((s, r) => s + r.ms, 0) / runs.length,
      sideEffects: [...new Set(runs.flatMap((r) => r.effects))],
      env,
    });
  }
  parentPort!.postMessage({ type: "done" });
});
