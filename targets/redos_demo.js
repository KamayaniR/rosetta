// redos_demo.js: WRITTEN BY US TODAY for Rosetta's security demo (§7d). Not third-party code.
// Deliberately vulnerable: the nested quantifier (a+)+ backtracks catastrophically on inputs like "aaaa...ab".
// Rosetta's ReDoS length sweep flags it (time-out at length 100); a safe variant /^a+$/ is not flagged.
module.exports = function isAllAs(s) {
  return /^(a+)+$/.test(String(s));
};
