// Step 5: Builder (Muse Spark) writes the TypeScript port from the ledger + quirk decisions + minified code.
// It never sees ground_truth/. Strict compile with up to 3 compiler-error retries; lookup-table lint.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { call } from "./llm.ts";
import { safeRead } from "./safeRead.ts";
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import { listHypotheses, type Hypothesis } from "./hypotheses.ts";
import { listQuirks, type Quirk } from "./quirks.ts";
import { compile, lookupLint, tagMap, transpile, type Diagnostic, type TagMap } from "./portcheck.ts";
import { runBatch } from "./sandbox/runner.ts";
import { compareOutcomes } from "./tagged.ts";
import { targetOf } from "./tracer.ts";
import type { Observation } from "./types.ts";
import { portLineEvidence, type EvidenceSummary, type LineEvidence } from "./evidence.ts";

export type Port = {
  sessionId: string;
  version: number;
  code: string;
  compileOk: boolean;
  diagnostics: Diagnostic[];
  ruleMap: TagMap;
  unknownTags: string[];
  lint: { hits: string[]; ok: boolean };
  attempts: number;
  provider?: string;
  model?: string;
  agreement?: { total: number; equal: number; lowOnly: number; mismatches: string[] };
  lineEvidence?: LineEvidence[];
  evidenceSummary?: EvidenceSummary;
  createdAt: Date;
};

const SYSTEM = `You are the Builder in Rosetta. You write a clean, typed TypeScript port of a JavaScript function whose behavior
was recovered by experiments. You get: the minified original (evidence), a ledger of rules with IDs and status, and quirk decisions.
Requirements:
- One file. \`export default function ms(val: unknown, options?: unknown): number | string | undefined\` (you may narrow internally).
  It must accept ANY arguments without type errors at runtime, exactly like the original.
- Readable: meaningful names, small helper functions, constants for unit sizes. Strict TypeScript, no \`any\`, no imports.
- Reproduce the observed behavior exactly, including errors (same Error type and message) and edge cases.
- Tag code with the rules it implements: put \`// @rule H3, H12\` on the line above each function/branch (or at the end of a line).
  Every branch should carry at least one tag. Only use rule IDs from the ledger.
- Quirks: implement Preserve and Flag (and pending, which means Preserve) EXACTLY as the original behaves, and tag them
  \`// @quirk H29 preserve (pending)\`, \`// @quirk H29 preserve\`, \`// @quirk H29 flag\`; for Fix implement the fix spec and tag \`// @quirk H29 fix\`.
- Never hardcode observed input/output pairs or lookup tables of observed inputs; implement the general logic.
Reply with the complete file in ONE \`\`\`ts code block and nothing else.`;

function fmtRule(h: Hypothesis): string {
  return `${h.hid} [${h.status} ${h.confidence.toFixed(2)}, ${h.evidence.length} runs] (${h.category}) ${h.claim}`;
}
function fmtQuirk(q: Quirk): string {
  const d = q.decision === "pending" ? "pending (= preserve)" : q.decision;
  return `${q.hid} decision: ${d}${q.fixSpec ? `, fix spec: ${q.fixSpec}` : ""} | why surprising: ${q.reason}`;
}

export function extractCode(text: string): string {
  const m = text.match(/```(?:ts|typescript)?\s*\n([\s\S]*?)```/);
  const code = (m ? m[1] : text).trim();
  if (!/export\s+default\s+function/.test(code)) throw new Error("reply must contain the file in a ```ts block with `export default function`");
  return code;
}

async function agreement(code: string, obs: Observation[]): Promise<Port["agreement"]> {
  const usable = obs.filter((o) => !o.nondeterministic);
  const js = transpile(code);
  const res = await runBatch(js, "ms.port.js", usable.map((o) => o.input), { repeats: 1 });
  let equal = 0, lowOnly = 0;
  const mismatches: string[] = [];
  res.forEach((r, i) => {
    const c = compareOutcomes(usable[i].outcome, r.outcome);
    if (c.equal) equal++;
    else if (c.severity === "low") lowOnly++;
    else if (mismatches.length < 25) mismatches.push(usable[i].runId);
  });
  return { total: usable.length, equal, lowOnly, mismatches };
}

