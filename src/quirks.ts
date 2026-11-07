// Step 4 (first part): quirk detection. Gemini judges rules (a different model from the Theorist that formed them).
// Every quirk starts as `pending`, which means Preserve until a human decides in Quirk Court.
import { z } from "zod";
import { call } from "./llm.ts";
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import { listHypotheses, type Hypothesis } from "./hypotheses.ts";

export type Decision = "pending" | "preserve" | "fix" | "flag";
export type Quirk = {
  hid: string;
  sessionId: string;
  claim: string;
  ruleStatus: Hypothesis["status"];
  reason: string;
  suggestedFix: string;
  examples: string[]; // run IDs
  decision: Decision;
  fixSpec?: string;
  decidedAt?: Date;
  createdAt: Date;
};

const JudgeOut = z.object({
  quirks: z.array(z.object({ hid: z.string(), reason: z.string().min(5), suggestedFix: z.string().min(3) })),
});

const SYSTEM = `You are the quirk judge in Rosetta. You get behavioral rules recovered from a black-box JavaScript function.
Flag ONLY rules describing behavior a reasonable developer would find surprising or inconsistent: silent undefined instead of an error,
asymmetric handling of similar inputs, odd rounding, accepting or rejecting unexpected formats, inconsistent error types, etc.
Ordinary, expected behavior is not a quirk. Reply with JSON only.`;

export async function listQuirks(sessionId: string): Promise<Quirk[]> {
  return (await getStore()).find<Quirk>("quirks", { sessionId }, { sort: { hid: 1 } });
}

/** Judge live rules not yet judged. Proven and inferred rules are both judged; ruleStatus tells the UI which. */
export async function detectQuirks(sessionId: string): Promise<Quirk[]> {
  const store = await getStore();
  const existing = new Set((await listQuirks(sessionId)).map((q) => q.hid));
  const rules = (await listHypotheses(sessionId)).filter((h) => h.status !== "disproven" && !existing.has(h.hid));
  if (!rules.length) return [];
  const user = `Rules:\n${rules.map((h) => `${h.hid} [${h.status}] (${h.category}) ${h.claim}`).join("\n")}

For each surprising rule give: hid, reason (one sentence: why it surprises), suggestedFix (one line: the behavior a developer would expect).
Reply: {"quirks":[{"hid","reason","suggestedFix"}]}  (empty list if none)`;
  const r = await call("quirk_judge", { system: SYSTEM, user }, JudgeOut, { sessionId });
  const byId = new Map(rules.map((h) => [h.hid, h]));
  const now = new Date();
  const quirks: Quirk[] = r.data.quirks.filter((q) => byId.has(q.hid) && !existing.has(q.hid)).map((q) => {
    const h = byId.get(q.hid)!;
    return {
      hid: q.hid, sessionId, claim: h.claim, ruleStatus: h.status, reason: q.reason, suggestedFix: q.suggestedFix,
      examples: h.evidence.slice(0, 3), decision: "pending", createdAt: now,
    };
  });
  // de-dupe within the reply
  const seen = new Set<string>();
  const unique = quirks.filter((q) => !seen.has(q.hid) && seen.add(q.hid));
  await store.insertMany("quirks", unique);
  for (const q of unique) {
    await store.updateOne("hypotheses", { sessionId, hid: q.hid }, { isQuirk: true, quirkReason: q.reason });
    await emit(sessionId, "quirk_detected", { hid: q.hid, reason: q.reason, ruleStatus: q.ruleStatus });
  }
  return unique;
}
