// Step 7: behavioral contract. One contract definition per session, used two ways:
//  - rendered to out/contract.test.ts (vitest + fast-check) for developers
//  - evaluated inside the sandbox for "try an AI edit" (pasted code never runs outside the sandbox)
// Fix decisions: the Skeptic (Gemini) turns the one-line fix spec into a checkable predicate; inputs it covers are
// intentional divergences: excluded from equivalence and asserted against the fix instead.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { call } from "./llm.ts";
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import { evalExpr } from "./predicate.ts";
import { compareOutcomes } from "./tagged.ts";
import { compile, transpile } from "./portcheck.ts";
import { runBatch } from "./sandbox/runner.ts";
import { listHypotheses } from "./hypotheses.ts";
import { listQuirks, type Quirk } from "./quirks.ts";
import { fmtCall } from "./theorist.ts";
import type { CallInput, Observation, Outcome } from "./types.ts";

export type Expr = { applies: string; holds: string };
/** Fix predicate. transform: new f(val) must equal ORIGINAL f(transform(val)); expr: new behavior satisfies holds. */
export type FixPred = { kind: "transform"; applies: string; transform: string } | { kind: "expr"; applies: string; holds: string };
export type Example = { runId: string; input: CallInput; expected: Outcome };
export type ContractDef = {
  sessionId: string; portVersion: number | null; createdAt: Date;
  rules: { hid: string; claim: string; category: string; examples: Example[]; property: Expr | null }[];
  quirks: { hid: string; claim: string; decision: string; security: boolean; examples: Example[]; fixSpec: string | null; fixPredicate: FixPred | null; fixedExpected?: (Outcome | null)[] }[];
  snapshot: Example[];
};

const FixOut = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transform"), applies: z.string().min(1), transform: z.string().min(1) }),
  z.object({ kind: z.literal("expr"), applies: z.string().min(1), holds: z.string().min(1) }),
]);

const ENC_SRC = `function __enc(x){ switch (typeof x) { case "undefined": return {t:"undefined"}; case "boolean": return {t:"boolean",v:x};
  case "string": return {t:"string",v:x}; case "bigint": return {t:"bigint",v:String(x)}; case "symbol": return {t:"symbol",v:x.description||""};
  case "function": return {t:"function",v:""}; case "number": if (x !== x) return {t:"nan"}; if (x === Infinity) return {t:"inf"};
  if (x === -Infinity) return {t:"-inf"}; if (x === 0 && 1/x < 0) return {t:"-0"}; return {t:"number",v:x}; }
  if (x === null) return {t:"null"}; if (Array.isArray(x)) return {t:"array",v:x.map(__enc)};
  var o = {}; for (var k in x) o[k] = __enc(x[k]); return {t:"object",v:o}; }`;

/** Apply a transform expression to each input's val inside an isolated vm context (no host objects). */
export function transformInputs(transform: string, inputs: CallInput[]): (CallInput | null)[] {
  const vm = require_vm();
  const src = `"use strict"; ${DECODER_SRC} ${ENC_SRC}
var __t = function (val, options) { return (${transform}); };
var __in = JSON.parse(__data), __out = [];
for (var i = 0; i < __in.length; i++) { try { __out.push(__enc(__t(__dec(__in[i].val), __dec(__in[i].options)))); } catch (e) { __out.push(null); } }
JSON.stringify(__out);`;
  try {
    const sandbox = Object.create(null);
    sandbox.__data = JSON.stringify(inputs);
    const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const out: (any | null)[] = JSON.parse(new vm.Script(src).runInContext(ctx, { timeout: 1000 }));
    return inputs.map((inp, i) => (out[i] ? { ...inp, val: out[i] } : null));
  } catch { return inputs.map(() => null); }
}
import vmMod from "node:vm";
const require_vm = () => vmMod;
const DECODER_SRC = `function __dec(tv){ if(!tv) return undefined; switch(tv.t){ case "undefined": return undefined; case "null": return null;
  case "nan": return NaN; case "inf": return Infinity; case "-inf": return -Infinity; case "-0": return -0; case "bigint": return BigInt(tv.v);
  case "symbol": return Symbol(tv.v); case "function": return function(){}; case "array": return tv.v.map(__dec);
  case "object": { var o = {}; for (var k in tv.v) o[k] = __dec(tv.v[k]); return o; } default: return tv.v; } }`;

