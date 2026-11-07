export const TAGS = [
  "string", "number", "undefined", "null", "boolean", "object", "array",
  "nan", "inf", "-inf", "-0", "function", "symbol", "bigint",
] as const;
export type Tag = (typeof TAGS)[number];

/** JSON-safe encoding of any JS value (JSON can't hold undefined, NaN, -0, Infinity, ...). */
export type TaggedValue = { t: Tag; v?: any };

/** One call to the target. `val` absent = called with zero args. */
export type CallInput = { val?: TaggedValue; options?: TaggedValue; extra?: TaggedValue[] };

export type OutcomeKind = "return" | "throw" | "timeout" | "crash";
export type Outcome = {
  kind: OutcomeKind;
  value?: TaggedValue; // return value, or thrown non-Error value
  errorName?: string;
  errorMessage?: string;
};

export type Env = { tz: string; lang: string; node: string };

export type ObservationSource = "seed" | "experiment" | "fuzz" | "heldout";

export type Observation = {
  runId: string;
  sessionId: string;
  input: CallInput;
  outcome: Outcome;
  nondeterministic: boolean;
  altOutcomes?: Outcome[]; // only when nondeterministic
  sideEffects: string[]; // globals the target touched (console, Date, process, ...)
  durationMs: number;
  env: Env;
  source: ObservationSource;
  round: number;
  createdAt: Date;
};
