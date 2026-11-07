// Archivist Job 3 (§7c): final audit of the port before the contract.
// Part 1 (mechanical): every tagged line is checked against the ledger, Quirk Court and line evidence:
//   unknown rule · inferred (unproven) rule · disproven rule · never executed · quirk tag vs decision mismatch,
//   plus executable lines with no tag at all (code with no evidence behind it).
// Part 2 (SubQ, one request): for each tagged rule, "do the lines tagged with it actually implement it?"
import { decide, type Question } from "./llm.ts";
import { getStore } from "./store.ts";
import { emit } from "./events.ts";
import { instrument } from "./coverage.ts";
import { listHypotheses } from "./hypotheses.ts";
import { listQuirks } from "./quirks.ts";
import type { Port } from "./builder.ts";

export type AuditIssue = { line: number; kind: "unknown_rule" | "unproven_rule" | "disproven_rule" | "never_executed" | "quirk_mismatch" | "untagged_code" | "tag_not_implemented"; hids: string[]; detail: string; code: string };

export async function auditPort(sessionId: string, log: (s: string) => void = console.log) {
  const store = await getStore();
  const [port] = await store.find<Port>("ports", { sessionId, compileOk: true }, { sort: { version: -1 }, limit: 1 });
  if (!port) throw new Error("no port to audit");
  const hyps = new Map((await listHypotheses(sessionId)).map((h) => [h.hid, h]));
  const quirks = new Map((await listQuirks(sessionId)).map((q) => [q.hid, q]));
  const lines = port.code.split("\n");
  const ev = new Map((port.lineEvidence ?? []).map((l) => [l.line, l]));
  const issues: AuditIssue[] = [];
  const code = (n: number) => (lines[n - 1] ?? "").trim().slice(0, 100);

  // Part 1a: tagged lines
  for (const t of port.ruleMap) {
    for (const hid of t.hids) {
      const h = hyps.get(hid);
      if (!h) issues.push({ line: t.line, kind: "unknown_rule", hids: [hid], detail: `${hid} is not in the ledger`, code: code(t.line) });
      else if (h.status === "disproven") issues.push({ line: t.line, kind: "disproven_rule", hids: [hid], detail: `${hid} was disproven: ${h.claim.slice(0, 80)}`, code: code(t.line) });
      else if (h.status === "inferred") issues.push({ line: t.line, kind: "unproven_rule", hids: [hid], detail: `${hid} is only inferred: ${h.claim.slice(0, 80)}`, code: code(t.line) });
    }
    if (ev.get(t.line)?.executed === false) issues.push({ line: t.line, kind: "never_executed", hids: t.hids, detail: "no observation executed this tagged line (code-only claim)", code: code(t.line) });
    for (const q of t.quirks) {
      const d = quirks.get(q.hid)?.decision ?? "pending";
      const tagged = q.decision === "pending" ? "preserve" : q.decision;
      const decided = d === "pending" ? "preserve" : d;
      if (quirks.has(q.hid) && tagged !== decided) issues.push({ line: t.line, kind: "quirk_mismatch", hids: [q.hid], detail: `tag says ${q.decision}, Quirk Court decided ${d}`, code: code(t.line) });
    }
  }
  // Part 1b: executable lines with no tag at all
  const tagged = new Set(port.ruleMap.map((t) => t.line));
  const ins = instrument(port.code, "ms.port.ts");
  const codeLines = [...new Set(ins.points.map((p) => p.line))].filter((l) => !tagged.has(l) && !/^\s*(\/\/|\}|$)/.test(lines[l - 1] ?? ""));
  for (const l of codeLines) issues.push({ line: l, kind: "untagged_code", hids: [], detail: "executable line with no @rule tag (no evidence cited)", code: code(l) });

  // Part 2: SubQ judges whether each tagged rule's lines implement it (one request, full port + ledger)
  const byRule = new Map<string, number[]>();
  for (const t of port.ruleMap) for (const hid of t.hids) if (hyps.has(hid)) byRule.set(hid, [...(byRule.get(hid) ?? []), t.line]);
  const rules = [...byRule.keys()].slice(0, 120);
  let subq: { calls: number; inputTokens: number; model: string } | { error: string } = { error: "not run" };
  if (rules.length) {
    const questions: Record<string, Question> = {};
    for (const hid of rules) {
      const h = hyps.get(hid)!;
      const ls = byRule.get(hid)!;
      questions[`impl_${hid}`] = {
        type: "noul",
        instructions: `Rule ${hid}: "${h.claim.slice(0, 160)}". It is tagged on port lines ${ls.slice(0, 12).join(", ")}. Do those lines actually implement this rule's behavior?`,
        criteria: { true: "implemented by the tagged lines", false: "tag is on code that does not implement it" },
      };
    }
    try {
      const r = await decide("archivist", {
        task: "Audit tags in a TypeScript port: does code tagged // @rule Hn implement rule Hn?",
        port: lines.map((l, i) => `${String(i + 1).padStart(3)}  ${l}`).join("\n"),
        ledger: [...hyps.values()].map((h) => ({ hid: h.hid, status: h.status, claim: h.claim })),
        mechanicalIssues: issues.slice(0, 200).map((i) => `${i.kind} line ${i.line}: ${i.detail}`),
      }, questions, { sessionId });
      subq = { calls: r.calls, inputTokens: r.inputTokens, model: r.model };
      for (const hid of rules) {
        const a = r.answers[`impl_${hid}`];
        const p = a && a.type === "noul" ? a.noul : 1;
        if (p < 0.3) issues.push({ line: byRule.get(hid)![0], kind: "tag_not_implemented", hids: [hid], detail: `SubQ: tagged lines likely do not implement ${hid} (p=${p.toFixed(2)})`, code: code(byRule.get(hid)![0]) });
      }
    } catch (e: any) {
      subq = { error: String(e?.message ?? e) }; // never block the contract
      log(`  audit: SubQ check skipped (${subq.error})`);
    }
  }

  const counts = issues.reduce<Record<string, number>>((m, i) => ((m[i.kind] = (m[i.kind] ?? 0) + 1), m), {});
  const report = { sessionId, portVersion: port.version, taggedLines: port.ruleMap.length, rulesChecked: rules.length, counts, issues, subq, createdAt: new Date() };
  await store.insertMany("port_audits", [report]);
  await emit(sessionId, "archivist_audit", { portVersion: port.version, counts, rulesChecked: rules.length });
  log(`  final audit of port v${port.version}: ${port.ruleMap.length} tagged lines, ${rules.length} rules checked by SubQ; ${JSON.stringify(counts)}`);
  return report;
}
