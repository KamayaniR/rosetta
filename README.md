# Rosetta

**Rosetta recovers what undocumented code actually does, lets a human decide which quirks matter, ports it to TypeScript with proof of equivalence, and locks the behavior into a contract so no future AI edit can silently break it.**

AIE Code Summit Hackathon · Nov 7 2026 · Track: **Software Archaeology** · Solo build · Repo: https://github.com/KamayaniR/rosetta

![Rosetta home](docs/screenshots/00-home.png)
*The home screen for a real session started from ASI:One and run by the Fetch.ai agents: 449 runs of the minified original, 35 proven rules (every one signed by the agent that made it), a TypeScript port by Meta Muse Spark with each line colored by its evidence, 100% on a held-out set no agent ever saw, and 17 rules found only by the SubQ Archivist. Each button opens one section.*

---

## Contents
1. [The problem](#the-problem)
2. [What Rosetta does](#what-rosetta-does)
3. [Results](#results)
4. [Walkthrough with screenshots](#walkthrough)
5. [How it works, step by step](#how-it-works)
6. [Sponsor integrations](#sponsor-integrations)
7. [Why you can trust the numbers](#why-you-can-trust-the-numbers)
8. [Run it](#run-it)
9. [Repo map](#repo-map)
10. [Honest caveats](#honest-caveats)
11. [Disclosure: what was built today](#disclosure)

---

## The problem

- Teams depend on code nobody understands: legacy systems, minified bundles, and more and more AI-written code.
- Ports and rewrites **silently change behavior** that other systems depend on.
- AI-written ports **mix observed facts with guesses**, and nobody can tell which is which.
- Nothing stops the **next AI edit** from breaking the behavior again.

## What Rosetta does

**Input:** a minified JavaScript module whose source the agents never see. The demo target is `ms@2.1.3` by Vercel, minified with terser `--toplevel`, so every name is mangled. The agents are told only: *"Module exports a single function `f(val, options?)`."*

**Output:**

| # | Output | Where |
|---|---|---|
| 1 | A clean, typed **TypeScript port**; every line tagged with the rules it implements (`// @rule H12`) and the quirks it preserves (`// @quirk H25 fix`) | `out/ms.port.ts`, web UI center |
| 2 | An **evidence ledger**: every rule `inferred` / `proven` / `disproven`, linked to real run IDs, with full status history, **signed by the agent that made it** | web UI right, `GET /sessions/:id/audit` |
| 3 | **Quirk Court**: surprising behaviors a human decides to **Preserve, Fix or Flag**, in the web UI or in **ASI:One chat** | web UI, ASI:One |
| 4 | An **equivalence report**: differential fuzzing, a **held-out set no agent ever saw**, independent property tests, a security pass | Verify tab, `out/report.json` |
| 5 | A **behavioral contract**: an executable vitest + fast-check suite any future change must pass, plus **"try an AI edit"** | `out/contract.test.ts`, Contract tab |

## Results

Two real sessions from today, read straight from the stored reports:

| | **Session A**: started from **ASI:One**, run by **signed Fetch.ai agents** (`s_20261107222044_b7b2`) | **Session B**: main demo, with a Quirk Court **Fix** applied (`s_20261107212548_b7e9`) |
|---|---|---|
| Runs of the minified original | 443 | 470 |
| Rules **proven** / inferred / disproven | **35** / 5 / 16 (one disproven by a live Challenge) | **39** / 4 / 12 |
| Rules found **only by the Archivist** (SubQ) | 17 | 18 |
| Archivist context vs Theorist context | **70,758 vs 8,537 tokens (8.3×)** | **70,887 vs 8,857 tokens (8.0×)** |
| Port written by | **Meta Muse Spark** (`muse-spark-1.1`) | **Meta Muse Spark** |
| Port agreement with all observations | v2 by Muse Spark: 436/436 + 7 intentional (Fix H3, decided in ASI:One) | **448/448** + 22 intentional (Fix H25) |
| Differential fuzz (fast-check) | **2000/2000** | **1759/1759** (+241 Fix-covered inputs checked against the fix) |
| **Held-out** (500 inputs, fixed seed, never shown to any agent) | **100%** | **100%** |
| Held-out, strict *unseen-only* subset | **463/463** | **400/400** |
| Skeptic property tests (Gemini, independent) | 11 proposed, 10 hold, 1 discarded | 14 proposed, 11 hold, 2 discarded |
| Security pass | 0 findings (measured) | 0 findings (measured) |
| Signed agent messages, verified by the backend | **49/49 verified** | (CLI run, unsigned by design) |
| Model calls | 29 (Meta 16, Gemini 7, SubQ 6), **0 agent errors** | 36 (Meta 17, Gemini 13, SubQ 6), 0 agent errors |

**What the agents discovered on their own** (never told what `f` does): it parses durations with every unit alias (`"1h"`, `"2 days"`, `"3 YRS"`, `"1.5ms"`); strings over **100 characters** return `undefined`; `".5"` parses but `"5."`, `"+42"`, `"1e3"` and `"0x2a"` don't; `""` **throws** but `"   "` returns `undefined`; `"42 "` parses but `" 42"` doesn't; **BigInt throws a `TypeError`** instead of the usual `Error`; `NaN` errors print `val=null`; long format uses a **1.5× plural threshold** (`90000` → `"2 minutes"`); `-0` formats as `"0ms"`.

---

<a name="walkthrough"></a>
## Walkthrough with screenshots

The web UI has a home screen (big wordmark, headline numbers, one button per section) and then shows **one section at a time**, with colored navigation pills, live mode or replay with a scrubber, and shareable links (`?session=<id>&view=<section>&mode=replay`).

### 1. Evidence and the port, colored by evidence
![Evidence](docs/screenshots/01-overview.png)
![Port](docs/screenshots/01b-port.png)
- **Evidence, left, Trace:** every run of the minified original (inputs, outputs, source, round). Clicking a rule highlights the runs it cites.
- **Port page:** the TypeScript port in a code editor; each tagged line is **green** if all its rules are proven *and* a real run executed it, **yellow** if a rule is only inferred or the line never ran, **red** if a rule was disproven. Purple marks are quirk lines. Hover a line to see its rules and how many runs executed it.
- **Evidence, right, the ledger:** status, confidence, evidence count, **"signed by theorist ✓"** badges, and **"found by Archivist"** badges.
- **Top strip on every page:** the headline numbers, all computed from stored data.

### 2. Quirk Court: a human decides
![Quirk Court](docs/screenshots/02-quirk-court.png)
Each quirk card shows the rule, why it is surprising, real example runs and a suggested fix, with **Preserve / Fix / Flag**. A **Fix** takes one line of intended behavior; the Skeptic turns it into an exact, testable predicate; **Apply decisions** rebuilds the port, re-verifies and regenerates the contract. Pending means Preserve.

### 2b. Challenge a rule, live
![Challenge](docs/screenshots/13-challenge.png)
*Session A: the H52 card shows a live Challenge that disproved it; its six challenge runs (`.1m`, `.9m`, `.25m`, `.0m`, …) are at the top of Trace.*
Every rule card has a **Challenge** button (live mode). It runs one targeted experiment round on just that rule. Here, challenging **H49** ("long format uses a 1.5× plural threshold for hours"): Muse Spark designed 7 new inputs right at the boundary (`f(5399999, {long:true})` → `"1 hour"`, `f(5400000)` → `"2 hours"`, `f(5400001)` → `"2 hours"`, runs R0471–R0477 at the top of Trace), and the rule **held** ("challenged, held: 7 predictions"). A rule that breaks under a challenge is disproven with the counterexample, and the Theorist immediately proposes a corrected rule, which is tested in the same request. Example: H52's predicate said every `.Nm` string returns 30000 (it had generalized from its one example `.5m`); a challenge ran `.1m` → 6000, `.25m` → 15000, `.0m` → 0 and disproved it. The behavior was fine; the rule was overfitted, which is exactly what a challenge should catch. **Stop session** in the top bar stops a running session in either orchestrator: running steps finish, and no new step starts.

### 3. Verify: equivalence, held-out, properties, divergences, conflicts, security
![Verify](docs/screenshots/03-verify.png)
- **Fuzz:** 2,000 generated inputs run on the original and the port.
- **Held-out:** 500 inputs no agent ever saw, plus the strict **unseen-only** subset.
- **Skeptic properties:** properties that fail on the *original* are discarded as wrong, not counted as port bugs.
- **Intentional divergences:** inputs covered by a Fix, checked against the fix instead.
- **A real conflict Rosetta surfaced:** *"H25 Fix vs H24 Preserve on 20 inputs; the port kept H24; decide which wins."*
- **Security pass:** a ReDoS timing sweep from 10 to 50,000 characters, flat for `ms`.

### 4. Archivist (Subquadratic SubQ): what the summaries miss
![Archivist](docs/screenshots/04-archivist.png)
One SubQ request per round sees the **whole bundle plus the full uncompressed history** (every run, every rule with its history, the quirks): ~70k tokens vs the Theorist's ~8.5k. It reports never-executed code, untested input categories and thin-evidence rules, each with what happened next (a hypothesis was requested, or a challenge queued).

### 4b. Final audit (Archivist Job 3), right before the contract
Every `@rule` / `@quirk` tagged line of the port is checked mechanically: it must cite a rule that exists, is proven (not just inferred or disproven), was executed by a real run, and whose quirk tag matches the Quirk Court decision; executable lines with no tag are listed. Then **one SubQ request** (the whole port plus the full ledger, ~10.8k tokens) answers, for each tagged rule, *"do the lines tagged with it actually implement it?"* On session A's latest port it found the port still citing **H52, which a live Challenge had just disproven**, and **3 tags on code that doesn't implement the rule**. Shown in the Archivist tab and the report (`GET /sessions/:id/port-audit`, `npm run audit -- --session <id>`).

### 5. Agents (Fetch.ai): every claim signed by the agent that made it
![Agents](docs/screenshots/05-agents-signed.png)
The coordinator runs the loop by messaging Tracer, Theorist, Archivist, Builder and Skeptic. Each message and each step request is signed with the sender's identity (`agent1…`, `sig1…`), and the backend **verifies the signature before writing anything**: 49/49 verified in this session.

### 6. Contract: "try an AI edit"
![Contract blocking an AI edit](docs/screenshots/06-contract.png)
A sneaky "simplification" (plural threshold `1.5` → `2`) is pasted as an AI edit. The contract runs it **inside the sandbox** and reports **BLOCKED: 4 contract tests fail**, naming H20, H37, H49 and the held-out snapshot, each with the exact failing input (`f(90000, {long: true})`: expected `"2 minutes"`, got `"2 minute"`). The same contract is written to `out/contract.test.ts` for vitest.

### 7. Port history: the loop fixing a real failure
![Port history](docs/screenshots/07-port-history.png)
Every port version with its model, compile result, agreement mismatches, never-executed lines and verify results. In session B, applying the trim Fix: **v2 failed (11 disagreements)** because the Skeptic's first fix rule was wider than the fix spec; it was re-derived as an exact *transform* (`new f(x) = original f(x.trim())`), and **v3/v4 pass**.

### 8. Report
![Report](docs/screenshots/08-report.png)

### 9. Reveal: the original source next to the recovered port
![Reveal](docs/screenshots/09-reveal.png)
The original `ms` source is behind a path allowlist the agents cannot pass; only this endpoint reads it, and only after the session ends.

### 10. ASI:One chat with interactive cards (tested live)
| Progress card | Quirk Court cards (Preserve / Fix / Flag) | Report card |
|---|---|---|
| ![](docs/screenshots/10-asi-progress-card.png) | ![](docs/screenshots/11-asi-quirk-cards.png) | ![](docs/screenshots/12-asi-report-card.png) |

The whole session A was started from ASI:One: `@rosetta demo` → "Session started" → `status` returns a **progress card** (phase, rules proven, held-out match, Open live session) → `quirks` returns one **Quirk Court card** per quirk with the rule, why it's surprising, real example runs, a suggested fix and **Preserve / Fix / Flag** → **Fix** opens a one-line **form** (or type `fix H3: <intended behavior>`) → the final **report card** shows 36 rules proven, the decisions (H3 = fix, decided in chat), 100% held-out (500/500), intentional divergences, and **Download port / View contract / Open session**. Decisions made in chat go to the same `quirks` collection as the web UI, and the rebuilt port implements them.

---

<a name="how-it-works"></a>
## How it works, step by step

```
 ASI:One chat ──► rosetta (Agentverse, chat protocol + cards)
                          │
 Web UI (React, Monaco) ◄─SSE── Backend (Fastify, TypeScript) ◄── signed requests ── Fetch.ai uAgents Bureau
                          │                                              coordinator → tracer · theorist · archivist · builder · skeptic
             sandbox (worker_threads + vm)            MongoDB Atlas (ledger, events → replay)
             Meta Muse Spark · Gemini · SubQ Snap
```

| Step | What happens | Model / mechanism | Code |
|---|---|---|---|
| **1. Trace** | ~60 seed inputs covering every JS type, string shapes and number edge cases, each run with and without `{long: true}`. Every call runs **3×** (nondeterminism check) in a fresh `vm` context: null-prototype global, **no host objects** (inputs/outputs cross as JSON strings), 200 ms timeout, TZ=UTC, side-effect log (`Date`, `console`, `process`, …). Tested against 5 sandbox-escape attempts | Gemini (seeds) | `src/sandbox/`, `src/tracer.ts`, `src/seeds.ts` |
| **2. Hypothesize** | Rules that cite run IDs, each with a mechanical predicate (`applies` / `holds` JS expressions). Cited run IDs that don't exist → rejected and re-asked once. A rule already contradicted by existing runs → disproven at once. Duplicates dropped by behavior + wording | **Meta Muse Spark** | `src/theorist.ts`, `src/hypotheses.ts`, `src/predicate.ts` |
| **3. Experiment** | 3–8 targeted inputs per rule, ≥ 1 designed to **disprove** it. Each input is declared twice (a JS call string and structured values), checked in the sandbox **before** running; a mismatch voids the experiment, not the rule. All predictions hold → **proven**; any contradiction → **disproven** with the counterexample; otherwise it stays inferred | **Meta Muse Spark** | `src/loop.ts`, `src/declared.ts` |
| **4. Archivist** (every round) | The bundle is mapped mechanically from the AST (branches, case-label groups, comparisons with constants, regexes); the **instrumented original** records which code each run executed. One SubQ request with the full bundle + full history answers ~150 typed questions (which rule explains each code feature, is the evidence thin, is the rule contradicted, was each input category tested). Gaps → "found by Archivist" rules for the next round; thin rules → challenges | **SubQ Snap** | `src/archivist.ts`, `src/archivist-step.ts`, `src/coverage.ts` |
| **5. Quirk Court** | Gemini flags surprising behaviors. A human decides in the web UI or ASI:One. **Fix** → the Skeptic converts the one-line spec into a `transform` (new f(x) = original f(transform(x))) or `expr` predicate; Fix-covered inputs become **intentional divergences**; a Fix that overlaps another decision is reported as a **conflict** | Gemini | `src/quirks.ts`, `src/contract.ts` |
| **6. Port** | Muse Spark writes the TypeScript from the ledger, the quirk decisions and the minified code (never the ground truth). Strict `tsc` (up to 3 compile retries), a lint that rejects lookup tables of observed inputs, `@rule`/`@quirk` tag map, **line evidence** (which tagged lines real runs executed) | **Meta Muse Spark** | `src/builder.ts`, `src/portcheck.ts`, `src/evidence.ts` |
| **7. Verify** | Differential fuzzing (fast-check, 2,000 inputs), the held-out score (500 inputs, stored apart from observations), Skeptic property tests, shrinking of mismatches to the smallest case, feedback of **fuzz** counterexamples (held-out never becomes an observation), one repair pass | Gemini (Skeptic) | `src/verify.ts`, `src/skeptic.ts` |
| **8. Security** | ReDoS length sweep (10 → 50k chars of adversarial patterns from the bundle's regexes, median of 3, flagged only on a super-linear trend or a timeout), crash/hang and dangerous-capability candidates, Gemini risk rating; findings → Security cards, never auto-fixed | Muse Spark (patterns), Gemini (risk) | `src/security.ts` |
| **9. Contract** | One contract definition, rendered to vitest + fast-check **and** evaluated in the sandbox for "try an AI edit" | | `src/contract.ts` |

**Two orchestrators, same steps.** The **Fetch.ai Bureau** (`agents/bureau.py`) owns the conversation and the loop order; every step is a signed `POST /internal/<step>`. If the Bureau is down, the **Node orchestrator** runs the same steps in-process and its records are marked `unsigned-fallback`. The UI never claims a signature it doesn't have.

**Live and replay share one view.** The UI derives everything from stored state plus events "as of time T": live mode is T = now (server-sent events trigger a refresh); replay animates T from the session start, so any past session can be replayed from MongoDB.

---

## Sponsor integrations

### Meta Muse Spark (`muse-spark-1.1`): the core reasoning and code generation
- **Theorist:** proposes rules from observations, designs experiments (including disproving inputs and declared calls), revises disproven rules, and turns Archivist findings into testable rules. Also proposes adversarial ReDoS patterns from the bundle's regexes.
- **Builder:** writes the TypeScript port with rule and quirk tags, repairs it from compiler errors and shrunk fuzz counterexamples, and implements Quirk Court fixes. Every port records its model: both demo ports are `meta:muse-spark-1.1`.
- Guard rails: 16k output cap (32k for the Builder), 120 s timeout, a 150-call budget per session, and automatic fallback to Gemini on errors or truncation (logged as `provider_switched`). Code: `src/llm.ts`, `src/theorist.ts`, `src/builder.ts`.

### Google Gemini (`gemini-3.8-flash`): independent checks
A **different model from the Theorist**, so the checks don't share its blind spots:
- **Seeds:** the first ~60 inputs.
- **Skeptic:** property tests (it sees only proven claims and the public signature, never the Theorist's reasoning) and Fix predicates.
- **Quirk judge:** flags surprising behaviors.
- **Security risk rating** of proven rules.
- **Fallback** for Meta.

### Subquadratic SubQ (`subq-snap-1.1`, Decisions API): the Archivist
- Every round, **one** `POST /v1/systemone` request carries the whole minified bundle, every code feature, every rule with its full status history, the quirks and every observation, uncompressed (up to the 384K-token window), and asks ~150 typed `choice` / `score` / `noul` questions.
- Measured in both sessions: **~70k tokens of context vs the Theorist's ~8.5k (8×)**. In one session the Archivist's findings took the port's never-executed tagged lines from **39 → 6**; across a full run it found **17–18 rules** the Theorist never proposed.
- The provider sits in `ROUTES.archivist = "subq"`; setting `SUBQ_MODEL=subq-preview` switches `decide()` to a generative model with the same answer shape (our key only allows Snap). Code: `src/archivist.ts`, `src/llm.ts` (`decide`).

### Fetch.ai: identity, provenance and a public agent
- **Six uAgents in a Bureau** (coordinator, tracer, theorist, archivist, builder, skeptic) with stable seeds, so stable `agent1…` addresses (`agents/keys.py`, kept in `.env`). Typed messages: TraceRequest → ObservationBatch, HypothesizeRequest → Hypotheses, ExperimentRequest → RoundDone, ArchivistRequest → Findings, QuirkRequest, BuildRequest → PortReady, VerifyRequest → MismatchReport, SecurityRequest, ContractRequest.
- **Signed provenance:** each request and message is an envelope `{payload, sha256(canonical JSON), signer, secp256k1 signature}` made with the agent's uAgents identity and **verified in Node before any write** (`src/provenance.ts`). Rejected: wrong agent for the step (the Skeptic's results must be signed by the Skeptic), tampered payloads, unknown signers (`npm run provenance-test`).
- **`rosetta` on Agentverse** (`agents/service.py`): an active mailbox agent with the chat protocol, searchable as "rosetta". ASI:One **interactive cards** live in one adapter (`agents/cards.py`): a progress card, Quirk/Security cards with Preserve/Fix/Flag, a Fix form, and a report card. Tested live in ASI:One.

### MongoDB Atlas: the ledger and the replay log
Collections: `observations`, `hypotheses` (with status history and signer), `quirks`, `ports` (every version, rule map, line evidence), `verify_reports`, `diff_results`, `properties`, `contracts`, `archivist_findings`, `bundle_maps`, `security_reports`, `provenance`, `agent_messages`, `events` (the replay log), `heldout_sets`, `reports`, `sessions`. There is an in-memory fallback if Atlas is unreachable (`src/store.ts`).

---

## Why you can trust the numbers

| Claim | How it's checked |
|---|---|
| The agents never saw the original | `src/safeRead.ts` path allowlist; `npm run guard` tests 4 sneaky paths, including `../`. Only the Reveal endpoint reads `ground_truth/`, after the session ends |
| A "proven" rule is real | Proven requires ≥ 3 predictions held, including ≥ 1 designed to disprove it; every live rule is re-checked against each round's new runs |
| No hallucinated evidence | Cited run IDs must exist in MongoDB; code-reading claims from the Archivist start with no evidence until experiments run |
| A bad experiment can't disprove a rule | The declared call is checked against the structured input before running (`npm run declared-test`) |
| Held-out means held-out | Held-out results never enter `observations`; a fuzz counterexample identical to a held-out input is never fed back; the strict unseen-only score is reported too |
| The verifier isn't blind | `npm run mutation-test` plants 3 bugs in the port: all caught and shrunk. `npm run security-sanity`: `/^(a+)+$/` flagged (timeout at 100 chars), `/^a+$/` not flagged |
| Green lines are really proven | Line evidence comes from instrumenting the port: a line is green only if a real run executed it and all of its rules are proven |
| Agent signatures mean something | 5 attack cases rejected (`npm run provenance-test`); the UI shows `unsigned` when a session ran without agents |
| The sandbox is safe for pasted code | 5 escape attempts (`this.constructor.constructor('return process')()` and variants) blocked (`npm run sandbox-test`) |

---

## Run it

**Requirements:** Node 20+, Python 3.11, and a `.env` (copy `.env.example`) with `MODEL_API_KEY` (Meta), `GEMINI_API_KEY`, `MONGODB_URI`, `SUBQ_API_KEY`, `AGENTVERSE_API_KEY`.

```bash
npm install && (cd ui && npm install && npx vite build)
python3 -m venv agents/.venv && agents/.venv/bin/pip install -r agents/requirements.txt
agents/.venv/bin/python agents/keys.py      # stable agent seeds + addresses into .env (never committed)
npm run ping                                 # one test call each: Meta, Gemini, MongoDB

npm run server                               # backend + web UI on http://localhost:8787
agents/.venv/bin/python agents/bureau.py     # Fetch.ai agents (optional; otherwise the Node orchestrator runs, unsigned)
agents/.venv/bin/python agents/service.py    # public `rosetta` agent on Agentverse / ASI:One (optional)
```

- **Web UI:** open `http://localhost:8787` and click **Start session** (~12 min). Replay any finished session with `http://localhost:8787/?session=<id>&mode=replay`; add `&view=evidence|port|court|verify|archivist|agents|contract|history|report|reveal` to open a section directly, and `&view=contract&edit=plural` to load and run the sneaky AI edit.
- **ASI:One:** message `@agent1q0j9cd9fn0krw3q87h4djuhgpy49nglx2ltwkpz43l2vuwqy0xnxc7q65f5 demo` (or paste a JS module). Then `status` for a progress card, `quirks` for the Quirk Court cards, and type `fix H3: <intended behavior>` or use the Fix form.
- **CLI:** `npm run e2e` runs the whole pipeline in a fresh session (~12 min) and writes `out/ms.port.ts`, `out/contract.test.ts` and `out/report.json`. Then run `npx vitest run out/contract.test.ts`.

**Checks:** `npm run guard` · `npm run sandbox-test` · `npm run predicate-test` · `npm run declared-test` · `npm run provenance-test` · `npm run mutation-test -- --session <id> [--version N]` · `npm run security-sanity` · `npm run contract-test` · `npm run typecheck`.

**API extras:** `POST /hypotheses/:hid/challenge {sessionId}` (one targeted experiment round) · `POST /sessions/:id/stop`.

## Repo map

```
src/
  sandbox/        worker.ts (isolated vm harness), runner.ts (batches, timeouts, respawn)
  tracer.ts       runs inputs, stores observations          seeds.ts   Gemini seed inputs
  theorist.ts     Muse Spark: rules + experiments            loop.ts    hypothesize/experiment rounds
  hypotheses.ts   ledger, evidence validation, dedupe         predicate.ts  sandboxed rule checks
  declared.ts     declared-call guard                         coverage.ts / evidence.ts  line-execution tracking
  archivist.ts    bundle map + SubQ review                    archivist-step.ts  findings -> rules / challenges
  quirks.ts       Gemini quirk judge                          builder.ts / portcheck.ts  port, compile, lint, tags
  verify.ts       fuzz, held-out, shrink, divergences         skeptic.ts  Gemini property tests
  security.ts     ReDoS sweep, crashes, capabilities          contract.ts  contract, fix predicates, AI-edit runner
  provenance.ts   signature verification                      steps.ts / server.ts  pipeline steps + Fastify API
  llm.ts          one wrapper: routing, JSON validation, fallback, budgets, SubQ decide()
  store.ts / events.ts / report.ts
agents/           bureau.py (uAgents), service.py (Agentverse/ASI:One), cards.py, signing.py, keys.py
ui/               React + Monaco web UI (live + replay)
scripts/          CLI entry points and checks
target/           minified target (agents read this)        ground_truth/  original ms (agents can't)
targets/          redos_demo.js (written by us for the security demo)
docs/screenshots/ the images in this README
```

## Honest caveats

- One target (`ms`) was run end to end today. Uploaded modules (from ASI:One or `POST /sessions {code}`) use the same pipeline, but the fuzz generators are tuned for string and number inputs.
- A few rules stay `inferred` in every run. They are listed in the report and never claimed as proven, and coverage is measured rather than assumed.
- The Skeptic's Fix predicates can be wrong: one over-wide `expr` predicate failed a correct port. The `transform` form exists because of that, and conflicts between decisions are reported rather than resolved silently.
- **SubQ:** our key only allows the Snap Decisions model, so the Archivist maps the bundle mechanically and uses SubQ to judge it, rather than generating text.
- **ASI:One** shows the agent's replies to your own messages, not messages the agent pushes on its own (Agentverse accepted the pushes, but ASI:One never displayed them), so the chat flow is pull-based (`status`, `quirks`). Agentverse can re-deliver a message, so Rosetta handles each message ID once and allows one running session per chat. This was learned the hard way: 15 duplicate sessions, all stopped.
- **Not deployed:** the demo runs from a laptop (Cloud Run was cut per the plan's cut order), so the "Live view" link in chat is local.
- **Not built:** resume after Stop, the Archivist A/B run and large-bundle scale demo, and deciding experiments for conflicting rules.

<a name="disclosure"></a>
## Disclosure: what was built today

Everything in this repository was written during the hackathon on Nov 7 2026. The only thing prepared before the event was the written spec (idea, architecture and milestones). **Claude Code** was used throughout as an AI coding assistant, writing code under my direction. Third-party code: `ms@2.1.3` by Vercel (MIT license, `ground_truth/LICENSE.ms.md`) as the target. `targets/redos_demo.js` was written by us as a deliberately vulnerable module for the security demo.
