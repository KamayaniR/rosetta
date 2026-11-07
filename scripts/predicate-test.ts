import { evalExpr } from "../src/predicate.ts";
const ob = (runId: string, v: any, out: any, threw = false): any => ({ runId, input: { val: v }, outcome: threw ? { kind: "throw", errorName: "Error", errorMessage: "x" } : { kind: "return", value: out } });
const obs = [
  ob("R1", { t: "boolean", v: true }, undefined, true),
  ob("R2", { t: "string", v: "42" }, { t: "number", v: 42 }),
  ob("R3", { t: "string", v: "5." }, { t: "undefined" }),
  ob("R4", { t: "nan" }, undefined, true),
];
const cases = {
  boolThrows: { applies: "typeof val === 'boolean'", holds: "threw && error.name === 'Error'" },
  digits: { applies: "typeof val === 'string' && /^\\d+$/.test(val)", holds: "out === Number(val)" },
  wrong: { applies: "typeof val === 'string'", holds: "typeof out === 'number'" },
  nanThrows: { applies: "Number.isNaN(val)", holds: "threw" },
  escape: { applies: "true", holds: "this.constructor.constructor('return process')().exit(1)" },
  hang: { applies: "true", holds: "(function(){while(true){}})()" },
  syntax: { applies: "true", holds: "))" },
};
for (const [k, p] of Object.entries(cases)) {
  const r = evalExpr({ kind: "expr", ...p }, obs);
  console.log(k.padEnd(10), "pass", r.pass.join(",") || "-", "| fail", r.fail.join(",") || "-", "| err", r.errors, r.invalid ?? "");
}
