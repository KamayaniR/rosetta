// One wrapper for every model call (spec §6). Provider per agent is one line in ROUTES.
// Strict JSON + zod validation, one repair retry, backoff on API errors, Meta -> Gemini fallback,
// Meta budget cap per session. Every call is logged as an `llm_call` event.
import "dotenv/config";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import type { z } from "zod";
import { emit } from "./events.ts";

export type Agent = "theorist" | "builder" | "skeptic" | "quirk_judge" | "seeder" | "summarizer" | "archivist";
export type Provider = "meta" | "gemini" | "subq";

export const ROUTES: Record<Agent, Provider> = {
  theorist: "meta",
  builder: "meta",
  skeptic: "gemini",
  quirk_judge: "gemini",
  seeder: "gemini",
  summarizer: "gemini",
  archivist: "subq",
};

export const MODELS: Record<Provider, string> = {
  meta: process.env.META_MODEL ?? "muse-spark-1.1",
  gemini: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
  // subq-snap-* = Decisions API (/v1/systemone). Set SUBQ_MODEL=subq-preview once access is granted (generative).
  subq: process.env.SUBQ_MODEL ?? "subq-snap-1.1",
};
const SUBQ_BASE = "https://api.subq.ai/v1";
export const isDecisionModel = (p: Provider) => p === "subq" && /snap/.test(MODELS.subq);

const META_CALL_CAP = Number(process.env.META_CALL_CAP ?? 150);
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 16384);
// The Builder writes a whole file and Muse Spark spends output tokens on reasoning first, so it gets a larger cap.
const AGENT_MAX_TOKENS: Partial<Record<Agent, number>> = { builder: Number(process.env.BUILDER_MAX_TOKENS ?? 32768) };
let currentMaxTokens = MAX_TOKENS;
const CALL_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);

/** Output hit the token cap: don't retry the same provider (it would run away again). */
class TruncatedError extends Error { name = "TruncatedError"; }
const metaCalls = new Map<string, number>();

let meta: OpenAI | undefined;
let gemini: GoogleGenAI | undefined;
let subq: OpenAI | undefined;

type Raw = { text: string; inputTokens: number; outputTokens: number };

async function callProvider(p: Provider, system: string, user: string, temperature: number, json: boolean): Promise<Raw> {
  if (p === "meta") {
    meta ??= new OpenAI({ apiKey: process.env.MODEL_API_KEY, baseURL: "https://api.meta.ai/v1", timeout: CALL_TIMEOUT_MS, maxRetries: 0 });
    const r = await meta.chat.completions.create({
      model: MODELS.meta,
      temperature,
      max_tokens: currentMaxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    });
    if (r.choices[0]?.finish_reason === "length") throw new TruncatedError(`meta output hit ${currentMaxTokens} token cap`);
    return {
      text: r.choices[0]?.message?.content ?? "",
      inputTokens: r.usage?.prompt_tokens ?? 0,
      outputTokens: r.usage?.completion_tokens ?? 0,
    };
  }
  if (p === "gemini") {
    gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const r = await gemini.models.generateContent({
      model: MODELS.gemini,
      contents: user,
      config: { systemInstruction: system, ...(json ? { responseMimeType: "application/json" } : {}), temperature, maxOutputTokens: MAX_TOKENS,
        httpOptions: { timeout: CALL_TIMEOUT_MS } },
    });
    if (r.candidates?.[0]?.finishReason === "MAX_TOKENS") throw new TruncatedError(`gemini output hit ${MAX_TOKENS} token cap`);
    return {
      text: r.text ?? "",
      inputTokens: r.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: r.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
  // subq generative models (e.g. subq-preview) are OpenAI-compatible chat completions
  if (isDecisionModel("subq")) throw new Error(`${MODELS.subq} is a decisions model; use decide()`);
  subq ??= new OpenAI({ apiKey: process.env.SUBQ_API_KEY, baseURL: SUBQ_BASE, timeout: CALL_TIMEOUT_MS, maxRetries: 0 });
  const r = await subq.chat.completions.create({
    model: MODELS.subq, temperature, max_tokens: MAX_TOKENS,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  return { text: r.choices[0]?.message?.content ?? "", inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0 };
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(body); } catch {}
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
  throw new Error("no JSON found in model output");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withBackoff(p: Provider, system: string, user: string, temperature: number, json: boolean): Promise<Raw> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try { return await callProvider(p, system, user, temperature, json); }
    catch (e) {
      lastErr = e;
      if (e instanceof TruncatedError) throw e;
      if (i < 2) await sleep(500 * 2 ** i);
    }
  }
  throw lastErr;
}

export type LlmResult<T> = { data: T; provider: Provider; model: string; inputTokens: number; outputTokens: number; latencyMs: number };

export async function call<T>(
  agent: Agent,
  msg: { system: string; user: string },
  /** zod schema for JSON replies, or a parser for free-text replies (e.g. code); a parser throws to request a repair. */
  schema: z.ZodType<T> | ((text: string) => T),
  ctx: { sessionId: string; temperature?: number },
): Promise<LlmResult<T>> {
  const json = typeof schema !== "function";
  currentMaxTokens = AGENT_MAX_TOKENS[agent] ?? MAX_TOKENS;
  let provider = ROUTES[agent];
  const temperature = ctx.temperature ?? 0.2;

  if (provider === "meta" && (metaCalls.get(ctx.sessionId) ?? 0) >= META_CALL_CAP) {
    await emit(ctx.sessionId, "provider_switched", { agent, from: "meta", to: "gemini", reason: "meta call cap reached" });
    provider = "gemini";
  }

  let user = msg.user;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    let raw: Raw;
    try {
      if (provider === "meta") metaCalls.set(ctx.sessionId, (metaCalls.get(ctx.sessionId) ?? 0) + 1);
      raw = await withBackoff(provider, msg.system, user, temperature, json);
    } catch (e: any) {
      if (provider === "gemini") {
        await emit(ctx.sessionId, "agent_error", { agent, provider, error: String(e?.message ?? e) });
        throw e;
      }
      await emit(ctx.sessionId, "provider_switched", { agent, from: provider, to: "gemini", reason: String(e?.message ?? e) });
      provider = "gemini";
      attempt--; // the fallback attempt doesn't consume the repair retry
      continue;
    }
    const latencyMs = Date.now() - t0;
    await emit(ctx.sessionId, "llm_call", {
      agent, provider, model: MODELS[provider], inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, latencyMs, attempt,
    });

    let problem: string;
    const meta = { provider, model: MODELS[provider], inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, latencyMs };
    try {
      if (typeof schema === "function") return { data: schema(raw.text), ...meta };
      const parsed = schema.safeParse(extractJson(raw.text));
      if (parsed.success) return { data: parsed.data, ...meta };
      problem = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } catch (e: any) {
      problem = String(e?.message ?? e);
    }
    user = `${msg.user}\n\nYour previous reply was invalid: ${problem}\nReply again in exactly the requested format.`;
  }
  await emit(ctx.sessionId, "agent_error", { agent, provider, error: "invalid output after repair retry" });
  throw new Error(`${agent}: invalid output after repair retry`);
}

// ---------- structured decisions (SubQ Snap /v1/systemone shape) ----------
export type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };
export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };
export type DecideResult = { answers: Record<string, Answer>; provider: Provider; model: string; inputTokens: number; latencyMs: number; calls: number };

