// Step 8 (data part): final session report, assembled only from stored data (never hardcoded).
import { getStore } from "./store.ts";
import { listHypotheses } from "./hypotheses.ts";
import { listQuirks } from "./quirks.ts";
import type { Port } from "./builder.ts";
import type { VerifyReport } from "./verify.ts";

export async function buildReport(sessionId: string) {
  const store = await getStore();
  const hyps = await listHypotheses(sessionId);
  const quirks = await listQuirks(sessionId);
  const ports = await store.find<Port>("ports", { sessionId, compileOk: true }, { sort: { version: 1 } });
  const port = ports[ports.length - 1];
  const firstPort = ports[0];
  const [verify] = await store.find<VerifyReport>("verify_reports", { sessionId }, { sort: { createdAt: -1 }, limit: 1 });
  const events = await store.find<any>("events", { sessionId });
  const obs = await store.find<any>("observations", { sessionId });
  const reviews = events.filter((e) => e.type === "archivist_review").map((e) => e.payload);
  const llm = events.filter((e) => e.type === "llm_call").map((e) => e.payload);
  const findings = await store.find<any>("archivist_findings", { sessionId });

  const count = (xs: { status: string }[]) => xs.reduce<Record<string, number>>((m, h) => ((m[h.status] = (m[h.status] ?? 0) + 1), m), {});
  const byArch = hyps.filter((h) => h.source === "archivist");
  const lastReview = reviews[reviews.length - 1];
  return {
    sessionId,
    generatedAt: new Date(),
    observations: { total: obs.length, bySource: obs.reduce<Record<string, number>>((m, o) => ((m[o.source] = (m[o.source] ?? 0) + 1), m), {}), nondeterministic: obs.filter((o) => o.nondeterministic).length },
    rules: { ...count(hyps), total: hyps.length },
    stillInferred: hyps.filter((h) => h.status === "inferred").map((h) => ({ hid: h.hid, claim: h.claim })),
    archivist: {
      hypotheses: byArch.length, ...Object.fromEntries(Object.entries(count(byArch)).map(([k, v]) => [`hypotheses_${k}`, v])),
      findings: findings.length,
      findingsByType: findings.reduce<Record<string, number>>((m, f) => ((m[f.type] = (m[f.type] ?? 0) + 1), m), {}),
      reviews: reviews.length,
      lastContext: lastReview ? { archivistTokens: lastReview.archivistTokens, theoristTokens: lastReview.theoristTokens, ratio: lastReview.ratio } : null,
    },
    quirks: quirks.map((q) => ({ hid: q.hid, decision: q.decision, claim: q.claim, reason: q.reason })),
    port: port && {
      version: port.version, versions: ports.length,
      agreement: port.agreement,
      lineEvidence: port.evidenceSummary,
      firstPortLineEvidence: firstPort?.evidenceSummary,
    },
    verify: verify && { fuzz: verify.fuzz, heldout: verify.heldout, mismatches: verify.mismatches.length, feedbackBlocked: verify.feedbackBlocked },
    llm: {
      calls: llm.length,
      byProvider: llm.reduce<Record<string, number>>((m, c) => ((m[c.provider] = (m[c.provider] ?? 0) + 1), m), {}),
      inputTokens: llm.reduce((s, c) => s + (c.inputTokens ?? 0), 0),
      outputTokens: llm.reduce((s, c) => s + (c.outputTokens ?? 0), 0),
      providerSwitches: events.filter((e) => e.type === "provider_switched").length,
      agentErrors: events.filter((e) => e.type === "agent_error").length,
    },
  };
}
