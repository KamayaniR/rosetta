import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API, getJSON, postJSON, snapshotAt, ts, PHASES, type Ev } from "./timeline";
import { PortViewer } from "./PortViewer";
import { TracePanel, HypothesesPanel, QuirkCourt, AgentsPanel, ArchivistPanel, Drawer } from "./panels";

const PHASE_LABEL: Record<string, string> = { trace: "Trace", hypothesize: "Hypothesize", experiment: "Experiment", quirk_court: "Quirk Court", port: "Port", verify: "Verify", contract: "Contract" };

export function App() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [sid, setSid] = useState<string | null>(() => new URLSearchParams(location.search).get("session"));
  const [state, setState] = useState<any>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  // ?mode=replay opens a finished session at its final state (no live connection); good for sharing links
  const [mode, setMode] = useState<"live" | "replay">(() => (new URLSearchParams(location.search).get("mode") === "replay" ? "replay" : "live"));
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

  useEffect(() => { getJSON("/sessions").then(setSessions).catch((e) => setErr(String(e))); }, [sid]);
  useEffect(() => {
    if (!sid) return;
    history.replaceState(null, "", `?session=${sid}${mode === "replay" ? "&mode=replay" : ""}`);
    setState(null); setSelected([]);
    refresh(sid).catch((e) => setErr(String(e)));
  }, [sid, refresh]);

  // live: SSE -> debounced refetch
  useEffect(() => {
    if (!sid || mode !== "live") return;
    const es = new EventSource(`${API}/sessions/${sid}/events`);
    let timer: any = null;
    let replayDone = false;
    es.addEventListener("replay_done", () => { replayDone = true; });
    es.onmessage = () => {};
    const bump = () => { if (!replayDone) return; clearTimeout(timer); timer = setTimeout(() => refresh(sid).catch(() => {}), 800); };
    for (const t of ["observation_added", "hypothesis_created", "hypothesis_updated", "experiment_started", "quirk_detected", "quirk_decided", "port_written", "verify_progress", "verify_done", "mismatch_found", "agent_message", "archivist_review", "phase", "session_done", "agent_error"]) es.addEventListener(t, bump);
    return () => { es.close(); clearTimeout(timer); };
  }, [sid, mode, refresh]);

  const t0 = useMemo(() => (events.length ? ts(events[0].ts) : 0), [events]);
  const t1 = useMemo(() => (events.length ? ts(events[events.length - 1].ts) : 0), [events]);
  useEffect(() => { if (mode === "replay" && !cursorSet && events.length) { setCursor(t1); setCursorSet(true); } }, [mode, cursorSet, events, t1]);

  // replay: animate cursor; 1x = whole session in ~90 s
  const raf = useRef<number>(0);
  useEffect(() => {
    if (mode !== "replay" || !playing) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last; last = now;
      setCursor((c) => {
        const next = c + ((t1 - t0) / 90000) * dt * speed;
        if (next >= t1) { setPlaying(false); return t1; }
        return next;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [mode, playing, speed, t0, t1]);

  const T = mode === "live" ? Number.MAX_SAFE_INTEGER : cursor;
  const view = useMemo(() => (state ? snapshotAt(state, events, T) : null), [state, events, T]);

  const start = async () => {
    setBusy(true); setErr(null);
    try { const r = await postJSON("/sessions", {}); setMode("live"); setSid(r.sessionId); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const startReplay = () => { setMode("replay"); setCursorSet(true); setCursor(t0); setPlaying(true); };

  const evidence = useMemo(() => new Set(view?.hypotheses.filter((h) => selected.includes(h.hid)).flatMap((h) => h.evidence) ?? []), [view, selected]);
  const phaseIdx = view ? PHASES.indexOf(view.phase as any) : -1;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="logo">◆</span> Rosetta <span className="muted">software archaeology</span></div>
        <div className="target">{state?.session?.target ?? "target/ms.min.js"}</div>
        <select value={sid ?? ""} onChange={(e) => { setMode("live"); setSid(e.target.value); }}>
          <option value="" disabled>select session…</option>
          {sessions.map((s) => <option key={s.sessionId} value={s.sessionId}>{s.sessionId} {s.orchestrator ? `· ${s.orchestrator}` : ""} {s.done ? "· done" : ""}</option>)}
        </select>
        <button className="primary" disabled={busy} onClick={start}>{busy ? "Starting…" : "Start session"}</button>
        <div className="modes">
          <button className={mode === "live" ? "on" : ""} onClick={() => { setMode("live"); setPlaying(false); }}>Live</button>
          <button className={mode === "replay" ? "on" : ""} disabled={!events.length} onClick={startReplay}>Replay</button>
        </div>
      </header>

      <nav className="stepper">
        {PHASES.map((p, i) => <div key={p} className={`step ${i < phaseIdx || view?.done ? "past" : ""} ${i === phaseIdx && !view?.done ? "now" : ""}`}><span>{i + 1}</span>{PHASE_LABEL[p]}</div>)}
        <div className="spacer" />
        {state?.session && <span className="pill">{state.session.orchestrator === "fetch" ? "Fetch.ai agents · signed" : "Node orchestrator"}</span>}
        {state?.session?.source?.kind === "agentverse" && <span className="pill accent">via Agentverse · {String(state.session.source.caller).slice(0, 14)}…</span>}
      </nav>

      {mode === "replay" && events.length > 0 && (
        <div className="replaybar">
          <button onClick={() => setPlaying(!playing)}>{playing ? "❚❚ Pause" : "▶ Play"}</button>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[0.5, 1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
          <input type="range" min={t0} max={t1} value={cursor} onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value)); }} />
          <span className="mono">{new Date(cursor).toLocaleTimeString()} · {Math.round((cursor - t0) / 1000)}s / {Math.round((t1 - t0) / 1000)}s</span>
        </div>
      )}

      {err && <div className="error">{err}</div>}
      {!sid && <div className="empty">Start a session or pick one above. Replay plays any finished session back from its stored events.</div>}
      {sid && !view && <div className="empty">Loading {sid}…</div>}

      {view && (
        <>
          <main className="grid">
            <section className="col left"><TracePanel view={view} evidence={evidence} /></section>
            <section className="col center">
              <PortViewer view={view} onSelect={setSelected} selected={selected} />
            </section>
            <section className="col right">
              <QuirkCourt view={view} sessionId={sid!} live={mode === "live"} onDecided={() => refresh(sid!)} />
              <HypothesesPanel view={view} selected={selected} onSelect={setSelected} />
            </section>
          </main>
          <section className="lower">
            <AgentsPanel view={view} session={state.session} />
            <ArchivistPanel view={view} />
          </section>
          <Drawer view={view} sessionId={sid!} />
        </>
      )}
    </div>
  );
}
