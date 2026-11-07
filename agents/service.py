"""Rosetta as a public chat agent on Agentverse, callable from ASI:One (§7b Part 2 + 2b).

Flow: user pastes JS (or says "run the demo") -> "Session started" + progress card + live link -> a new progress card
per phase -> Quirk / Security cards with Preserve / Fix / Flag (Fix asks for one line) -> report card with actions.
Decisions go to POST /quirks/:hid/decision (same `quirks` collection as the web UI; last write wins).

Run:  agents/.venv/bin/python agents/service.py   (backend up; Bureau optional, else Node orchestrator)
"""
import asyncio, json, os, sys, threading
from datetime import datetime, timezone
from uuid import uuid4

import requests
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(__file__))
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from uagents import Agent, Context, Protocol  # noqa: E402
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage, TextContent, chat_protocol_spec  # noqa: E402
import cards  # noqa: E402

BACKEND = os.environ.get("BACKEND_URL", "http://127.0.0.1:8787")
PUBLIC = os.environ.get("PUBLIC_URL", BACKEND).rstrip("/")
PORT = int(os.environ.get("SERVICE_PORT", "8001"))
MAX_CODE = 200 * 1024

agent = Agent(
    name="rosetta",
    seed=os.environ["AGENT_SEED_ROSETTA_SERVICE"],
    port=PORT,
    mailbox=True,
    publish_agent_details=True,
    readme_path=os.path.join(os.path.dirname(__file__), "SERVICE_README.md"),
    description="Rosetta recovers what undocumented or minified JavaScript actually does, ports it to TypeScript with proof of "
                "equivalence, and locks the behavior into a contract. Paste a JS module; decide its quirks in chat.",
    network="testnet",
)
assert agent.address == os.environ["AGENT_ADDR_ROSETTA_SERVICE"]
chat = Protocol(spec=chat_protocol_spec)

# sender -> chat state (kept in memory; sessions themselves live in MongoDB via the backend)
chats: dict[str, dict] = {}


def ui_url(sid: str) -> str:
    return f"{PUBLIC}/?session={sid}"


def api(method: str, path: str, **kw):
    r = requests.request(method, f"{BACKEND}{path}", timeout=kw.pop("timeout", 30), **kw)
    r.raise_for_status()
    return r.json() if r.content else {}


async def reply(ctx: Context, to: str, msg: ChatMessage):
    await ctx.send(to, msg)


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    t = " ".join(c.text for c in msg.content if isinstance(c, TextContent)).strip()
    if not t:
        return
    st = chats.setdefault(sender, {"session": None, "last_quirk": None, "last_card": "quirk", "phase": None, "shown_quirks": set(), "done": False})

    # 1) card taps / numbered replies about the current session
    tap = cards.parse_tap(t, st["last_quirk"], st["last_card"]) if st["session"] else None
    if tap:
        await handle_tap(ctx, sender, st, tap)
        return

    # 2) new session: pasted code, a URL, or "demo"
    code = None
    if cards.looks_like_code(t):
        code = cards.extract_code(t)
    elif t.lower().startswith("http"):
        try:
            code = (await asyncio.to_thread(requests.get, t.split()[0], timeout=15)).text
        except Exception as e:
            await reply(ctx, sender, cards.text(f"Could not fetch that URL: {e}"))
            return
    elif "demo" not in t.lower() and "ms" not in t.lower().split():
        await reply(ctx, sender, cards.text("Paste a JavaScript module (or a URL to one) and I will recover what it does, port it to "
                                              "TypeScript with proof of equivalence, and ask you about its quirks. Say \"demo\" to run on a minified `ms`."))
        return
    if code and len(code.encode()) > MAX_CODE:
        await reply(ctx, sender, cards.text(f"That module is {len(code.encode()) // 1024} KB; the limit is {MAX_CODE // 1024} KB."))
        return
    try:
        body = {"source": {"kind": "agentverse", "caller": sender, "request": t[:300]}}
        if code:
            body["code"] = code
        res = await asyncio.to_thread(api, "POST", "/sessions", json=body)
    except Exception as e:
        await reply(ctx, sender, cards.text(f"Could not start a session: {e}"))
        return
    sid = res["sessionId"]
    st.update(session=sid, phase=None, shown_quirks=set(), done=False, last_quirk=None, last_card="quirk")
    # long sessions vs chat timeouts: answer now with the link, push updates as new messages
    await reply(ctx, sender, cards.text(f"Session started: {sid} (orchestrator: {res.get('orchestrator')}). "
                                          f"Live view: {ui_url(sid)}. I'll post a card at each phase."))


