import { readFileSync } from "node:fs";
import { verifyEnvelope } from "../src/provenance.ts";
const { good, skeptic } = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log("python-signed theorist envelope:", verifyEnvelope(good, "theorist"));
console.log("tampered payload:              ", verifyEnvelope({ ...good, payload: { ...good.payload, round: 3 } }));
console.log("signed by skeptic, claimed theorist:", verifyEnvelope(skeptic, "theorist"));
console.log("forged signer address:         ", verifyEnvelope({ ...good, signer: skeptic.signer }));
console.log("unknown signer:                ", verifyEnvelope({ ...good, signer: "agent1qfakefakefakefakefakefakefakefakefakefakefakefakefakefake" }));
