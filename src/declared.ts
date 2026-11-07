// Declared-call cross-check (guards against an experiment whose structured input drifts from its intent).
// The Theorist states each experiment input twice: as a JS call string `f(...)` and as structured TaggedValues.
// We evaluate the call's argument list inside an isolated vm context (null-proto global, no host objects,
// strict mode, no eval) and compare it argument-by-argument with the structured input.
import vm from "node:vm";
import { show, tvEqual } from "./tagged.ts";
import type { CallInput, TaggedValue } from "./types.ts";

const ENC = `function enc(x, seen, depth) {
  switch (typeof x) {
    case "undefined": return { t: "undefined" };
    case "boolean": return { t: "boolean", v: x };
    case "string": return { t: "string", v: x };
    case "bigint": return { t: "bigint", v: String(x) };
    case "symbol": return { t: "symbol", v: x.description === undefined ? "" : x.description };
    case "function": return { t: "function", v: "" };
    case "number":
      if (x !== x) return { t: "nan" };
      if (x === Infinity) return { t: "inf" };
      if (x === -Infinity) return { t: "-inf" };
      if (x === 0 && 1 / x < 0) return { t: "-0" };
      return { t: "number", v: x };
  }
  if (x === null) return { t: "null" };
  if (seen.has(x) || depth > 20) return { t: "string", v: "[circular-or-deep]" };
  seen.add(x);
  if (Array.isArray(x)) { var a = []; for (var i = 0; i < x.length; i++) a.push(enc(x[i], seen, depth + 1)); return { t: "array", v: a }; }
  var o = {}, ks = Object.keys(x);
  for (var k = 0; k < ks.length; k++) o[ks[k]] = enc(x[ks[k]], seen, depth + 1);
  return { t: "object", v: o };
}`;

export function parseDeclared(call: string): { args: TaggedValue[] } | { error: string } {
  const m = call.trim().replace(/;$/, "").match(/^f\s*\(([\s\S]*)\)$/);
  if (!m) return { error: `declared call must look like f(...), got ${call.slice(0, 60)}` };
  const src = `"use strict"; ${ENC}
(function () { var a = [${m[1]}]; var out = []; for (var i = 0; i < a.length; i++) out.push(enc(a[i], new WeakSet(), 0)); return JSON.stringify(out); })()`;
  try {
    const script = new vm.Script(src);
    const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    const json = script.runInContext(ctx, { timeout: 200 }) as string;
    if (json.length > 2_000_000) return { error: "declared args too large" };
    return { args: JSON.parse(json) };
  } catch (e: any) {
    return { error: `declared call does not evaluate: ${e?.message ?? e}` };
  }
}

/** The actual argument list the sandbox passes for a CallInput (same rules as the worker). */
export function argsOf(input: CallInput): TaggedValue[] {
  const args: TaggedValue[] = [];
  if (input.val !== undefined) args.push(input.val);
  if (input.options !== undefined || input.extra?.length) {
    if (input.val === undefined) args.push({ t: "undefined" });
    args.push(input.options ?? { t: "undefined" });
  }
  args.push(...(input.extra ?? []));
  return args;
}

// Functions: only the kind is compared (source text formatting legitimately differs).
function looseEqual(a: TaggedValue, b: TaggedValue): boolean {
  if (a.t === "function" && b.t === "function") return true;
  if (a.t === "array" && b.t === "array") return a.v.length === b.v.length && a.v.every((e: TaggedValue, i: number) => looseEqual(e, b.v[i]));
  if (a.t === "object" && b.t === "object") {
    const ka = Object.keys(a.v), kb = Object.keys(b.v);
    return ka.length === kb.length && ka.every((k) => k in b.v && looseEqual(a.v[k], b.v[k]));
  }
  return tvEqual(a, b);
}

/** null = structured input matches the declared call; otherwise a short reason. */
export function checkDeclared(call: string | undefined, input: CallInput): string | null {
  if (!call) return "missing declared call";
  const parsed = parseDeclared(call);
  if ("error" in parsed) return parsed.error;
  const want = parsed.args, got = argsOf(input);
  if (want.length !== got.length) return `declared ${call.slice(0, 60)} has ${want.length} args, structured input has ${got.length}`;
  for (let i = 0; i < want.length; i++) {
    if (!looseEqual(want[i], got[i])) return `arg ${i + 1}: declared ${show(want[i]).slice(0, 40)}, structured ${show(got[i]).slice(0, 40)}`;
  }
  return null;
}
