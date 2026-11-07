"""Rosetta's agents as Fetch.ai uAgents (§7b Part 1 + 3).

Coordinator, Tracer, Theorist, Archivist, Builder and Skeptic run in one Bureau. The uAgents own the conversation and
the loop order; the heavy work stays in TypeScript behind POST /internal/<step>. Every request to the backend and
every message between agents is signed with the sending agent's identity (stable seed -> stable agent1... address),
and the backend verifies the signature before writing anything.

Run:  agents/.venv/bin/python agents/bureau.py      (backend must be up: npm run server)
"""
import asyncio, json, os, sys, uuid
from typing import Optional

import requests
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(__file__))
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from uagents import Agent, Bureau, Context, Model  # noqa: E402
from uagents_core.identity import Identity  # noqa: E402
from signing import envelope  # noqa: E402

BACKEND = os.environ.get("BACKEND_URL", "http://127.0.0.1:8787")
PORT = int(os.environ.get("BUREAU_PORT", "8100"))
NAMES = ["coordinator", "tracer", "theorist", "archivist", "builder", "skeptic"]


# ---------- messages (mirror the step payloads in src/steps.ts) ----------
class StartSession(Model):
    session_id: str
    rounds: int = 6
    top: int = 8

class StartResponse(Model):
    ok: bool
    session_id: str

class Health(Model):
    ok: bool
    agents: list

class StepRequest(Model):
    session_id: str
    msg_id: str
    round: int = 0
    top: int = 8
    feedback: Optional[str] = None
    repair: bool = False

class TraceRequest(StepRequest): pass
class HypothesizeRequest(StepRequest): pass
class ExperimentRequest(StepRequest): pass
class ArchivistRequest(StepRequest): pass
class QuirkRequest(StepRequest): pass
class BuildRequest(StepRequest): pass
class VerifyRequest(StepRequest): pass
class SecurityRequest(StepRequest): pass
class ContractRequest(StepRequest): pass

class StepResult(Model):
    session_id: str
    msg_id: str
    round: int
    step: str
    ok: bool
    result_json: str = "{}"
    error: Optional[str] = None

class ObservationBatch(StepResult): pass
class Hypotheses(StepResult): pass
class RoundDone(StepResult): pass
class Findings(StepResult): pass
class Quirks(StepResult): pass
class PortReady(StepResult): pass
class MismatchReport(StepResult): pass
class SecurityFindings(StepResult): pass
class ContractReady(StepResult): pass


# ---------- agents ----------
def make(name: str) -> tuple[Agent, Identity]:
    seed = os.environ[f"AGENT_SEED_{name.upper()}"]
    agent = Agent(name=f"rosetta_{name}", seed=seed, network="testnet")
    ident = Identity.from_seed(seed, 0)
    assert agent.address == ident.address == os.environ[f"AGENT_ADDR_{name.upper()}"], f"{name}: address mismatch"
    return agent, ident

AGENTS = {n: make(n) for n in NAMES}
ADDR = {n: a.address for n, (a, _) in AGENTS.items()}
NAME_OF = {v: k for k, v in ADDR.items()}


def post(path: str, body: dict, timeout: int = 900) -> requests.Response:
    return requests.post(f"{BACKEND}{path}", json=body, timeout=timeout)

async def report(me: str, to: str, msg_type: str, session_id: str, msg_id: str, rnd: int, summary: str):
    """Signed record of a message for the backend's agent log (never blocks the conversation)."""
    payload = {"sessionId": session_id, "msgId": msg_id, "round": rnd, "from": me, "to": to, "type": msg_type, "summary": summary[:200]}
    try:
        await asyncio.to_thread(post, "/internal/agent-message", envelope(AGENTS[me][1], payload), 15)
    except Exception as e:  # logging only
        print(f"[{me}] agent-message log failed: {e}")


async def send(ctx: Context, me: str, to: str, msg: Model, summary: str):
    await report(me, to, type(msg).__name__, msg.session_id, msg.msg_id, getattr(msg, "round", 0), summary)
    await ctx.send(ADDR[to], msg)


# ---------- workers: each owns steps, signs its backend request, replies with a typed result ----------
WORKER_STEPS = {
    "tracer": [(TraceRequest, "seed", ObservationBatch)],
    "theorist": [(HypothesizeRequest, "hypothesize", Hypotheses), (ExperimentRequest, "experiment", RoundDone)],
    "archivist": [(ArchivistRequest, "archivist", Findings)],
    "builder": [(BuildRequest, "build", PortReady)],
    "skeptic": [(QuirkRequest, "quirks", Quirks), (VerifyRequest, "verify", MismatchReport),
                (SecurityRequest, "security", SecurityFindings), (ContractRequest, "contract", ContractReady)],
}
handled: set[str] = set()

def register_worker(name: str, req_cls, step: str, res_cls):
    agent, ident = AGENTS[name]

    @agent.on_message(model=req_cls, replies=res_cls)
    async def handle(ctx: Context, sender: str, req):  # noqa: ANN001
        if req.msg_id in handled:  # duplicate delivery
            return
        handled.add(req.msg_id)
        payload = {"sessionId": req.session_id, "msgId": req.msg_id, "round": req.round, "topN": req.top, "repair": req.repair}
        if req.feedback:
            payload["feedback"] = req.feedback
        try:
            r = await asyncio.to_thread(post, f"/internal/{step}", envelope(ident, payload))
            body = r.json() if r.content else {}
            ok, result, err = r.ok, body.get("result", {}), (None if r.ok else body.get("error", f"HTTP {r.status_code}"))
        except Exception as e:
            ok, result, err = False, {}, str(e)
        reply = res_cls(session_id=req.session_id, msg_id=str(uuid.uuid4()), round=req.round, step=step, ok=ok, result_json=json.dumps(result), error=err)
        await send(ctx, name, NAME_OF[sender], reply, f"{step} {'ok' if ok else 'FAILED: ' + str(err)[:80]} {json.dumps(result)[:100]}")

