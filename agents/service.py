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
# processed message ids survive restarts, so re-delivered messages never start duplicate sessions
SEEN_PATH = os.path.join(os.path.dirname(__file__), ".seen_msgs.json")
try:
    seen_msgs: set[str] = set(json.load(open(SEEN_PATH)))
except Exception:
    seen_msgs = set()
def save_seen():
    try:
        json.dump(sorted(seen_msgs)[-2000:], open(SEEN_PATH, "w"))
    except Exception:
        pass
last_start: dict[str, float] = {}
MIN_START_GAP_S = 120


def ui_url(sid: str) -> str:
    return f"{PUBLIC}/?session={sid}"


def api(method: str, path: str, **kw):
    r = requests.request(method, f"{BACKEND}{path}", timeout=kw.pop("timeout", 30), **kw)
    r.raise_for_status()
    return r.json() if r.content else {}


async def reply(ctx: Context, to: str, msg: ChatMessage):
    kinds = [c.metadata.get("card_kind") for c in msg.content if getattr(c, "type", "") == "metadata"]
    status = await ctx.send(to, msg)
    ctx.logger.info(f"sent to {to[:16]}… {'card ' + kinds[0] if kinds else 'text'}: {getattr(status, 'status', status)} {getattr(status, 'detail', '')}")


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    # Agentverse can re-deliver queued messages (e.g. after a restart): handle each msg_id once
    if str(msg.msg_id) in seen_msgs:
        return
    seen_msgs.add(str(msg.msg_id))
    save_seen()
    t = " ".join(c.text for c in msg.content if isinstance(c, TextContent)).strip()
    ctx.logger.info(f"received from {sender[:16]}…: {t[:300]!r}")
    t = cards.strip_mentions(t)
    if not t:
        return
    st = chats.setdefault(sender, {"session": None, "last_quirk": None, "last_card": "quirk", "phase": None, "shown_quirks": set(), "done": False})

    # 1) pull: ASI:One shows replies to the user's own messages, so "status" answers with the latest cards
    low = t.lower().strip().strip("!?.")
    if st["session"] and low in ("status", "update", "progress", "next", "quirks", "report", "cards"):
        want_quirks = low == "quirks"
        msgs = await collect_updates(ctx, st, force_progress=not want_quirks, all_quirks=want_quirks)
        if want_quirks and not st.get("quirks"):
            await reply(ctx, sender, cards.text("No quirks yet: Quirk Court starts after the experiment rounds. Say \"status\" to see the phase."))
            return
        for m in msgs[:10]:
            await reply(ctx, sender, m)
        if not msgs:
            await reply(ctx, sender, cards.text("No update yet."))
        return

    # 2) card taps / numbered replies about the current session
    tap = cards.parse_tap(t, st["last_quirk"], st["last_card"]) if st["session"] else None
    if tap:
        await handle_tap(ctx, sender, st, tap)
        return

    # one running session per chat: anything that isn't a command shows its status (say "new ..." to start another)
    if st["session"] and not st.get("done") and not low.startswith("new"):
        msgs = await collect_updates(ctx, st, force_progress=True)
        await reply(ctx, sender, cards.text(f"Session {st['session']} is still running. Say \"status\" for updates, \"quirks\" for the quirk cards, or \"new demo\" to start another session."))
        for m in msgs[:3]:
            await reply(ctx, sender, m)
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
    import time as _t
    if _t.time() - last_start.get(sender, 0) < MIN_START_GAP_S:
        await reply(ctx, sender, cards.text("A session was just started from this chat; wait a couple of minutes or say \"status\"."))
        return
    last_start[sender] = _t.time()
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
                                          f"Live view: {ui_url(sid)}. A full run takes about 12 minutes. "
                                          f"Say \"status\" any time for the latest card; quirk cards with Preserve / Fix / Flag arrive after the experiments."))


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


def restore_chats():
    """After a restart, reattach to unfinished sessions started from ASI:One (caller stored by the backend)."""
    try:
        for s in requests.get(f"{BACKEND}/sessions", timeout=10).json():
            src = s.get("source") or {}
            if src.get("kind") == "agentverse" and src.get("caller") and not s.get("aborted") and src["caller"] not in chats:  # newest first; finished sessions too (decisions + report)
                chats[src["caller"]] = {"session": s["sessionId"], "last_quirk": None, "last_card": "quirk", "phase": None, "shown_quirks": set(), "done": False}
                print(f"[rosetta] restored chat {src['caller'][:16]}… -> {s['sessionId']}")
    except Exception as e:
        print(f"[rosetta] restore failed: {e}")


