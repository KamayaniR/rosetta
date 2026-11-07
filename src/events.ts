// Event log: every event goes to the store (for replay) and to an in-process bus (for SSE later).
import { EventEmitter } from "node:events";
import { getStore } from "./store.ts";

export type RosettaEvent = { sessionId: string; type: string; payload: unknown; ts: Date };

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export async function emit(sessionId: string, type: string, payload: unknown): Promise<void> {
  const ev: RosettaEvent = { sessionId, type, payload, ts: new Date() };
  bus.emit("event", ev);
  try {
    await (await getStore()).insertMany("events", [ev]);
  } catch (e: any) {
    console.warn(`WARN event not stored: ${e?.message ?? e}`);
  }
}
