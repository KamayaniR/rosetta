// Mechanical checks for hypotheses.
// expr predicates are LLM-written JS, so they run in an isolated vm context with no host objects:
// observation data goes in as a JSON string and is decoded inside the context.
import vm from "node:vm";
import { tvEqual } from "./tagged.ts";
import type { Observation, Outcome, TaggedValue } from "./types.ts";

export type ExprPredicate = { kind: "expr"; applies: string; holds: string };
export type Expected = { kind: Outcome["kind"]; value?: TaggedValue; errorName?: string; errorMessage?: string };
export type Example = { input: import("./types.ts").CallInput; expected: Expected };
export type ExamplesPredicate = { kind: "examples"; examples: Example[] };
export type Predicate = ExprPredicate | ExamplesPredicate;

export function predictionMatches(exp: Expected, act: Outcome): boolean {
  if (exp.kind !== act.kind) return false;
  if (exp.value !== undefined && !tvEqual(exp.value, act.value)) return false;
  if (exp.errorName !== undefined && exp.errorName !== act.errorName) return false;
  if (exp.errorMessage !== undefined && exp.errorMessage !== act.errorMessage) return false;
  return true;
}

const DECODER = `function __dec(tv){ if(!tv) return undefined; switch(tv.t){
  case "undefined": return undefined; case "null": return null; case "nan": return NaN;
  case "inf": return Infinity; case "-inf": return -Infinity; case "-0": return -0;
  case "bigint": return BigInt(tv.v); case "symbol": return Symbol(tv.v); case "function": return function(){};
  case "array": return tv.v.map(__dec);
  case "object": { var o = {}; for (var k in tv.v) o[k] = __dec(tv.v[k]); return o; }
  default: return tv.v; } }`;

export type ExprResult = { pass: string[]; fail: string[]; errors: number; applicable: number; invalid?: string };

/** Evaluate an expr predicate over observations. pass/fail hold run IDs. */
export function evalExpr(p: ExprPredicate, obs: Observation[]): ExprResult {
  const res: ExprResult = { pass: [], fail: [], errors: 0, applicable: 0 };
  const usable = obs.filter((o) => o.outcome.kind === "return" || o.outcome.kind === "throw");
  if (!usable.length) return res;
  const data = usable.map((o) => ({
    v: o.input.val, o: o.input.options,
    n: o.input.val === undefined && o.input.options === undefined && !o.input.extra?.length ? 0
      : 1 + (o.input.options !== undefined || o.input.extra?.length ? 1 : 0) + (o.input.extra?.length ?? 0),
    out: o.outcome.kind === "return" ? o.outcome.value : undefined,
    threw: o.outcome.kind === "throw",
    err: o.outcome.kind === "throw" ? { name: o.outcome.errorName ?? null, message: o.outcome.errorMessage ?? null } : null,
  }));
  const src = `"use strict";
${DECODER}
var __a = function(val, options, nArgs, out, threw, error){ return (${p.applies}); };
var __h = function(val, options, nArgs, out, threw, error){ return (${p.holds}); };
var __obs = JSON.parse(__data), __res = [];
for (var i = 0; i < __obs.length; i++) { var o = __obs[i], r;
  var args = [__dec(o.v), __dec(o.o), o.n, __dec(o.out), o.threw, o.err];
  try { if (!__a.apply(null, args)) r = -1; else { try { r = __h.apply(null, args) ? 1 : 0; } catch (e) { r = -2; } } }
  catch (e) { r = -3; }
  __res.push(r); }
JSON.stringify(__res);`;
  let script: vm.Script;
  try { script = new vm.Script(src); } catch (e: any) { return { ...res, invalid: `syntax: ${e?.message}` }; }
  // Null-prototype global + strict mode: no host object is reachable from the expression.
  const sandbox = Object.create(null);
  sandbox.__data = JSON.stringify(data);
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  let out: number[];
  try { out = JSON.parse(script.runInContext(ctx, { timeout: 1000 })); }
  catch (e: any) { return { ...res, invalid: `runtime: ${e?.message}` }; }
  out.forEach((r, i) => {
    if (r === 1) res.pass.push(usable[i].runId);
    else if (r === 0) res.fail.push(usable[i].runId);
    else if (r === -2 || r === -3) res.errors++;
  });
  res.applicable = res.pass.length + res.fail.length;
  return res;
}
