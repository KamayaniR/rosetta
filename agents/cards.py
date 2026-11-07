"""ASI:One interactive cards adapter (§7b Part 2b). ALL card payloads live here so the format is easy to change.

Format (docs.agentverse.ai/documentation/advanced-usages/agent-driven-interactive-cards): a ChatMessage carries a
TextContent narration plus one MetadataContent with string values:
  card_protocol_version="1", requires_card_interaction="true"|"false", card_kind, card_payload=<JSON string>
`detail` cards take summary_rows + a ctas list (3 buttons for Preserve/Fix/Flag); `form` cards take text fields.
If ASI:One rejects a card it shows the TextContent, so every narration includes numbered plain-text options.
"""
import json, re
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from uagents_core.contrib.protocols.chat import ChatMessage, MetadataContent, TextContent

MAX_PAYLOAD = 60_000  # docs limit is 64 KB


def _msg(text: str, kind: Optional[str] = None, payload: Optional[dict] = None, interactive: bool = True) -> ChatMessage:
    content = [TextContent(type="text", text=text)]
    if kind and payload is not None:
        body = json.dumps(payload, ensure_ascii=False)
        if len(body) <= MAX_PAYLOAD:
            content.append(MetadataContent(type="metadata", metadata={
                "card_protocol_version": "1",
                # required to be "true" (docs); informational cards are marked with is_terminal instead
                "requires_card_interaction": "true",
                **({} if interactive else {"is_terminal": "true"}),
                "preferred_drawer_width_px": "540",
                "card_kind": kind,
                "card_payload": body,
            }))
    return ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(), content=content)


def text(t: str) -> ChatMessage:
    return _msg(t)


def _rows(pairs: list[tuple[str, str]]) -> list[dict]:
    return [{"label": k, "value": str(v)[:300]} for k, v in pairs if v not in (None, "")]


def progress_card(session_id: str, phase: str, rules: dict, match_rate: Optional[float], ui_url: str) -> ChatMessage:
    mr = f"{match_rate * 100:.1f}%" if match_rate is not None else "n/a yet"
    rows = _rows([("Session", session_id), ("Phase", phase), ("Proven", rules.get("proven", 0)),
                  ("Inferred", rules.get("inferred", 0)), ("Disproven", rules.get("disproven", 0)), ("Held-out match", mr)])
    payload = {"title": f"Rosetta · {phase}", "summary_rows": rows,
               "ctas": [{"label": "Open live session", "selection": {"action": "open_session", "session": session_id, "url": ui_url}, "primary": True}]}
    t = (f"Session {session_id}: {phase}. Rules proven {rules.get('proven', 0)}, inferred {rules.get('inferred', 0)}, "
         f"disproven {rules.get('disproven', 0)}. Held-out match: {mr}. Live view: {ui_url}")
    return _msg(t, "detail", payload, interactive=False)


def quirk_card(session_id: str, q: dict, examples: list[str], security: bool = False) -> ChatMessage:
    hid = q["hid"]
    tag = "Security" if security else "Quirk"
    rows = _rows([("Rule", f"{hid}: {q.get('claim', '')}"), ("Why surprising", q.get("reason", "")),
                  ("Examples", " | ".join(examples[:3])), ("Suggested fix", q.get("suggestedFix", "")),
                  ("Tag", tag), ("Current decision", q.get("decision", "pending"))])
    sel = lambda a: {"action": a, "hid": hid, "session": session_id}  # noqa: E731
    ctas = [{"label": "Preserve", "selection": sel("preserve"), "primary": not security},
            {"label": "Fix", "selection": sel("fix"), "primary": security},
            {"label": "Flag", "selection": sel("flag")}]
    t = (f"[{tag}] {hid}: {q.get('claim', '')}\nWhy: {q.get('reason', '')}\nExamples: {'; '.join(examples[:3])}\n"
         f"Reply 1 to Preserve, 2 to Fix, 3 to Flag (e.g. \"2 {hid}\").")
    return _msg(t, "detail", {"title": f"{tag} Court · {hid}", "summary_rows": rows, "ctas": ctas})


def fix_form(session_id: str, hid: str, suggested: str = "") -> ChatMessage:
    payload = {"title": f"Fix {hid}: intended behavior",
               "fields": [{"name": "fix_spec", "kind": "text", "label": "One line describing the intended behavior", "required": True}],
               "submit_cta": {"label": "Save fix", "selection": {"action": "fix_spec", "hid": hid, "session": session_id}}}
    t = f"Describe the intended behavior for {hid} in one line (reply: \"fix {hid}: <behavior>\"). Suggested: {suggested}"
    return _msg(t, "form", payload)


