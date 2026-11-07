import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API, getJSON, postJSON, snapshotAt, ts, PHASES, type Ev, type View } from "./timeline";
import { PortViewer } from "./PortViewer";
import { TracePanel, HypothesesPanel, QuirkCourt, Drawer } from "./panels";

const PHASE_LABEL: Record<string, string> = { trace: "Trace", hypothesize: "Hypothesize", experiment: "Experiment", quirk_court: "Quirk Court", port: "Port", verify: "Verify", contract: "Contract" };

type Section = "home" | "evidence" | "port" | "court" | "verify" | "archivist" | "agents" | "contract" | "history" | "report" | "reveal";

const SECTIONS: { id: Section; label: string; icon: string; color: string; blurb: string }[] = [
  { id: "evidence", label: "Evidence", icon: "🔬", color: "indigo", blurb: "Every run of the minified code and the rules proven from them" },
  { id: "port", label: "Port", icon: "🧩", color: "violet", blurb: "The TypeScript port, each line colored by its evidence" },
  { id: "court", label: "Quirk Court", icon: "⚖️", color: "amber", blurb: "Surprising behaviors: Preserve, Fix or Flag" },
  { id: "verify", label: "Verify", icon: "✅", color: "green", blurb: "Fuzzing, held-out set, properties, security" },
  { id: "archivist", label: "Archivist · SubQ", icon: "📚", color: "teal", blurb: "Full-history review and the final audit" },
  { id: "agents", label: "Agents · Fetch.ai", icon: "🤝", color: "blue", blurb: "Signed messages between the agents" },
  { id: "contract", label: "Contract", icon: "🔒", color: "rose", blurb: "The test suite that blocks bad AI edits" },
  { id: "report", label: "Report & Reveal", icon: "📜", color: "slate", blurb: "Final numbers and the original source" },
];
// old ?tab= links (README, screenshots) map onto sections
const TAB_TO_SECTION: Record<string, Section> = { verify: "verify", archivist: "archivist", agents: "agents", contract: "contract", history: "history", report: "report", reveal: "reveal" };

/** Headline numbers, all derived from stored data at the current time cursor. */
function Kpis({ view, session, big }: { view: View; session: any; big?: boolean }) {
  const c = view.hypotheses.reduce((m: any, h) => ((m[h.status] = (m[h.status] ?? 0) + 1), m), {});
  const v = view.verify;
  const pct = (x?: number) => (x === undefined || x === null ? "–" : `${(x * 100).toFixed(1)}%`);
  const ev = view.port?.evidenceSummary;
  const signed = view.agentMessages.filter((m: any) => m.verified === true).length;
  const items: [string, string, string, string][] = [
    ["rules proven", `${c.proven ?? 0}`, `${c.inferred ?? 0} inferred · ${c.disproven ?? 0} disproven`, "indigo"],
    ["held-out match", pct(v?.heldout?.matchRate), v ? `unseen-only ${pct(v.heldout.unseen?.matchRate)}` : "after verify", "green"],
    ["fuzz", v ? `${v.fuzz.equal}/${v.fuzz.total}` : "–", "original vs port", "green"],
    ["found by Archivist", `${view.hypotheses.filter((h) => h.source === "archivist").length}`, view.review?.ratio ? `${view.review.ratio.toFixed(1)}× more context` : "SubQ", "teal"],
    ["port lines never run", ev ? `${ev.neverExecuted}/${ev.tagged}` : "–", "tagged lines", "violet"],
    ["quirks", `${view.quirks.length}`, `${view.quirks.filter((q) => q.decision !== "pending").length} decided`, "amber"],
    [session?.orchestrator === "fetch" ? "signed messages" : "orchestrator", session?.orchestrator === "fetch" ? `${signed}` : "node", session?.orchestrator === "fetch" ? "Fetch.ai uAgents" : "unsigned fallback", "blue"],
  ];
  return (
    <div className={`kpis ${big ? "big" : ""}`}>
      {items.map(([l, v2, sub, color]) => <div key={l} className={`kpi c-${color}`}><div className="kv">{v2}</div><div className="kl">{l}</div><div className="ks">{sub}</div></div>)}
    </div>
  );
}