const SNAP_MAX_QUESTIONS = 128;

async function snap(state: unknown, questions: Record<string, Question>): Promise<{ answers: Record<string, Answer>; inputTokens: number }> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${SUBQ_BASE}/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.SUBQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODELS.subq, state, questions }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(`subq ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
        if (res.status === 400 || res.status === 403) throw Object.assign(err, { fatal: true });
        throw err;
      }
      return { answers: body.answers ?? {}, inputTokens: body.usage?.input_tokens ?? 0 };
    } catch (e: any) {
      lastErr = e;
      if (e?.fatal) throw e;
      if (i < 2) await sleep(500 * 2 ** i);
    }
  }
  throw lastErr;
}

/**
 * Ask many typed questions about one shared state. Uses SubQ Snap's Decisions API when the agent routes to a
 * snap model; otherwise emulates the same answer shape with a JSON-mode text model (so ROUTES can be switched).
 */
export async function decide(agent: Agent, state: unknown, questions: Record<string, Question>, ctx: { sessionId: string }): Promise<DecideResult> {
  const provider = ROUTES[agent];
  const t0 = Date.now();
  const names = Object.keys(questions);
  const answers: Record<string, Answer> = {};
  let inputTokens = 0, calls = 0;
  if (isDecisionModel(provider)) {
    for (let i = 0; i < names.length; i += SNAP_MAX_QUESTIONS) {
      const chunk = Object.fromEntries(names.slice(i, i + SNAP_MAX_QUESTIONS).map((n) => [n, questions[n]]));
      const r = await snap(state, chunk);
      Object.assign(answers, r.answers);
      inputTokens += r.inputTokens;
      calls++;
    }
  } else {
    const { z } = await import("zod");
    const schema = z.object({ answers: z.record(z.string(), z.any()) });
    const r = await call(agent, {
      system: "Answer every question about the given state. Reply JSON only.",
      user: `State:\n${JSON.stringify(state)}\n\nQuestions:\n${JSON.stringify(questions)}\n\nReply {"answers": {<name>: noul -> {"type":"noul","noul":p}, choice -> {"type":"choice","choice":<option>,"probabilities":{..},"confidence":p}, score -> {"type":"score","score":<0-based level>,"probabilities":{..},"confidence":p}}}`,
    }, schema, { sessionId: ctx.sessionId });
    Object.assign(answers, r.data.answers);
    inputTokens = r.inputTokens;
    calls = 1;
  }
  const latencyMs = Date.now() - t0;
  await emit(ctx.sessionId, "llm_call", { agent, provider, model: MODELS[provider], inputTokens, outputTokens: 0, latencyMs, attempt: 0, decisions: names.length, calls });
  return { answers, provider, model: MODELS[provider], inputTokens, latencyMs, calls };
}
