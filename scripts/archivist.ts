// Archivist pass on an existing session (after the Builder):
// Job 1 map + full-history review -> found-by-Archivist hypotheses -> more loop rounds (Archivist reviews each round)
// -> quirk judge -> rebuild port -> compare line evidence before/after.
// usage: npm run archivist -- --session <id> [--rounds 3] [--top 8]
import { parseArgs } from "node:util";
import { getStore } from "../src/store.ts";
import { bus } from "../src/events.ts";
import { archivistStep } from "../src/archivist-step.ts";
import { runLoop } from "../src/loop.ts";
import { detectQuirks, listQuirks } from "../src/quirks.ts";
import { build, type Port } from "../src/builder.ts";
import { listHypotheses } from "../src/hypotheses.ts";

const { values } = parseArgs({ options: { session: { type: "string" }, rounds: { type: "string" }, top: { type: "string" } } });
const sessionId = values.session!;
const store = await getStore();
bus.on("event", (e) => {
  if (e.type === "llm_call") { const p = e.payload as any; console.log(`  · ${p.agent} via ${p.provider} ${p.inputTokens}→${p.outputTokens} tok ${p.latencyMs}ms`); }
  else if (e.type === "provider_switched" || e.type === "agent_error") console.log(`  ! ${e.type}`, JSON.stringify(e.payload).slice(0, 200));
});

const [before] = await store.find<Port>("ports", { sessionId, compileOk: true }, { sort: { version: -1 }, limit: 1 });
const countBy = async () => (await listHypotheses(sessionId)).reduce<Record<string, number>>((m, h) => ((m[h.status] = (m[h.status] ?? 0) + 1), m), {});
const ledgerBefore = await countBy();
const obsRounds = await store.find<any>("observations", { sessionId }, { sort: { round: -1 }, limit: 1 });
const startRound = (obsRounds[0]?.round ?? 0) + 1;

console.log(`archivist Job 1 (round ${startRound - 1}):`);
await archivistStep(sessionId, startRound - 1, console.log);
console.log("loop with archivist review each round:");
await runLoop({ sessionId, startRound, roundCap: Number(values.rounds ?? 3), topN: Number(values.top ?? 8), archivist: true });
console.log("quirk judge:");
const fresh = await detectQuirks(sessionId);
console.log(`  +${fresh.length} quirks (${(await listQuirks(sessionId)).length} total)`);
console.log("builder:");
const port = await build({ sessionId });

const hyps = await listHypotheses(sessionId);
const byArch = hyps.filter((h) => h.source === "archivist");
console.log(`\nledger before ${JSON.stringify(ledgerBefore)} -> after ${JSON.stringify(await countBy())}`);
console.log(`found by Archivist: ${byArch.length} hypotheses (${byArch.filter((h) => h.status === "proven").length} proven, ${byArch.filter((h) => h.status === "disproven").length} disproven)`);
for (const h of byArch) console.log(`  ${h.hid} [${h.status}] ${h.claim.slice(0, 100)}`);
const fmt = (p?: Port) => p?.evidenceSummary ? `${p.evidenceSummary.executed}/${p.evidenceSummary.tagged} tagged lines executed, ${p.evidenceSummary.neverExecuted} never` : "n/a";
console.log(`port line evidence: v${before?.version} ${fmt(before)}  ->  v${port.version} ${fmt(port)}`);
if (port.agreement) console.log(`port v${port.version} agreement: ${port.agreement.equal}/${port.agreement.total}${port.agreement.mismatches.length ? ` mismatches ${port.agreement.mismatches.slice(0, 8).join(" ")}` : ""}`);
await store.close();
