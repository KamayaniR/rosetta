// §7d security pass on a session. usage: npm run security -- --session <id>
import { parseArgs } from "node:util";
import { getStore } from "../src/store.ts";
import { securityPass } from "../src/security.ts";
const { values } = parseArgs({ options: { session: { type: "string" } } });
const store = await getStore();
const r = await securityPass(values.session!);
console.log(`security findings: ${r.findings.length} (${r.findings.join(", ") || "none"}); crashes/hangs ${r.crashes}; dangerous capability uses ${r.dangerous}`);
for (const s of r.sweeps) console.log(`  ${s.flagged ? "FLAG" : "ok  "} ${s.regex.slice(0, 50)} unit ${JSON.stringify(s.pattern.unit)}: ${s.reason}`);
await store.close();
