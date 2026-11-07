// Line-execution tracking. Instruments JS or TS source with counters so each observation records which
// statements, branches and switch cases it actually executed. Works on the minified original and on the port.
//   __c(id)      statement / branch reached
//   __sw(id, v)  switch discriminant value (tells which `case "x":` label matched, even for fall-through labels)
// Both are defined inside the sandbox prelude. Instrumentation only inserts text, so positions map back to the source.
import ts from "ts5";

export type CovPoint = { id: number; kind: "stmt" | "branch"; line: number; start: number; end: number; snippet: string };
export type CaseLabel = { switchId: number; value: string; line: number; start: number; end: number };
export type Instrumented = { code: string; points: CovPoint[]; labels: CaseLabel[] };

type Edit = { pos: number; suffix: boolean; depth: number; text: string };

export function instrument(src: string, fileName = "code.js"): Instrumented {
  const isTs = fileName.endsWith(".ts");
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.ES2022, true, isTs ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const edits: Edit[] = [];
  const points: CovPoint[] = [];
  const labels: CaseLabel[] = [];
  let next = 1;
  const lineOf = (p: number) => sf.getLineAndCharacterOfPosition(p).line + 1;
  const point = (n: ts.Node, kind: CovPoint["kind"]) => {
    const id = next++;
    const start = n.getStart(sf);
    points.push({ id, kind, line: lineOf(start), start, end: n.getEnd(), snippet: src.slice(start, Math.min(n.getEnd(), start + 80)) });
    return id;
  };
  const pre = (pos: number, depth: number, text: string) => edits.push({ pos, suffix: false, depth, text });
  const post = (pos: number, depth: number, text: string) => edits.push({ pos, suffix: true, depth, text });

  const runtime = (s: ts.Statement) =>
    !ts.isTypeAliasDeclaration(s) && !ts.isInterfaceDeclaration(s) && !ts.isEmptyStatement(s)
    && !(ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)); // keep "use strict" directives intact

  const stmtList = (list: ts.NodeArray<ts.Statement>, depth: number) => {
    for (const s of list) if (runtime(s)) pre(s.getStart(sf), depth, `__c(${point(s, "stmt")});`);
  };
  const body = (s: ts.Statement, depth: number) => {
    if (ts.isBlock(s)) return; // its statements get their own points
    const id = point(s, "branch");
    pre(s.getStart(sf), depth, `{__c(${id});`);
    post(s.getEnd(), depth, "}");
  };
  const wrap = (e: ts.Expression, depth: number) => {
    const id = point(e, "branch");
    pre(e.getStart(sf), depth, `(__c(${id}),`);
    post(e.getEnd(), depth, ")");
  };

  const visit = (n: ts.Node, depth: number) => {
    if (ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) stmtList(n.statements, depth);
    if (ts.isIfStatement(n)) {
      body(n.thenStatement, depth);
      if (n.elseStatement && !ts.isIfStatement(n.elseStatement)) body(n.elseStatement, depth);
    }
    if (ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) body(n.statement, depth);
    if (ts.isConditionalExpression(n)) { wrap(n.whenTrue, depth); wrap(n.whenFalse, depth); }
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) wrap(n.right, depth);
    if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) wrap(n.body as ts.Expression, depth);
    if (ts.isSwitchStatement(n)) {
      const id = next++;
      pre(n.expression.getStart(sf), depth, `__sw(${id},`);
      post(n.expression.getEnd(), depth, ")");
      for (const c of n.caseBlock.clauses) {
        if (!ts.isCaseClause(c)) continue;
        const e = c.expression;
        const value = ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : ts.isNumericLiteral(e) ? String(Number(e.text)) : null;
        if (value !== null) labels.push({ switchId: id, value, line: lineOf(c.getStart(sf)), start: c.getStart(sf), end: e.getEnd() });
      }
    }
    ts.forEachChild(n, (c) => visit(c, depth + 1));
  };
  visit(sf, 0);

  // Same position: closing text first (inner before outer), then opening text (outer before inner).
  edits.sort((a, b) => a.pos - b.pos || (a.suffix === b.suffix ? (a.suffix ? b.depth - a.depth : a.depth - b.depth) : a.suffix ? -1 : 1));
  let out = "", at = 0;
  for (const e of edits) { out += src.slice(at, e.pos) + e.text; at = e.pos; }
  out += src.slice(at);
  return { code: out, points, labels };
}

export type CoverageIndex = { point: Map<number, string[]>; label: Map<string, string[]> };

/** Index raw coverage keys (from the sandbox) per run: point id -> runIds, "switchId:value" -> runIds. */
export function indexCoverage(runs: { runId: string; cov: string[] }[]): CoverageIndex {
  const point = new Map<number, string[]>(), label = new Map<string, string[]>();
  for (const r of runs) for (const k of r.cov) {
    if (k.startsWith("s")) { const key = k.slice(1); label.set(key, [...(label.get(key) ?? []), r.runId]); }
    else { const id = Number(k); point.set(id, [...(point.get(id) ?? []), r.runId]); }
  }
  return { point, label };
}

export const labelKey = (l: CaseLabel) => `${l.switchId}:${l.value}`;
