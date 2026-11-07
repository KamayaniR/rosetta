import { compile, tagMap, transpile, lookupLint } from "../src/portcheck.ts";
import { runBatch } from "../src/sandbox/runner.ts";
const code = `// @rule H1
export default function ms(val: unknown, options?: unknown): number | string | undefined {
  // @quirk H29 preserve (pending)
  if (typeof val === "string") {
    return val.length; // @rule H5
  }
  return "x";
}`;
console.log("good diag:", compile(code));
console.log("bad diag:", compile("export default function ms(v) { return v.x }").map((d) => `L${d.line} ${d.message}`));
console.log("tags:", JSON.stringify(tagMap(code)));
const [r] = await runBatch(transpile(code), "p.js", [{ val: { t: "string", v: "abc" } }], { repeats: 1 });
console.log("sandbox:", r.outcome, "lint:", lookupLint(code, [{ input: { val: { t: "string", v: "x" } } } as any]));
