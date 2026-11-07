"""Generate stable seeds for Rosetta's agents and append seeds + addresses to ../.env (never committed).
Re-running keeps existing seeds (stable addresses across runs)."""
import os, secrets, pathlib
from uagents_core.identity import Identity

AGENTS = ["coordinator", "tracer", "theorist", "builder", "skeptic", "archivist", "rosetta_service"]
env_path = pathlib.Path(__file__).resolve().parent.parent / ".env"
existing = dict(l.split("=", 1) for l in env_path.read_text().splitlines() if "=" in l)
lines = []
for name in AGENTS:
    key = f"AGENT_SEED_{name.upper()}"
    seed = existing.get(key) or f"rosetta-{name}-{secrets.token_hex(24)}"
    addr = Identity.from_seed(seed, 0).address
    if key not in existing:
        lines.append(f"{key}={seed}")
    if f"AGENT_ADDR_{name.upper()}" not in existing:
        lines.append(f"AGENT_ADDR_{name.upper()}={addr}")
    print(f"{name:16} {addr}")
if lines:
    with env_path.open("a") as f:
        f.write("\n" + "\n".join(lines) + "\n")
