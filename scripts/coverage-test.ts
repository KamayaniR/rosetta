// Instrument the minified original and check: behavior unchanged, and which code each input reaches.
import { instrument, indexCoverage, labelKey } from "../src/coverage.ts";
import { runBatch } from "../src/sandbox/runner.ts";
import { safeRead } from "../src/safeRead.ts";
import { compareOutcomes, encode, showOutcome } from "../src/tagged.ts";
const src = safeRead("target/ms.min.js");
const ins = instrument(src, "ms.min.js");
console.log(`points ${ins.points.length}, case labels ${ins.labels.length}, instrumented ${src.length} -> ${ins.code.length} chars`);
const vals: [unknown, unknown?][] = [["2h"], ["1 hour"], ["3 YRS"], ["5.5"], [" 42"], [1500, { long: true }], [60000], [true], [""], ["a".repeat(101)]];
const inputs = vals.map(([v, o]) => ({ val: encode(v), ...(o ? { options: encode(o) } : {}) }));
const plain = await runBatch(src, "ms.min.js", inputs, { repeats: 1 });
const inst = await runBatch(ins.code, "ms.min.js", inputs, { repeats: 1 });
const idx = indexCoverage(inst.map((r, i) => ({ runId: `R${i}`, cov: r.coverage })));
inst.forEach((r, i) => {
  const same = compareOutcomes(plain[i].outcome, r.outcome).equal;
  const labs = ins.labels.filter((l) => idx.label.get(labelKey(l))?.includes(`R${i}`)).map((l) => l.value);
  console.log(JSON.stringify(vals[i]).slice(0, 26).padEnd(28), same ? "same" : "DIFFERENT!", showOutcome(r.outcome).slice(0, 30).padEnd(32), `pts ${r.coverage.filter((k) => !k.startsWith("s")).length}`, labs.length ? `case ${labs.join(",")}` : "");
});
const never = ins.points.filter((p) => !idx.point.has(p.id));
console.log(`\nnever reached by these 10 inputs: ${never.length}/${ins.points.length}`);
for (const p of never.slice(0, 8)) console.log("  ", p.kind, JSON.stringify(p.snippet.slice(0, 60)));
console.log("case labels never matched:", ins.labels.filter((l) => !idx.label.has(labelKey(l))).map((l) => l.value).join(" "));
