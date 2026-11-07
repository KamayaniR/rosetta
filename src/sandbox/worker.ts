// Runs inside a worker thread. Fresh vm context per call.
// Isolation: the context global is a null-prototype object and NO host object is ever placed in it.
// Inputs go in as a JSON string, are decoded inside the context, and the outcome comes back as a JSON
// string encoded inside the context. So target code can't reach a host Function constructor/process.
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";
import type { CallInput, Env, Outcome, TaggedValue } from "../types.ts";

type Job = { idx: number; input: CallInput };
const { code, filename, callTimeoutMs, repeats } = workerData as {
  code: string; filename: string; callTimeoutMs: number; repeats: number;
};

const WATCHED = ["console", "process", "require", "Date", "setTimeout", "setInterval", "setImmediate",
  "queueMicrotask", "fetch", "performance", "crypto", "Buffer", "global"];

// Runs before the target. Captures builtins the harness needs (target may monkeypatch them later).
const PRELUDE = new vm.Script(`"use strict";
var __fx = [], __fns = [];
var __H = { apply: Reflect.apply, parse: JSON.parse, stringify: JSON.stringify, isArray: Array.isArray,
  keys: Object.keys, fnToString: Function.prototype.toString, WeakSet: WeakSet, BigInt: BigInt, Symbol: Symbol };
(function (g) {
  var stubConsole = { log: function(){}, warn: function(){}, error: function(){}, info: function(){}, debug: function(){} };
  var names = ${JSON.stringify(WATCHED)};
  for (var i = 0; i < names.length; i++) (function (n) {
    var v = n === "Date" ? Date : n === "console" ? stubConsole : undefined;
    Object.defineProperty(g, n, { get: function () { if (__fx.indexOf(n) < 0) __fx.push(n); return v; }, configurable: true });
  })(names[i]);
  g.module = { exports: {} };
  g.exports = g.module.exports;
})(globalThis);`, { filename: "rosetta-prelude.js" });

const moduleScript = new vm.Script(code, { filename });

const CALL = new vm.Script(`"use strict";
(function () {
  var H = __H;
  function dec(tv) {
    if (!tv) return undefined;
    switch (tv.t) {
      case "undefined": return undefined; case "null": return null; case "nan": return NaN;
      case "inf": return Infinity; case "-inf": return -Infinity; case "-0": return -0;
      case "bigint": return H.BigInt(tv.v); case "symbol": return H.Symbol(tv.v);
      case "function": return __fns[tv.v];
      case "array": var a = []; for (var i = 0; i < tv.v.length; i++) a.push(dec(tv.v[i])); return a;
      case "object": var o = {}; var ks = H.keys(tv.v); for (var j = 0; j < ks.length; j++) o[ks[j]] = dec(tv.v[ks[j]]); return o;
      default: return tv.v;
    }
  }
  function enc(x, seen, depth) {
    switch (typeof x) {
      case "undefined": return { t: "undefined" };
      case "boolean": return { t: "boolean", v: x };
      case "string": return { t: "string", v: x };
      case "bigint": return { t: "bigint", v: String(x) };
      case "symbol": return { t: "symbol", v: x.description === undefined ? "" : x.description };
      case "function": var src; try { src = H.apply(H.fnToString, x, []); } catch (e) { src = "[unreadable]"; } return { t: "function", v: src };
      case "number":
        if (x !== x) return { t: "nan" };
        if (x === Infinity) return { t: "inf" };
        if (x === -Infinity) return { t: "-inf" };
        if (x === 0 && 1 / x < 0) return { t: "-0" };
        return { t: "number", v: x };
    }
    if (x === null) return { t: "null" };
    if (seen.has(x) || depth > 20) return { t: "string", v: "[circular-or-deep]" };
    seen.add(x);
    if (H.isArray(x)) { var arr = []; for (var i = 0; i < x.length; i++) arr.push(enc(x[i], seen, depth + 1)); return { t: "array", v: arr }; }
    var out = {}, ks = H.keys(x);
    for (var k = 0; k < ks.length; k++) { try { out[ks[k]] = enc(x[ks[k]], seen, depth + 1); } catch (e) { out[ks[k]] = { t: "string", v: "[getter-threw]" }; } }
    return { t: "object", v: out };
  }
  var input = H.parse(__input), args = [];
  if (input.val !== undefined) args.push(dec(input.val));
  if (input.options !== undefined || (input.extra && input.extra.length)) {
    if (input.val === undefined) args.push(undefined);
    args.push(input.options === undefined ? undefined : dec(input.options));
  }
  if (input.extra) for (var i = 0; i < input.extra.length; i++) args.push(dec(input.extra[i]));
  var outcome;
  try {
    var r = H.apply(module.exports, undefined, args);
    outcome = { kind: "return", value: enc(r, new H.WeakSet(), 0) };
  } catch (e) {
    var isObj = e !== null && (typeof e === "object" || typeof e === "function");
    var name = isObj ? String(e.name) : undefined, msg = isObj ? String(e.message) : undefined;
    if (name === "RangeError" && /call stack/i.test(msg)) outcome = { kind: "crash", errorName: name, errorMessage: msg };
    else if (isObj && "name" in e && "message" in e) outcome = { kind: "throw", errorName: name, errorMessage: msg };
    else outcome = { kind: "throw", value: enc(e, new H.WeakSet(), 0) };
  }
  return H.stringify({ outcome: outcome, fx: __fx.slice() });
})()`, { filename: "rosetta-call.js" });

