// Safety net (§16, 2:45): the whole pipeline from the CLI in a fresh session.
// seeds -> hypothesize/experiment loop (Archivist review every round) -> quirk judge -> Builder (+ line evidence)
// -> Verify with one repair pass -> report (Mongo `reports` + out/report.json).
// usage: npm run e2e [-- --rounds 6 --top 8 --session <existing id to resume>]
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getStore } from "../src/store.ts";
import { bus } from "../src/events.ts";
import { startSession } from "../src/session.ts";
import { runLoop } from "../src/loop.ts";
import { detectQuirks } from "../src/quirks.ts";
import { build } from "../src/builder.ts";
import { verify } from "../src/verify.ts";
import { buildReport } from "../src/report.ts";

const { values } = parseArgs({ options: { rounds: { type: "string" }, top: { type: "string" }, session: { type: "string" } } });
const store = await getStore();
if (store.warning) console.warn(`WARN ${store.warning}`);
bus.on("event", (e) => {
  if (e.type === "llm_call") { const p = e.payload as any; console.log(`  · ${p.agent} via ${p.provider} ${p.inputTokens}→${p.outputTokens} tok ${p.latencyMs}ms`); }
  else if (e.type === "provider_switched" || e.type === "agent_error") console.log(`  ! ${e.type}`, JSON.stringify(e.payload).slice(0, 160));
});
const t0 = Date.now();
const phase = (name: string) => console.log(`\n== ${name} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

phase("trace: seeds");
const sessionId = values.session ?? (await startSession()).sessionId;

phase("hypothesize + experiment (Archivist every round)");
await runLoop({ sessionId, roundCap: Number(values.rounds ?? 6), topN: Number(values.top ?? 8), archivist: true });

phase("quirk judge");
console.log(`  ${(await detectQuirks(sessionId)).length} quirks (pending = preserve)`);

phase("port");
let port = await build({ sessionId });

phase("verify");
let v = await verify({ sessionId, fuzzSeed: 42 });
const fuzzMiss = v.mismatches.filter((m) => m.phase === "fuzz" && m.severity === "high");
if (fuzzMiss.length) {
  phase("repair port with shrunk fuzz counterexamples");
  port = await build({ sessionId, feedback: `Differential fuzzing found inputs where your previous port differs from the original. Fix the general logic (do not special-case these inputs):\n${fuzzMiss.map((m) => `- ${m.call}: original ${m.original} | port ${m.port}`).join("\n")}` });
  v = await verify({ sessionId, fuzzSeed: 43 });
}

phase("security pass");
const { securityPass } = await import("../src/security.ts");
const sec = await securityPass(sessionId);
console.log(`  ${sec.findings.length} security findings; ${sec.sweeps.map((s) => s.reason).join(" | ")}`);
phase("final audit (Archivist Job 3)");
await (await import("../src/audit.ts")).auditPort(sessionId);
phase("contract");
const { buildContract, runContract } = await import("../src/contract.ts");
const contract = await buildContract(sessionId);
const cr = await runContract(contract, port.code);
console.log(`  contract: ${contract.rules.length} rule groups, ${contract.quirks.length} quirk tests, ${contract.snapshot.length} snapshot; port passes ${cr.passed}/${cr.passed + cr.failed}`);

phase("report");
const report = await buildReport(sessionId);
await store.insertMany("reports", [report]);
await store.updateOne("sessions", { sessionId }, { done: true, finishedAt: new Date(), phase: "contract" }); // enables Reveal
const dir = resolve(import.meta.dirname, "..", "out");
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "report.json"), JSON.stringify(report, null, 2));

const r = report;
console.log(`session ${sessionId}  (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
console.log(`rules: ${JSON.stringify(r.rules)} | found by Archivist: ${r.archivist.hypotheses} (${JSON.stringify(r.archivist.findingsByType)})`);
if (r.archivist.lastContext) console.log(`archivist context: ${r.archivist.lastContext.archivistTokens} tok vs theorist ${r.archivist.lastContext.theoristTokens} tok (${r.archivist.lastContext.ratio?.toFixed(1)}x)`);
console.log(`quirks: ${r.quirks.length} (${r.quirks.map((q) => q.hid).join(", ")}) all pending`);
console.log("port history:");
for (const p of r.portHistory) console.log(`  v${p.version} ${p.provider}:${p.model} compile ${p.compileOk ? "ok" : `FAIL(${p.compileErrors})`} agreement-mismatch ${p.agreementMismatches ?? "-"} never-executed ${p.neverExecutedLines ?? "-"} fuzz ${p.fuzzMismatches ?? "-"} held-out ${p.heldoutMismatches ?? "-"} property-fails ${p.propertyFailures ?? "-"}`);
if (r.verify?.properties) console.log(`properties: ${JSON.stringify(r.verify.properties)}`);
if (r.port) console.log(`port v${r.port.version} by ${r.port.provider}:${r.port.model}: agreement ${r.port.agreement?.equal}/${r.port.agreement?.total}; tagged lines never executed ${r.port.lineEvidence?.neverExecuted}/${r.port.lineEvidence?.tagged}`);
if (r.verify) console.log(`verify: fuzz ${r.verify.fuzz.equal}/${r.verify.fuzz.total} | held-out ${(100 * r.verify.heldout.matchRate).toFixed(1)}% | unseen-only ${(100 * r.verify.heldout.unseen.matchRate).toFixed(1)}% (${r.verify.heldout.unseen.equal}/${r.verify.heldout.unseen.total})`);
console.log(`llm: ${r.llm.calls} calls ${JSON.stringify(r.llm.byProvider)}, ${r.llm.providerSwitches} provider switches, ${r.llm.agentErrors} agent errors`);
console.log("written: out/ms.port.ts, out/report.json");
await store.close();
