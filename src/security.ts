// §7d Security pass on top of the trace data. Every finding is stored as a hypothesis with category "security",
// real evidence run IDs and measured numbers, and as a quirk (Security card, suggested action Fix, never auto-fixed).
//  1. ReDoS: length sweep (10..50k chars) of adversarial strings proposed from the bundle's regexes; median of 3 runs
//     per length; flagged only if time grows super-linearly over >= 3 lengths or a call times out.
//  2. Crashes / hangs: any crash or timeout outcome in the observations.
//  3. Dangerous capabilities: sandbox side-effect log (eval/Function/process/require/network/globals).
//  4. Unsafe input acceptance: malformed input silently accepted (Gemini rates risk on proven rules).
import ts from "ts5";
import { z } from "zod";
import { call } from "./llm.ts";
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import { safeRead } from "./safeRead.ts";
import { targetOf, trace } from "./tracer.ts";
import { createHypotheses, listHypotheses, updateHypothesis } from "./hypotheses.ts";
import type { Observation } from "./types.ts";

const LENGTHS = [10, 100, 1000, 10_000, 50_000];
const SWEEP_TIMEOUT_MS = 1000;

export type SweepPoint = { length: number; medianMs: number; samples: number[]; outcome: string; runIds: string[] };
export type Sweep = { regex: string; pattern: { unit: string; prefix: string; suffix: string; why?: string }; points: SweepPoint[]; slope: number | null; flagged: boolean; reason: string };

function regexesIn(src: string): string[] {
  const sf = ts.createSourceFile("t.js", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const out: string[] = [];
  const visit = (n: ts.Node) => { if (n.kind === ts.SyntaxKind.RegularExpressionLiteral) out.push(n.getText(sf)); ts.forEachChild(n, visit); };
  visit(sf);
  return [...new Set(out)];
}

const PatternsOut = z.object({ patterns: z.array(z.object({ unit: z.string().min(1).max(40), prefix: z.string().max(40), suffix: z.string().max(40), why: z.string().optional() })).min(1).max(4) });

/** log-log slope of time vs length over points above the timer noise floor. */
function slopeOf(points: SweepPoint[]): number | null {
  const pts = points.filter((p) => p.medianMs > 0.05);
  if (pts.length < 3) return null;
  const xs = pts.map((p) => Math.log(p.length)), ys = pts.map((p) => Math.log(p.medianMs));
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0), den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return den ? num / den : null;
}

async function redosSweep(sessionId: string, round: number, src: string): Promise<Sweep[]> {
  const sweeps: Sweep[] = [];
  for (const re of regexesIn(src).slice(0, 3)) {
    const r = await call("theorist", {
      system: "You are a security tester. Propose adversarial input strings for regular-expression denial of service (catastrophic backtracking). Reply JSON only.",
      user: `A function passes its string argument to this regex: ${re}\nPropose 2 adversarial patterns as {"unit","prefix","suffix","why"}: the string is prefix + unit repeated N times + suffix, built to maximize backtracking (usually ending with a character that makes the match fail). Reply {"patterns":[...]}`,
    }, PatternsOut, { sessionId, temperature: 0.3 });
    for (const pattern of r.data.patterns) {
      const inputs = LENGTHS.map((len) => {
        const body = pattern.unit.repeat(Math.max(1, Math.ceil((len - pattern.prefix.length - pattern.suffix.length) / pattern.unit.length)));
        return { val: { t: "string" as const, v: (pattern.prefix + body + pattern.suffix).slice(0, Math.max(len, pattern.prefix.length + pattern.suffix.length + 1)) } };
      });
      // 3 separate runs per length (fresh worker each time), median of the per-call times
      const runs: Observation[][] = [];
      for (let k = 0; k < 3; k++) runs.push(await trace({ sessionId, round, source: "experiment", inputs, run: { repeats: 1, callTimeoutMs: SWEEP_TIMEOUT_MS } }));
      const points: SweepPoint[] = LENGTHS.map((length, i) => {
        const samples = runs.map((rs) => rs[i].durationMs).sort((a, b) => a - b);
        return { length, medianMs: samples[1], samples, outcome: runs[0][i].outcome.kind, runIds: runs.map((rs) => rs[i].runId) };
      });
      const slope = slopeOf(points);
      const timedOut = points.some((p) => p.outcome === "timeout");
      // super-linear = slope > 1.3 across >= 3 lengths with growing times (spec: report only what the measurements show)
      const growing = points.slice(1).every((p, i) => p.medianMs >= points[i].medianMs * 0.8);
      const flagged = timedOut || (slope !== null && slope > 1.3 && growing);
      const reason = timedOut ? `timed out (${SWEEP_TIMEOUT_MS} ms) at length ${points.find((p) => p.outcome === "timeout")!.length}`
        : slope === null ? "times stay at the timer noise floor at every length (no growth measurable)"
        : `time ~ length^${slope.toFixed(2)} (${flagged ? "super-linear" : "not super-linear"})`;
      sweeps.push({ regex: re, pattern, points, slope, flagged, reason });
    }
  }
  return sweeps;
}

const RiskOut = z.object({ risks: z.array(z.object({ hid: z.string(), risk: z.enum(["low", "medium", "high"]), reason: z.string(), suggestedFix: z.string() })) });

