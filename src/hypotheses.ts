// Hypothesis ledger: storage, evidence validation, status changes.
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import type { Predicate } from "./predicate.ts";

export const CATEGORIES = ["parsing", "units", "rounding", "formatting", "errors", "types"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Status = "inferred" | "proven" | "disproven";

export type HistoryEntry = { round: number; status: Status; confidence: number; note: string };

export type Hypothesis = {
  hid: string;
  sessionId: string;
  claim: string;
  category: Category;
  confidence: number;
  status: Status;
  evidence: string[];
  predicate: Predicate;
  history: HistoryEntry[];
  isQuirk: boolean;
  quirkReason?: string;
  revises?: string;
  source: "theorist" | "archivist";
  createdRound: number;
  testedRounds: number[];
};

export type Draft = Pick<Hypothesis, "claim" | "category" | "confidence" | "evidence" | "predicate"> & { revises?: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Split drafts into valid (all cited run IDs exist) and rejected. */
export async function validateEvidence(sessionId: string, drafts: Draft[]) {
  const store = await getStore();
  const cited = [...new Set(drafts.flatMap((d) => d.evidence))];
  const found = new Set((await store.find<{ runId: string }>("observations", { sessionId, runId: { $in: cited } })).map((o) => o.runId));
  const ok: Draft[] = [], rejected: { draft: Draft; missing: string[] }[] = [];
  for (const d of drafts) {
    const missing = d.evidence.filter((r) => !found.has(r));
    if (d.evidence.length === 0 || missing.length) rejected.push({ draft: d, missing: missing.length ? missing : ["<no evidence>"] });
    else ok.push(d);
  }
  return { ok, rejected };
}

export async function listHypotheses(sessionId: string): Promise<Hypothesis[]> {
  return (await getStore()).find<Hypothesis>("hypotheses", { sessionId }, { sort: { createdRound: 1 } });
}

export async function createHypotheses(sessionId: string, round: number, drafts: Draft[], source: Hypothesis["source"] = "theorist") {
  const store = await getStore();
  const existing = new Set((await listHypotheses(sessionId)).map((h) => norm(h.claim)));
  const fresh = drafts.filter((d) => !existing.has(norm(d.claim)) && existing.add(norm(d.claim)));
  if (!fresh.length) return [];
  const first = await store.nextSeq(`${sessionId}:hyp`, fresh.length);
  const hyps: Hypothesis[] = fresh.map((d, i) => ({
    hid: `H${first + i}`,
    sessionId,
    claim: d.claim,
    category: d.category,
    confidence: Math.min(0.85, Math.max(0, d.confidence)),
    status: "inferred",
    evidence: [...new Set(d.evidence)],
    predicate: d.predicate,
    history: [{ round, status: "inferred", confidence: d.confidence, note: d.revises ? `revision of ${d.revises}` : "proposed" }],
    isQuirk: false,
    ...(d.revises ? { revises: d.revises } : {}),
    source,
    createdRound: round,
    testedRounds: [],
  }));
  await store.insertMany("hypotheses", hyps);
  for (const h of hyps) await emit(sessionId, "hypothesis_created", { hid: h.hid, claim: h.claim, category: h.category, confidence: h.confidence, source });
  return hyps;
}

export async function updateHypothesis(h: Hypothesis, round: number, status: Status, confidence: number, note: string, extraEvidence: string[] = []) {
  const store = await getStore();
  const entry: HistoryEntry = { round, status, confidence, note };
  const evidence = [...new Set([...h.evidence, ...extraEvidence])];
  await store.updateOne("hypotheses", { sessionId: h.sessionId, hid: h.hid },
    { status, confidence, evidence, testedRounds: [...new Set([...h.testedRounds, round])] }, { history: entry });
  Object.assign(h, { status, confidence, evidence });
  h.history.push(entry);
  await emit(h.sessionId, "hypothesis_updated", { hid: h.hid, status, confidence, note, round });
}
