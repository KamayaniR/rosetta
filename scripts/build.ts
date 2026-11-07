// Milestone 4: detect quirks (Gemini) then build the TS port (Muse Spark).
// usage: npm run build-port -- --session <id>
import { parseArgs } from "node:util";
import { getStore } from "../src/store.ts";
import { bus } from "../src/events.ts";
import { detectQuirks, listQuirks } from "../src/quirks.ts";
import { build } from "../src/builder.ts";
import { listHypotheses } from "../src/hypotheses.ts";

const { values } = parseArgs({ options: { session: { type: "string" } } });
if (!values.session) throw new Error("--session <id> required");
const sessionId = values.session;
const store = await getStore();
bus.on("event", (e) => {
  if (e.type === "llm_call") { const p = e.payload as any; console.log(`  · ${p.agent} via ${p.provider} ${p.inputTokens}→${p.outputTokens} tok ${p.latencyMs}ms`); }
  else if (e.type === "provider_switched" || e.type === "agent_error") console.log(`  ! ${e.type}`, JSON.stringify(e.payload).slice(0, 200));
});

console.log("quirk judge:");
const fresh = await detectQuirks(sessionId);
const quirks = await listQuirks(sessionId);
console.log(`  ${fresh.length} new, ${quirks.length} total (all pending = preserve)`);
for (const q of quirks) console.log(`  ${q.hid} [${q.ruleStatus}] ${q.claim.slice(0, 70)}\n        why: ${q.reason.slice(0, 110)}`);

console.log("builder:");
const port = await build({ sessionId });
const hyps = await listHypotheses(sessionId);
const proven = hyps.filter((h) => h.status === "proven").map((h) => h.hid);
const tagged = new Set(port.ruleMap.flatMap((t) => t.hids));
const quirkTagged = new Set(port.ruleMap.flatMap((t) => t.quirks.map((q) => q.hid)));
console.log(`\nport v${port.version}: compile ${port.compileOk ? "OK" : "FAIL"} after ${port.attempts} attempt(s)`);
if (port.agreement) {
  const a = port.agreement;
  console.log(`agreement with all ${a.total} observations: ${a.equal} equal (${((100 * a.equal) / a.total).toFixed(1)}%), ${a.lowOnly} low-severity only, ${a.total - a.equal - a.lowOnly} mismatches ${a.mismatches.slice(0, 10).join(" ")}`);
}
console.log(`proven rules referenced by @rule tags: ${proven.filter((h) => tagged.has(h)).length}/${proven.length}`);
console.log(`quirks tagged with @quirk: ${quirks.filter((q) => quirkTagged.has(q.hid)).length}/${quirks.length}`);
console.log(`lint: ${port.lint.hits.length} observed string literals in port`);
if (port.compileOk) console.log("written: out/ms.port.ts");
await store.close();