for w, specs in WORKER_STEPS.items():
    for spec in specs:
        register_worker(w, *spec)


# ---------- coordinator: loop order, rounds, stop rule, one retry per failed step ----------
coord, _ = AGENTS["coordinator"]
sessions: dict[str, dict] = {}

def new_req(cls, s: dict, **kw):
    return cls(session_id=s["id"], msg_id=str(uuid.uuid4()), round=s["round"], top=s["top"], **kw)

async def dispatch(ctx: Context, s: dict, to: str, cls, summary: str, **kw):
    s["last"] = (to, cls, summary, kw)
    await send(ctx, "coordinator", to, new_req(cls, s, **kw), summary)

@coord.on_rest_get("/health", Health)
async def health(ctx: Context) -> Health:
    return Health(ok=True, agents=[{"name": n, "address": a} for n, a in ADDR.items()])

@coord.on_rest_post("/start", StartSession, StartResponse)
async def start(ctx: Context, req: StartSession) -> StartResponse:
    s = {"id": req.session_id, "rounds": req.rounds, "top": req.top, "round": 0, "stable": 0, "repaired": False, "retries": 0, "changes": 0}
    sessions[req.session_id] = s
    await dispatch(ctx, s, "tracer", TraceRequest, "seed trace")
    return StartResponse(ok=True, session_id=req.session_id)

async def finish(ctx: Context, s: dict):
    payload = {"sessionId": s["id"], "msgId": str(uuid.uuid4()), "round": s["round"]}
    await report("coordinator", "coordinator", "SessionDone", s["id"], payload["msgId"], s["round"], "session complete")
    await asyncio.to_thread(post, "/internal/done", envelope(AGENTS["coordinator"][1], payload))
    sessions.pop(s["id"], None)

async def on_result(ctx: Context, sender: str, msg: StepResult):
    s = sessions.get(msg.session_id)
    if not s or msg.round != s["round"] and msg.step not in ("quirks", "build", "verify"):
        return  # unknown session or stale round
    result = json.loads(msg.result_json or "{}")
    if not msg.ok and "session stopped" in str(msg.error):
        print(f"[coordinator] {s['id']} stopped by user")
        sessions.pop(s["id"], None)
        return
    if not msg.ok:
        if s["retries"] < 1:  # retry once, then mark the step failed and move on
            s["retries"] += 1
            to, cls, summary, kw = s["last"]
            await dispatch(ctx, s, to, cls, f"retry: {summary}", **kw)
            return
        print(f"[coordinator] step {msg.step} failed twice: {msg.error}")
    s["retries"] = 0

    if msg.step == "seed":
        s["round"] = 1
        await dispatch(ctx, s, "theorist", HypothesizeRequest, "hypothesize round 1")
    elif msg.step == "hypothesize":
        await dispatch(ctx, s, "theorist", ExperimentRequest, f"experiment round {s['round']}")
    elif msg.step == "experiment":
        s["changes"] = result.get("changes", 0)
        s["empty"] = bool(result.get("empty"))
        await dispatch(ctx, s, "archivist", ArchivistRequest, f"full-history review round {s['round']}")
    elif msg.step == "archivist":
        added = result.get("added", 0)
        s["stable"] = s["stable"] + 1 if s["changes"] == 0 and added == 0 else 0
        if (s.get("empty") and not added) or s["stable"] >= 2 or s["round"] >= s["rounds"]:
            await dispatch(ctx, s, "skeptic", QuirkRequest, "judge quirks")
        else:
            s["round"] += 1
            await dispatch(ctx, s, "theorist", HypothesizeRequest, f"hypothesize round {s['round']}")
    elif msg.step == "quirks":
        await dispatch(ctx, s, "builder", BuildRequest, "write port")
    elif msg.step == "build":
        await dispatch(ctx, s, "skeptic", VerifyRequest, f"verify port v{result.get('portVersion')}", repair=s["repaired"])
    elif msg.step == "verify":
        fb = result.get("repairFeedback")
        if fb and not s["repaired"]:
            s["repaired"] = True
            await dispatch(ctx, s, "builder", BuildRequest, "repair port with shrunk counterexamples", feedback=fb)
        else:
            await dispatch(ctx, s, "skeptic", SecurityRequest, "security pass (ReDoS sweep, crashes, capabilities, unsafe acceptance)")
    elif msg.step == "security":
        await dispatch(ctx, s, "skeptic", ContractRequest, "generate behavioral contract")
    elif msg.step == "contract":
        await finish(ctx, s)

for cls in (ObservationBatch, Hypotheses, RoundDone, Findings, Quirks, PortReady, MismatchReport, SecurityFindings, ContractReady):
    coord.on_message(model=cls)(on_result)


@coord.on_event("startup")
async def online(ctx: Context):
    try:
        await asyncio.to_thread(post, "/internal/agents-online", {"agents": [{"name": n, "address": a} for n, a in ADDR.items()]}, 5)
    except Exception:
        pass
    for n, a in ADDR.items():
        print(f"  {n:12} {a}")


if __name__ == "__main__":
    bureau = Bureau(port=PORT, endpoint=[f"http://127.0.0.1:{PORT}/submit"])
    for n, (a, _) in AGENTS.items():
        bureau.add(a)
    bureau.run()