export function App() {
  const q0 = new URLSearchParams(location.search);
  const [sessions, setSessions] = useState<any[]>([]);
  const [sid, setSid] = useState<string | null>(() => q0.get("session"));
  const [section, setSection] = useState<Section>(() => (q0.get("view") as Section) ?? (q0.get("right") === "court" ? "court" : TAB_TO_SECTION[q0.get("tab") ?? ""] ?? "home"));
  const [state, setState] = useState<any>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  // ?mode=replay opens a finished session at its final state (no live connection); good for sharing links
  const [mode, setMode] = useState<"live" | "replay">(() => (q0.get("mode") === "replay" ? "replay" : "live"));
  const [cursorSet, setCursorSet] = useState(false);
  const [cursor, setCursor] = useState<number>(Date.now());
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async (id: string) => {
    const [s, e] = await Promise.all([getJSON(`/sessions/${id}/state`), getJSON<Ev[]>(`/sessions/${id}/events.json`)]);
    setState(s); setEvents(e);
  }, []);

  useEffect(() => { getJSON("/sessions").then((list) => { setSessions(list); if (!sid && list[0]) setSid(list[0].sessionId); }).catch((e) => setErr(String(e))); }, [sid]);
  useEffect(() => {
    if (!sid) return;
    setState(null); setSelected([]);
    refresh(sid).catch((e) => setErr(String(e)));
  }, [sid, refresh]);
  // keep the URL shareable: session, mode, view (+ any extra params like edit=plural)
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (sid) q.set("session", sid);
    q.set("view", section);
    if (mode === "replay") q.set("mode", "replay"); else q.delete("mode");
    q.delete("tab"); q.delete("right");
    history.replaceState(null, "", `?${q.toString()}`);
  }, [sid, section, mode]);

  // live: SSE -> debounced refetch
  useEffect(() => {
    if (!sid || mode !== "live") return;
    const es = new EventSource(`${API}/sessions/${sid}/events`);
    let timer: any = null;
    let replayDone = false;
    es.addEventListener("replay_done", () => { replayDone = true; });
    const bump = () => { if (!replayDone) return; clearTimeout(timer); timer = setTimeout(() => refresh(sid).catch(() => {}), 800); };
    for (const t of ["observation_added", "hypothesis_created", "hypothesis_updated", "experiment_started", "quirk_detected", "quirk_decided", "port_written", "verify_progress", "verify_done", "mismatch_found", "agent_message", "archivist_review", "phase", "session_done", "agent_error", "decisions_applied", "contract_generated", "challenge_started", "challenge_done", "session_stopped", "archivist_audit"]) es.addEventListener(t, bump);
    return () => { es.close(); clearTimeout(timer); };
  }, [sid, mode, refresh]);

  const t0 = useMemo(() => (events.length ? ts(events[0].ts) : 0), [events]);
  const t1 = useMemo(() => (events.length ? ts(events[events.length - 1].ts) : 0), [events]);
  useEffect(() => { if (mode === "replay" && !cursorSet && events.length) { setCursor(t1); setCursorSet(true); } }, [mode, cursorSet, events, t1]);

  // replay: 1x = whole session in ~90 s
  const raf = useRef<number>(0);
  useEffect(() => {
    if (mode !== "replay" || !playing) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last; last = now;
      setCursor((c) => { const next = c + ((t1 - t0) / 90000) * dt * speed; if (next >= t1) { setPlaying(false); return t1; } return next; });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [mode, playing, speed, t0, t1]);

  const T = mode === "live" ? Number.MAX_SAFE_INTEGER : cursor;
  const view = useMemo(() => (state ? snapshotAt(state, events, T) : null), [state, events, T]);

  const start = async () => {
    setBusy(true); setErr(null);
    try { const r = await postJSON("/sessions", {}); setMode("live"); setSid(r.sessionId); setSection("evidence"); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const startReplay = () => { setMode("replay"); setCursorSet(true); setCursor(t0); setPlaying(true); };
  const evidence = useMemo(() => new Set(view?.hypotheses.filter((h) => selected.includes(h.hid)).flatMap((h) => h.evidence) ?? []), [view, selected]);
  const phaseIdx = view ? PHASES.indexOf(view.phase as any) : -1;
  const pendingQuirks = view?.quirks.filter((q) => q.decision === "pending").length ?? 0;
  const running = mode === "live" && state?.session && !state.session.done && !state.session.aborted && !view?.stopped;

  const sessionPicker = (
    <select className="picker" value={sid ?? ""} onChange={(e) => { setMode("live"); setSid(e.target.value); }}>
      <option value="" disabled>select a session…</option>
      {sessions.map((s) => {
        const t = new Date(s.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const how = s.orchestrator === "fetch" ? (s.source?.kind === "agentverse" ? "ASI:One → Fetch.ai agents" : "Fetch.ai agents") : s.orchestrator === "node" ? "backend" : "CLI run";
        const st = s.done ? `${s.proven} proven` : s.aborted ? "stopped" : `running · ${s.proven} proven`;
        return <option key={s.sessionId} value={s.sessionId}>{t} · {how} · {st}</option>;
      })}
    </select>
  );
  const modes = (
    <div className="modes">
      <button className={mode === "live" ? "on" : ""} onClick={() => { setMode("live"); setPlaying(false); }}>Live</button>
      <button className={mode === "replay" ? "on" : ""} disabled={!events.length} onClick={startReplay}>Replay</button>
    </div>
  );
  const stepper = (
    <div className="stepper">
      {PHASES.map((p, i) => <span key={p} className={`step ${i < phaseIdx || view?.done ? "past" : ""} ${i === phaseIdx && !view?.done ? "now" : ""}`}>{PHASE_LABEL[p]}</span>)}
    </div>
  );

  // ---------- home ----------
  if (section === "home") {
    return (
      <div className="app light home">
        <div className="hero">
          <div className="halo" />
          <h1 className="wordmark">Rosetta</h1>
          <p className="tagline">Recover what undocumented code actually does, decide which quirks matter, port it with proof of equivalence, and lock the behavior into a contract.</p>
          <div className="hero-controls">
            {sessionPicker}
            <button className="primary glow" disabled={busy} onClick={start}>{busy ? "Starting…" : "Start a new session"}</button>
            {running && <span className="pill live-dot">running</span>}
          </div>
          {err && <div className="error">{err}</div>}
          {view && <>{stepper}<Kpis view={view} session={state.session} big /></>}
          <div className="tiles">
            {SECTIONS.map((s) => (
              <button key={s.id} className={`tile c-${s.color}`} disabled={!view} onClick={() => setSection(s.id)}>
                <span className="ti">{s.icon}</span>
                <span className="tl">{s.label}{s.id === "court" && pendingQuirks ? <span className="badge-n">{pendingQuirks}</span> : null}</span>
                <span className="tb">{s.blurb}</span>
              </button>
            ))}
          </div>
          <div className="sponsors">Meta Muse Spark · Google Gemini · Subquadratic SubQ · Fetch.ai · MongoDB Atlas</div>
        </div>
      </div>
    );
  }

  // ---------- one section at a time ----------
  const current = SECTIONS.find((s) => s.id === section) ?? (section === "history" ? { label: "Port history", color: "violet" } : section === "reveal" ? { label: "Reveal", color: "slate" } : SECTIONS[0]);
  return (
    <div className="app light">
      <header className="bar">
        <button className="logo-btn" onClick={() => setSection("home")} title="Home"><span className="mini-mark">Rosetta</span></button>
        <nav className="pills">
          {SECTIONS.map((s) => <button key={s.id} className={`pill-btn c-${s.color} ${section === s.id || (s.id === "report" && section === "reveal") || (s.id === "port" && section === "history") ? "active" : ""}`} onClick={() => setSection(s.id)}>{s.icon} {s.label}</button>)}
        </nav>
        <div className="bar-right">
          {sessionPicker}
          {running && <button className="danger" onClick={async () => { if (confirm("Stop this session? Running steps finish; no new step starts.")) { await postJSON(`/sessions/${sid}/stop`, {}); refresh(sid!); } }}>Stop</button>}
          {modes}
        </div>
      </header>
      <div className="subbar">
        <h2 className={`section-title c-${(current as any).color}`}>{current.label}</h2>
        {stepper}
        {mode === "replay" && events.length > 0 && (
          <div className="replay">
            <button onClick={() => setPlaying(!playing)}>{playing ? "❚❚" : "▶"}</button>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[0.5, 1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
            <input type="range" min={t0} max={t1} value={cursor} onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value)); }} />
            <span className="mono muted">{Math.round((cursor - t0) / 1000)}s / {Math.round((t1 - t0) / 1000)}s</span>
          </div>
        )}
      </div>
      {err && <div className="error">{err}</div>}
      {!view && <div className="empty">Loading…</div>}
      {view && (
        <main className="section">
          {section !== "report" && section !== "reveal" && <Kpis view={view} session={state.session} />}
          {section === "evidence" && (
            <div className="two">
              <TracePanel view={view} evidence={evidence} />
              <div className="panel"><HypothesesPanel view={view} selected={selected} onSelect={setSelected} sessionId={sid!} live={mode === "live"} /></div>
            </div>
          )}
          {section === "port" && <div className="port-wrap"><PortViewer view={view} onSelect={setSelected} selected={selected} /><div className="link-row"><button onClick={() => setSection("history")}>Port history →</button></div></div>}
          {section === "history" && <Drawer view={view} sessionId={sid!} session={state.session} tab="history" hideTabs />}
          {section === "court" && <div className="panel"><QuirkCourt view={view} sessionId={sid!} live={mode === "live"} onDecided={() => refresh(sid!)} /></div>}
          {["verify", "archivist", "agents", "contract"].includes(section) && <Drawer view={view} sessionId={sid!} session={state.session} tab={section} hideTabs />}
          {section === "report" && (
            <div className="two">
              <Drawer view={view} sessionId={sid!} session={state.session} tab="report" hideTabs />
              <div className="panel reveal-cta">
                <h3>Reveal</h3>
                <p className="muted">The original source has been hidden from every agent all session. See it next to the recovered port.</p>
                <button className="primary glow" disabled={!view.done} onClick={() => setSection("reveal")}>{view.done ? "Reveal the original →" : "Available when the session is done"}</button>
              </div>
            </div>
          )}
          {section === "reveal" && <Drawer view={view} sessionId={sid!} session={state.session} tab="reveal" hideTabs />}
        </main>
      )}
    </div>
  );
}
