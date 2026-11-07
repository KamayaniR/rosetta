// Archivist (SubQ). Job 1: map the minified bundle into code features (mechanical, from the AST) and mark which
// ones real observations executed (instrumented original). Then ONE SubQ Snap decisions request sees the WHOLE
// bundle + the FULL uncompressed history (every observation, every rule with full status history, quirks) and
// judges each feature/rule/category. Findings become hypotheses (source "archivist") or challenges for the loop.
import ts from "ts5";
import { decide, type Answer, type Question } from "./llm.ts";
import { safeRead } from "./safeRead.ts";
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import { instrument, labelKey, type CovPoint } from "./coverage.ts";
import { coverageOf } from "./evidence.ts";
import { listHypotheses } from "./hypotheses.ts";
import { listQuirks } from "./quirks.ts";
import { fmtObs } from "./theorist.ts";
import { targetOf } from "./tracer.ts";
import type { Observation } from "./types.ts";

export type FeatureKind = "case_group" | "branch" | "return" | "throw" | "comparison" | "regex";
export type Feature = { fid: string; kind: FeatureKind; snippet: string; start: number; end: number; exercisedBy: string[] };

export type FindingType = "never_tested" | "unexplained" | "thin_evidence" | "contradiction" | "untested_category";
export type Finding = {
  sessionId: string; round: number; type: FindingType; fid?: string; hid?: string; category?: string;
  detail: string; probability: number; runIds: string[]; next: string; createdAt: Date;
  acted: boolean; // true once the Archivist step turned it into a hypothesis or challenge
};

/** §10a input categories the Archivist checks for coverage. */
export const CATEGORIES: Record<string, string> = {
  unit_short: "strings with a short unit letter other than ms, e.g. '2h', '3d', '1w', '1y', '5m', '10s'",
  unit_long: "strings with long unit words, singular and plural, e.g. '1 hour', '2 days', '3 weeks', '1 year'",
  unit_abbrev: "strings with unit abbreviations like 'hr', 'hrs', 'min', 'mins', 'sec', 'secs', 'yr', 'yrs', 'msec'",
  unit_case: "unit case variants like '1H', '1Hours', '1 DAYS'",
  multi_unit: "strings with several number+unit pairs like '1h 30m'",
  long_string: "strings longer than 100 characters, and exactly 100 vs 101",
  unicode: "unicode digits, emoji or right-to-left text",
  unit_boundaries: "numbers just below/above each unit boundary (999/1000, 59999/60000, 3599999/3600000, 86399999/86400000)",
  plural_threshold: "long format at 1, 1.4, 1.5, 2 units (plural threshold) for seconds, minutes, hours, days",
  hour_format: "numbers in the hour range formatted short and long (e.g. 3600000, 7200000)",
  negative_long: "negative numbers with {long: true}",
  options_types: "options that are not objects (numbers, strings, arrays) or objects with long set to non-boolean values",
};

