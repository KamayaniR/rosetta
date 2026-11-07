// Milestone 3: seed (or reuse a session's seeds) then run the hypothesize/experiment loop.
// usage: npm run loop [-- --session <id>] [--rounds 4] [--top 5]
import { parseArgs } from "node:util";
import { getStore } from "../src/store.ts";
import { startSession } from "../src/session.ts";
import { runLoop } from "../src/loop.ts";
import { bus } from "../src/events.ts";

const { values } = parseArgs({ options: { session: { type: "string" }, rounds: { type: "string" }, top: { type: "string" } } });
const store = await getStore();
if (store.warning) console.warn(`WARN ${store.warning}`);

let tokens = { in: 0, out: 0, calls: 0, byProvider: {} as Record<string, number> };
bus.on("event", (e) => {
  if (e.type === "llm_call") {
    const p = e.payload as any;
    tokens.in += p.inputTokens; tokens.out += p.outputTokens; tokens.calls++;
    tokens.byProvider[p.provider] = (tokens.byProvider[p.provider] ?? 0) + 1;
    console.log(`  · ${p.agent} via ${p.provider} ${p.inputTokens}→${p.outputTokens} tok ${p.latencyMs}ms`);
  } else if (e.type === "provider_switched" || e.type === "agent_error") console.log(`  ! ${e.type}`, JSON.stringify(e.payload).slice(0, 200));
});

const sessionId = values.session ?? (await startSession()).sessionId;
const t0 = Date.now();
const res = await runLoop({ sessionId, roundCap: Number(values.rounds ?? 4), topN: Number(values.top ?? 5) });
console.log(`\nledger (${JSON.stringify(res.counts)}), ${((Date.now() - t0) / 1000).toFixed(0)}s, ${tokens.calls} LLM calls ${JSON.stringify(tokens.byProvider)}, ${tokens.in}→${tokens.out} tokens`);
for (const line of res.ledger) console.log(line);
console.log(`\nsession: ${sessionId}`);
await store.close();