export async function build(opts: { sessionId: string; maxRetries?: number; log?: (s: string) => void; feedback?: string }): Promise<Port> {
  const { sessionId } = opts;
  const log = opts.log ?? console.log;
  const maxRetries = opts.maxRetries ?? 3;
  const store = await getStore();
  const target = await targetOf(sessionId);
  const minified = safeRead(target);
  const hyps = await listHypotheses(sessionId);
  const quirks = await listQuirks(sessionId);
  const obs = await store.find<Observation>("observations", { sessionId });
  const live = hyps.filter((h) => h.status !== "disproven");
  const known = new Set(hyps.map((h) => h.hid));

  const baseUser = [
    `Minified original (${target}):\n\`\`\`js\n${minified}\n\`\`\``,
    `Ledger: proven and inferred rules (implement these):\n${live.map(fmtRule).join("\n")}`,
    hyps.some((h) => h.status === "disproven")
      ? `Disproven claims (these are WRONG, do not implement them):\n${hyps.filter((h) => h.status === "disproven").map((h) => `${h.hid}: ${h.claim}`).join("\n")}`
      : "",
    quirks.length ? `Quirk decisions:\n${quirks.map(fmtQuirk).join("\n")}` : "Quirk decisions: none yet.",
    opts.feedback ?? "",
  ].filter(Boolean).join("\n\n");

  let user = baseUser;
  let last: Port | undefined, lastCompiling: Port | undefined;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const r = await call("builder", { system: SYSTEM, user }, extractCode, { sessionId, temperature: 0.1 });
    const code = r.data;
    const diagnostics = compile(code);
    const lint = lookupLint(code, obs);
    const ruleMap = tagMap(code);
    const unknownTags = [...new Set(ruleMap.flatMap((t) => [...t.hids, ...t.quirks.map((q) => q.hid)]).filter((h) => !known.has(h)))];
    const version = (await store.nextSeq(`${sessionId}:port`)) as number;
    const port: Port = {
      sessionId, version, code, compileOk: diagnostics.length === 0, diagnostics, ruleMap, unknownTags, lint, attempts: attempt, provider: r.provider, model: r.model, createdAt: new Date(),
    };
    if (port.compileOk && lint.ok) {
      port.agreement = await agreement(code, obs);
      const ev = await portLineEvidence(code, ruleMap, obs);
      port.lineEvidence = ev.lines;
      port.evidenceSummary = ev.summary;
    }
    await store.insertMany("ports", [port]);
    log(`  port v${version} (${r.provider}:${r.model}): compile ${port.compileOk ? "OK" : `FAIL (${diagnostics.length})`}, lint ${lint.ok ? "OK" : "FAIL"} (${lint.hits.length} observed literals), ${ruleMap.length} tagged lines${unknownTags.length ? `, unknown tags ${unknownTags.join(",")}` : ""}`);
    last = port;
    if (port.compileOk && lint.ok) {
      lastCompiling = port;
      await emit(sessionId, "port_written", { version, attempts: attempt, agreement: port.agreement, taggedLines: ruleMap.length });
      break;
    }
    await emit(sessionId, "port_compile_failed", { version, diagnostics: diagnostics.slice(0, 10), lint });
    const problems = [
      diagnostics.length ? `TypeScript errors (strict):\n${diagnostics.slice(0, 15).map((d) => `line ${d.line}: ${d.message}`).join("\n")}` : "",
      lint.ok ? "" : `Lookup-table lint failed: the port contains ${lint.hits.length} string literals that are observed test inputs (${lint.hits.slice(0, 10).map((s) => JSON.stringify(s)).join(", ")}). Implement general logic instead.`,
    ].filter(Boolean).join("\n\n");
    user = `${baseUser}\n\nYour previous file:\n\`\`\`ts\n${code}\n\`\`\`\n\nIt was rejected:\n${problems}\n\nReply with the corrected complete file in one \`\`\`ts block.`;
  }
  const final = lastCompiling ?? last!;
  if (lastCompiling) {
    const dir = resolve(import.meta.dirname, "..", "out");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "ms.port.ts"), final.code);
  }
  return final;
}
