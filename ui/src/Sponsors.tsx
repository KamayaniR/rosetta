// Sponsors page: what each sponsor's product does in this session, with numbers computed from stored data.
import { useEffect, useState } from "react";
import { getJSON } from "./timeline";

const n = (x: number | null | undefined) => (x === null || x === undefined ? "–" : x.toLocaleString());
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${(x * 100).toFixed(0)}%`);

function Card({ color, logo, name, role, children }: { color: string; logo: string; name: string; role: string; children: React.ReactNode }) {
  return (
    <div className={`sp-card c-${color}`}>
      <div className="sp-head"><span className="sp-logo">{logo}</span><div><div className="sp-name">{name}</div><div className="sp-role">{role}</div></div></div>
      {children}
    </div>
  );
}
const Big = ({ v, l }: { v: string; l: string }) => <div className="sp-big"><div className="v">{v}</div><div className="l">{l}</div></div>;

export function Sponsors({ sessionId, onGo }: { sessionId: string; onGo: (s: any) => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { getJSON(`/sessions/${sessionId}/sponsors`).then(setD).catch((e) => setErr(String(e))); }, [sessionId]);
  if (err) return <div className="error">{err}</div>;
  if (!d) return <div className="empty">Loading…</div>;
  const { meta, gemini, subq, fetch: fa, mongodb } = d;
  const firstTry = meta.ports.filter((p: any) => p.compileOk && p.attempts === 1).length;
  return (
    <div className="sponsors-grid">
      <Card color="indigo" logo="Ⓜ" name="Meta Muse Spark" role="Theorist and Builder: the reasoning and the code">
        <div className="sp-bigs">
          <Big v={`${meta.rulesProven}/${meta.rulesProposed}`} l="rules it proposed that were proven" />
          <Big v={`${firstTry}/${meta.ports.length}`} l="ports it wrote that compiled on the first try" />
          <Big v={pct(meta.ports.map((p: any) => p.heldout).filter((x: any) => x !== null).pop())} l="held-out match of its port" />
        </div>
        <ul>
          <li>Proposed {meta.rulesProposed} rules from real runs and designed the experiments that proved {meta.rulesProven} and disproved {meta.rulesDisproven}</li>
          <li>Turned {meta.archivistFindingsTurnedIntoRules} Archivist findings into testable rules</li>
          <li>Wrote the TypeScript port: {meta.ports.map((p: any) => `v${p.version} (${p.agreement ?? "?"})`).join(", ") || "none yet"}</li>
          <li>{n(meta.total.calls)} calls · {n(meta.total.inputTokens)} in / {n(meta.total.outputTokens)} out tokens · {Object.entries(meta.roles).map(([r, v]: any) => `${r} ${v.calls}`).join(" · ")}</li>
        </ul>
        <button onClick={() => onGo("port")}>See the port →</button>
      </Card>

      <Card color="blue" logo="✦" name="Fetch.ai" role="Signed agents and a public agent on Agentverse">
        <div className="sp-bigs">
          <Big v={`${fa.verified}/${fa.messages}`} l="agent messages with a verified signature" />
          <Big v={`${fa.agents.length || 6}`} l="agents in the Bureau" />
          <Big v={fa.source?.kind === "agentverse" ? "ASI:One" : fa.orchestrator === "fetch" ? "web" : "n/a"} l="where this session was started" />
        </div>
        <ul>
          <li>Coordinator, tracer, theorist, archivist, builder and skeptic are uAgents with their own keys; every step they run is signed, and the backend rejects a step signed by the wrong agent</li>
          {fa.source?.kind === "agentverse" && <li>Requested by <span className="mono">{String(fa.source.caller).slice(0, 22)}…</span> in ASI:One: "{String(fa.source.request).replace(/^(\s*@\S+)+\s*/, "")}"</li>}
          <li>Public agent <b>rosetta</b> on Agentverse: <span className="mono">{String(fa.serviceAgent).slice(0, 22)}…</span>, with Quirk Court cards in ASI:One</li>
          <li>{fa.signedSteps} pipeline steps signed and verified{fa.rejected ? `, ${fa.rejected} rejected` : ""}</li>
        </ul>
        <button onClick={() => onGo("agents")}>See the signed messages →</button>
      </Card>

      <Card color="teal" logo="◈" name="Subquadratic SubQ" role="Archivist: the whole history in one request">
        <div className="sp-bigs">
          <Big v={subq.lastContext ? `${subq.lastContext.ratio.toFixed(1)}×` : "–"} l={`more context than the Theorist (${n(subq.lastContext?.archivistTokens)} vs ${n(subq.lastContext?.theoristTokens)} tokens)`} />
          <Big v={`${subq.rulesFound}`} l={`rules found that the Theorist didn't propose (${subq.rulesFoundProven} proven)`} />
          <Big v={subq.audit ? `${subq.audit.rulesChecked}` : "–"} l="port tags checked in the final audit" />
        </div>
        <ul>
          <li>{subq.reviews} full-history reviews, {subq.lastContext?.questions ?? "–"} questions each, one request per round</li>
          <li>Gaps found: {Object.entries(subq.findings).map(([k, v]: any) => `${k.replace("_", " ")} ${v}`).join(" · ")}</li>
          {subq.audit && <li>Final audit of port v{subq.audit.portVersion}: {Object.entries(subq.audit.counts).map(([k, v]: any) => `${k.replace(/_/g, " ")} ${v}`).join(" · ")}</li>}
        </ul>
        <button onClick={() => onGo("archivist")}>See the Archivist →</button>
      </Card>

      <Card color="green" logo="◆" name="Google Gemini" role="Independent checks, a different model from the Theorist">
        <div className="sp-bigs">
          <Big v={`${gemini.properties.hold}/${gemini.properties.proposed}`} l={`property tests that hold (${gemini.properties.discarded} wrong ones discarded)`} />
          <Big v={`${gemini.quirksFlagged}`} l="surprising behaviors flagged for Quirk Court" />
          <Big v={`${gemini.seeds}`} l="seed runs from its inputs" />
        </div>
        <ul>
          <li>Writes property tests seeing only the proven rules, not the Theorist's reasoning</li>
          <li>Turned {gemini.fixChecks} Fix decision{gemini.fixChecks === 1 ? "" : "s"} into checks; rated security risk</li>
          <li>Stepped in for Meta {gemini.fallbacksForMeta} time{gemini.fallbacksForMeta === 1 ? "" : "s"}{gemini.portsWritten ? `, including ${gemini.portsWritten} port` : ""}</li>
          <li>{n(gemini.total.calls)} calls · {n(gemini.total.inputTokens)} in / {n(gemini.total.outputTokens)} out tokens</li>
        </ul>
        <button onClick={() => onGo("verify")}>See Verify →</button>
      </Card>

      <Card color="slate" logo="⬢" name="MongoDB Atlas" role="The ledger and the replay log">
        <div className="sp-bigs">
          <Big v={n(mongodb.totalDocuments)} l="documents stored for this session" />
          <Big v={n(mongodb.observations)} l="recorded runs of the original" />
          <Big v={n(mongodb.events)} l="events, used to replay the session" />
        </div>
        <ul>
          <li>{Object.entries(mongodb.documents).filter(([, v]: any) => v > 0).map(([k, v]: any) => `${k} ${v}`).join(" · ")}</li>
          <li>Store: {mongodb.store === "mongo" ? "MongoDB Atlas" : "in-memory fallback"}</li>
        </ul>
        <button onClick={() => onGo("evidence")}>See the evidence →</button>
      </Card>
    </div>
  );
}