def report_card(session_id: str, report: dict, ui_url: str, port_url: str) -> ChatMessage:
    r = report.get("rules", {})
    v = report.get("verify") or {}
    held = (v.get("heldout") or {})
    quirks = report.get("quirks", [])
    pending = [q["hid"] for q in quirks if q.get("decision") == "pending"]
    decided = [f"{q['hid']}={q['decision']}" for q in quirks if q.get("decision") != "pending"]
    divergences = [q["hid"] for q in quirks if q.get("decision") == "fix"]
    rows = _rows([("Rules proven", r.get("proven", 0)), ("Inferred / disproven", f"{r.get('inferred', 0)} / {r.get('disproven', 0)}"),
                  ("Quirks", f"{len(quirks)} ({', '.join(decided) or 'none decided'}; pending = preserve: {', '.join(pending) or 'none'})"),
                  ("Held-out match", f"{held.get('matchRate', 0) * 100:.1f}% ({held.get('equal', 0)}/{held.get('total', 0)})" if held else "n/a"),
                  ("Unseen-only held-out", f"{(held.get('unseen') or {}).get('matchRate', 0) * 100:.1f}%" if held else "n/a"),
                  ("Intentional divergences", ", ".join(divergences) or "none")])
    ctas = [{"label": "Download port", "selection": {"action": "download_port", "session": session_id, "url": port_url}, "primary": True},
            {"label": "View contract", "selection": {"action": "view_contract", "session": session_id}},
            {"label": "Open session", "selection": {"action": "open_session", "session": session_id, "url": ui_url}}]
    t = (f"Rosetta finished {session_id}: {r.get('proven', 0)} rules proven, held-out match "
         f"{held.get('matchRate', 0) * 100:.1f}%. Port: {port_url}  Session: {ui_url}\nReply 1 Download port, 2 View contract, 3 Open session.")
    return _msg(t, "detail", {"title": "Rosetta report", "summary_rows": rows, "ctas": ctas})


# ---------- parsing taps (selection JSON for @mentions, prose for planner-mediated, numbered fallback) ----------
ACTIONS = ("preserve", "fix", "flag", "fix_spec", "download_port", "view_contract", "open_session")
NUMBERED_QUIRK = {"1": "preserve", "2": "fix", "3": "flag"}
NUMBERED_REPORT = {"1": "download_port", "2": "view_contract", "3": "open_session"}


def strip_mentions(t: str) -> str:
    """ASI:One prefixes messages with '@agent1…' mentions; remove them before parsing."""
    return re.sub(r"^(\s*@\S+)+\s*", "", t).strip()


def parse_tap(t: str, last_quirk: Optional[str] = None, last_card: str = "quirk") -> Optional[dict]:
    s = strip_mentions(t)
    # selection JSON (direct @mention taps), possibly embedded in surrounding text
    if "{" in s and "}" in s:
        try:
            obj = json.loads(s[s.index("{"): s.rindex("}") + 1])
            if isinstance(obj, dict) and obj.get("action") in ACTIONS:
                return obj
        except Exception:
            pass
    low = s.lower()
    hid = (re.search(r"\bH\d+\b", s) or [None])[0] if re.search(r"\bH\d+\b", s) else last_quirk
    m = re.match(r"^\s*fix\s+(H\d+)\s*:\s*(.+)$", s, re.I)
    if m:
        return {"action": "fix_spec", "hid": m.group(1).upper(), "fix_spec": m.group(2).strip()}
    m = re.match(r"^\s*([123])\b", s)
    if m:
        action = (NUMBERED_REPORT if last_card == "report" else NUMBERED_QUIRK)[m.group(1)]
        return {"action": action, "hid": hid}
    # planner-mediated form submissions arrive as prose, e.g. 'The user submitted fix_spec "..." for H27'
    if hid and re.search(r"fix_spec|intended behavio|save fix|submitted", low):
        q = re.search(r'["\u201c\u2018\']([^"\u201d\u2019\']{8,})["\u201d\u2019\']', s)
        spec = q.group(1) if q else (s.split(":", 1)[1].strip() if ":" in s else "")
        if spec:
            return {"action": "fix_spec", "hid": hid, "fix_spec": spec}
    for a in ("preserve", "flag", "fix"):
        if re.search(rf"\b{a}\b", low) and hid:
            return {"action": a, "hid": hid}
    return None


def looks_like_code(t: str) -> bool:
    return bool(re.search(r"module\.exports|exports\.|function\s*\w*\s*\(|=>|\bvar\b|\bconst\b", t)) and len(t) > 40


def extract_code(t: str) -> str:
    m = re.search(r"```(?:js|javascript)?\s*\n([\s\S]*?)```", t)
    return (m.group(1) if m else t).strip()
