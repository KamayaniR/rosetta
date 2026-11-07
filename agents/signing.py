"""Canonical JSON + signing, mirrored in src/provenance.ts. Agents sign sha256(canonical(payload))."""
import hashlib, json
from uagents_core.identity import Identity

def canonical(x) -> str:
    if isinstance(x, dict):
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{canonical(v)}" for k, v in sorted(x.items())) + "}"
    if isinstance(x, list):
        return "[" + ",".join(canonical(v) for v in x) + "]"
    if isinstance(x, bool) or x is None:
        return json.dumps(x)
    if isinstance(x, float) and x.is_integer():
        return str(int(x))
    return json.dumps(x, ensure_ascii=False)

def payload_hash(payload) -> str:
    return hashlib.sha256(canonical(payload).encode()).hexdigest()

def envelope(identity: Identity, payload) -> dict:
    h = payload_hash(payload)
    return {"payload": payload, "payloadHash": h, "signer": identity.address, "signature": identity.sign_digest(bytes.fromhex(h))}
