// Live and replay share one view: everything is derived from stored state + events "as of time T".
// Live: T = now (SSE triggers refetch). Replay: T animates from session start to end.
export const API = import.meta.env.DEV ? "/api" : "";

export async function getJSON<T = any>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
export async function postJSON<T = any>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `${path}: ${r.status}`);
  return j;
}

export type TV = { t: string; v?: any };
export type Outcome = { kind: string; value?: TV; errorName?: string; errorMessage?: string };
export type Obs = { runId: string; input: { val?: TV; options?: TV; extra?: TV[] }; outcome: Outcome; source: string; round: number; createdAt: string; nondeterministic: boolean; sideEffects: string[] };
export type Hyp = { hid: string; claim: string; category: string; status: string; confidence: number; evidence: string[]; source: string; signerName?: string; verified?: any; isQuirk?: boolean; history: { round: number; status: string; note: string }[]; revises?: string };
export type Ev = { type: string; payload: any; ts: string };

export const ts = (x: string | Date | undefined) => (x ? new Date(x).getTime() : 0);

export function show(tv?: TV): string {
  if (!tv) return "";
  switch (tv.t) {
    case "string": return tv.v.length > 40 ? `${JSON.stringify(tv.v.slice(0, 30))}…(${tv.v.length})` : JSON.stringify(tv.v);
    case "number": return String(tv.v);
    case "nan": return "NaN"; case "inf": return "Infinity"; case "-inf": return "-Infinity"; case "-0": return "-0";
    case "undefined": case "null": return tv.t;
    case "boolean": return String(tv.v);
    case "bigint": return `${tv.v}n`;
    case "symbol": return `Symbol(${tv.v})`;
    case "function": return "fn";
    case "array": return `[${tv.v.map(show).join(", ")}]`;
    case "object": return `{${Object.entries(tv.v).map(([k, e]) => `${k}: ${show(e as TV)}`).join(", ")}}`;
  }
  return "?";
}
export function call(input: Obs["input"]): string {
  const a: string[] = [];
  if (input.val) a.push(show(input.val));
  if (input.options || input.extra?.length) { if (!input.val) a.push("undefined"); a.push(input.options ? show(input.options) : "undefined"); }
  for (const e of input.extra ?? []) a.push(show(e));
  return `f(${a.join(", ")})`;
}
export function outcome(o: Outcome): string {
  if (o.kind === "return") return show(o.value);
  if (o.kind === "throw") return `throws ${o.errorName ?? show(o.value)}`;
  return o.kind;
}

export const PHASES = ["trace", "hypothesize", "experiment", "quirk_court", "port", "verify", "contract"] as const;
const PHASE_OF_EVENT: Record<string, string> = {
  session_started: "trace", observation_added: "trace", hypothesis_created: "hypothesize", experiment_started: "experiment",
  hypothesis_updated: "experiment", quirk_detected: "quirk_court", port_written: "port", port_compile_failed: "port",
  verify_progress: "verify", verify_done: "verify", session_done: "contract",
};

export type View = ReturnType<typeof snapshotAt>;

export function snapshotAt(state: any, events: Ev[], T: number) {
  const evs = events.filter((e) => ts(e.ts) <= T);
  // phase: explicit "phase" events (orchestrated sessions) or inferred from event types (CLI sessions)
  let phase = "trace";
  for (const e of evs) phase = e.type === "phase" ? e.payload.phase : PHASE_OF_EVENT[e.type] ?? phase;
  const done = evs.some((e) => e.type === "session_done") || (!!state.session?.done && T >= ts(state.session?.finishedAt));

  const created = new Map<string, number>();
  const status = new Map<string, { status: string; confidence: number }>();
  for (const e of evs) {
    if (e.type === "hypothesis_created") { created.set(e.payload.hid, ts(e.ts)); status.set(e.payload.hid, { status: "inferred", confidence: e.payload.confidence }); }
    if (e.type === "hypothesis_updated") status.set(e.payload.hid, { status: e.payload.status, confidence: e.payload.confidence });
  }
  const hypotheses: Hyp[] = (state.hypotheses as Hyp[]).filter((h) => created.has(h.hid)).map((h) => ({ ...h, ...status.get(h.hid)! }));

  const decided = new Map<string, any>();
  for (const e of evs) if (e.type === "quirk_decided") decided.set(e.payload.hid, e.payload);
  const quirks = (state.quirks as any[]).filter((q) => ts(q.createdAt) <= T).map((q) => {
    const d = decided.get(q.hid);
    return { ...q, decision: d?.decision ?? "pending", fixSpec: d?.fixSpec ?? null };
  });

  const ports = (state.ports as any[]).filter((p) => ts(p.createdAt) <= T);
  const verifies = (state.verifies as any[]).filter((v) => ts(v.createdAt) <= T);
  const reviews = evs.filter((e) => e.type === "archivist_review").map((e) => e.payload);
  const llm = evs.filter((e) => e.type === "llm_call").map((e) => ({ ...e.payload, ts: e.ts }));
  return {
    phase, done,
    observations: (state.observations as Obs[]).filter((o) => ts(o.createdAt) <= T),
    hypotheses, quirks, ports, verifies,
    port: [...ports].reverse().find((p) => p.compileOk) ?? null,
    verify: verifies[verifies.length - 1] ?? null,
    findings: (state.findings as any[]).filter((f) => ts(f.createdAt) <= T),
    agentMessages: (state.agentMessages as any[]).filter((m) => ts(m.ts) <= T),
    properties: (state.properties as any[] ?? []).filter((p) => ts(p.createdAt) <= T),
    review: reviews[reviews.length - 1] ?? null,
    llm,
    errors: evs.filter((e) => e.type === "agent_error" || e.type === "provider_switched"),
    challenges: evs.filter((e) => e.type === "challenge_started" || e.type === "challenge_done").map((e) =>
      e.type === "challenge_started" && !evs.some((x) => x.type === "challenge_done" && x.payload.hid === e.payload.hid && ts(x.ts) >= ts(e.ts))
        ? { hid: e.payload.hid, round: e.payload.round, state: "running" as const, before: "", after: "", ran: 0, note: "" }
        : { hid: e.payload.hid, round: e.payload.round, state: (e.type === "challenge_done" ? "done" : "superseded") as "done" | "superseded", before: e.payload.before, after: e.payload.after, ran: e.payload.ran, note: e.payload.note }),
    stopped: evs.some((e) => e.type === "session_stopped"),
  };
}
