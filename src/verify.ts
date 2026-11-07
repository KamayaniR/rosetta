// Step 6: Verify. Differential fuzzing (fast-check, fixed seeds) of original vs port, held-out score,
// shrinking of mismatches, and feedback of mismatches as new observations.
// Held-out results live in their own collections and are never put in `observations`, so the Theorist,
// Builder and Archivist never see them.
import fc from "fast-check";
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import { runBatch } from "./sandbox/runner.ts";
import { safeRead } from "./safeRead.ts";
import { compareOutcomes, encode, showOutcome, type Comparison } from "./tagged.ts";
import { transpile } from "./portcheck.ts";
import { trace, TARGET_PATH } from "./tracer.ts";
import { fmtCall } from "./theorist.ts";
import type { CallInput, Outcome, TaggedValue } from "./types.ts";
import type { Port } from "./builder.ts";

// ---------- arbitraries (§7 Step 6) ----------
const UNITS = ["ms", "msec", "msecs", "millisecond", "milliseconds", "s", "sec", "secs", "second", "seconds", "m", "min", "mins",
  "minute", "minutes", "h", "hr", "hrs", "hour", "hours", "d", "day", "days", "w", "week", "weeks", "y", "yr", "yrs", "year", "years",
  "", "x", "fortnight", "mo", "month", "sek", "hs", "mss"];