/** Expected outcomes under a transform fix: run the ORIGINAL on transform(input). null = transform failed. */
export async function expectedUnderTransform(sessionId: string, transform: string, inputs: CallInput[]): Promise<(Outcome | null)[]> {
  const { safeRead } = await import("./safeRead.ts");
  const { targetOf } = await import("./tracer.ts");
  const target = await targetOf(sessionId);
  const tin = transformInputs(transform, inputs);
  const ok = tin.map((x, i) => [x, i] as const).filter(([x]) => x) as [CallInput, number][];
  const res = ok.length ? await runBatch(safeRead(target), target, ok.map(([x]) => x), { repeats: 1 }) : [];
  const out: (Outcome | null)[] = inputs.map(() => null);
  ok.forEach(([, i], k) => { out[i] = res[k].outcome; });
  return out;
}

/** Skeptic: one-line fix spec -> mechanical predicate. Must apply to the quirk's examples. Cached on the quirk. */
export async function fixPredicate(sessionId: string, q: Quirk, examples: Example[]): Promise<FixPred | null> {
  if ((q as any).fixPredicate) return (q as any).fixPredicate;
  if (!q.fixSpec) return null;
  const user = `A behavior of a function f(val, options?) will be intentionally changed.
Current behavior: ${q.claim}
Examples of current behavior:\n${examples.map((e) => `${fmtCall(e.input)} => ${e.expected.kind === "return" ? JSON.stringify(e.expected.value) : `throws ${e.expected.errorName}`}`).join("\n")}
Intended behavior (fix spec): ${q.fixSpec}

Reply with ONE of two forms (JSON only):
1) {"kind":"transform","applies":"<JS bool over val, options>","transform":"<JS expr over val, options returning the new val>"}
   Use this when the fix normalizes the input and the function should then behave exactly as before
   (e.g. trimming, lower-casing, stripping a prefix). New f(val) must equal ORIGINAL f(transform(val)).
2) {"kind":"expr","applies":"<JS bool>","holds":"<JS bool over val, options, nArgs, out, threw, error>"}
   Use this when the fix changes the output itself (e.g. throw instead of returning undefined).
"applies" selects exactly the inputs this fix changes and must be true for the examples above. Keep it as narrow as the fix spec says; do not widen it.`;
  const r = await call("skeptic", { system: "You turn behavior change requests into precise, testable predicates. Reply JSON only.", user }, FixOut, { sessionId, temperature: 0.1 });
  const rows = examples.map((e) => ({ runId: e.runId, input: e.input, outcome: e.expected } as unknown as Observation));
  const check = evalExpr({ kind: "expr", applies: r.data.applies, holds: "true" }, rows);
  if (check.invalid || check.applicable === 0) return null; // predicate doesn't even cover its own examples
  await (await getStore()).updateOne("quirks", { sessionId, hid: q.hid }, { fixPredicate: r.data });
  return r.data;
}

function examplesOf(runIds: string[], byId: Map<string, Observation>, max = 5): Example[] {
  return runIds.map((r) => byId.get(r)).filter((o): o is Observation => !!o && !o.nondeterministic && (o.outcome.kind === "return" || o.outcome.kind === "throw"))
    .slice(0, max).map((o) => ({ runId: o.runId, input: o.input, expected: o.outcome }));
}

/** Run IDs among the examples that a fix predicate's `applies` selects. */
function applies(e: { applies: string }, ex: Example[]): Set<string> {
  const r = evalExpr({ kind: "expr", applies: e.applies, holds: "true" }, ex.map((x) => ({ runId: x.runId, input: x.input, outcome: x.expected } as unknown as Observation)));
  return new Set(r.invalid ? [] : [...r.pass, ...r.fail]);
}

