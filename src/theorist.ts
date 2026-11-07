// Theorist (Muse Spark): hypotheses from observations, and experiments to test them.
import { z } from "zod";
import { call } from "./llm.ts";
import { decode, show, showOutcome } from "./tagged.ts";
import { checkDeclared } from "./declared.ts";
import { CATEGORIES, type Draft, type Hypothesis } from "./hypotheses.ts";
import type { Example } from "./predicate.ts";
import { TAGS, type CallInput, type Observation, type TaggedValue } from "./types.ts";

// ---------- schemas (LLM side) ----------
// LLM-side TaggedValue also allows {t:"string", v, repeat, suffix} so long strings can be written exactly.
const LTV = z.object({ t: z.enum(TAGS), v: z.any().optional(), repeat: z.number().int().min(1).max(20000).optional(), suffix: z.string().optional() });
const LInput = z.object({ val: LTV.optional(), options: LTV.optional(), extra: z.array(LTV).optional() });
const LExpected = z.object({
  kind: z.enum(["return", "throw", "timeout", "crash"]),
  value: LTV.optional(), errorName: z.string().optional(), errorMessage: z.string().optional(),
});
const LPredicate = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("expr"), applies: z.string().min(1), holds: z.string().min(1) }),
  z.object({ kind: z.literal("examples"), examples: z.array(z.object({ input: LInput, expected: LExpected })).min(1).max(10) }),
]);
const LHypothesis = z.object({
  claim: z.string().min(5),
  category: z.enum(CATEGORIES),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).min(1),
  predicate: LPredicate,
  revises: z.string().optional(),
});
const TheorizeOut = z.object({ hypotheses: z.array(LHypothesis).max(15) });
const ExperimentOut = z.object({
  experiments: z.array(z.object({
    hid: z.string(),
    inputs: z.array(z.object({ call: z.string(), input: LInput, expected: LExpected, disproving: z.boolean(), why: z.string().optional() })).min(1).max(8),
  })),
});

// ---------- normalization ----------
function normTV(tv: z.infer<typeof LTV>): TaggedValue {
  if (tv.t === "string" && (tv.repeat || tv.suffix)) {
    return { t: "string", v: String(tv.v ?? "").repeat(tv.repeat ?? 1) + (tv.suffix ?? "") };
  }
  const { repeat: _r, suffix: _s, ...rest } = tv;
  return rest;
}
function normInput(i: z.infer<typeof LInput>): CallInput | null {
  const out: CallInput = {
    ...(i.val ? { val: normTV(i.val) } : {}),
    ...(i.options ? { options: normTV(i.options) } : {}),
    ...(i.extra?.length ? { extra: i.extra.map(normTV) } : {}),
  };
  try {
    for (const tv of [out.val, out.options, ...(out.extra ?? [])]) if (tv) decode(tv, () => null);
    return out;
  } catch { return null; }
}
function normExpected(e: z.infer<typeof LExpected>) {
  return { ...e, ...(e.value ? { value: normTV(e.value) } : {}) };
}

// ---------- prompt formatting ----------
function argShow(tv: TaggedValue): string {
  if (tv.t === "string" && tv.v.length > 60) return `${JSON.stringify(tv.v.slice(0, 24))}…(string of length ${tv.v.length})`;
  return show(tv);
}
/** Human-readable call, always generated from the input that was actually executed. */
export function fmtCall(input: CallInput): string {
  const args: string[] = [];
  if (input.val !== undefined) args.push(argShow(input.val));
  if (input.options !== undefined || input.extra?.length) {
    if (input.val === undefined) args.push("undefined");
    args.push(input.options ? argShow(input.options) : "undefined");
  }
  for (const e of input.extra ?? []) args.push(argShow(e));
  return `f(${args.join(", ")})`;
}
export function fmtObs(o: Observation): string {
  let out = showOutcome(o.outcome);
  if (out.length > 120) out = `${out.slice(0, 110)}…`;
  return `${o.runId} ${fmtCall(o.input)} => ${out}${o.nondeterministic ? " [NONDETERMINISTIC]" : ""}`;
}
export function fmtHyp(h: Hypothesis): string {
  const last = h.history[h.history.length - 1];
  return `${h.hid} [${h.status} ${h.confidence.toFixed(2)}] (${h.category}) ${h.claim}${h.status === "disproven" ? ` | ${last.note}` : ""}`;
}