const env: Env = {
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  lang: process.env.LANG ?? "",
  node: process.version,
};

/** Replace function sources with indexes into the context's __fns list. */
function liftFunctions(input: CallInput, fns: string[]): CallInput {
  const walk = (tv: TaggedValue | undefined): TaggedValue | undefined => {
    if (!tv) return tv;
    if (tv.t === "function") { fns.push(String(tv.v)); return { t: "function", v: fns.length - 1 }; }
    if (tv.t === "array") return { t: "array", v: tv.v.map(walk) };
    if (tv.t === "object") return { t: "object", v: Object.fromEntries(Object.entries(tv.v).map(([k, e]) => [k, walk(e as TaggedValue)])) };
    return tv;
  };
  return { val: walk(input.val), options: walk(input.options), extra: input.extra?.map((e) => walk(e)!) };
}

function runOnce(input: CallInput): { outcome: Outcome; ms: number; effects: string[] } {
  const t0 = performance.now();
  const sandbox = Object.create(null);
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  try {
    PRELUDE.runInContext(ctx);
    const fns: string[] = [];
    const lifted = liftFunctions(input, fns);
    for (const src of fns) vm.runInContext(`__fns.push((${src}));`, ctx, { timeout: callTimeoutMs });
    moduleScript.runInContext(ctx, { timeout: callTimeoutMs });
    sandbox.__input = JSON.stringify(lifted);
    const res = JSON.parse(CALL.runInContext(ctx, { timeout: callTimeoutMs }) as string);
    return { outcome: res.outcome, ms: performance.now() - t0, effects: res.fx };
  } catch (e: any) {
    // Only host-side failures land here: timeouts, target code failing at load time, bad function sources.
    let outcome: Outcome;
    if (e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") outcome = { kind: "timeout" };
    else if (/call stack/i.test(String(e?.message))) outcome = { kind: "crash", errorName: "RangeError", errorMessage: String(e.message) };
    else outcome = { kind: "crash", errorName: String(e?.name ?? "Error"), errorMessage: `harness: ${String(e?.message ?? e)}` };
    let effects: string[] = [];
    try { effects = JSON.parse(vm.runInContext("JSON.stringify(__fx)", ctx, { timeout: 50 })); } catch {}
    return { outcome, ms: performance.now() - t0, effects };
  }
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
