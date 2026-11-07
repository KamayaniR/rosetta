// Mechanical checks on a port: strict compile, @rule/@quirk tag map, lookup-table lint, transpile for the sandbox.
import ts from "ts5";
import type { Observation } from "./types.ts";

export type Diagnostic = { line: number; message: string };
export type TagMap = { line: number; hids: string[]; quirks: { hid: string; decision: string }[] }[];

const COMPILER: ts.CompilerOptions = {
  strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], lib: ["lib.es2022.d.ts"], skipLibCheck: true,
  noImplicitReturns: true, noUnusedLocals: false,
};

/** `tsc --noEmit --strict` on the port source, in memory. */
export function compile(code: string): Diagnostic[] {
  const fileName = "/virtual/ms.port.ts";
  const host = ts.createCompilerHost(COMPILER);
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) =>
    name === fileName ? ts.createSourceFile(name, code, lang, true) : orig(name, lang, ...rest);
  const origExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || origExists(name);
  const origRead = host.readFile.bind(host);
  host.readFile = (name) => (name === fileName ? code : origRead(name));
  const program = ts.createProgram([fileName], COMPILER, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ({
    line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  }));
}

/** CommonJS JS for the sandbox; the default export becomes module.exports. */
export function transpile(code: string): string {
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, strict: true } }).outputText;
  return `${js}\nif (module.exports && typeof module.exports.default === "function") module.exports = module.exports.default;`;
}

/**
 * Map lines to rule IDs. A trailing `// @rule H1, H2` tags its own line. A comment-only tag line tags the
 * lines after it until the next comment-only tag line or until indentation drops below the tag's indentation.
 * `@quirk H29 preserve` adds a quirk tag the same way.
 */
export function tagMap(code: string): TagMap {
  const lines = code.split("\n");
  const parse = (s: string) => {
    const hids = [...(s.match(/@rule\s+([H\d,\s]+)/)?.[1] ?? "").matchAll(/H\d+/g)].map((m) => m[0]);
    const quirks = [...s.matchAll(/@quirk\s+(H\d+)\s*(preserve|fix|flag|pending)?(?:\s*\((pending)\))?/g)]
      .map((m) => ({ hid: m[1], decision: m[3] ? "pending" : m[2] ?? "pending" }));
    return { hids, quirks };
  };
  const indent = (s: string) => s.match(/^\s*/)![0].length;
  const map: TagMap = [];
  // Nested blocks: each comment-only tag line opens a block that lasts while code stays at >= its indentation.
  const stack: { hids: string[]; quirks: TagMap[number]["quirks"]; indent: number }[] = [];
  lines.forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    const isCommentOnly = trimmed.startsWith("//");
    const tags = parse(raw);
    const hasTag = tags.hids.length > 0 || tags.quirks.length > 0;
    if (trimmed && !isCommentOnly) {
      while (stack.length && indent(raw) < stack[stack.length - 1].indent) stack.pop();
    }
    if (isCommentOnly && hasTag) {
      while (stack.length && stack[stack.length - 1].indent >= indent(raw)) stack.pop();
      stack.push({ ...tags, indent: indent(raw) });
    }
    const hids = [...new Set([...stack.flatMap((b) => b.hids), ...(isCommentOnly ? [] : tags.hids)])];
    const seenQ = new Set<string>();
    const quirks = [...stack.flatMap((b) => b.quirks), ...(isCommentOnly ? [] : tags.quirks)].filter((q) => !seenQ.has(q.hid) && seenQ.add(q.hid));
    if (trimmed && (hids.length || quirks.length)) map.push({ line, hids, quirks });
    // a closing brace at the block's indentation ends that block (the brace itself still belongs to it)
    if (!isCommentOnly && /^[}\])]/.test(trimmed)) {
      while (stack.length && indent(raw) <= stack[stack.length - 1].indent) stack.pop();
    }
  });
  return map;
}

/** Spec §10b: reject ports with > 20 string literals that also appear as string inputs in observations. */
export function lookupLint(code: string, obs: Observation[]): { hits: string[]; ok: boolean } {
  const inputs = new Set(obs.filter((o) => o.input.val?.t === "string").map((o) => o.input.val!.v as string));
  const sf = ts.createSourceFile("p.ts", code, ts.ScriptTarget.ES2022, true);
  const hits = new Set<string>();
  const visit = (n: ts.Node) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && inputs.has(n.text)) hits.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { hits: [...hits], ok: hits.size <= 20 };
}