export async function buildContract(sessionId: string): Promise<ContractDef> {
  const store = await getStore();
  const obs = await store.find<Observation>("observations", { sessionId });
  const byId = new Map(obs.map((o) => [o.runId, o]));
  const hyps = await listHypotheses(sessionId);
  const quirks = await listQuirks(sessionId);
  const [port] = await store.find<any>("ports", { sessionId, compileOk: true }, { sort: { version: -1 }, limit: 1 });

  const qdefs: ContractDef["quirks"] = [];
  for (const q of quirks) {
    const examples = examplesOf(q.examples.length ? q.examples : hyps.find((h) => h.hid === q.hid)?.evidence ?? [], byId, 3);
    const fp = q.decision === "fix" ? await fixPredicate(sessionId, q, examples) : null;
    const fixedExpected = fp?.kind === "transform" ? await expectedUnderTransform(sessionId, fp.transform, examples.map((e) => e.input)) : undefined;
    qdefs.push({ hid: q.hid, claim: q.claim, decision: q.decision, security: !!(q as any).security, examples, fixSpec: q.fixSpec ?? null, fixPredicate: fp, ...(fixedExpected ? { fixedExpected } : {}) });
  }
  const fixes = qdefs.filter((q) => q.decision === "fix" && q.fixPredicate);
  const fixCovered = (ex: Example[]) => new Set(fixes.flatMap((f) => [...applies(f.fixPredicate!, ex)]));

  const rules: ContractDef["rules"] = [];
  for (const h of hyps.filter((x) => x.status === "proven" && x.category !== "security")) {
    let ex = examplesOf(h.evidence, byId);
    const covered = fixCovered(ex);
    ex = ex.filter((e) => !covered.has(e.runId)); // fixed behavior is asserted by the quirk test instead
    const prop = h.predicate.kind === "expr" && h.predicate.applies !== "false" ? { applies: h.predicate.applies, holds: h.predicate.holds } : null;
    if (ex.length || prop) rules.push({ hid: h.hid, claim: h.claim, category: h.category, examples: ex, property: fixes.length ? null : prop });
  }
  // held-out regression snapshot: 200 held-out inputs with the ORIGINAL's outcomes (fix-covered inputs excluded)
  const [held] = await store.find<{ inputs: CallInput[] }>("heldout_sets", { sessionId });
  let snapshot: Example[] = [];
  if (held) {
    const { safeRead } = await import("./safeRead.ts");
    const { targetOf } = await import("./tracer.ts");
    const target = await targetOf(sessionId);
    const ins = held.inputs.slice(0, 200);
    const res = await runBatch(safeRead(target), target, ins, { repeats: 1 });
    snapshot = ins.map((input, i) => ({ runId: `S${i + 1}`, input, expected: res[i].outcome })).filter((e) => e.expected.kind === "return" || e.expected.kind === "throw");
    const covered = fixCovered(snapshot);
    snapshot = snapshot.filter((e) => !covered.has(e.runId));
  }
  const def: ContractDef = { sessionId, portVersion: port?.version ?? null, createdAt: new Date(), rules, quirks: qdefs, snapshot };
  await store.insertMany("contracts", [def]);
  writeContractFile(def);
  await emit(sessionId, "contract_generated", { rules: rules.length, quirks: qdefs.length, snapshot: snapshot.length, fixes: fixes.length });
  return def;
}

// ---------- evaluate a contract against any port source, in the sandbox ----------
export type TestResult = { id: string; kind: "rule" | "property" | "quirk" | "snapshot"; hid?: string; title: string; pass: boolean; failures: string[] };

