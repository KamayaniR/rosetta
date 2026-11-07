// Line evidence for a port: which tagged lines actually executed on real observations.
// A tagged line is only "evidenced" if some observation ran it. Never-executed tagged lines are code-only claims.
import { instrument, indexCoverage, labelKey, type CoverageIndex, type Instrumented } from "./coverage.ts";
import { transpile, type TagMap } from "./portcheck.ts";
import { runBatch } from "./sandbox/runner.ts";
import type { Observation } from "./types.ts";

export type LineEvidence = { line: number; hids: string[]; quirks: string[]; executed: boolean | null; runs: string[] };
export type EvidenceSummary = { tagged: number; executed: number; neverExecuted: number; noCode: number; neverLines: number[] };

/** Run instrumented code over observations; returns the coverage index. */
export async function coverageOf(ins: Instrumented, filename: string, obs: Observation[], js = ins.code): Promise<CoverageIndex> {
  const usable = obs.filter((o) => !o.nondeterministic);
  const res = await runBatch(js, filename, usable.map((o) => o.input), { repeats: 1 });
  return indexCoverage(res.map((r, i) => ({ runId: usable[i].runId, cov: r.coverage })));
}

export async function portLineEvidence(code: string, ruleMap: TagMap, obs: Observation[]): Promise<{ lines: LineEvidence[]; summary: EvidenceSummary }> {
  const ins = instrument(code, "ms.port.ts");
  const idx = await coverageOf(ins, "ms.port.js", obs, transpile(ins.code));
  const lines = ruleMap.map((t) => {
    const pts = ins.points.filter((p) => p.line === t.line);
    const labs = ins.labels.filter((l) => l.line === t.line);
    const runs = [...new Set([...pts.flatMap((p) => idx.point.get(p.id) ?? []), ...labs.flatMap((l) => idx.label.get(labelKey(l)) ?? [])])];
    const hasCode = pts.length > 0 || labs.length > 0;
    return { line: t.line, hids: t.hids, quirks: t.quirks.map((q) => q.hid), executed: hasCode ? runs.length > 0 : null, runs: runs.slice(0, 50) };
  });
  const summary: EvidenceSummary = {
    tagged: lines.length,
    executed: lines.filter((l) => l.executed === true).length,
    neverExecuted: lines.filter((l) => l.executed === false).length,
    noCode: lines.filter((l) => l.executed === null).length,
    neverLines: lines.filter((l) => l.executed === false).map((l) => l.line),
  };
  return { lines, summary };
}