const SYSTEM = `You are the Theorist in Rosetta. You reverse-engineer a black-box JavaScript function from observed runs.
All that is known up front: "Module exports a single function f(val, options?)."
Rules:
- Every claim must be testable and must cite real run IDs (like "R0012") from the observations shown as evidence. Never invent run IDs.
- Confidence (0..1) must reflect how much evidence you have, not how plausible the claim sounds. Untested generalizations stay below 0.85.
- Prefer one precise rule per claim over vague summaries. Describe observable behavior, not implementation guesses.
- Reply with JSON only.

Predicates make a claim mechanically checkable. Two kinds:
1) {"kind":"expr","applies":"<JS boolean expr>","holds":"<JS boolean expr>"}
   Evaluated for every observation. Variables: val, options (the args; undefined if absent), nArgs (number of args),
   out (return value, undefined if it threw), threw (boolean), error ({name, message} or null).
   "applies" selects the observations the rule is about; "holds" must be true for each of them.
   Example: {"kind":"expr","applies":"typeof val === 'boolean'","holds":"threw && error.name === 'Error'"}
   Only plain JS expressions: no statements, no require, no eval.
2) {"kind":"examples","examples":[{"input":..., "expected":...}]} for rules that are easier to state as cases.

Values are TaggedValues: {"t": tag, "v": value} with tags string, number, undefined, null, nan, inf, -inf, -0, boolean,
bigint (v = decimal string), symbol, function (v = source), array (v = TaggedValue list), object (v = key -> TaggedValue).
For long strings use {"t":"string","v":"a","repeat":101} (and optional "suffix").
An input is {"val"?: TaggedValue, "options"?: TaggedValue, "extra"?: TaggedValue[]}; omit val for a zero-arg call.
An expected outcome is {"kind":"return"|"throw"|"timeout"|"crash", "value"?: TaggedValue, "errorName"?: string}.`;

export async function theorize(args: {
  sessionId: string;
  round: number;
  hypotheses: Hypothesis[];
  observations: Observation[];
  feedback?: string;
}): Promise<{ drafts: Draft[]; contextChars: number }> {
  const disproven = args.hypotheses.filter((h) => h.status === "disproven" && !args.hypotheses.some((x) => x.revises === h.hid));
  const user = [
    `Round ${args.round}.`,
    args.hypotheses.length ? `Current rules (ledger):\n${args.hypotheses.map(fmtHyp).join("\n")}` : "No rules yet.",
    `Observations (${args.observations.length}):\n${args.observations.map(fmtObs).join("\n")}`,
    disproven.length
      ? `These rules were disproven. Propose a revised rule for each one that still makes sense, with "revises": "<hid>":\n${disproven.map((h) => h.hid).join(", ")}`
      : "",
    args.round === 1
      ? "Propose 8 to 15 hypotheses that together explain the observations. Cover parsing, types, errors, formatting and any unit or rounding behavior you see."
      : "Propose new hypotheses only for behavior no current rule explains, plus the revisions above. NEVER restate a rule already in the ledger (proven or inferred), even in different words: duplicates are discarded. An empty list is fine.",
    args.feedback ?? "",
    `Reply: {"hypotheses":[{"claim","category" (one of ${CATEGORIES.join(", ")}),"confidence","evidence":[run IDs],"predicate","revises"?}]}`,
  ].filter(Boolean).join("\n\n");

  const r = await call("theorist", { system: SYSTEM, user }, TheorizeOut, { sessionId: args.sessionId });
  const drafts: Draft[] = [];
  for (const h of r.data.hypotheses) {
    let predicate: Draft["predicate"];
    if (h.predicate.kind === "expr") predicate = h.predicate;
    else {
      const examples: Example[] = [];
      for (const ex of h.predicate.examples) {
        const input = normInput(ex.input);
        if (input) examples.push({ input, expected: normExpected(ex.expected) });
      }
      if (!examples.length) continue;
      predicate = { kind: "examples", examples };
    }
    drafts.push({ claim: h.claim, category: h.category, confidence: h.confidence, evidence: h.evidence, predicate, ...(h.revises ? { revises: h.revises } : {}) });
  }
  return { drafts, contextChars: user.length + SYSTEM.length };
}

export type PlannedInput = { input: CallInput; expected: Example["expected"]; disproving: boolean; why?: string; declared?: string };
export type Experiment = { hid: string; inputs: PlannedInput[] };
export type InvalidExperiment = { hid: string; problems: string[] };

/**
 * Ask the Theorist for experiments. Every input carries a declared call `f(...)` that must match its structured
 * input exactly (checked in a sandbox). An experiment with any mismatching input is returned as invalid, unrun.
 */
