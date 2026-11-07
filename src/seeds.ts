// Step 1: seed inputs. The model is told only the public API; it must not be told what f does.
import { z } from "zod";
import { call } from "./llm.ts";
import { decode } from "./tagged.ts";
import { TAGS, type CallInput, type TaggedValue } from "./types.ts";

const TV = z.object({ t: z.enum(TAGS), v: z.any().optional() });
const SeedSchema = z.object({
  inputs: z.array(z.object({
    val: TV.optional(),
    options: TV.optional(),
    extra: z.array(TV).optional(),
    why: z.string().optional(),
  })).min(20),
});

const SYSTEM = `You are probing an unknown JavaScript module as a black box.
All you know: "Module exports a single function f(val, options?)." Nothing else.
Propose diverse first inputs that will reveal what f does. Reply with JSON only.`;

const USER = `Propose about 60 seed inputs for f. Cover:
- every JS type for val: string, number, undefined, null, boolean, object, array, function, Symbol, BigInt; no arguments at all; extra arguments; options that is not an object
- strings: empty, whitespace only, plain integers, decimals, leading dot, trailing dot, negative, double negative, plus sign, scientific notation, hex, "Infinity", "NaN", numbers followed by letters or words in different cases, with and without spaces/tabs/newlines, multiple number+word pairs, words only, very long strings (around 100 chars and 10000 chars), unicode digits, emoji, right-to-left text, number words
- numbers: 0, -0, 1, -1, small and large integers, powers of ten and values just around them, fractions, x.5 values, negative fractions, Number.MAX_SAFE_INTEGER, 1e21, 1e308, Number.MIN_VALUE, NaN, Infinity, -Infinity

Encode every value as a TaggedValue: {"t": tag, "v": value}
tags: "string" (v = the string), "number" (v = finite number), "undefined", "null", "nan", "inf", "-inf", "-0" (no v),
"boolean" (v = true/false), "bigint" (v = decimal string), "symbol" (v = description), "function" (v = JS source like "function(){return 1}"),
"array" (v = list of TaggedValue), "object" (v = map of key -> TaggedValue).
For very long strings write the full string out.

Each item: {"val"?: TaggedValue, "options"?: TaggedValue, "extra"?: TaggedValue[], "why": "short reason"}.
Omit "val" to call f with no arguments. Omit "options" unless the input is specifically about options.
Reply: {"inputs": [...]}`;

function valid(tv: TaggedValue | undefined): boolean {
  if (!tv) return true;
  try { decode(tv, () => null); return true; } catch { return false; }
}

export async function generateSeeds(sessionId: string): Promise<{ inputs: CallInput[]; dropped: number; model: string }> {
  const r = await call("seeder", { system: SYSTEM, user: USER }, SeedSchema, { sessionId, temperature: 0.7 });
  const seen = new Set<string>();
  const inputs: CallInput[] = [];
  let dropped = 0;
  for (const s of r.data.inputs) {
    const inp: CallInput = {
      ...(s.val ? { val: s.val } : {}),
      ...(s.options ? { options: s.options } : {}),
      ...(s.extra?.length ? { extra: s.extra } : {}),
    };
    const key = JSON.stringify(inp);
    if (!valid(inp.val) || !valid(inp.options) || !(inp.extra ?? []).every(valid) || seen.has(key)) { dropped++; continue; }
    seen.add(key);
    inputs.push(inp);
  }
  return { inputs, dropped, model: `${r.provider}:${r.model}` };
}

/** Spec Step 1: run each seed with options absent and with {long: true} (unless the seed sets options itself). */
export function expandSeeds(seeds: CallInput[]): CallInput[] {
  const LONG: TaggedValue = { t: "object", v: { long: { t: "boolean", v: true } } };
  return seeds.flatMap((s) => (s.options || s.extra ? [s] : [s, { ...s, options: LONG }]));
}
