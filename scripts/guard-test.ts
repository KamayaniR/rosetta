import { safeRead } from "../src/safeRead.ts";
const ok = safeRead("target/ms.min.js").length > 0;
let blocked = 0;
for (const p of ["ground_truth/ms.original.js", "target/../ground_truth/ms.original.js", "/etc/passwd", "package.json"]) {
  try { safeRead(p); console.log("LEAK", p); } catch { blocked++; }
}
console.log(ok && blocked === 4 ? "guard OK" : "guard FAIL");
