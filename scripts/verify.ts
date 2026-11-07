// Milestone 5: verify the latest port. usage: npm run verify -- --session <id> [--runs 2000] [--seed N] [--repair]
// --repair: if fuzzing finds mismatches, rebuild the port once with the shrunk counterexamples, then verify again.
import { parseArgs } from "node:util";
import { getStore } from "../src/store.ts";
import { bus } from "../src/events.ts";
import { verify, type VerifyReport } from "../src/verify.ts";
import { build } from "../src/builder.ts";

const { values } = parseArgs({ options: { session: { type: "string" }, runs: { type: "string" }, seed: { type: "string" }, repair: { type: "boolean" } } });
const sessionId = values.session!;
const store = await getStore();
bus.on("event", (e) => {
  if (e.type === "llm_call") { const p = e.payload as any; console.log(`  · ${p.agent} via ${p.provider} ${p.inputTokens}→${p.outputTokens} tok ${p.latencyMs}ms`); }
});
const show = (r: VerifyReport) => {
  console.log(`port v${r.portVersion}: fuzz ${r.fuzz.equal}/${r.fuzz.total} equal | held-out ${(100 * r.heldout.matchRate).toFixed(1)}% (${r.heldout.equal}/${r.heldout.total}, ${r.heldout.low} low, ${r.heldout.high} high)`);
  for (const m of r.mismatches) console.log(`  [${m.phase} ${m.severity}${m.shrunk ? " shrunk" : ""}] ${m.call}\n      original: ${m.original.slice(0, 80)}\n      port:     ${m.port.slice(0, 80)}`);
  if (r.feedbackRunIds.length) console.log(`  fed back as observations: ${r.feedbackRunIds.join(" ")}`);
};

console.log("verify:");
let r = await verify({ sessionId, fuzzRuns: Number(values.runs ?? 2000), fuzzSeed: values.seed ? Number(values.seed) : undefined });
show(r);
const fuzzMiss = r.mismatches.filter((m) => m.phase === "fuzz" && m.severity === "high");
if (values.repair && fuzzMiss.length) {
  console.log("\nrepair: rebuilding port with shrunk counterexamples");
  const feedback = `Differential fuzzing found inputs where your previous port differs from the original. Fix the general logic (do not special-case these inputs):\n${fuzzMiss.map((m) => `- ${m.call}: original ${m.original} | port ${m.port}`).join("\n")}`;
  await build({ sessionId, feedback });
  console.log("verify again:");
  r = await verify({ sessionId, fuzzRuns: Number(values.runs ?? 2000) });
  show(r);
}
await store.close();
