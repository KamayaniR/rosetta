# Rosetta

**Recover what undocumented code actually does, let a human decide which quirks matter, port it to TypeScript with proof of equivalence, and lock the behavior into a contract so no future AI edit can silently break it.**

AIE Code Summit Hackathon, Nov 7 2026 · Track: **Software Archaeology** · Solo build.

---

## The problem

Teams depend on code nobody understands: legacy systems, minified bundles, and more and more AI-written code. Rewrites silently change behavior that other systems depend on; AI ports mix observed facts with guesses, and nothing stops the next AI edit from breaking the behavior again.

## What Rosetta does

Input: a minified JavaScript module (the demo uses `ms@2.1.3`, minified with all names mangled). **The agents never see the original source.**

Output:
1. A clean, typed **TypeScript port** (`out/ms.port.ts`), every line tagged with the rules it implements.
2. An **evidence ledger**: every rule `inferred` / `proven` / `disproven`, linked to real run IDs, signed by the agent that made it.
3. **Quirk Court** decisions: surprising behaviors a human chose to Preserve, Fix or Flag (web UI or ASI:One chat).
4. An **equivalence report**: differential fuzzing, a held-out set no agent ever saw, and independent property tests.
5. A **behavioral contract** (`out/contract.test.ts`, vitest + fast-check) that any future change must pass, plus "try an AI edit".

## Results (real run, session `s_20261107212548_b7e9`)

| | |
|---|---|
| Observations of the minified original | 470 (129 seed, 341 experiment) |
| Rules | **39 proven**, 4 inferred, 12 disproven by real counterexamples |
| Found only by the Archivist (SubQ) | **18 rules** (7 proven); Archivist context **70,887 tokens vs Theorist 8,857 (8.0×)** |
| Port (written by **Meta Muse Spark**) | agreement **448/448** with all observations (+22 intentional divergences from a Fix) |
| Port lines tagged with a rule but never executed by any run | **1 / 89** (first e2e run before the Archivist retry fix: 23/119; earlier session: 39 → 6 after one Archivist pass) |
| Differential fuzz (fast-check, 2000 inputs) | **1759/1759** equal (+241 Fix-covered inputs checked against the fix) |
| **Held-out** (500 inputs, fixed seed, never shown to any agent) | **100%** · strict unseen-only subset **400/400** |
| Skeptic property tests (Gemini, independent) | 14 proposed · 11 hold on original and port · 2 discarded (failed on the original) |
| Contract | 39 rule groups + 4 Quirk Court tests + held-out snapshot · `npx vitest run out/contract.test.ts` passes (441 tests on the first contract) |
| Security pass | 0 findings for `ms` (measured flat timing 10 → 50,000 chars: it rejects strings > 100 chars before the regex) |
| Model calls | 36 (Meta 17, Gemini 13, SubQ 6), 0 agent errors |

Things the agents discovered on their own (never told what `f` does): units and all aliases (`"1h"`, `"2 days"`, `"3 YRS"`), the 100-char limit, `".5"` parses but `"5."` and `"+42"` don't, `""` throws but `"   "` returns undefined, BigInt throws a `TypeError` instead of the usual `Error`, the 1.5× plural threshold in long format, `-0` formatted as `0ms`.

**The verifier is checked too:** `npm run mutation-test` plants 3 bugs in the port (plural threshold, length cap, rounding); fuzzing catches and shrinks each one. `npm run security-sanity` shows the ReDoS detector flags `/^(a+)+$/` (time-out at 100 chars) and clears `/^a+$/`.

**The loop fixing a real failure:** applying a Quirk Court **Fix** ("trim whitespace before parsing"): port v2 failed the contract (11 disagreements); the Skeptic's fix rule was re-derived as an exact *transform* (`new f(x) = original f(x.trim())`) and port v3/v4 pass it. Rosetta then surfaced a real **conflict between two decisions** (Fix H25 vs Preserve H24 on 20 whitespace-only inputs) instead of hiding it.

## How it works

