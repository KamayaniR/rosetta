// Skeptic (Gemini, §7 Step 6 property tests). Independent of the Theorist: it sees ONLY proven rule claims and the
// port's public signature, never the Theorist's reasoning, predicates or the code. Each property is an expr
// ({applies, holds}) checked on generated inputs. A property that fails on the ORIGINAL is a wrong property:
// discarded and logged. Properties that hold on the original are then checked on the port.
import { z } from "zod";
import { call } from "./llm.ts";
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import { evalExpr } from "./predicate.ts";
import { listHypotheses } from "./hypotheses.ts";
import type { Observation, Outcome, CallInput } from "./types.ts";

const PropsOut = z.object({
  properties: z.array(z.object({ name: z.string(), description: z.string(), applies: z.string().min(1), holds: z.string().min(1) })).min(1).max(20),
});

const SYSTEM = `You are the Skeptic in Rosetta, an independent verifier. You get behavioral rules that were proven about a function
and the function's public signature. Write general PROPERTIES that should hold for ALL inputs a rule covers, so they can catch a
port that matches the examples but breaks the general behavior. Reply with JSON only.
Each property is {"name","description","applies","holds"}: two JS boolean expressions over val, options, nArgs, out (return value,
undefined if it threw), threw (boolean), error ({name, message} or null). Plain expressions only (no statements, no require).
Example: {"name":"numbers_format_to_strings","description":"finite numbers return a string","applies":"typeof val === 'number' && isFinite(val)","holds":"!threw && typeof out === 'string'"}`;

export type PropertyResult = {
  name: string; description: string; applies: string; holds: string;
  status: "holds" | "wrong_property" | "port_fails" | "invalid" | "vacuous";
  applicable: number; originalFails: string[]; portFails: string[];
};

/** Turn (input, outcome) pairs into Observation-shaped rows so evalExpr can check them. */
function rows(inputs: CallInput[], outs: Outcome[], prefix: string): Observation[] {
  return inputs.map((input, i) => ({ runId: `${prefix}${i}`, input, outcome: outs[i] } as unknown as Observation));
}

export async function propertyTests(sessionId: string, portVersion: number, inputs: CallInput[], original: Outcome[], port: Outcome[]) {
  const hyps = (await listHypotheses(sessionId)).filter((h) => h.status === "proven");
  const user = `Function signature: export default function f(val: unknown, options?: unknown): number | string | undefined

Proven rules:
${hyps.map((h) => `- (${h.category}) ${h.claim}`).join("\n")}

Write 8 to 15 general properties covering these rules. Reply: {"properties":[...]}`;
  const r = await call("skeptic", { system: SYSTEM, user }, PropsOut, { sessionId, temperature: 0.2 });

  const origRows = rows(inputs, original, "o"), portRows = rows(inputs, port, "p");
  const results: PropertyResult[] = r.data.properties.map((p) => {
    const pred = { kind: "expr" as const, applies: p.applies, holds: p.holds };
    const o = evalExpr(pred, origRows);
    if (o.invalid) return { ...p, status: "invalid", applicable: 0, originalFails: [], portFails: [] };
    if (o.applicable === 0) return { ...p, status: "vacuous", applicable: 0, originalFails: [], portFails: [] };
    if (o.fail.length) return { ...p, status: "wrong_property", applicable: o.applicable, originalFails: o.fail.slice(0, 5), portFails: [] };
    const q = evalExpr(pred, portRows);
    return { ...p, status: q.fail.length ? "port_fails" : "holds", applicable: o.applicable, originalFails: [], portFails: q.fail.slice(0, 5) };
  });

  const store = await getStore();
  await store.insertMany("properties", results.map((x) => ({ sessionId, portVersion, ...x, model: `${r.provider}:${r.model}`, createdAt: new Date() })));
  for (const x of results.filter((x) => x.status === "wrong_property")) {
    await emit(sessionId, "property_discarded", { name: x.name, reason: "fails on the original", examples: x.originalFails });
  }
  const summary = {
    model: `${r.provider}:${r.model}`,
    proposed: results.length,
    holds: results.filter((x) => x.status === "holds").length,
    portFails: results.filter((x) => x.status === "port_fails").length,
    wrongProperty: results.filter((x) => x.status === "wrong_property").length,
    invalidOrVacuous: results.filter((x) => x.status === "invalid" || x.status === "vacuous").length,
  };
  await emit(sessionId, "verify_progress", { phase: "property", ...summary });
  return { summary, results };
}