export async function securityPass(sessionId: string, log: (s: string) => void = console.log) {
  const store = await getStore();
  const src = safeRead(await targetOf(sessionId));
  const round = ((await store.find<any>("observations", { sessionId }, { sort: { round: -1 }, limit: 1 }))[0]?.round ?? 0) + 1;
  const findings: { claim: string; evidence: string[]; measurements: unknown; reason: string; suggestedFix: string }[] = [];

  // 1. ReDoS
  const sweeps = await redosSweep(sessionId, round, src);
  for (const s of sweeps) log(`  ReDoS sweep ${s.regex.slice(0, 40)}… unit ${JSON.stringify(s.pattern.unit)}: ${s.points.map((p) => `${p.length}:${p.medianMs.toFixed(3)}ms`).join(" ")} -> ${s.reason}`);
  for (const s of sweeps.filter((x) => x.flagged)) {
    findings.push({ claim: `Regex ${s.regex.slice(0, 60)} shows super-linear time on ${JSON.stringify(s.pattern.unit)}-repeated input: ${s.reason}`,
      evidence: s.points.flatMap((p) => p.runIds), measurements: { sweep: s.points, slope: s.slope }, reason: "potential ReDoS (denial of service)", suggestedFix: "cap input length before matching or use a linear-time parser" });
  }

  // 2. crashes / hangs, 3. dangerous capabilities (from all observations so far)
  const obs = await store.find<Observation>("observations", { sessionId });
  const bad = obs.filter((o) => o.outcome.kind === "crash" || o.outcome.kind === "timeout");
  if (bad.length) findings.push({ claim: `${bad.length} inputs crash or hang the function (${[...new Set(bad.map((o) => o.outcome.kind))].join(", ")})`, evidence: bad.slice(0, 20).map((o) => o.runId), measurements: { count: bad.length }, reason: "crafted input can crash or hang the caller", suggestedFix: "validate input and fail fast with an error" });
  const fx = obs.filter((o) => o.sideEffects.some((e) => ["process", "require", "fetch", "global", "Buffer", "crypto"].includes(e)));
  if (fx.length) findings.push({ claim: `The function reaches dangerous globals: ${[...new Set(fx.flatMap((o) => o.sideEffects))].join(", ")}`, evidence: fx.slice(0, 20).map((o) => o.runId), measurements: { count: fx.length }, reason: "dangerous capability used", suggestedFix: "remove the capability or isolate it" });

  // 4. unsafe input acceptance: Gemini rates the proven rules (a different model from the Theorist)
  const proven = (await listHypotheses(sessionId)).filter((h) => h.status === "proven" && h.category !== "security");
  try {
    const r = await call("quirk_judge", {
      system: "You are a security reviewer. Rate whether a recovered behavior silently accepts clearly malformed input in a way that could hide bugs or be abused. Most rules are not risky. Reply JSON only.",
      user: `Rules:\n${proven.map((h) => `${h.hid}: ${h.claim}`).join("\n")}\n\nList only rules with medium or high risk: {"risks":[{"hid","risk","reason","suggestedFix"}]} (empty list if none)`,
    }, RiskOut, { sessionId });
    for (const x of r.data.risks.filter((x) => x.risk !== "low")) {
      const h = proven.find((p) => p.hid === x.hid);
      if (h) findings.push({ claim: `Unsafe input acceptance (${x.risk}): ${h.claim}`, evidence: h.evidence.slice(0, 10), measurements: { risk: x.risk, basedOn: h.hid }, reason: x.reason, suggestedFix: x.suggestedFix });
    }
  } catch (e: any) { log(`  risk rating skipped: ${e?.message ?? e}`); }

  // store: hypothesis (category security, real run IDs, measurements) + Security quirk card (pending, suggested Fix)
  const created = await createHypotheses(sessionId, round, findings.map((f) => ({
    claim: f.claim, category: "security" as const, confidence: 0.85, evidence: f.evidence,
    predicate: { kind: "expr" as const, applies: "false", holds: "true" }, // measured finding, not an input/output rule
  })), "theorist");
  const now = new Date();
  for (const h of created) {
    const f = findings.find((x) => x.claim === h.claim)!;
    await store.updateOne("hypotheses", { sessionId, hid: h.hid }, { measurements: f.measurements, isQuirk: true, quirkReason: f.reason, security: true });
    await updateHypothesis(h, round, "proven", 0.95, "measured security finding");
    await store.insertMany("quirks", [{ hid: h.hid, sessionId, claim: h.claim, ruleStatus: "proven", reason: f.reason, suggestedFix: f.suggestedFix, examples: f.evidence.slice(0, 3), decision: "pending", security: true, createdAt: now }]);
    await emit(sessionId, "quirk_detected", { hid: h.hid, reason: f.reason, security: true });
  }
  const report = { sessionId, round, sweeps, findings: created.map((h) => h.hid), crashes: bad.length, dangerous: fx.length, createdAt: now };
  await store.insertMany("security_reports", [report]);
  await emit(sessionId, "security_done", { findings: created.length, sweeps: sweeps.map((s) => ({ regex: s.regex.slice(0, 40), slope: s.slope, flagged: s.flagged, reason: s.reason })) });
  return report;
}
