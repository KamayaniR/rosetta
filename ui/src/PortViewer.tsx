// Center: the port in Monaco (read-only). Line color = evidence for the rules tagged on that line:
//   green  = every rule proven AND the line executed on a real observation
//   yellow = a rule only inferred, or the line never executed (code-only claim)
//   red    = a tagged rule was disproven, or the line is linked to an open mismatch
// Quirk lines get a purple gutter marker. Hover shows the rules; click selects them (highlights evidence on the left).
import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import type { View } from "./timeline";

type Monaco = Parameters<OnMount>[1];
type Ed = Parameters<OnMount>[0];

export function lineColor(view: View, line: { hids: string[]; executed?: boolean | null }) {
  const st = line.hids.map((h) => view.hypotheses.find((x) => x.hid === h)?.status ?? "unknown");
  if (st.includes("disproven")) return "red";
  if (st.length && st.every((s) => s === "proven") && line.executed !== false) return "green";
  return "yellow";
}

export function PortViewer({ view, selected, onSelect }: { view: View; selected: string[]; onSelect: (h: string[]) => void }) {
  const [version, setVersion] = useState<number | null>(null);
  const ports = view.ports.filter((p: any) => p.compileOk);
  const port = ports.find((p: any) => p.version === version) ?? view.port;
  const edRef = useRef<Ed | null>(null);
  const monRef = useRef<Monaco | null>(null);
  const decos = useRef<string[]>([]);
  const [ready, setReady] = useState(0); // bumps when Monaco mounts / the model changes, so decorations re-apply
  const dataRef = useRef<{ view: View; port: any }>({ view, port });
  dataRef.current = { view, port };

  const evidenceByLine = new Map<number, any>((port?.lineEvidence ?? []).map((l: any) => [l.line, l]));
  const lines = (port?.ruleMap ?? []).map((t: any) => ({ ...t, executed: evidenceByLine.get(t.line)?.executed ?? null }));

  useEffect(() => {
    const ed = edRef.current, monaco = monRef.current;
    if (!ed || !monaco || !port) return;
    const d = lines.map((l: any) => {
      const color = lineColor(view, l);
      const sel = l.hids.some((h: string) => selected.includes(h));
      return {
        range: new monaco.Range(l.line, 1, l.line, 1),
        options: {
          isWholeLine: true,
          className: `ln-${color}${sel ? " ln-sel" : ""}`,
          glyphMarginClassName: l.quirks?.length ? "glyph-quirk" : undefined,
          overviewRuler: { color: color === "green" ? "#16a34a" : color === "red" ? "#dc2626" : "#d97706", position: 1 },
        },
      };
    });
    decos.current = ed.deltaDecorations(decos.current, d);
  }, [port, view, selected, lines, ready]);

  const onMount: OnMount = (ed, monaco) => {
    edRef.current = ed; monRef.current = monaco;
    setReady((n) => n + 1);
    ed.onDidChangeModelContent(() => setReady((n) => n + 1));
    monaco.languages.registerHoverProvider("typescript", {
      provideHover: (_model: unknown, pos: { lineNumber: number }) => {
        const { view: v, port: p } = dataRef.current;
        const t = (p?.ruleMap ?? []).find((x: any) => x.line === pos.lineNumber);
        if (!t) return null;
        const ev = (p?.lineEvidence ?? []).find((x: any) => x.line === pos.lineNumber);
        const md = t.hids.map((h: string) => {
          const hy = v.hypotheses.find((x) => x.hid === h);
          return hy ? `**${h}** · ${hy.status} ${hy.confidence.toFixed(2)} · ${hy.evidence.length} runs${hy.source === "archivist" ? " · found by Archivist" : ""}  \n${hy.claim}` : `**${h}** (not in ledger)`;
        });
        const exec = ev ? (ev.executed === true ? `executed by ${ev.runs.length}${ev.runs.length >= 50 ? "+" : ""} runs` : ev.executed === false ? "**never executed** by any observation (code-only claim)" : "no executable code") : "";
        const q = (t.quirks ?? []).map((x: any) => `Quirk ${x.hid}: ${x.decision}`).join(", ");
        return { range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, 1), contents: [{ value: [exec, q, ...md].filter(Boolean).join("\n\n") }] };
      },
    });
    ed.onMouseDown((e) => {
      const ln = e.target.position?.lineNumber;
      const t = (dataRef.current.port?.ruleMap ?? []).find((x: any) => x.line === ln);
      onSelect(t ? t.hids : []);
    });
  };

  const counts = lines.reduce((m: any, l: any) => ((m[lineColor(view, l)] = (m[lineColor(view, l)] ?? 0) + 1), m), {});
  return (
    <div className="panel port">
      <div className="panel-h">
        <h3>TypeScript port</h3>
        {ports.length > 0 && (
          <select value={port?.version ?? ""} onChange={(e) => setVersion(Number(e.target.value))}>
            {ports.map((p: any) => <option key={p.version} value={p.version}>v{p.version} · {p.provider ?? "?"}</option>)}
          </select>
        )}
      </div>
      {port ? (
        <>
          <div className="legend">
            <span className="sw green" /> proven {counts.green ?? 0}
            <span className="sw yellow" /> unproven {counts.yellow ?? 0}
            <span className="sw red" /> disputed {counts.red ?? 0}
            <span className="sw quirk" /> quirk
            {port.agreement && <span className="muted"> · agreement {port.agreement.equal}/{port.agreement.total}{port.agreement.intentional ? ` + ${port.agreement.intentional} intentional (Fix ${Object.keys(port.agreement.intentionalByHid ?? {}).join(", ")})` : ""}</span>}
          </div>
          <div className="editor">
            <Editor height="100%" theme="vs" language="typescript" value={port.code} onMount={onMount}
              options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, glyphMargin: true, scrollBeyondLastLine: false, fontFamily: "JetBrains Mono, monospace" }} />
          </div>
        </>
      ) : <div className="empty small">The Builder writes the port after the hypothesize/experiment loop.</div>}
    </div>
  );
}
