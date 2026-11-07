// Backend (§12). Public API for the UI + signed /internal/* endpoints for the Fetch.ai uAgents.
// ORCHESTRATOR=fetch (default when the Bureau is up) | node (in-process fallback, entries "unsigned-fallback").
import "dotenv/config";
import Fastify from "fastify";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getStore } from "./store.ts";
import { bus, emit, type RosettaEvent } from "./events.ts";
import { verifyEnvelope, ALLOWLIST, type SignedEnvelope } from "./provenance.ts";
import { createSession, runPipeline, runStep, STEP_AGENT, type StepName } from "./steps.ts";
import { buildReport } from "./report.ts";
import { listHypotheses } from "./hypotheses.ts";
import { listQuirks } from "./quirks.ts";
import { runContract, renderVitest, buildContract, type ContractDef } from "./contract.ts";

async function latestContract(sessionId: string): Promise<ContractDef | null> {
  const [c] = await (await getStore()).find<ContractDef>("contracts", { sessionId }, { sort: { createdAt: -1 }, limit: 1 });
  return c ?? null;
}

const PORT = Number(process.env.PORT ?? 8787);
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? "http://127.0.0.1:8100";
const ROOT = resolve(import.meta.dirname, "..");

const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
app.addHook("onRequest", async (req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") reply.code(204).send();
});

