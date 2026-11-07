// Step 7: generate the contract for a session, run it on the current port, then on "AI edits".
// usage: npm run contract -- --session <id> [--edit path/to/edited.ts]
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { getStore } from "../src/store.ts";
import { buildContract, runContract } from "../src/contract.ts";
const { values } = parseArgs({ options: { session: { type: "string" }, edit: { type: "string" } } });
const sessionId = values.session!;
const store = await getStore();
const def = await buildContract(sessionId);
console.log(`contract: ${def.rules.length} rule groups, ${def.quirks.length} quirk tests (${def.quirks.map((q) => `${q.hid}=${q.decision}`).join(", ")}), snapshot ${def.snapshot.length}; written out/contract.test.ts`);
const [port] = await store.find<any>("ports", { sessionId, compileOk: true }, { sort: { version: -1 }, limit: 1 });
const show = (label: string, r: Awaited<ReturnType<typeof runContract>>) => {
  console.log(`\n${label}: ${r.passed} passed, ${r.failed} failed${r.compileErrors.length ? `, ${r.compileErrors.length} TS errors` : ""}`);
  for (const t of r.results.filter((x) => !x.pass)) console.log(`  BROKEN ${t.title.slice(0, 90)}\n         ${t.failures.slice(0, 2).join("\n         ")}`);
};
show(`port v${port.version}`, await runContract(def, port.code));
const edits: [string, string][] = values.edit ? [["your edit", readFileSync(values.edit, "utf8")]] : [
  ["AI edit: 'simplify' plural rule to >= 2", port.code.replace("1.5", "2")],
  ["AI edit: 'trim input first' (silently accepts ' 42')", port.code.replace(/(function \w+\((\w+): string\)[^{]*\{)/, "$1 $2 = $2.trim();")],
];
for (const [label, code] of edits) show(label, await runContract(def, code));
await store.close();