export async function runContract(def: ContractDef, code: string) {
  const diagnostics = compile(code);
  let js: string;
  try { js = transpile(code); } catch (e: any) { return { compileErrors: diagnostics, results: [] as TestResult[], passed: 0, failed: 0, error: `does not transpile: ${e?.message}` }; }
  const inputs: CallInput[] = [];
  const idx = new Map<string, number>();
  const add = (k: string, input: CallInput) => { if (!idx.has(k)) { idx.set(k, inputs.length); inputs.push(input); } };
  for (const r of def.rules) for (const e of r.examples) add(`${r.hid}:${e.runId}`, e.input);
  for (const q of def.quirks) for (const e of q.examples) add(`${q.hid}:${e.runId}`, e.input);
  for (const e of def.snapshot) add(`snap:${e.runId}`, e.input);
  const res = await runBatch(js, "edited.port.js", inputs, { repeats: 1 });
  const out = (k: string) => res[idx.get(k)!].outcome;
  const show = (o: Outcome) => (o.kind === "return" ? JSON.stringify(o.value?.v ?? o.value?.t) : `${o.kind} ${o.errorName ?? ""}`.trim());
  const results: TestResult[] = [];
  const corpusRows = inputs.map((input, i) => ({ runId: `c${i}`, input, outcome: res[i].outcome } as unknown as Observation));

  for (const r of def.rules) {
    const fails = r.examples.filter((e) => !compareOutcomes(e.expected, out(`${r.hid}:${e.runId}`)).equal)
      .map((e) => `${fmtCall(e.input)}: expected ${show(e.expected)}, got ${show(out(`${r.hid}:${e.runId}`))} (evidence ${e.runId})`);
    if (r.examples.length) results.push({ id: `rule:${r.hid}`, kind: "rule", hid: r.hid, title: `${r.hid} ${r.claim}`, pass: fails.length === 0, failures: fails });
    if (r.property) {
      const p = evalExpr({ kind: "expr", ...r.property }, corpusRows);
      if (!p.invalid && p.applicable) results.push({ id: `prop:${r.hid}`, kind: "property", hid: r.hid, title: `${r.hid} property over ${p.applicable} inputs`, pass: p.fail.length === 0, failures: p.fail.slice(0, 3).map((c) => `${fmtCall(inputs[Number(c.slice(1))])} violates ${r.hid}`) });
    }
  }
  for (const q of def.quirks) {
    const fails: string[] = [];
    if (q.decision === "fix" && q.fixPredicate?.kind === "transform") {
      q.examples.forEach((e, i) => {
        const want = q.fixedExpected?.[i];
        const got = out(`${q.hid}:${e.runId}`);
        if (want && !compareOutcomes(want, got).equal) fails.push(`${fmtCall(e.input)}: fixed behavior should be ${show(want)} (original on ${q.fixPredicate!.kind === "transform" ? q.fixPredicate!.transform : ""}), got ${show(got)}`);
      });
    } else if (q.decision === "fix" && q.fixPredicate?.kind === "expr") {
      const rows = q.examples.map((e) => ({ runId: e.runId, input: e.input, outcome: out(`${q.hid}:${e.runId}`) } as unknown as Observation));
      const p = evalExpr({ kind: "expr", applies: "true", holds: q.fixPredicate.holds }, rows);
      fails.push(...p.fail.map((rid) => `${rid}: fixed behavior not implemented ("${q.fixSpec}")`));
    } else {
      for (const e of q.examples) if (!compareOutcomes(e.expected, out(`${q.hid}:${e.runId}`)).equal) fails.push(`${fmtCall(e.input)}: expected original ${show(e.expected)}, got ${show(out(`${q.hid}:${e.runId}`))}`);
    }
    const label = q.decision === "fix" ? "Fix" : q.decision === "flag" ? "Flag (FLAGGED, original kept)" : q.decision === "pending" ? "Preserve (pending)" : "Preserve";
    results.push({ id: `quirk:${q.hid}`, kind: "quirk", hid: q.hid, title: `${q.security ? "[Security] " : ""}${q.hid} ${label}: ${q.claim}`, pass: fails.length === 0, failures: fails });
  }
  const snapFails = def.snapshot.filter((e) => !compareOutcomes(e.expected, out(`snap:${e.runId}`)).equal);
  results.push({ id: "snapshot", kind: "snapshot", title: `held-out regression snapshot (${def.snapshot.length} inputs)`, pass: snapFails.length === 0, failures: snapFails.slice(0, 5).map((e) => `${fmtCall(e.input)}: expected ${show(e.expected)}, got ${show(out(`snap:${e.runId}`))}`) });
  return { compileErrors: diagnostics, results, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length };
}

