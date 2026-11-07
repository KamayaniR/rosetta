// Archivist Job 3 on a session's latest port. usage: npm run audit -- --session <id>
import { parseArgs } from "node:util";
import { getStore } from "../src/store.ts";
import { auditPort } from "../src/audit.ts";
const { values } = parseArgs({ options: { session: { type: "string" } } });
const r = await auditPort(values.session!);
console.log(JSON.stringify(r.subq));
for (const k of Object.keys(r.counts)) for (const i of r.issues.filter((x) => x.kind === k).slice(0, 3)) console.log(`  [${k}] L${i.line} ${i.detail.slice(0, 90)} | ${i.code.slice(0, 60)}`);
await (await getStore()).close();
