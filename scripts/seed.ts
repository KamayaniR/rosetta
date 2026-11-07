// Milestone 2: create a session, get seed inputs from Gemini, trace them, save observations.
import { randomBytes } from "node:crypto";
import { getStore } from "../src/store.ts";
import { emit } from "../src/events.ts";
import { expandSeeds, generateSeeds } from "../src/seeds.ts";
import { trace, TARGET_PATH } from "../src/tracer.ts";
import { show, showOutcome } from "../src/tagged.ts";

const store = await getStore();
if (store.warning) console.warn(`WARN ${store.warning}`);

const sessionId = `s_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}_${randomBytes(2).toString("hex")}`;
await store.insertMany("sessions", [{ sessionId, target: TARGET_PATH, createdAt: new Date(), store: store.kind }]);
await emit(sessionId, "session_started", { target: TARGET_PATH });
console.log(`session ${sessionId} (store: ${store.kind})`);

const t0 = Date.now();
const seeds = await generateSeeds(sessionId);
console.log(`seeds: ${seeds.inputs.length} from ${seeds.model} (${seeds.dropped} dropped as invalid/duplicate) in ${Date.now() - t0}ms`);

const inputs = expandSeeds(seeds.inputs);
const t1 = Date.now();
const obs = await trace({ sessionId, round: 0, source: "seed", inputs });
console.log(`traced ${obs.length} observations (x3 runs each) in ${Date.now() - t1}ms\n`);

const byKind: Record<string, number> = {};
for (const o of obs) byKind[o.outcome.kind] = (byKind[o.outcome.kind] ?? 0) + 1;
console.log("outcomes:", byKind);
console.log("nondeterministic:", obs.filter((o) => o.nondeterministic).length);
console.log("side effects:", [...new Set(obs.flatMap((o) => o.sideEffects))].join(", ") || "none");
console.log("stored:", await store.count("observations", { sessionId }), "\n");

for (const o of obs.slice(0, 20)) {
  const inp = [o.input.val ? show(o.input.val) : "<no args>", o.input.options ? show(o.input.options) : ""].filter(Boolean).join(", ");
  console.log(`${o.runId}  f(${inp.slice(0, 50)})`.padEnd(64), "=>", showOutcome(o.outcome).slice(0, 70));
}
await store.close();
