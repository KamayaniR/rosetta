// Sanity check for Verify: plant small bugs in the latest port and confirm fuzzing catches + shrinks each one.
import { parseArgs } from "node:util";
import { getStore } from "../src/store.ts";
import { runBoth, sampleInputs, shrink } from "../src/verify.ts";
import { transpile } from "../src/portcheck.ts";
import { showOutcome } from "../src/tagged.ts";
import { fmtCall } from "../src/theorist.ts";
// --version N tests a specific port (e.g. the one before a Fix was applied, so fixes don't count as "caught")
const { values } = parseArgs({ options: { session: { type: "string" }, version: { type: "string" } } });
const store = await getStore();
const [port] = values.version
  ? await store.find<any>("ports", { sessionId: values.session!, version: Number(values.version) })
  : await store.find<any>("ports", { sessionId: values.session!, compileOk: true }, { sort: { version: -1 }, limit: 1 });
console.log(`port v${port.version} (${port.provider ?? "?"})`);
const mutants: [string, (c: string) => string][] = [
  ["plural threshold 1.5 -> 2", (c) => c.replace("1.5", "2")],
  ["length cap 100 -> 50", (c) => c.replace(/100\b/, "50")],
  ["Math.round -> Math.floor", (c) => c.replace("Math.round", "Math.floor")],
];
const inputs = sampleInputs(7, 2000);
for (const [name, mut] of mutants) {
  const code = mut(port.code);
  if (code === port.code) { console.log(`${name}: pattern not found, skipped`); continue; }
  const res = await runBoth(transpile(code), inputs);
  const bad = res.filter((r) => !r.cmp.equal);
  const s = bad.length ? await shrink(transpile(code), bad[0]) : null;
  console.log(`${name.padEnd(28)} caught ${bad.length}/2000${s ? ` | shrunk to ${fmtCall(s.input)}: original ${showOutcome(s.original)} vs port ${showOutcome(s.port)}` : " | NOT CAUGHT"}`);
}
await store.close();
