// One Archivist pass inside the loop: re-map coverage, full-history review, act on NEW findings.
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import { mapBundle, review, type Finding } from "./archivist.ts";
import { createHypotheses, listHypotheses, setChallenge, updateHypothesis } from "./hypotheses.ts";
import { evalExpr } from "./predicate.ts";
import { hypothesizeFromFindings } from "./theorist.ts";
import type { Observation } from "./types.ts";

const key = (f: Pick<Finding, "type" | "fid" | "hid" | "category">) => `${f.type}:${f.fid ?? f.hid ?? f.category}`;

/** Returns the number of hypotheses added + challenges queued (0 = nothing new). Never throws (spec: never block the loop). */
export async function archivistStep(sessionId: string, round: number, log: (s: string) => void): Promise<number> {
  try {
    const store = await getStore();
    const obs = await store.find<Observation>("observations", { sessionId });
    // A finding is acted on when first seen; if it is STILL open 2+ rounds after the last attempt, it is re-requested,
    // at most MAX_ATTEMPTS times in total (so persistent gaps get another try but never loop forever).
    const MAX_ATTEMPTS = 2;
    const acted = await store.find<Finding>("archivist_findings", { sessionId, acted: true });
    const attempts = new Map<string, { n: number; last: number }>();
    for (const f of acted) { const a = attempts.get(key(f)) ?? { n: 0, last: -1 }; attempts.set(key(f), { n: a.n + 1, last: Math.max(a.last, f.round) }); }
    const isNew = (f: Finding) => { const a = attempts.get(key(f)); return !a || (a.n < MAX_ATTEMPTS && round - a.last >= 2); };
    const features = await mapBundle(sessionId, obs);
    const { findings, stats } = await review(sessionId, round, features);
    const fresh = findings.filter(isNew);
    log(`  archivist (${stats.model}): ${stats.archivistTokens} tok full history vs theorist ${stats.theoristTokens} tok; ${findings.length} findings, ${fresh.length} new ${JSON.stringify(stats.byType)}`);
    if (!fresh.length) return 0;

    let actedCount = 0;
    const hyps = await listHypotheses(sessionId);
    for (const f of fresh.filter((x) => x.hid && (x.type === "thin_evidence" || x.type === "contradiction"))) {
      const h = hyps.find((x) => x.hid === f.hid);
      if (h && h.status === "proven" && !h.challenge) { await setChallenge(h, { by: "archivist", reason: f.type, round }); actedCount++; }
    }
    const gaps = fresh.filter((x) => x.type === "never_tested" || x.type === "untested_category" || x.type === "unexplained");
    if (gaps.length) {
      const drafts = await hypothesizeFromFindings({ sessionId, round, hypotheses: hyps, findings: gaps });
      // code-reading claims: keep only run IDs that really exist (never mark anything observed without a real run)
      const real = new Set(obs.map((o) => o.runId));
      for (const d of drafts) d.evidence = d.evidence.filter((r) => real.has(r));
      const created = await createHypotheses(sessionId, round + 1, drafts, "archivist", obs);
      for (const h of created) {
        if (h.predicate.kind !== "expr") continue;
        const r = evalExpr(h.predicate, obs);
        if (r.fail.length) await updateHypothesis(h, round + 1, "disproven", 0.05, `contradicted by existing runs ${r.fail.slice(0, 5).join(", ")}`);
      }
      log(`  archivist -> +${created.length} hypotheses (found by Archivist): ${created.map((h) => h.hid).join(", ")}`);
      await emit(sessionId, "archivist_hypotheses", { round, hids: created.map((h) => h.hid), fromFindings: gaps.length });
      actedCount += created.length;
    }
    for (const f of fresh) {
      await store.updateOne("archivist_findings", { sessionId, round, type: f.type, ...(f.fid ? { fid: f.fid } : {}), ...(f.hid ? { hid: f.hid } : {}), ...(f.category ? { category: f.category } : {}) }, { acted: true });
    }
    return actedCount;
  } catch (e: any) {
    log(`  archivist skipped: ${e?.message ?? e}`);
    await emit(sessionId, "agent_error", { agent: "archivist", error: String(e?.message ?? e) });
    return 0;
  }
}
