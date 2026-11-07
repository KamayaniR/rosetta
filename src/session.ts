import { randomBytes } from "node:crypto";
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import { expandSeeds, generateSeeds } from "./seeds.ts";
import { trace, TARGET_PATH } from "./tracer.ts";
import type { Observation } from "./types.ts";

/** Step 1: new session + seed trace. */
export async function startSession(log: (s: string) => void = console.log): Promise<{ sessionId: string; obs: Observation[] }> {
  const store = await getStore();
  const sessionId = `s_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}_${randomBytes(2).toString("hex")}`;
  await store.insertMany("sessions", [{ sessionId, target: TARGET_PATH, createdAt: new Date(), store: store.kind }]);
  await emit(sessionId, "session_started", { target: TARGET_PATH });
  log(`session ${sessionId} (store: ${store.kind})`);
  const t0 = Date.now();
  const seeds = await generateSeeds(sessionId);
  log(`seeds: ${seeds.inputs.length} from ${seeds.model} (${seeds.dropped} dropped) in ${Date.now() - t0}ms`);
  const obs = await trace({ sessionId, round: 0, source: "seed", inputs: expandSeeds(seeds.inputs) });
  log(`traced ${obs.length} seed observations`);
  return { sessionId, obs };
}
