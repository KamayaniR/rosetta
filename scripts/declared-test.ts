import { checkDeclared } from "../src/declared.ts";
const n = (v: number) => ({ t: "number" as const, v });
const LONG = { t: "object" as const, v: { long: { t: "boolean" as const, v: true } } };
const cases: [string, any][] = [
  ["f(1, {}, 2, 3)", { val: n(1), options: LONG, extra: [n(2), n(3)] }],            // the H22 bug -> must be rejected
  ["f(1, {}, 2, 3)", { val: n(1), options: { t: "object", v: {} }, extra: [n(2), n(3)] }],
  ["f('1h', {long: true})", { val: { t: "string", v: "1h" }, options: LONG }],
  ["f('a'.repeat(101))", { val: { t: "string", v: "a".repeat(101) } }],
  ["f('a'.repeat(100))", { val: { t: "string", v: "a".repeat(101) } }],
  ["f()", {}],
  ["f(-0)", { val: { t: "-0" } }],
  ["f(0)", { val: { t: "-0" } }],
  ["f(NaN, undefined)", { val: { t: "nan" }, options: { t: "undefined" } }],
  ["f(10n)", { val: { t: "bigint", v: "10" } }],
  ["f(function(){return 1})", { val: { t: "function", v: "function () { return 1 }" } }],
  ["f(this.constructor.constructor('return process')())", { val: n(1) }],
  ["ms('1h')", { val: { t: "string", v: "1h" } }],
];
for (const [call, input] of cases) console.log(call.padEnd(52), "->", checkDeclared(call, input) ?? "MATCH");
