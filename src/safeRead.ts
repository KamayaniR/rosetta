// Path allowlist for every file read used by the agent pipeline.
// ground_truth/ is never readable from here; only the reveal endpoint may read it.
import { readFileSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ALLOWED = ["target", "out", "data"].map((d) => resolve(ROOT, d));
const FORBIDDEN = resolve(ROOT, "ground_truth");

export class ForbiddenPathError extends Error {
  name = "ForbiddenPathError";
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

export function assertAllowed(p: string): string {
  const abs = resolve(ROOT, p);
  if (isInside(abs, FORBIDDEN)) throw new ForbiddenPathError(`blocked: ${p} is ground truth`);
  if (!ALLOWED.some((dir) => isInside(abs, dir))) throw new ForbiddenPathError(`blocked: ${p} not in allowlist`);
  return abs;
}

export function safeRead(p: string): string {
  return readFileSync(assertAllowed(p), "utf8");
}
