import { useEffect, useMemo, useState } from "react";
import { API as API_BASE, call, getJSON, outcome, postJSON, type View } from "./timeline";

// ---------- Left: trace inspector ----------
export function TracePanel({ view, evidence }: { view: View; evidence: Set<string> }) {
  const [src, setSrc] = useState("all");
  const [kind, setKind] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(() => {
    let r = view.observations.filter((o) => (src === "all" || o.source === src) && (kind === "all" || o.outcome.kind === kind));
    if (evidence.size) r = [...r.filter((o) => evidence.has(o.runId)), ...r.filter((o) => !evidence.has(o.runId))];
    return r.slice(-600).reverse();
  }, [view.observations, src, kind, evidence]);
  return (
    <div className="panel trace">
      <div className="panel-h"><h3>Trace inspector</h3><span className="muted">{view.observations.length} runs</span></div>
      <div className="chips">
        {["all", "seed", "experiment", "fuzz"].map((s) => <button key={s} className={src === s ? "on" : ""} onClick={() => setSrc(s)}>{s}</button>)}
        <span className="sep" />
        {["all", "return", "throw", "timeout", "crash"].map((k) => <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{k}</button>)}
      </div>
      {evidence.size > 0 && <div className="hint">{evidence.size} runs cited by the selected rule are highlighted</div>}
      <div className="rows">
        {rows.map((o) => (
          <div key={o.runId} className={`row ${evidence.has(o.runId) ? "ev" : ""} k-${o.outcome.kind}`} onClick={() => setOpen(open === o.runId ? null : o.runId)}>
            <span className="rid">{o.runId}</span>
            <span className="call mono">{call(o.input)}</span>
            <span className="out mono">{outcome(o.outcome)}</span>
            <span className={`src s-${o.source}`}>{o.source}{o.round ? ` r${o.round}` : ""}</span>
            {open === o.runId && (
              <div className="detail mono">
                {o.outcome.errorMessage && <div>message: {o.outcome.errorMessage.slice(0, 200)}</div>}
                <div>nondeterministic: {String(o.nondeterministic)} · side effects: {o.sideEffects.join(", ") || "none"}</div>
                <div>cited by: {view.hypotheses.filter((h) => h.evidence.includes(o.runId)).map((h) => h.hid).join(", ") || "none"}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Right: hypotheses ----------
const badge = (s: string) => <span className={`badge b-${s}`}>{s}</span>;

export function HypothesesPanel({ view, selected, onSelect }: { view: View; selected: string[]; onSelect: (h: string[]) => void }) {
  const [filter, setFilter] = useState("all");
  const counts = view.hypotheses.reduce((m: any, h) => ((m[h.status] = (m[h.status] ?? 0) + 1), m), {});
  const list = view.hypotheses.filter((h) => filter === "all" || h.status === filter || (filter === "archivist" && h.source === "archivist"));
  return (
    <div className="panel hyps">
      <div className="panel-h"><h3>Evidence ledger</h3><span className="muted">{counts.proven ?? 0} proven · {counts.inferred ?? 0} inferred · {counts.disproven ?? 0} disproven</span></div>
      <div className="chips">{["all", "proven", "inferred", "disproven", "archivist"].map((f) => <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>)}</div>
      <div className="cards">
        {[...list].reverse().map((h) => (
          <div key={h.hid} className={`card ${selected.includes(h.hid) ? "sel" : ""}`} onClick={() => onSelect([h.hid])}>
            <div className="card-h">
              <b>{h.hid}</b>{badge(h.status)}<span className="cat">{h.category}</span>
              {h.source === "archivist" && <span className="badge b-arch">found by Archivist</span>}
              {h.isQuirk && <span className="badge b-quirk">quirk</span>}
            </div>
            <div className="claim">{h.claim}</div>
            <div className="meta">
              <div className="conf"><div style={{ width: `${Math.round(h.confidence * 100)}%` }} /></div>
              <span>{h.confidence.toFixed(2)}</span><span>{h.evidence.length} runs</span>
              {h.signerName ? <span className={`sig ${h.verified === true ? "ok" : "bad"}`}>signed by {h.signerName} {h.verified === true ? "✓" : "✗"}</span> : <span className="sig gray">unsigned</span>}
            </div>
            {h.status === "disproven" && <div className="note">{h.history[h.history.length - 1]?.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Right: Quirk Court ----------
export function QuirkCourt({ view, sessionId, live, onDecided }: { view: View; sessionId: string; live: boolean; onDecided: () => void }) {
  const [fixing, setFixing] = useState<string | null>(null);
  const [spec, setSpec] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  if (!view.quirks.length) return null;
  const obs = new Map(view.observations.map((o) => [o.runId, o]));
  const decide = async (hid: string, decision: string, fixSpec?: string) => {
    setErr(null);
    try { await postJSON(`/quirks/${hid}/decision`, { sessionId, decision, fixSpec, via: "web" }); setFixing(null); setSpec(""); onDecided(); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="panel court">
      <div className="panel-h"><h3>Quirk Court</h3><span className="muted">pending = preserve</span></div>
      {err && <div className="error small">{err}</div>}
      {live && view.quirks.some((q) => q.decision !== "pending") && (
        <div className="applybar">
          <span className="muted small">{view.quirks.filter((q) => q.decision !== "pending").length} decided · Fix = intentional divergence, asserted by the contract</span>
          <button className="primary" disabled={applying} onClick={async () => { setApplying(true); try { await postJSON(`/sessions/${sessionId}/apply-decisions`, {}); } catch (e: any) { setErr(e.message); } finally { setTimeout(() => { setApplying(false); onDecided(); }, 1500); } }}>{applying ? "Rebuilding…" : "Apply decisions → rebuild port"}</button>
        </div>
      )}
      {view.quirks.map((q) => {
        const hyp = view.hypotheses.find((h) => h.hid === q.hid);
        const security = hyp?.category === "security" || q.security;
        return (
          <div key={q.hid} className={`card quirk ${security ? "security" : ""}`}>
            <div className="card-h"><b>{q.hid}</b>{security && <span className="badge b-sec">Security</span>}<span className={`badge d-${q.decision}`}>{q.decision}</span></div>
            <div className="claim">{q.claim}</div>
            <div className="why">Why surprising: {q.reason}</div>
            <div className="ex mono">{q.examples.map((r: string) => obs.get(r) ? `${r} ${call(obs.get(r)!.input)} → ${outcome(obs.get(r)!.outcome)}` : r).join("\n")}</div>
            {q.fixSpec && <div className="why">Fix spec: {q.fixSpec}</div>}
            {live && (fixing === q.hid ? (
              <div className="fix">
                <input autoFocus placeholder={q.suggestedFix || "one line: intended behavior"} value={spec} onChange={(e) => setSpec(e.target.value)} onKeyDown={(e) => e.key === "Enter" && decide(q.hid, "fix", spec)} />
                <button className="primary" onClick={() => decide(q.hid, "fix", spec)}>Save fix</button>
              </div>
            ) : (
              <div className="actions">
                <button onClick={() => decide(q.hid, "preserve")}>Preserve</button>
                <button className={security ? "primary" : ""} onClick={() => { setFixing(q.hid); setSpec(q.suggestedFix ?? ""); }}>Fix</button>
                <button onClick={() => decide(q.hid, "flag")}>Flag</button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ---------- Lower: agents (Fetch.ai) ----------
const NODES = ["tracer", "theorist", "archivist", "builder", "skeptic"];
export function AgentsPanel({ view, session }: { view: View; session: any }) {
  const msgs = view.agentMessages;
  const last = msgs[msgs.length - 1];
  const pos = (n: string) => {
    if (n === "coordinator") return { x: 150, y: 95 };
    const i = NODES.indexOf(n), a = (-Math.PI / 2) + (i * 2 * Math.PI) / NODES.length;
    return { x: 150 + Math.cos(a) * 105, y: 95 + Math.sin(a) * 75 };
  };
  const models: Record<string, string> = { tracer: "sandbox", theorist: "Muse Spark", archivist: "SubQ Snap", builder: "Muse Spark", skeptic: "Gemini" };
  const fetchMode = session?.orchestrator === "fetch";
  return (
    <div className="panel agents">
      <div className="panel-h"><h3>Agents <span className="muted">Fetch.ai uAgents</span></h3><span className="muted">{fetchMode ? `${msgs.length} signed messages` : "Node orchestrator · entries unsigned (fallback)"}</span></div>
      <div className="agents-body">
        <svg viewBox="0 0 300 190" className="net">
          {NODES.map((n) => {
            const a = pos("coordinator"), b = pos(n);
            const lit = last && [last.fromName, last.toName].includes(n);
            return <line key={n} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={lit ? "edge lit" : "edge"} />;
          })}
          {["coordinator", ...NODES].map((n) => {
            const p = pos(n);
            return (
              <g key={n} transform={`translate(${p.x},${p.y})`}>
                <circle r={n === "coordinator" ? 24 : 20} className={`node ${last && [last.fromName, last.toName].includes(n) ? "lit" : ""}`} />
                <text y={-2} textAnchor="middle" className="nl">{n}</text>
                <text y={9} textAnchor="middle" className="nm">{models[n] ?? "loop"}</text>
              </g>
            );
          })}
        </svg>
        <div className="log">
          {msgs.length === 0 && <div className="muted small">No agent messages{fetchMode ? " yet" : ": this session ran on the Node orchestrator"}.</div>}
          {[...msgs].reverse().slice(0, 60).map((m) => (
            <div key={m.msgId + m.type} className="msg">
              <span className={`sig ${m.verified === true ? "ok" : m.verified === "tampered" ? "bad" : "gray"}`}>{m.verified === true ? "signed ✓" : m.verified === "tampered" ? "tampered" : String(m.verified)}</span>
              <b>{m.fromName}</b> → {m.toName} <span className="mono">{m.type}</span>
              <span className="muted"> {m.summary?.slice(0, 70)}</span>
              <span className="addr mono">{String(m.from).slice(0, 12)}…</span>
            </div>
          ))}
        </div>
      </div>
      <div className="muted small">Skeptic runs on Gemini with its own identity, independent of the Builder; the backend rejects any step signed by the wrong agent.</div>
    </div>
  );
}

// ---------- Lower: Archivist (SubQ) ----------
export function ArchivistPanel({ view }: { view: View }) {
  const r = view.review;
  const arch = view.hypotheses.filter((h) => h.source === "archivist");
  const distinct = new Map(view.findings.map((f) => [`${f.type}:${f.fid ?? f.hid ?? f.category}`, f]));
  const byType = [...distinct.values()].reduce((m: any, f: any) => ((m[f.type] = (m[f.type] ?? 0) + 1), m), {});
  const first = view.ports.find((p: any) => p.evidenceSummary), lastP = view.port;
  const ratio = r?.ratio ? r.ratio : null;
  return (
    <div className="panel archivist">
      <div className="panel-h"><h3>Archivist <span className="muted">SubQ Snap · full history</span></h3><span className="muted">{r ? `review round ${r.round}` : "no review yet"}</span></div>
      <div className="stats">
        <div className="stat"><div className="v">{r ? r.archivistTokens.toLocaleString() : "–"}</div><div className="l">Archivist sees (tokens)<br />{r ? `${r.runs} runs · ${r.rules} rules · ${r.questions} questions` : ""}</div></div>
        <div className="stat"><div className="v">{r ? r.theoristTokens.toLocaleString() : "–"}</div><div className="l">Theorist sees (tokens)<br />rule list + recent runs</div></div>
        <div className="stat"><div className="v">{arch.length}</div><div className="l">Caught only by Archivist<br />{arch.filter((h) => h.status === "proven").length} proven · {byType.never_tested ?? 0} untested code · {byType.untested_category ?? 0} categories · {byType.thin_evidence ?? 0} thin</div></div>
        <div className="stat"><div className="v">{first && lastP ? `${first.evidenceSummary.neverExecuted}→${lastP.evidenceSummary?.neverExecuted ?? "?"}` : "–"}</div><div className="l">Port lines never executed<br />first port → current</div></div>
      </div>
      {ratio && <div className="ratio"><div style={{ width: `${Math.min(100, (1 / ratio) * 100)}%` }} className="t" /><span>{ratio.toFixed(1)}× more evidence in one SubQ request</span></div>}
      <div className="feed">
        {[...view.findings].reverse().slice(0, 30).map((f: any, i: number) => (
          <div key={i} className="finding"><span className={`ft t-${f.type}`}>{f.type.replace("_", " ")}</span> {f.detail.slice(0, 110)} <span className="muted">→ {f.next}</span></div>
        ))}
      </div>
    </div>
  );
}

// ---------- Bottom drawer: verify / port history / report / reveal ----------
export function Drawer({ view, sessionId }: { view: View; sessionId: string }) {
  const [tab, setTab] = useState("verify");
  const [report, setReport] = useState<any>(null);
  const [reveal, setReveal] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const v = view.verify;
  const pct = (x?: number) => (x === undefined ? "–" : `${(x * 100).toFixed(1)}%`);
  const load = async (t: string) => {
    setTab(t); setErr(null);
    try {
      if (t === "report") setReport(await getJSON(`/sessions/${sessionId}/report`));
      if (t === "reveal") setReveal(await getJSON(`/sessions/${sessionId}/reveal`));
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="panel drawer">
      <div className="tabs">
        {["verify", "history", "contract", "report", "reveal"].map((t) => <button key={t} className={tab === t ? "on" : ""} disabled={t === "reveal" && !view.done} onClick={() => load(t)}>{t === "history" ? "port history" : t}</button>)}
      </div>
      {err && <div className="error small">{err}</div>}
      {tab === "verify" && (v ? (
        <div className="verify">
          <Meter label="Fuzz (differential)" n={v.fuzz.equal} d={v.fuzz.total} />
          <Meter label="Held-out (never seen by agents)" n={v.heldout.equal} d={v.heldout.total} />
          <Meter label="Held-out, unseen-only" n={v.heldout.unseen?.equal} d={v.heldout.unseen?.total} />
          <div className="props">
            <b>Skeptic properties</b> {v.properties?.model ? <span className="muted">({v.properties.model})</span> : null}<br />
            {v.properties && "proposed" in v.properties ? `${v.properties.proposed} proposed · ${v.properties.holds} hold on both · ${v.properties.portFails} fail on port · ${v.properties.wrongProperty} wrong (fail on original, discarded)` : v.properties?.error ?? "not run"}
          </div>
          {(v.fuzz.divergences?.total > 0 || v.heldout.divergences?.total > 0) && (
            <div className="props"><b>Intentional divergences (Fix decisions)</b><br />
              fuzz {v.fuzz.divergences.pass}/{v.fuzz.divergences.total} implement the fix · {v.fuzz.divergences.conflicts ?? 0} conflict with another decision · {v.fuzz.divergences.fail} fail · held-out {v.heldout.divergences?.pass ?? 0}/{v.heldout.divergences?.total ?? 0}
              {Object.entries(v.fuzz.divergences.byHid ?? {}).map(([h, b]: any) => <div key={h} className="muted small">{h}: "{b.fixSpec}" · {b.total - b.fail - Object.values(b.conflictsWith ?? {}).reduce((x: number, y: any) => x + y, 0)}/{b.total} implement the fix
                {Object.entries(b.conflictsWith ?? {}).map(([o, n]: any) => <div key={o} className="conflict">Conflict: {h} Fix vs {o} on {n} inputs. The port kept {o}; decide which wins in Quirk Court.</div>)}</div>)}
            </div>
          )}
          <SecuritySummary sessionId={sessionId} />
          <div className="mismatches">
            {v.mismatches.length === 0 ? <div className="muted">No mismatches. Mutation test: planted bugs are caught and shrunk (npm run mutation-test).</div> :
              v.mismatches.map((m: any, i: number) => <div key={i} className="mono small">[{m.phase} {m.severity}] {m.call}: original {m.original} · port {m.port}</div>)}
          </div>
        </div>
      ) : <div className="muted">Verify runs after the port is written.</div>)}
      {tab === "history" && (
        <table className="hist">
          <thead><tr><th>port</th><th>model</th><th>compile</th><th>agreement mismatches</th><th>never-executed lines</th><th>fuzz mismatches</th><th>held-out mismatches</th></tr></thead>
          <tbody>{view.ports.map((p: any) => {
            const vv = view.verifies.filter((x: any) => x.portVersion === p.version).pop();
            return <tr key={p.version}><td>v{p.version}</td><td>{p.provider}:{p.model}</td><td>{p.compileOk ? "ok" : `fail (${p.diagnostics?.length})`}</td><td>{p.agreement ? p.agreement.total - p.agreement.equal : "–"}</td><td>{p.evidenceSummary?.neverExecuted ?? "–"}</td><td>{vv ? vv.fuzz.high : "–"}</td><td>{vv ? vv.heldout.high : "–"}</td></tr>;
          })}</tbody>
        </table>
      )}
      {tab === "contract" && <ContractTab sessionId={sessionId} port={view.port} />}
      {tab === "report" && report && (
        <div className="report">
          <div><b>Rules</b> {JSON.stringify(report.rules)} · <b>observations</b> {report.observations.total}</div>
          <div><b>Archivist</b> {report.archivist.hypotheses} hypotheses · distinct findings {JSON.stringify(report.archivist.findingsByType)} · open now {JSON.stringify(report.archivist.openNow)}</div>
          <div><b>Quirks</b> {report.quirks.map((q: any) => `${q.hid}=${q.decision}`).join(", ") || "none"} · intentional divergences: {report.quirks.filter((q: any) => q.decision === "fix").map((q: any) => q.hid).join(", ") || "none"}</div>
          {report.port && <div><b>Port</b> v{report.port.version} by {report.port.provider}:{report.port.model} · agreement {report.port.agreement?.equal}/{report.port.agreement?.total}</div>}
          {report.verify && <div><b>Verify</b> fuzz {report.verify.fuzz.equal}/{report.verify.fuzz.total} · held-out {pct(report.verify.heldout.matchRate)} · unseen-only {pct(report.verify.heldout.unseen?.matchRate)}</div>}
          <div><b>Still inferred</b> {report.stillInferred.map((h: any) => h.hid).join(", ") || "none"}</div>
          <div><b>Models</b> {report.llm.calls} calls {JSON.stringify(report.llm.byProvider)} · {report.llm.providerSwitches} fallbacks · {report.llm.agentErrors} agent errors</div>
        </div>
      )}
      {tab === "reveal" && reveal && (
        <div className="reveal">
          <div><h4>Original source (ground_truth/, never shown to agents)</h4><pre className="mono">{reveal.original}</pre></div>
          <div><h4>Recovered port</h4><pre className="mono">{reveal.port}</pre></div>
        </div>
      )}
    </div>
  );
}

function Meter({ label, n, d }: { label: string; n?: number; d?: number }) {
  const p = n !== undefined && d ? n / d : 0;
  return <div className="meter"><div className="ml">{label}</div><div className="mb"><div style={{ width: `${p * 100}%` }} /></div><div className="mv">{d ? `${n}/${d} · ${(p * 100).toFixed(1)}%` : "–"}</div></div>;
}

function SecuritySummary({ sessionId }: { sessionId: string }) {
  const [r, setR] = useState<any>(null);
  useEffect(() => { getJSON(`/sessions/${sessionId}/report`).then((x) => setR(x.security)).catch(() => {}); }, [sessionId]);
  if (!r) return null;
  return (
    <div className="props"><b>Security pass (§7d)</b> · {r.findings.length} findings · crashes/hangs {r.crashesOrHangs} · dangerous capability uses {r.dangerousCapabilityUses}
      {r.redos.map((x: any, i: number) => <div key={i} className="mono small">{x.flagged ? "FLAG" : "ok"} ReDoS sweep unit {JSON.stringify(x.unit)}: {x.points.map((p: any) => `${p[0]}:${p[2] === "timeout" ? "TIMEOUT" : p[1] + "ms"}`).join(" ")} → {x.reason}</div>)}
    </div>
  );
}

function ContractTab({ sessionId, port }: { sessionId: string; port: any }) {
  const [c, setC] = useState<any>(null);
  const [code, setCode] = useState<string>(port?.code ?? "");
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { getJSON(`/sessions/${sessionId}/contract`).then(setC).catch((e) => setErr(String(e))); }, [sessionId]);
  const run = async () => { setBusy(true); setErr(null); try { setRes(await postJSON(`/sessions/${sessionId}/contract/run`, { code })); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  return (
    <div className="contract">
      <div>
        {c && <div><b>Contract</b> for port v{c.portVersion}: {c.rules.length} proven-rule groups ({c.rules.reduce((n: number, r: any) => n + r.examples.length, 0)} examples, {c.rules.filter((r: any) => r.property).length} properties) · {c.quirks.length} Quirk Court tests ({c.quirks.map((q: any) => `${q.hid}=${q.decision}`).join(", ")}) · held-out snapshot {c.snapshot.length}</div>}
        <a href={`${API_BASE}/sessions/${sessionId}/contract.test.ts`} target="_blank" rel="noreferrer">Download contract.test.ts (vitest + fast-check)</a>
        <h4>Try an AI edit</h4>
        <div className="muted small">Paste a modified port. The contract runs against it inside the sandbox and names every rule it breaks.</div>
        <textarea className="mono" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} />
        <div className="actions"><button className="primary" disabled={busy || !code} onClick={run}>{busy ? "Running…" : "Run contract"}</button><button onClick={() => { setCode(port?.code ?? ""); setRes(null); }}>Reset to port</button></div>
        {err && <div className="error small">{err}</div>}
      </div>
      <div className="results">
        {res && <div className={res.failed ? "bad" : "good"}><b>{res.failed ? `BLOCKED: ${res.failed} contract tests fail` : `PASS: all ${res.passed} contract tests`}</b>{res.compileErrors?.length ? ` · ${res.compileErrors.length} TypeScript errors` : ""}</div>}
        {res?.results.filter((t: any) => !t.pass).map((t: any) => (
          <div key={t.id} className="broken"><span className="badge b-disproven">broken</span> {t.title}<div className="mono small">{t.failures.slice(0, 3).join("\n")}</div></div>
        ))}
        {res && res.failed === 0 && <div className="muted small">Every proven rule, every Quirk Court decision and the held-out snapshot still hold.</div>}
      </div>
    </div>
  );
}