export async function designExperiments(args: { sessionId: string; round: number; targets: Hypothesis[]; ledger: Hypothesis[]; feedback?: string }): Promise<{ valid: Experiment[]; invalid: InvalidExperiment[] }> {
  const user = [
    `Round ${args.round}. Design experiments for these rules:`,
    args.targets.map((h) => `${fmtHyp(h)}\n  predicate: ${JSON.stringify(h.predicate).slice(0, 400)}`).join("\n"),
    `Other rules for context:\n${args.ledger.filter((h) => !args.targets.includes(h)).map(fmtHyp).join("\n") || "none"}`,
    `For EACH rule give 3 to 8 NEW inputs with the outcome the rule predicts for each one.
Keep strings short: for long strings ALWAYS use {"t":"string","v":"a","repeat":N}, never write them out.
At least one input per rule must have "disproving": true: an input where, if the rule is wrong, the result would most likely show it (edges, boundaries, near-misses, odd types).
Each input needs "call": the exact JS call it makes, e.g. "f('1h', {long: true})" or "f(1, {}, 2, 3)" or "f('a'.repeat(101))".
"call" and "input" are checked against each other mechanically; if they differ, the experiment is rejected unrun.
Reply: {"experiments":[{"hid","inputs":[{"call","input","expected","disproving","why"}]}]}`,
    args.feedback ?? "",
  ].filter(Boolean).join("\n\n");
  const r = await call("theorist", { system: SYSTEM, user }, ExperimentOut, { sessionId: args.sessionId });
  const wanted = new Set(args.targets.map((h) => h.hid));
  const valid: Experiment[] = [], invalid: InvalidExperiment[] = [];
  for (const e of r.data.experiments.filter((x) => wanted.has(x.hid))) {
    const inputs: PlannedInput[] = [], problems: string[] = [];
    for (const p of e.inputs) {
      const input = normInput(p.input);
      if (!input) { problems.push(`unusable structured input for ${p.call.slice(0, 50)}`); continue; }
      const mismatch = checkDeclared(p.call, input);
      if (mismatch) { problems.push(mismatch); continue; }
      inputs.push({ input, expected: normExpected(p.expected), disproving: p.disproving, why: p.why, declared: p.call });
    }
    if (problems.length || !inputs.length) invalid.push({ hid: e.hid, problems: problems.length ? problems : ["no inputs"] });
    else valid.push({ hid: e.hid, inputs });
  }
  for (const h of args.targets) if (!r.data.experiments.some((x) => x.hid === h.hid)) invalid.push({ hid: h.hid, problems: ["no experiment returned"] });
  return { valid, invalid };
}

const FindingsOut = z.object({ hypotheses: z.array(LHypothesis.extend({ evidence: z.array(z.string()) })).max(15) });

/** Archivist findings -> code-reading hypotheses (evidence may be empty; experiments prove or disprove them next). */
export async function hypothesizeFromFindings(args: {
  sessionId: string; round: number; hypotheses: Hypothesis[]; findings: { type: string; detail: string }[];
}): Promise<Draft[]> {
  const user = [
    `Round ${args.round}. The Archivist (full-history reviewer) reports gaps the current rules never covered:`,
    args.findings.map((f) => `- [${f.type}] ${f.detail}`).join("\n"),
    `Current rules:\n${args.hypotheses.map(fmtHyp).join("\n")}`,
    `Propose testable hypotheses about what f does in these areas (code snippets come from the minified original).
These are code-reading claims: "evidence" may be [] or cite existing run IDs. Each must have a mechanical predicate.
Group related gaps into one rule where natural (e.g. one rule per unit family). Do not restate existing rules.
Reply: {"hypotheses":[{"claim","category","confidence","evidence":[],"predicate"}]}`,
  ].join("\n\n");
  const r = await call("theorist", { system: SYSTEM, user }, FindingsOut, { sessionId: args.sessionId });
  const drafts: Draft[] = [];
  for (const h of r.data.hypotheses) {
    let predicate: Draft["predicate"];
    if (h.predicate.kind === "expr") predicate = h.predicate;
    else {
      const examples: Example[] = [];
      for (const ex of h.predicate.examples) { const input = normInput(ex.input); if (input) examples.push({ input, expected: normExpected(ex.expected) }); }
      if (!examples.length) continue;
      predicate = { kind: "examples", examples };
    }
    drafts.push({ claim: h.claim, category: h.category, confidence: Math.min(0.6, h.confidence), evidence: h.evidence, predicate });
  }
  return drafts;
}
