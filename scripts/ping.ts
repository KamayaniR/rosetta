// One test call each to Meta, Gemini, MongoDB (and SubQ if a key is set).
import "dotenv/config";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { MongoClient } from "mongodb";

const META_MODEL = process.env.META_MODEL ?? "muse-spark-1.1";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

async function check(name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`OK   ${name} (${Date.now() - t}ms): ${out.slice(0, 80).replace(/\s+/g, " ")}`);
  } catch (e: any) {
    console.log(`FAIL ${name}: ${e?.message ?? e}`);
  }
}

await check(`meta ${META_MODEL}`, async () => {
  if (!process.env.MODEL_API_KEY) throw new Error("MODEL_API_KEY missing");
  const c = new OpenAI({ apiKey: process.env.MODEL_API_KEY, baseURL: "https://api.meta.ai/v1" });
  const r = await c.chat.completions.create({
    model: META_MODEL,
    messages: [{ role: "user", content: "Reply with the word pong." }],
  });
  return r.choices[0]?.message?.content ?? "";
});

await check(`gemini ${GEMINI_MODEL}`, async () => {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const g = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const r = await g.models.generateContent({ model: GEMINI_MODEL, contents: "Reply with the word pong." });
  return r.text ?? "";
});

await check("mongodb", async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI missing");
  const m = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await m.connect();
    const r = await m.db("rosetta").command({ ping: 1 });
    return JSON.stringify(r);
  } finally {
    await m.close();
  }
});

if (process.env.SUBQ_API_KEY) {
  console.log("SKIP subq: key present, API shape not wired yet (milestone 2.35)");
} else {
  console.log("SKIP subq: no SUBQ_API_KEY");
}
