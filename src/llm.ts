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
  subq: process.env.SUBQ_MODEL ?? "subq-snap-1.1",
};

const META_CALL_CAP = Number(process.env.META_CALL_CAP ?? 150);
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 16384);
const CALL_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);

/** Output hit the token cap: don't retry the same provider (it would run away again). */
class TruncatedError extends Error { name = "TruncatedError"; }
const metaCalls = new Map<string, number>();

let meta: OpenAI | undefined;
let gemini: GoogleGenAI | undefined;

type Raw = { text: string; inputTokens: number; outputTokens: number };

async function callProvider(p: Provider, system: string, user: string, temperature: number, json: boolean): Promise<Raw> {
  if (p === "meta") {
    meta ??= new OpenAI({ apiKey: process.env.MODEL_API_KEY, baseURL: "https://api.meta.ai/v1", timeout: CALL_TIMEOUT_MS, maxRetries: 0 });
    const r = await meta.chat.completions.create({
      model: MODELS.meta,
      temperature,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    });
    if (r.choices[0]?.finish_reason === "length") throw new TruncatedError(`meta output hit ${MAX_TOKENS} token cap`);
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
  throw new Error("subq provider not wired yet");
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