async def collect_updates(ctx: Context, st: dict, force_progress: bool = False, all_quirks: bool = False) -> list:
    """Cards for this chat's session: progress (on phase change or when asked), new quirk cards, the final report."""
    sid = st.get("session")
    out = []
    try:
        s = await asyncio.to_thread(api, "GET", f"/sessions/{sid}/state", timeout=20)
    except Exception as e:
        ctx.logger.warning(f"state fetch failed for {sid}: {e}")
        return out
    sess = s.get("session") or {}
    rules = {"proven": 0, "inferred": 0, "disproven": 0}
    for h in s.get("hypotheses", []):
        rules[h["status"]] = rules.get(h["status"], 0) + 1
    mr = ((s.get("verify") or {}).get("heldout") or {}).get("matchRate")
    phase = sess.get("phase")
    if phase and (phase != st["phase"] or force_progress):
        st["phase"] = phase
        out.append(cards.progress_card(sid, phase, rules, mr, ui_url(sid)))
    obs = {o["runId"]: o for o in s.get("observations", [])}
    st["quirks"] = s.get("quirks", [])
    for q in st["quirks"]:
        if q["hid"] in st["shown_quirks"] and not all_quirks:
            continue
        st["shown_quirks"].add(q["hid"])
        hyp = next((h for h in s.get("hypotheses", []) if h["hid"] == q["hid"]), {})
        ex = [f"{rid}: {fmt_obs(obs[rid])}" for rid in q.get("examples", []) if rid in obs]
        st["last_quirk"], st["last_card"] = q["hid"], "quirk"
        out.append(cards.quirk_card(sid, q, ex, security=hyp.get("category") == "security" or q.get("security", False)))
    if sess.get("done") and not st.get("done"):
        st["done"] = True
        report = await asyncio.to_thread(api, "GET", f"/sessions/{sid}/report", timeout=30)
        st["last_card"] = "report"
        out.append(cards.report_card(sid, report, ui_url(sid), f"{PUBLIC}/sessions/{sid}/port.ts"))
    return out


@agent.on_interval(period=8.0)
async def keep_chats(ctx: Context):
    """Pull-only: ASI:One shows the agent's replies to the user's own messages, not unsolicited pushes (pushed
    messages were accepted, never displayed, then failed). So updates are sent when the user says "status".
    This interval only reattaches unfinished ASI:One sessions after a restart."""
    if not getattr(keep_chats, "_restored", False):
        keep_chats._restored = True
        await asyncio.to_thread(restore_chats)


def show_tv(tv) -> str:
    """TaggedValue -> readable JS-ish text (mirrors src/tagged.ts show)."""
    if not tv:
        return ""
    t, v = tv.get("t"), tv.get("v")
    if t == "string":
        return json.dumps(v if len(v) <= 30 else v[:27] + "...")
    if t == "number":
        return str(v)
    if t in ("undefined", "null"):
        return t
    if t in ("nan", "inf", "-inf", "-0"):
        return {"nan": "NaN", "inf": "Infinity", "-inf": "-Infinity", "-0": "-0"}[t]
    if t == "boolean":
        return "true" if v else "false"
    if t == "bigint":
        return f"{v}n"
    if t == "symbol":
        return f"Symbol({v})"
    if t == "function":
        return "function"
    if t == "array":
        return "[" + ", ".join(show_tv(e) for e in v) + "]"
    if t == "object":
        return "{" + ", ".join(f"{k}: {show_tv(e)}" for k, e in v.items()) + "}"
    return str(v)


def fmt_obs(o: dict) -> str:
    inp = o["input"]
    args = [show_tv(inp.get("val"))] if inp.get("val") else []
    if inp.get("options") or inp.get("extra"):
        if not inp.get("val"):
            args.append("undefined")
        args.append(show_tv(inp.get("options")) if inp.get("options") else "undefined")
    args += [show_tv(e) for e in inp.get("extra") or []]
    out = o["outcome"]
    res = show_tv(out.get("value")) if out["kind"] == "return" else f"throws {out.get('errorName') or ''}".strip() if out["kind"] == "throw" else out["kind"]
    return f"f({', '.join(args)}) → {res}"


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