function containing(points: CovPoint[], start: number, end: number): CovPoint | undefined {
  return points.filter((p) => p.start <= start && p.end >= end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
}

/** Job 1: mechanical bundle map + which features observations executed. */
export async function mapBundle(sessionId: string, obs: Observation[]): Promise<Feature[]> {
  const src = safeRead(await targetOf(sessionId));
  const ins = instrument(src, "target.js");
  const idx = await coverageOf(ins, "target.js", obs);
  const hits = (p?: CovPoint) => (p ? idx.point.get(p.id) ?? [] : []);
  const feats: Omit<Feature, "fid">[] = [];

  // switch case groups (fall-through aliases share one body)
  const groups = new Map<string, typeof ins.labels>();
  for (const l of ins.labels) groups.set(`${l.switchId}:${l.group}`, [...(groups.get(`${l.switchId}:${l.group}`) ?? []), l]);
  for (const ls of groups.values()) {
    const perLabel = ls.map((l) => ({ v: l.value, runs: idx.label.get(labelKey(l)) ?? [] }));
    feats.push({
      kind: "case_group",
      snippet: `case ${ls.map((l) => JSON.stringify(l.value)).join(", ")}  (labels hit: ${perLabel.filter((p) => p.runs.length).map((p) => p.v).join(", ") || "none"})`,
      start: ls[0].start, end: ls[ls.length - 1].end,
      exercisedBy: [...new Set(perLabel.flatMap((p) => p.runs))],
    });
  }
  // returns, throws, branches
  for (const p of ins.points) {
    const s = p.snippet;
    const kind: FeatureKind | null = p.kind === "branch" ? "branch" : /^return\b/.test(s) ? "return" : /^throw\b/.test(s) ? "throw" : null;
    if (kind) feats.push({ kind, snippet: s.slice(0, 80), start: p.start, end: p.end, exercisedBy: hits(p) });
  }
  // comparisons with constants and regex literals
  const sf = ts.createSourceFile("target.js", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const rel = [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken];
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && rel.includes(n.operatorToken.kind)) {
      const start = n.getStart(sf), end = n.getEnd();
      feats.push({ kind: "comparison", snippet: src.slice(start, end).slice(0, 80), start, end, exercisedBy: hits(containing(ins.points, start, end)) });
    }
    if (n.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const start = n.getStart(sf), end = n.getEnd();
      feats.push({ kind: "regex", snippet: src.slice(start, end).slice(0, 200), start, end, exercisedBy: hits(containing(ins.points, start, end)) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  const features = feats.sort((a, b) => a.start - b.start).map((f, i) => ({ ...f, fid: `F${i + 1}` }));
  const store = await getStore();
  await store.insertMany("bundle_maps", [{ sessionId, createdAt: new Date(), features: features.map((f) => ({ ...f, exercisedBy: f.exercisedBy.slice(0, 20), exercisedCount: f.exercisedBy.length })) }]);
  await emit(sessionId, "bundle_mapped", { features: features.length, exercised: features.filter((f) => f.exercisedBy.length).length });
  return features;
}

const p = (a: Answer | undefined, key?: string): number => {
  if (!a) return 0;
  if (a.type === "noul") return a.noul;
  if (a.type === "choice") return key ? a.probabilities?.[key] ?? 0 : a.confidence;
  return a.score;
};

/** Job 1 judgement + Job 2 review in one SubQ request over the full uncompressed context. */
export async function review(sessionId: string, round: number, features: Feature[]) {
  const store = await getStore();
  const obs = await store.find<Observation>("observations", { sessionId }, { sort: { runId: 1 } });
  const hyps = await listHypotheses(sessionId);
  const quirks = await listQuirks(sessionId);
  const live = hyps.filter((h) => h.status !== "disproven");

  const state = {
    task: "Rosetta reverse-engineers a minified JavaScript function f(val, options?) from black-box runs.",
    bundle: safeRead(await targetOf(sessionId)),
    codeFeatures: features.map((f) => ({ fid: f.fid, kind: f.kind, code: f.snippet, executedByRuns: f.exercisedBy.length })),
    ledger: hyps.map((h) => ({ hid: h.hid, status: h.status, confidence: h.confidence, category: h.category, claim: h.claim, evidence: h.evidence, history: h.history })),
    quirks: quirks.map((q) => ({ hid: q.hid, decision: q.decision, reason: q.reason })),
    observations: obs.map(fmtObs),
  };

  const questions: Record<string, Question> = {};
  const ruleOptions: Record<string, string | null> = { none: "No rule in the ledger describes the behavior this code produces" };
  for (const h of live) ruleOptions[h.hid] = null;
  for (const f of features) {
    questions[`explain_${f.fid}`] = {
      type: "choice",
      instructions: `Code feature ${f.fid} (${f.kind}): ${f.snippet}. Which single ledger rule (hid) describes the observable behavior this code produces? Answer "none" if no rule covers it.`,
      criteria: ruleOptions,
    };
  }
  for (const h of live) {
    questions[`thin_${h.hid}`] = {
      type: "score",
      instructions: `How thin is the evidence for rule ${h.hid} ("${h.claim.slice(0, 120)}") in the full history: few supporting runs, only one kind of input, never tested near its edges?`,
      criteria: ["solid", "adequate", "thin"],
    };
    questions[`contra_${h.hid}`] = {
      type: "noul",
      instructions: `Does any observation in the history contradict rule ${h.hid} ("${h.claim.slice(0, 120)}"), or does another ledger rule make an incompatible claim?`,
      criteria: { true: "contradicted", false: "consistent" },
    };
  }
  for (const [k, desc] of Object.entries(CATEGORIES)) {
    questions[`cat_${k}`] = { type: "noul", instructions: `Do the observations include inputs from this category: ${desc}?`, criteria: { true: "tested", false: "never tested" } };
  }

  const r = await decide("archivist", state, questions, { sessionId });
  const A = r.answers;
  const now = new Date();
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, "sessionId" | "round" | "createdAt" | "acted">) => findings.push({ ...f, sessionId, round, createdAt: now, acted: false });

  for (const f of features) {
    const a = A[`explain_${f.fid}`];
    const none = p(a, "none");
    const choice = a?.type === "choice" ? a.choice : "none";
    if (!f.exercisedBy.length) {
      add({ type: "never_tested", fid: f.fid, detail: `${f.kind} never executed by any run: ${f.snippet}${choice !== "none" ? ` (claimed by ${choice})` : ""}`, probability: 1, runIds: [], next: "hypothesis requested from Theorist" });
    } else if (choice === "none" && none >= 0.5) {
      add({ type: "unexplained", fid: f.fid, detail: `${f.kind} executed by ${f.exercisedBy.length} runs but no rule explains it: ${f.snippet}`, probability: none, runIds: f.exercisedBy.slice(0, 5), next: "hypothesis requested from Theorist" });
    }
  }
  for (const h of live) {
    const thin = p(A[`thin_${h.hid}`]);
    if (thin >= 1.5) add({ type: "thin_evidence", hid: h.hid, detail: `${h.hid} rests on thin evidence (${h.evidence.length} runs): ${h.claim}`, probability: thin / 2, runIds: h.evidence.slice(0, 5), next: "challenge queued" });
    const contra = p(A[`contra_${h.hid}`]);
    if (contra >= 0.7) add({ type: "contradiction", hid: h.hid, detail: `${h.hid} may be contradicted: ${h.claim}`, probability: contra, runIds: h.evidence.slice(0, 5), next: "challenge queued" });
  }
  for (const [k, desc] of Object.entries(CATEGORIES)) {
    const tested = p(A[`cat_${k}`]);
    if (tested < 0.3) add({ type: "untested_category", category: k, detail: `never tested: ${desc}`, probability: 1 - tested, runIds: [], next: "hypothesis requested from Theorist" });
  }

  if (findings.length) await store.insertMany("archivist_findings", findings);
  // Context comparison for the UI: Archivist (full history) vs Theorist (rule list + recent observations).
  const events = await store.find<any>("events", { sessionId, type: "llm_call" });
  const theoristTokens = Math.max(0, ...events.filter((e) => e.payload.agent === "theorist").map((e) => e.payload.inputTokens));
  const stats = {
    round, archivistTokens: r.inputTokens, theoristTokens, ratio: theoristTokens ? r.inputTokens / theoristTokens : null,
    runs: obs.length, rules: hyps.length, questions: Object.keys(questions).length, calls: r.calls, model: r.model,
    byType: findings.reduce<Record<string, number>>((m, f) => ((m[f.type] = (m[f.type] ?? 0) + 1), m), {}),
  };
  await emit(sessionId, "archivist_review", stats);
  return { findings, stats, answers: A };
}