async def handle_tap(ctx: Context, sender: str, st: dict, tap: dict):
    sid = tap.get("session") or st["session"]
    action, hid = tap.get("action"), tap.get("hid")
    if action in ("preserve", "flag"):
        await asyncio.to_thread(api, "POST", f"/quirks/{hid}/decision", json={"sessionId": sid, "decision": action, "via": "asi1"})
        await reply(ctx, sender, cards.text(f"{hid}: {action} recorded."))
    elif action == "fix":
        q = next((x for x in st.get("quirks", []) if x["hid"] == hid), {})
        st["last_quirk"] = hid
        await reply(ctx, sender, cards.fix_form(sid, hid, q.get("suggestedFix", "")))
    elif action == "fix_spec":
        spec = (tap.get("fix_spec") or "").strip()
        if not spec:
            await reply(ctx, sender, cards.fix_form(sid, hid))
            return
        await asyncio.to_thread(api, "POST", f"/quirks/{hid}/decision", json={"sessionId": sid, "decision": "fix", "fixSpec": spec, "via": "asi1"})
        await reply(ctx, sender, cards.text(f"{hid}: fix recorded: \"{spec}\". The port will implement it and the contract will assert it."))
    elif action == "download_port":
        try:
            code = await asyncio.to_thread(lambda: requests.get(f"{BACKEND}/sessions/{sid}/port.ts", timeout=15).text)
            await reply(ctx, sender, cards.text(f"Port for {sid} ({PUBLIC}/sessions/{sid}/port.ts):\n```ts\n{code[:12000]}\n```"))
        except Exception as e:
            await reply(ctx, sender, cards.text(f"Port not available yet: {e}"))
    elif action == "view_contract":
        await reply(ctx, sender, cards.text(f"Contract: {PUBLIC}/sessions/{sid}/contract.test.ts"))
    elif action == "open_session":
        await reply(ctx, sender, cards.text(f"Live session: {ui_url(sid)}"))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


@agent.on_interval(period=8.0)
async def push_updates(ctx: Context):
    """Poll each active chat's session and push a new card per phase, quirk cards, and the final report."""
    for sender, st in list(chats.items()):
        sid = st.get("session")
        if not sid or st.get("done"):
            continue
        try:
            s = await asyncio.to_thread(api, "GET", f"/sessions/{sid}/state", timeout=20)
        except Exception:
            continue
        sess = s.get("session") or {}
        rules = {"proven": 0, "inferred": 0, "disproven": 0}
        for h in s.get("hypotheses", []):
            rules[h["status"]] = rules.get(h["status"], 0) + 1
        mr = ((s.get("verify") or {}).get("heldout") or {}).get("matchRate")
        phase = sess.get("phase")
        if phase and phase != st["phase"]:
            st["phase"] = phase
            await reply(ctx, sender, cards.progress_card(sid, phase, rules, mr, ui_url(sid)))
        obs = {o["runId"]: o for o in s.get("observations", [])}
        st["quirks"] = s.get("quirks", [])
        for q in st["quirks"]:
            if q["hid"] in st["shown_quirks"]:
                continue
            st["shown_quirks"].add(q["hid"])
            hyp = next((h for h in s.get("hypotheses", []) if h["hid"] == q["hid"]), {})
            ex = [f"{rid}: {fmt_obs(obs[rid])}" for rid in q.get("examples", []) if rid in obs]
            st["last_quirk"], st["last_card"] = q["hid"], "quirk"
            await reply(ctx, sender, cards.quirk_card(sid, q, ex, security=hyp.get("category") == "security"))
        if sess.get("done"):
            st["done"] = True
            report = await asyncio.to_thread(api, "GET", f"/sessions/{sid}/report", timeout=30)
            st["last_card"] = "report"
            await reply(ctx, sender, cards.report_card(sid, report, ui_url(sid), f"{PUBLIC}/sessions/{sid}/port.ts"))


def fmt_obs(o: dict) -> str:
    def show(tv):
        if not tv:
            return ""
        t, v = tv.get("t"), tv.get("v")
        if t == "string":
            return json.dumps(v if len(v) <= 30 else v[:27] + "...")
        return str(v) if v is not None else t
    args = ", ".join(x for x in [show(o["input"].get("val")), show(o["input"].get("options"))] if x)
    out = o["outcome"]
    res = show(out.get("value")) if out["kind"] == "return" else f"{out['kind']} {out.get('errorName') or ''}".strip()
    return f"f({args}) -> {res}"


@agent.on_event("startup")
async def connect_mailbox(ctx: Context):
    """Register the mailbox with Agentverse using AGENTVERSE_API_KEY (same as the inspector's Connect button)."""
    key = os.environ.get("AGENTVERSE_API_KEY")
    if not key:
        ctx.logger.warning("AGENTVERSE_API_KEY not set: running locally only")
        return

    def connect():
        import time
        time.sleep(3)
        try:
            r = requests.post(f"http://127.0.0.1:{PORT}/connect", json={"user_token": key, "agent_type": "mailbox"}, timeout=30)
            print(f"[rosetta] Agentverse connect: {r.status_code} {r.text[:200]}")
        except Exception as e:
            print(f"[rosetta] Agentverse connect failed: {e}")
    threading.Thread(target=connect, daemon=True).start()
    ctx.logger.info(f"Rosetta service agent {agent.address}")


agent.include(chat, publish_manifest=True)

if __name__ == "__main__":
    agent.run()