```
                       ┌────────────── Fetch.ai uAgents Bureau (signed messages) ─────────────┐
 ASI:One chat ──► rosetta_service (Agentverse)        coordinator                               │
 Web UI (React) ◄─SSE── Backend (Fastify, TS) ◄── tracer · theorist · archivist · builder · skeptic
                            │                                                                   │
                     sandbox (worker_threads + vm)          MongoDB Atlas (ledger, events, replay)
```

1. **Trace**: Gemini proposes ~60 seeds knowing only `f(val, options?)`. Each runs 3× in a sandbox (fresh `vm` context per call, null-prototype global, no host objects, 200 ms timeout, TZ=UTC, side-effect log, nondeterminism check).
2. **Hypothesize**: Muse Spark proposes rules citing run IDs, each with a mechanical predicate. Hallucinated run IDs → rejected and re-asked; a rule already contradicted by existing runs is disproven at once.
3. **Experiment**: Muse Spark designs inputs per rule, ≥ 1 meant to disprove it. Each input is declared twice (JS call string + structured input); a mismatch voids the experiment instead of the rule.
4. **Archivist** (every round): the bundle is mapped mechanically (branches, case labels, constants, regexes) and the instrumented original shows which code each run executed. One **SubQ Snap** decision request then sees the whole bundle + full uncompressed history and judges every code feature, rule and input category. Gaps become "found by Archivist" rules.
5. **Quirk Court**: Gemini flags surprising behavior; a human decides Preserve / Fix / Flag. Fix → the Skeptic turns the one-line spec into an exact predicate; Fix-covered inputs become intentional divergences.
6. **Port**: Muse Spark writes the TypeScript with `// @rule` and `// @quirk` tags; strict `tsc`, up to 3 compile retries, lookup-table lint. Line evidence colors each tagged line green (proven + executed) or yellow.
7. **Verify**: differential fuzzing, held-out score, Skeptic properties, shrinking, feedback of fuzz counterexamples (held-out results never become observations).
8. **Security**: ReDoS length sweep (median of 3, trend over ≥ 3 lengths), crash/hang and dangerous-capability candidates, Gemini risk rating; findings become Security cards (never auto-fixed).
9. **Contract**: rendered to vitest and also evaluated in the sandbox for "try an AI edit".

Ground truth (`ground_truth/ms.original.js`) is behind a path allowlist (`src/safeRead.ts`); only the Reveal endpoint reads it, after the session ends.

## Sponsor usage

| Sponsor | Where |
|---|---|
| **Meta Muse Spark** (`muse-spark-1.1`) | Theorist (rules, experiments, revisions, Archivist-finding rules, ReDoS patterns) and Builder (port, repairs, Fix implementation): the core reasoning and code generation |
| **Google Gemini** (`gemini-3.8-flash`) | Seeds, Skeptic property tests, quirk judge, Fix predicates, security risk rating, and automatic fallback when Meta errors or hits its token cap. A different model from the Theorist, so no shared blind spots |
| **Subquadratic SubQ** (`subq-snap-1.1`, Decisions API) | The Archivist: one request with the full bundle + full history (~150 typed questions) every round; measured context vs the Theorist's is reported in the UI. `ROUTES.archivist = "subq"`; `SUBQ_MODEL=subq-preview` switches to the generative model if access is granted |
| **MongoDB Atlas** | Every observation, rule (with status history), port version, verify report, contract, finding, signed provenance record and event; Replay is rebuilt from stored events (in-memory fallback if unreachable) |
| **Fetch.ai** | Coordinator, Tracer, Theorist, Archivist, Builder, Skeptic as uAgents with stable identities; every step request and message is signed (secp256k1) and **verified by the backend before any write** (wrong signer, tampered payload or unknown agent → rejected); `rosetta` is a public chat agent on Agentverse with ASI:One interactive cards (progress, Quirk/Security with Preserve/Fix/Flag, Fix form, report), tested live in ASI:One |

## Run it

Requirements: Node 20+, Python 3.11, a `.env` (copy `.env.example`): `MODEL_API_KEY` (Meta), `GEMINI_API_KEY`, `MONGODB_URI`, `SUBQ_API_KEY`, `AGENTVERSE_API_KEY`.

