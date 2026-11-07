// Apply Quirk Court decisions synchronously (same as the UI button). usage: npm run apply -- --session <id>
import { parseArgs } from "node:util";
import { getStore } from "../src/store.ts";
import { runStep } from "../src/steps.ts";
import { runContract } from "../src/contract.ts";
const { values } = parseArgs({ options: { session: { type: "string" } } });
const store = await getStore();
const r: any = await runStep("apply", { sessionId: values.session! });
console.log(JSON.stringify(r));
const [c] = await store.find<any>("contracts", { sessionId: values.session! }, { sort: { createdAt: -1 }, limit: 1 });
const [p] = await store.find<any>("ports", { sessionId: values.session!, compileOk: true }, { sort: { version: -1 }, limit: 1 });
for (const q of c.quirks.filter((x: any) => x.decision === "fix")) console.log(`fix ${q.hid}: "${q.fixSpec}" -> predicate ${JSON.stringify(q.fixPredicate)}`);
const res = await runContract(c, p.code);
console.log(`new port v${p.version} (${p.provider}): contract ${res.passed} passed, ${res.failed} failed`);
for (const t of res.results.filter((x) => !x.pass)) console.log("  BROKEN", t.title, t.failures.slice(0, 2));
await store.close();
