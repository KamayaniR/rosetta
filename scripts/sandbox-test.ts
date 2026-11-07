import { runBatch } from "../src/sandbox/runner.ts";
import { safeRead } from "../src/safeRead.ts";
import { encode, showOutcome } from "../src/tagged.ts";
import type { CallInput } from "../src/types.ts";

const ms = safeRead("target/ms.min.js");
const I = (val?: unknown, options?: unknown): CallInput => ({
  val: encode(val),
  ...(options !== undefined ? { options: encode(options) } : {}),
});
const msInputs: CallInput[] = [
  I("2h"), I(60000), I(60000, { long: true }), I(""), I(NaN), I(-0), I(null),
  { val: { t: "symbol", v: "x" } }, { val: { t: "bigint", v: "10" } },
  { val: { t: "function", v: "function(){ return 1 }" } }, {},
];
const t = Date.now();
for (const [inp, r] of (await runBatch(ms, "ms.min.js", msInputs)).map((r, i) => [msInputs[i], r] as const))
  console.log(JSON.stringify(inp).padEnd(60), "=>", showOutcome(r.outcome), r.nondeterministic ? "NONDET" : "", r.sideEffects.join(","));
console.log("env", (await runBatch(ms, "x", [I(1)]))[0].env, `${Date.now() - t}ms`);

const weird: Record<string, string> = {
  hang: "module.exports=function(){while(true){}}",
  recurse: "module.exports=function f(){return f()+1}",
  random: "module.exports=function(){return Math.random()}",
  effects: "module.exports=function(){console.log('hi');return Date.now()>0}",
};
for (const [name, code] of Object.entries(weird)) {
  const [r, after] = await runBatch(code, name, [I(1), I(2)]);
  console.log(name.padEnd(8), showOutcome(r.outcome), r.nondeterministic ? "NONDET" : "", r.sideEffects.join(","), "| next:", showOutcome(after.outcome));
}
