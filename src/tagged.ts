import type { Outcome, TaggedValue } from "./types.ts";

export function encode(x: unknown, seen = new WeakSet<object>(), depth = 0): TaggedValue {
  switch (typeof x) {
    case "undefined": return { t: "undefined" };
    case "boolean": return { t: "boolean", v: x };
    case "string": return { t: "string", v: x };
    case "bigint": return { t: "bigint", v: x.toString() };
    case "symbol": return { t: "symbol", v: x.description ?? "" };
    case "function": {
      let src = "";
      try { src = Function.prototype.toString.call(x); } catch { src = "[unreadable]"; }
      return { t: "function", v: src };
    }
    case "number":
      if (Number.isNaN(x)) return { t: "nan" };
      if (x === Infinity) return { t: "inf" };
      if (x === -Infinity) return { t: "-inf" };
      if (Object.is(x, -0)) return { t: "-0" };
      return { t: "number", v: x };
    case "object": {
      if (x === null) return { t: "null" };
      if (seen.has(x) || depth > 20) return { t: "string", v: "[circular-or-deep]" };
      seen.add(x);
      if (Array.isArray(x)) return { t: "array", v: x.map((e) => encode(e, seen, depth + 1)) };
      const out: Record<string, TaggedValue> = {};
      for (const k of Object.keys(x)) {
        try { out[k] = encode((x as any)[k], seen, depth + 1); } catch { out[k] = { t: "string", v: "[getter-threw]" }; }
      }
      return { t: "object", v: out };
    }
  }
  return { t: "string", v: String(x) };
}

/** Rebuild a JS value. `mkFn` builds functions (inside a sandbox context, never the host). */
export function decode(tv: TaggedValue, mkFn: (src: string) => unknown = () => { throw new Error("functions not allowed here"); }): unknown {
  switch (tv.t) {
    case "undefined": return undefined;
    case "null": return null;
    case "nan": return NaN;
    case "inf": return Infinity;
    case "-inf": return -Infinity;
    case "-0": return -0;
    case "boolean": if (typeof tv.v !== "boolean") throw new Error("bad boolean"); return tv.v;
    case "string": if (typeof tv.v !== "string") throw new Error("bad string"); return tv.v;
    case "number": if (typeof tv.v !== "number" || !Number.isFinite(tv.v)) throw new Error("bad number"); return tv.v;
    case "bigint": return BigInt(String(tv.v));
    case "symbol": return Symbol(tv.v == null ? undefined : String(tv.v));
    case "function": return mkFn(String(tv.v));
    case "array": if (!Array.isArray(tv.v)) throw new Error("bad array"); return tv.v.map((e: TaggedValue) => decode(e, mkFn));
    case "object": {
      if (!tv.v || typeof tv.v !== "object") throw new Error("bad object");
      const o: Record<string, unknown> = {};
      for (const [k, e] of Object.entries(tv.v)) o[k] = decode(e as TaggedValue, mkFn);
      return o;
    }
  }
  throw new Error(`unknown tag ${(tv as any).t}`);
}

export function tvEqual(a: TaggedValue | undefined, b: TaggedValue | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.t !== b.t) return false;
  switch (a.t) {
    // value-less tags: ignore any stray `v` (LLMs often send {"t":"undefined","v":null})
    case "undefined": case "null": case "nan": case "inf": case "-inf": case "-0": return true;
    case "number": return Object.is(a.v, b.v);
    case "array":
      return a.v.length === b.v.length && a.v.every((e: TaggedValue, i: number) => tvEqual(e, b.v[i]));
    case "object": {
      const ka = Object.keys(a.v), kb = Object.keys(b.v);
      return ka.length === kb.length && ka.every((k) => k in b.v && tvEqual(a.v[k], b.v[k]));
    }
    default: return a.v === b.v;
  }
}

/** Short human-readable form, for prompts and logs. */
export function show(tv: TaggedValue | undefined): string {
  if (!tv) return "<none>";
  switch (tv.t) {
    case "string": return JSON.stringify(tv.v);
    case "number": return String(tv.v);
    case "nan": return "NaN";
    case "inf": return "Infinity";
    case "-inf": return "-Infinity";
    case "-0": return "-0";
    case "undefined": case "null": return tv.t;
    case "boolean": return String(tv.v);
    case "bigint": return `${tv.v}n`;
    case "symbol": return `Symbol(${tv.v})`;
    case "function": return `[function ${String(tv.v).slice(0, 30)}]`;
    case "array": return `[${tv.v.map(show).join(", ")}]`;
    case "object": return `{${Object.entries(tv.v).map(([k, e]) => `${k}: ${show(e as TaggedValue)}`).join(", ")}}`;
  }
  return "?";
}

export function showOutcome(o: Outcome): string {
  switch (o.kind) {
    case "return": return show(o.value);
    case "throw": return o.errorName ? `throws ${o.errorName}: ${o.errorMessage}` : `throws ${show(o.value)}`;
    case "timeout": return "timeout";
    case "crash": return `crash: ${o.errorMessage}`;
  }
}

export type Severity = "none" | "low" | "high";
export type Comparison = { equal: boolean; severity: Severity; reason?: string };

const eq: Comparison = { equal: true, severity: "none" };
const low = (reason: string): Comparison => ({ equal: false, severity: "low", reason });
const high = (reason: string): Comparison => ({ equal: false, severity: "high", reason });

/** Spec §9 equality rules. */
export function compareOutcomes(a: Outcome, b: Outcome): Comparison {
  if (a.kind !== b.kind) return high(`kind ${a.kind} vs ${b.kind}`);
  switch (a.kind) {
    case "timeout": return eq;
    case "crash": return a.errorMessage === b.errorMessage ? eq : low("crash message differs");
    case "throw":
      if (a.errorName !== b.errorName) return high(`error ${a.errorName} vs ${b.errorName}`);
      if (a.errorName === undefined && !tvEqual(a.value, b.value)) return high("thrown value differs");
      return a.errorMessage === b.errorMessage ? eq : low("error message differs");
    case "return": {
      if (tvEqual(a.value, b.value)) return eq;
      const x = a.value!, y = b.value!;
      const zeroish = (t: TaggedValue) => t.t === "-0" || (t.t === "number" && t.v === 0);
      if (zeroish(x) && zeroish(y)) return low("-0 vs 0");
      if (x.t === "number" && y.t === "number") {
        const delta = Math.abs(x.v - y.v);
        const rel = delta / Math.max(Math.abs(x.v), Math.abs(y.v));
        if (rel < 1e-12) return low(`float noise, delta ${delta}`);
      }
      return high(`returned ${show(x)} vs ${show(y)}`);
    }
  }
}