const caseVariant = (u: string) => fc.constantFrom(u, u.toUpperCase(), u.charAt(0).toUpperCase() + u.slice(1));
const numberText = fc.oneof(
  fc.integer({ min: 0, max: 100000 }).map(String),
  fc.double({ min: 0, max: 10000, noNaN: true, noDefaultInfinity: true }).map((x) => x.toFixed(2)),
  fc.integer({ min: 1, max: 99 }).map((x) => `.${x}`),
  fc.integer({ min: 1, max: 99 }).map((x) => `${x}.`),
  fc.constantFrom("1e3", "0x10", "Infinity", "NaN", "00", "007", "1.5", "2.5", "-0"),
);
const durationString = fc.tuple(
  fc.constantFrom("", "", "", "-", "--", "+", " "),
  numberText,
  fc.constantFrom("", "", " ", "  ", "\t"),
  fc.constantFrom(...UNITS).chain(caseVariant),
  fc.constantFrom("", "", "", "", " ", "x", " 30m"),
).map(([sign, n, sp, u, tail]) => `${sign}${n}${sp}${u}${tail}`);
const oddString = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom("", " ", "   ", "\n", "one hour", "١٢٣", "🚀", "1h 30m", "h", "ms"),
  fc.integer({ min: 95, max: 105 }).map((n) => "1".repeat(n)),
  fc.integer({ min: 95, max: 105 }).map((n) => `${"1".repeat(n - 2)}ms`),
);
const BOUNDARIES = [1000, 60000, 3600000, 86400000, 604800000, 31557600000];
const numberVal = fc.oneof(
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.double({ min: -1e13, max: 1e13, noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom(...BOUNDARIES.flatMap((b) => [b - 1, b, b + 1, 1.5 * b, 1.5 * b - 1, 2.5 * b, -b, -1.5 * b])),
  fc.constantFrom(0, -0, 1, -1, 999, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, 1e21, 1e308, Number.MIN_VALUE, -Number.MIN_VALUE),
);
const otherVal = fc.oneof(fc.constant(null), fc.constant(undefined), fc.boolean(), fc.array(fc.integer(), { maxLength: 3 }), fc.constant({}), fc.constant({ a: 1 }));
const optionsVal = fc.oneof(
  fc.constant(undefined), fc.constant(undefined), fc.constant({ long: true }), fc.constant({ long: false }), fc.constant({}),
  fc.constant({ long: 1 }), fc.constant({ long: "yes" }), fc.constant(null), fc.constant(true), fc.constant("long"),
);
export const callArb = fc.tuple(fc.oneof({ weight: 5, arbitrary: durationString }, { weight: 2, arbitrary: oddString }, { weight: 5, arbitrary: numberVal }, { weight: 1, arbitrary: otherVal }), optionsVal)
  .map(([val, options]): CallInput => ({ val: encode(val), ...(options !== undefined ? { options: encode(options) } : {}) }));

export function sampleInputs(seed: number, n: number): CallInput[] {
  return fc.sample(callArb, { seed, numRuns: n });
}

// ---------- differential run ----------
export type Diff = { input: CallInput; original: Outcome; port: Outcome; cmp: Comparison };

export async function runBoth(portJs: string, inputs: CallInput[]) {
  const original = safeRead(TARGET_PATH);
  const [a, b] = await Promise.all([
    runBatch(original, TARGET_PATH, inputs, { repeats: 1 }),
    runBatch(portJs, "ms.port.js", inputs, { repeats: 1 }),
  ]);
  return inputs.map((input, i) => ({ input, original: a[i].outcome, port: b[i].outcome, cmp: compareOutcomes(a[i].outcome, b[i].outcome) }));
}

// ---------- shrinking (greedy, batched): smaller input that still mismatches with the same severity ----------
function smaller(tv: TaggedValue): TaggedValue[] {
  if (tv.t === "string") {
    const s: string = tv.v, out = new Set<string>();
    if (s.length > 1) { out.add(s.slice(0, Math.ceil(s.length / 2))); out.add(s.slice(Math.floor(s.length / 2))); }
    for (let i = 0; i < s.length && out.size < 40; i++) out.add(s.slice(0, i) + s.slice(i + 1));
    if (s !== s.toLowerCase()) out.add(s.toLowerCase());
    return [...out].filter((x) => x !== s).map((v) => ({ t: "string", v }));
  }
  if (tv.t === "number") {
    const x: number = tv.v, out = new Set<number>([Math.trunc(x), Math.round(x), Math.trunc(x / 2), Math.sign(x) * 10 ** Math.floor(Math.log10(Math.abs(x) || 1))]);
    if (x < 0) out.add(-x);
    out.delete(x);
    return [...out].filter(Number.isFinite).map((v) => encode(v));
  }
  return [];
}

export async function shrink(portJs: string, d: Diff, maxSteps = 12): Promise<Diff> {
  let best = d;
  for (let step = 0; step < maxSteps; step++) {
    const cands: CallInput[] = [
      ...(best.input.options ? [{ val: best.input.val }] : []),
      ...smaller(best.input.val ?? { t: "undefined" }).map((val) => ({ ...best.input, val })),
    ];
    if (!cands.length) break;
    const res = await runBoth(portJs, cands);
    const next = res.find((r) => !r.cmp.equal && r.cmp.severity === best.cmp.severity);
    if (!next) break;
    best = next;
  }
  return best;
}

// ---------- held-out set ----------
const HELDOUT_SEED = 20261107, HELDOUT_SIZE = 500;

async function heldoutInputs(sessionId: string): Promise<CallInput[]> {
  const store = await getStore();
  const [existing] = await store.find<{ inputs: CallInput[] }>("heldout_sets", { sessionId });
  if (existing) return existing.inputs;
  const inputs = sampleInputs(HELDOUT_SEED, HELDOUT_SIZE);
  await store.insertMany("heldout_sets", [{ sessionId, seed: HELDOUT_SEED, size: HELDOUT_SIZE, inputs, createdAt: new Date() }]);
  return inputs;
}

export type VerifyReport = {
  sessionId: string; portVersion: number; createdAt: Date;
  fuzz: { seed: number; total: number; equal: number; low: number; high: number };
  heldout: { seed: number; total: number; equal: number; low: number; high: number; matchRate: number;
    // held-out inputs that appear in NO observation (the strict number); seenElsewhere = also observed via experiments/fuzz
    unseen: { total: number; equal: number; matchRate: number }; seenElsewhere: number };
  mismatches: { phase: "fuzz" | "heldout"; severity: string; call: string; original: string; port: string; reason?: string; shrunk: boolean }[];
  feedbackRunIds: string[];
  feedbackBlocked: number; // fuzz counterexamples not fed back because they equal a held-out input
};

const tally = (ds: Diff[]) => ({
  total: ds.length,
  equal: ds.filter((d) => d.cmp.equal).length,
  low: ds.filter((d) => d.cmp.severity === "low").length,
  high: ds.filter((d) => d.cmp.severity === "high").length,
});

export async function verify(opts: { sessionId: string; fuzzSeed?: number; fuzzRuns?: number; log?: (s: string) => void }): Promise<VerifyReport> {
  const { sessionId } = opts;
  const log = opts.log ?? console.log;
  const store = await getStore();
  const [port] = await store.find<Port>("ports", { sessionId, compileOk: true }, { sort: { version: -1 }, limit: 1 });
  if (!port) throw new Error("no compiling port for this session");
  const portJs = transpile(port.code);
  const fuzzSeed = opts.fuzzSeed ?? Date.now() % 1_000_000;

  const fuzzIn = sampleInputs(fuzzSeed, opts.fuzzRuns ?? 2000);
  const fuzz = await runBoth(portJs, fuzzIn);
  await emit(sessionId, "verify_progress", { phase: "fuzz", ...tally(fuzz) });
  log(`  fuzz (seed ${fuzzSeed}): ${tally(fuzz).equal}/${fuzz.length} equal, ${tally(fuzz).low} low-severity, ${tally(fuzz).high} mismatches`);

  const heldIn = await heldoutInputs(sessionId);
  const heldKeys = new Set(heldIn.map((i) => JSON.stringify(i)));
  const held = await runBoth(portJs, heldIn);
  const ht = tally(held);
  // strict subset: held-out inputs that never occur as an observation input (seeds, experiments, fuzz feedback)
  const obsKeys = new Set((await store.find<{ input: CallInput }>("observations", { sessionId })).map((o) => JSON.stringify(o.input)));
  const unseenRuns = held.filter((d) => !obsKeys.has(JSON.stringify(d.input)));
  const unseen = { total: unseenRuns.length, equal: unseenRuns.filter((d) => d.cmp.equal).length, matchRate: unseenRuns.length ? unseenRuns.filter((d) => d.cmp.equal).length / unseenRuns.length : 0 };
  await emit(sessionId, "verify_progress", { phase: "heldout", ...ht });
  log(`  held-out (seed ${HELDOUT_SEED}): ${ht.equal}/${ht.total} equal (${((100 * ht.equal) / ht.total).toFixed(1)}%), ${ht.low} low, ${ht.high} mismatches; unseen-only ${unseen.equal}/${unseen.total} (${(100 * unseen.matchRate).toFixed(1)}%), ${ht.total - unseen.total} also appear as observations`);

  // shrink distinct fuzz mismatches (dedupe by reason), max 8
  const seenReason = new Set<string>();
  const toShrink = fuzz.filter((d) => !d.cmp.equal).filter((d) => { const k = `${d.cmp.severity}:${d.original.kind}:${d.port.kind}:${d.input.val?.t}`; if (seenReason.has(k)) return false; seenReason.add(k); return true; }).slice(0, 8);
  const shrunk: Diff[] = [];
  for (const d of toShrink) shrunk.push(await shrink(portJs, d));

  const rows: VerifyReport["mismatches"] = [];
  const now = new Date();
  for (const d of shrunk) rows.push({ phase: "fuzz", severity: d.cmp.severity, call: fmtCall(d.input), original: showOutcome(d.original), port: showOutcome(d.port), reason: d.cmp.reason, shrunk: true });
  // held-out mismatches are reported by count + a few examples, but never fed back (they must stay unseen)
  for (const d of held.filter((x) => !x.cmp.equal).slice(0, 5)) rows.push({ phase: "heldout", severity: d.cmp.severity, call: fmtCall(d.input), original: showOutcome(d.original), port: showOutcome(d.port), reason: d.cmp.reason, shrunk: false });
  if (rows.length) {
    await store.insertMany("diff_results", rows.map((r) => ({ sessionId, portVersion: port.version, ...r, createdAt: now })));
    for (const r of rows) await emit(sessionId, "mismatch_found", r);
  }

  // feedback: shrunk FUZZ mismatches become new observations of the original (Step 2 input), never held-out ones
  // A fuzz counterexample identical to a held-out input is reported but NOT fed back (it would leak the held-out set).
  let feedbackRunIds: string[] = [];
  const feedable = shrunk.filter((d) => !heldKeys.has(JSON.stringify(d.input)));
  const feedbackBlocked = shrunk.length - feedable.length;
  if (feedbackBlocked) log(`  ${feedbackBlocked} fuzz counterexample(s) equal a held-out input: reported, not fed back`);
  if (feedable.length) {
    const lastRound = (await store.find<any>("observations", { sessionId }, { sort: { round: -1 }, limit: 1 }))[0]?.round ?? 0;
    const fb = await trace({ sessionId, round: lastRound, source: "fuzz", inputs: feedable.map((d) => d.input) });
    feedbackRunIds = fb.map((o) => o.runId);
  }

  const report: VerifyReport = {
    sessionId, portVersion: port.version, createdAt: now,
    fuzz: { seed: fuzzSeed, ...tally(fuzz) },
    heldout: { seed: HELDOUT_SEED, ...ht, matchRate: ht.equal / ht.total, unseen, seenElsewhere: ht.total - unseen.total },
    mismatches: rows, feedbackRunIds, feedbackBlocked,
  };
  await store.insertMany("verify_reports", [report]);
  await emit(sessionId, "verify_done", { portVersion: port.version, fuzz: report.fuzz, heldout: report.heldout, mismatches: rows.length });
  return report;
}
