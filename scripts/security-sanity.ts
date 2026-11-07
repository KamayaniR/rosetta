// Sanity check for the §7d detector: a deliberately vulnerable module must be flagged; a safe one must not.
import { getStore } from "../src/store.ts";
import { createSession } from "../src/steps.ts";
import { securityPass } from "../src/security.ts";
const store = await getStore();
for (const [name, code] of [
  ["vulnerable /^(a+)+$/", "module.exports = function (s) { return /^(a+)+$/.test(String(s)); };"],
  ["safe /^a+$/", "module.exports = function (s) { return /^a+$/.test(String(s)); };"],
]) {
  const sid = await createSession({ orchestrator: "node", code });
  const r = await securityPass(sid, () => {});
  console.log(`${name.padEnd(22)} findings ${r.findings.length}`);
  for (const s of r.sweeps) console.log(`   ${s.flagged ? "FLAG" : "ok  "} unit ${JSON.stringify(s.pattern.unit)} suffix ${JSON.stringify(s.pattern.suffix)}: ${s.points.map((p) => `${p.length}:${p.outcome === "timeout" ? "TIMEOUT" : p.medianMs.toFixed(2) + "ms"}`).join(" ")} -> ${s.reason}`);
}
await store.close();