// ---------- sessions ----------
async function coordinatorUp(): Promise<boolean> {
  try { return (await fetch(`${COORDINATOR_URL}/health`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; }
}

app.post<{ Body: { orchestrator?: "node" | "fetch"; rounds?: number; top?: number; code?: string; source?: { kind: "web" | "agentverse"; caller?: string; request?: string } } }>("/sessions", async (req, reply) => {
  const want = req.body?.orchestrator ?? (process.env.ORCHESTRATOR as "node" | "fetch" | undefined) ?? "fetch";
  const orchestrator = want === "fetch" && (await coordinatorUp()) ? "fetch" : "node";
  let sessionId: string;
  try { sessionId = await createSession({ orchestrator, source: req.body?.source, code: req.body?.code }); }
  catch (e: any) { return reply.code(400).send({ error: String(e?.message ?? e) }); }
  const rounds = req.body?.rounds ?? 6, top = req.body?.top ?? 8;
  if (orchestrator === "fetch") {
    const r = await fetch(`${COORDINATOR_URL}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sessionId, rounds, top }) });
    if (!r.ok) await emit(sessionId, "agent_error", { agent: "coordinator", error: `start failed ${r.status}` });
  } else {
    if (want === "fetch") await emit(sessionId, "agent_error", { agent: "coordinator", error: "Bureau not reachable; Node orchestrator took over (unsigned fallback)" });
    runPipeline(sessionId, { rounds, topN: top }).catch((e) => emit(sessionId, "agent_error", { agent: "orchestrator", error: String(e?.message ?? e) }));
  }
  return { sessionId, orchestrator };
});

app.get("/sessions", async () => (await getStore()).find("sessions", {}, { sort: { createdAt: -1 }, limit: 20 }));

app.get<{ Params: { id: string } }>("/sessions/:id/state", async (req) => {
  const store = await getStore();
  const sessionId = req.params.id;
  const [session] = await store.find<any>("sessions", { sessionId });
  const [port] = await store.find<any>("ports", { sessionId, compileOk: true }, { sort: { version: -1 }, limit: 1 });
  const [verify] = await store.find<any>("verify_reports", { sessionId }, { sort: { createdAt: -1 }, limit: 1 });
  return {
    session,
    hypotheses: await listHypotheses(sessionId),
    observations: await store.find("observations", { sessionId }, { sort: { runId: 1 } }),
    quirks: await listQuirks(sessionId),
    port: port ?? null,
    verify: verify ?? null,
    ports: await store.find("ports", { sessionId }, { sort: { version: 1 } }),
    verifies: await store.find("verify_reports", { sessionId }, { sort: { createdAt: 1 } }),
    properties: await store.find("properties", { sessionId }, { sort: { createdAt: 1 } }),
    findings: await store.find("archivist_findings", { sessionId }),
    agentMessages: await store.find("agent_messages", { sessionId }, { sort: { ts: 1 } }),
  };
});

// SSE: replay stored events, then stream live ones for this session.
app.get<{ Params: { id: string } }>("/sessions/:id/events", async (req, reply) => {
  const sessionId = req.params.id;
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
  const send = (e: RosettaEvent) => reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  for (const e of await (await getStore()).find<RosettaEvent>("events", { sessionId }, { sort: { ts: 1 } })) send(e);
  reply.raw.write(`event: replay_done\ndata: {}\n\n`);
  const onEvent = (e: RosettaEvent) => { if (e.sessionId === sessionId) send(e); };
  bus.on("event", onEvent);
  const ping = setInterval(() => reply.raw.write(": ping\n\n"), 15000);
  req.raw.on("close", () => { bus.off("event", onEvent); clearInterval(ping); });
  return reply;
});

app.get<{ Params: { id: string } }>("/sessions/:id/report", async (req) => buildReport(req.params.id));

// all stored events as JSON (replay mode loads these once)
app.get<{ Params: { id: string } }>("/sessions/:id/events.json", async (req) =>
  (await getStore()).find("events", { sessionId: req.params.id }, { sort: { ts: 1 } }));

app.get<{ Params: { id: string } }>("/sessions/:id/port.ts", async (req, reply) => {
  const [port] = await (await getStore()).find<any>("ports", { sessionId: req.params.id, compileOk: true }, { sort: { version: -1 }, limit: 1 });
  return port ? reply.type("text/plain").send(port.code) : reply.code(404).send({ error: "no port yet" });
});

app.post<{ Params: { hid: string }; Body: { sessionId: string; decision: "preserve" | "fix" | "flag"; fixSpec?: string; via?: string } }>("/quirks/:hid/decision", async (req, reply) => {
  const { sessionId, decision, fixSpec, via } = req.body;
  if (!["preserve", "fix", "flag"].includes(decision)) return reply.code(400).send({ error: "bad decision" });
  if (decision === "fix" && !fixSpec?.trim()) return reply.code(400).send({ error: "fix needs a one-line fixSpec" });
  // last write wins; web UI and ASI:One both refresh from `quirks`
  await (await getStore()).updateOne("quirks", { sessionId, hid: req.params.hid }, { decision, fixSpec: fixSpec ?? null, decidedAt: new Date(), decidedVia: via ?? "web" });
  await emit(sessionId, "quirk_decided", { hid: req.params.hid, decision, fixSpec, via: via ?? "web" });
  return { ok: true };
});

// Apply Quirk Court decisions: fix predicates -> rebuilt port -> verify -> contract (runs in the background)
app.post<{ Params: { id: string } }>("/sessions/:id/apply-decisions", async (req) => {
  const sessionId = req.params.id;
  runStep("apply", { sessionId }).then(async (result) => {
    await (await getStore()).insertMany("provenance", [{ sessionId, step: "apply", signerName: "builder", signer: null, verified: "unsigned-fallback", result, ts: new Date() }]);
    await emit(sessionId, "decisions_applied", result);
  }).catch((e) => emit(sessionId, "agent_error", { agent: "builder", step: "apply", error: String(e?.message ?? e) }));
  return { ok: true };
});

app.get<{ Params: { id: string } }>("/sessions/:id/contract", async (req) => (await latestContract(req.params.id)) ?? buildContract(req.params.id));
app.get<{ Params: { id: string } }>("/sessions/:id/contract.test.ts", async (req, reply) => {
  const c = (await latestContract(req.params.id)) ?? (await buildContract(req.params.id));
  return reply.type("text/plain").send(renderVitest(c));
});
// "Try an AI edit": run the contract against pasted code, inside the sandbox
app.post<{ Params: { id: string }; Body: { code?: string } }>("/sessions/:id/contract/run", async (req, reply) => {
  const code = req.body?.code;
  if (!code || code.length > 200_000) return reply.code(400).send({ error: "code (<= 200 KB) required" });
  const c = (await latestContract(req.params.id)) ?? (await buildContract(req.params.id));
  const r = await runContract(c, code);
  await emit(req.params.id, "contract_result", { passed: r.passed, failed: r.failed, broken: r.results.filter((x) => !x.pass).map((x) => x.hid ?? x.id) });
  return r;
});

// Reveal: the ONLY code path that reads ground_truth/, and only after the session is done.
app.get<{ Params: { id: string } }>("/sessions/:id/reveal", async (req, reply) => {
  const [session] = await (await getStore()).find<any>("sessions", { sessionId: req.params.id });
  if (!session?.done) return reply.code(403).send({ error: "reveal is available after session_done" });
  const [port] = await (await getStore()).find<any>("ports", { sessionId: req.params.id, compileOk: true }, { sort: { version: -1 }, limit: 1 });
  return { original: readFileSync(resolve(ROOT, "ground_truth/ms.original.js"), "utf8"), port: port?.code ?? null };
});

// Audit (§7b Part 3): every ledger entry with signer + verification status.
app.get<{ Params: { id: string } }>("/sessions/:id/audit", async (req) => {
  const store = await getStore();
  return {
    allowlist: ALLOWLIST,
    provenance: await store.find("provenance", { sessionId: req.params.id }, { sort: { ts: 1 } }),
    agentMessages: await store.find("agent_messages", { sessionId: req.params.id }, { sort: { ts: 1 } }),
  };
});

// ---------- internal: called only by the uAgents; signature verified BEFORE any write ----------
const seenMsg = new Set<string>();

app.post<{ Params: { step: string }; Body: SignedEnvelope<{ sessionId: string; msgId: string; round?: number; topN?: number; feedback?: string; repair?: boolean }> }>("/internal/:step", async (req, reply) => {
  const step = req.params.step as StepName;
  if (step === ("agent-message" as StepName)) return reply.callNotFound();
  if (!(step in STEP_AGENT)) return reply.code(404).send({ error: "unknown step" });
  const env = req.body;
  const check = verifyEnvelope(env, STEP_AGENT[step]);
  const store = await getStore();
  const sessionId = env?.payload?.sessionId;
  if (check.verified !== true) {
    await store.insertMany("provenance", [{ sessionId, step, signer: env?.signer ?? null, signerName: check.signerName ?? null, payloadHash: env?.payloadHash ?? null, signature: env?.signature ?? null, verified: check.verified, reason: check.reason, ts: new Date() }]);
    if (sessionId) await emit(sessionId, "agent_error", { agent: check.signerName ?? "unknown", step, error: `rejected: ${check.reason}` });
    return reply.code(401).send({ error: check.reason, verified: check.verified });
  }
  const { msgId } = env.payload;
  if (seenMsg.has(msgId)) return reply.code(409).send({ error: "duplicate msgId" });
  seenMsg.add(msgId);
  try {
    const result = await runStep(step, env.payload);
    await store.insertMany("provenance", [{ sessionId, step, round: env.payload.round ?? null, msgId, signer: env.signer, signerName: check.signerName, payloadHash: env.payloadHash, signature: env.signature, verified: true, result, ts: new Date() }]);
    // stamp what this step produced with its signer
    const stamp = { signer: env.signer, signerName: check.signerName, signature: env.signature, payloadHash: env.payloadHash, verified: true };
    for (const hid of ((result as any).hids ?? []) as string[]) await store.updateOne("hypotheses", { sessionId, hid }, stamp);
    if ((result as any).portVersion) await store.updateOne("ports", { sessionId, version: (result as any).portVersion }, stamp);
    return { ok: true, result };
  } catch (e: any) {
    await emit(sessionId, "agent_error", { agent: check.signerName, step, error: String(e?.message ?? e) });
    return reply.code(500).send({ error: String(e?.message ?? e) });
  }
});

// Agents report every message they send (signed) for the Agent activity strip and the audit log.
app.post<{ Body: SignedEnvelope<{ sessionId: string; msgId: string; round: number; from: string; to: string; type: string; summary: string }> }>("/internal/agent-message", async (req, reply) => {
  const env = req.body;
  const p = env.payload;
  const check = verifyEnvelope(env, p.from);
  const doc = { sessionId: p.sessionId, msgId: p.msgId, round: p.round, from: env.signer, fromName: p.from, to: ALLOWLIST[p.to] ?? p.to, toName: p.to, type: p.type, summary: p.summary, payloadHash: env.payloadHash, signature: env.signature, verified: check.verified, reason: check.reason ?? null, ts: new Date() };
  await (await getStore()).insertMany("agent_messages", [doc]);
  await emit(p.sessionId, "agent_message", doc);
  return check.verified === true ? { ok: true } : reply.code(401).send({ error: check.reason });
});

app.post<{ Body: { agents: string[] } }>("/internal/agents-online", async (req) => {
  await emit("_global", "agent_online", { agents: req.body.agents });
  return { ok: true };
});

// ---------- static UI (built) ----------
const UI_DIST = resolve(ROOT, "ui/dist");
if (existsSync(UI_DIST)) await app.register((await import("@fastify/static")).default, { root: resolve(UI_DIST, "assets"), prefix: "/assets/" });
app.get("/", async (_req, reply) => (existsSync(resolve(UI_DIST, "index.html")) ? reply.type("text/html").send(readFileSync(resolve(UI_DIST, "index.html"))) : { rosetta: "backend up", ui: "not built" }));
app.get("/health", async () => ({ ok: true, store: (await getStore()).kind, coordinator: await coordinatorUp() }));

const store = await getStore();
await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`rosetta backend on :${PORT} (store: ${store.kind}${store.warning ? `, ${store.warning}` : ""}); coordinator ${COORDINATOR_URL}`);