// ---------- render the vitest file ----------
export function renderVitest(def: ContractDef): string {
  const J = (x: unknown) => JSON.stringify(x);
  const lines: string[] = [];
  lines.push(`// Behavioral contract generated by Rosetta for session ${def.sessionId} (port v${def.portVersion}).`);
  lines.push(`// Any future change must pass this file. Run: npx vitest run out/contract.test.ts`);
  lines.push(`// Swap the implementation under test with CONTRACT_PORT=/path/to/other.ts`);
  lines.push(`import { describe, it, expect } from "vitest";`);
  lines.push(`import fc from "fast-check";`);
  lines.push(`import defaultPort from "./ms.port.ts";`);
  lines.push(`const f: (...a: unknown[]) => unknown = process.env.CONTRACT_PORT ? (await import(process.env.CONTRACT_PORT)).default : defaultPort;`);
  lines.push(`
type TV = { t: string; v?: any };
const dec = (tv?: TV): unknown => { if (!tv) return undefined; switch (tv.t) {
  case "undefined": return undefined; case "null": return null; case "nan": return NaN; case "inf": return Infinity; case "-inf": return -Infinity; case "-0": return -0;
  case "bigint": return BigInt(tv.v); case "symbol": return Symbol(tv.v); case "function": return () => {}; case "array": return tv.v.map(dec);
  case "object": return Object.fromEntries(Object.entries(tv.v).map(([k, e]) => [k, dec(e as TV)])); default: return tv.v; } };
type In = { val?: TV; options?: TV; extra?: TV[] };
const args = (i: In) => { const a: unknown[] = []; if (i.val) a.push(dec(i.val)); if (i.options || i.extra?.length) { if (!i.val) a.push(undefined); a.push(i.options ? dec(i.options) : undefined); } for (const e of i.extra ?? []) a.push(dec(e)); return a; };
const run = (i: In) => { try { return { threw: false, out: f(...args(i)) as any, error: null as any }; } catch (e: any) { return { threw: true, out: undefined, error: { name: e?.name, message: e?.message } }; } };
const expectOutcome = (i: In, exp: { kind: string; value?: TV; errorName?: string }) => {
  const r = run(i);
  if (exp.kind === "throw") { expect(r.threw).toBe(true); expect(r.error?.name).toBe(exp.errorName); }
  else { expect(r.threw).toBe(false); expect(Object.is(r.out, dec(exp.value)) || r.out === dec(exp.value)).toBe(true); }
};
const nArgs = (i: In) => args(i).length;`);
  // data first: describe() bodies run at collection time
  const corpus = [...def.rules.flatMap((r) => r.examples.map((e) => e.input)), ...def.snapshot.map((e) => e.input)];
  lines.push(`const CORPUS: In[] = ${J(corpus)};`);
  lines.push(`const SNAPSHOT: { label: string; input: In; expected: { kind: string; value?: TV; errorName?: string } }[] = ${J(def.snapshot.map((e) => ({ label: fmtCall(e.input), input: e.input, expected: e.expected })))};`);
  lines.push(`\ndescribe("proven rules", () => {`);
  for (const r of def.rules) {
    lines.push(`  describe(${J(`${r.hid}: ${r.claim}`)}, () => {`);
    for (const e of r.examples) lines.push(`    it(${J(`${fmtCall(e.input)} (evidence ${e.runId})`)}, () => expectOutcome(${J(e.input)}, ${J(e.expected)}));`);
    if (r.property) {
      lines.push(`    it("property holds on the contract corpus", () => fc.assert(fc.property(fc.constantFrom(...CORPUS), (i) => {`);
      lines.push(`      const { out, threw, error } = run(i); const val = dec(i.val), options = dec(i.options), n = nArgs(i);`);
      lines.push(`      if (!((val: any, options: any, nArgs: number, out: any, threw: boolean, error: any) => (${r.property.applies}))(val, options, n, out, threw, error)) return true;`);
      lines.push(`      return ((val: any, options: any, nArgs: number, out: any, threw: boolean, error: any) => (${r.property.holds}))(val, options, n, out, threw, error);`);
      lines.push(`    }), { numRuns: 200 }));`);
    }
    lines.push(`  });`);
  }
  lines.push(`});\n\ndescribe("Quirk Court decisions", () => {`);
  for (const q of def.quirks) {
    const tag = q.decision === "flag" ? " // FLAGGED: original behavior kept, marked for review" : "";
    lines.push(`  describe(${J(`${q.security ? "[Security] " : ""}${q.hid} ${q.decision}: ${q.claim}`)}, () => {${tag}`);
    for (const [k, e] of q.examples.entries()) {
      if (q.decision === "fix" && q.fixPredicate?.kind === "transform" && q.fixedExpected?.[k]) {
        lines.push(`    it(${J(`fixed: ${q.fixSpec} :: ${fmtCall(e.input)}`)}, () => expectOutcome(${J(e.input)}, ${J(q.fixedExpected[k])}));`);
      } else if (q.decision === "fix" && q.fixPredicate?.kind === "expr") {
        lines.push(`    it(${J(`fixed: ${q.fixSpec} :: ${fmtCall(e.input)}`)}, () => { const i = ${J(e.input)}; const { out, threw, error } = run(i);`);
        lines.push(`      expect(((val: any, options: any, nArgs: number, out: any, threw: boolean, error: any) => (${q.fixPredicate.holds}))(dec(i.val), dec(i.options), nArgs(i), out, threw, error)).toBe(true); });`);
      } else lines.push(`    it(${J(`preserved: ${fmtCall(e.input)}`)}, () => expectOutcome(${J(e.input)}, ${J(e.expected)}));`);
    }
    lines.push(`  });`);
  }
  lines.push(`});\n\ndescribe("held-out regression snapshot", () => {`);
  lines.push(`  it.each(SNAPSHOT.map((s) => [s.label, s] as const))("%s", (_l, s) => expectOutcome(s.input, s.expected));`);
  lines.push(`});\n`);
  return lines.join("\n") + "\n";
}

export function writeContractFile(def: ContractDef) {
  const dir = resolve(import.meta.dirname, "..", "out");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "contract.test.ts"), renderVitest(def));
}