```bash
npm install && (cd ui && npm install && npx vite build)
python3 -m venv agents/.venv && agents/.venv/bin/pip install -r agents/requirements.txt
agents/.venv/bin/python agents/keys.py      # stable agent seeds + addresses into .env (never committed)
npm run ping                                 # one test call each: Meta, Gemini, MongoDB

npm run server                               # backend + UI on http://localhost:8787
agents/.venv/bin/python agents/bureau.py     # Fetch.ai agents (optional: else the Node orchestrator runs, unsigned)
agents/.venv/bin/python agents/service.py    # public rosetta agent on Agentverse / ASI:One (optional)
```

Open `http://localhost:8787`, click **Start session**. Any finished session: `http://localhost:8787/?session=<id>&mode=replay`.

**ASI:One:** message `@agent1q0j9cd9fn0krw3q87h4djuhgpy49nglx2ltwkpz43l2vuwqy0xnxc7q65f5 demo` (or paste a JS module). Then say `status` for a progress card, `quirks` for Quirk Court cards (Preserve / Fix / Flag; Fix opens a one-line form), and `status` again at the end for the report card. Decisions made in chat land in the same `quirks` collection as the web UI (last write wins).

CLI (no UI): `npm run e2e` runs the whole pipeline in a fresh session (~12 min, ~25 model calls) and writes `out/ms.port.ts`, `out/contract.test.ts`, `out/report.json`.

Checks: `npm run guard` (ground-truth allowlist) · `npm run sandbox-test` (hangs, crashes, escapes) · `npm run provenance-test` (signature attacks) · `npm run declared-test` · `npm run mutation-test -- --session <id>` · `npm run security-sanity` · `npx vitest run out/contract.test.ts`.

## Honest caveats

- One target (`ms`) was run end to end today; uploaded modules (ASI:One or `POST /sessions {code}`) use the same pipeline but the fuzz generators are tuned for string/number inputs.
- A handful of rules stay `inferred` each run; they are listed in the report, never claimed as proven. Coverage is reported, never 100% by assumption.
- The Skeptic's Fix predicates can be wrong (one over-widened `expr` predicate wrongly failed a correct port); the `transform` form exists because of that, and conflicts between decisions are reported rather than resolved silently.
- SubQ: our key only allows the Snap Decisions model, so the Archivist maps the bundle mechanically and uses SubQ to judge it, rather than generating text.
- ASI:One shows the agent's replies to your own messages, not messages the agent pushes on its own (pushes were accepted by Agentverse but never displayed), so the chat flow is pull-based (`status`, `quirks`). Agentverse can re-deliver a message; Rosetta handles each message ID once and allows one running session per chat.
- Not deployed: the demo runs from a laptop (Cloud Run was cut per the plan's cut order); the ASI:One "Live view" link is local.
- Not built: Challenge button / pause-resume endpoints, the Archivist A/B run and large-bundle scale demo, deciding experiments for conflicting rules.

## What was built today (disclosure)

Everything in this repository was written during the hackathon on Nov 7 2026. Before the event: only the written spec (idea, architecture and milestones). AI coding assistant: **Claude Code** was used throughout to write code under my direction. Third-party code: `ms@2.1.3` by Vercel (MIT, `ground_truth/LICENSE.ms.md`) as the target. `targets/redos_demo.js` was written by us as a deliberately vulnerable module for the security demo.

## Repo map

```
src/            backend (TypeScript): sandbox/, tracer, theorist, loop, archivist, builder, verify, skeptic,
                security, contract, provenance, steps, server, store, llm
agents/         Fetch.ai uAgents (Python): bureau.py, service.py (Agentverse/ASI:One), cards.py, signing.py, keys.py
ui/             React + Monaco web UI (live + replay)
scripts/        CLI entry points and checks
target/         minified target (agents read this); ground_truth/ original (agents can't)
targets/        extra demo targets (redos_demo.js)
out/            generated port, contract, report (gitignored)
```
