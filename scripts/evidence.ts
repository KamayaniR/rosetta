// Line evidence for the latest port of a session (no rebuild). usage: npm run evidence -- --session <id>
import { parseArgs } from "node:util";
import { getStore } from "../src/store.ts";
import { portLineEvidence } from "../src/evidence.ts";
import type { Port } from "../src/builder.ts";
const { values } = parseArgs({ options: { session: { type: "string" } } });
const store = await getStore();
const [port] = await store.find<Port>("ports", { sessionId: values.session!, compileOk: true }, { sort: { version: -1 }, limit: 1 });
const obs = await store.find<any>("observations", { sessionId: values.session! });
const ev = await portLineEvidence(port.code, port.ruleMap, obs);
await store.updateOne("ports", { sessionId: values.session!, version: port.version }, { lineEvidence: ev.lines, evidenceSummary: ev.summary });
const lines = port.code.split("\n");
console.log(`port v${port.version}: ${ev.summary.tagged} tagged lines -> ${ev.summary.executed} executed, ${ev.summary.neverExecuted} NEVER executed, ${ev.summary.noCode} no code`);
for (const l of ev.lines.filter((x) => x.executed === false)) console.log(`  L${String(l.line).padEnd(4)} [${l.hids.join(",")}] ${lines[l.line - 1].trim().slice(0, 70)}`);
await store.close();
