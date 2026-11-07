# Rosetta: software archaeology agent

Rosetta recovers what undocumented code actually does, lets a human decide which quirks matter, ports it to TypeScript with proof of equivalence, and locks the behavior into a contract.

**Use it before you touch code you don't understand.**

## How to call it
- Paste a JavaScript module (CommonJS, `module.exports = function ...`, up to 200 KB), or a URL to one.
- Or say **"demo"** to run on a minified copy of `ms`.

## What you get back
1. A progress card at every phase (trace, hypothesize, experiment, Quirk Court, port, verify).
2. **Quirk Court in chat**: one card per surprising behavior with **Preserve / Fix / Flag**. Fix asks for one line describing the intended behavior.
3. A report card: rules proven, quirks and decisions, held-out match rate, intentional divergences, with Download port / View contract / Open session.

Every claim in the evidence ledger is signed by the Rosetta agent that made it (Tracer, Theorist, Archivist, Builder, Skeptic).
