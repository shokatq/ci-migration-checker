// CLI: npm run convert -- .github/workflows/ci.yml [more.yml...]
// Prints the generated .gitlab-ci.yml to stdout and the report summary to stderr.
import { readFileSync } from "node:fs";
import { analyze } from "../src/engine/analyze";

const files = process.argv.slice(2).map((path) => ({ path: path.replace(/\\/g, "/"), content: readFileSync(path, "utf8") }));
if (!files.length) {
  console.error("Usage: npm run convert -- <workflow.yml>...");
  process.exit(1);
}
const report = analyze(files);
console.log(report.gitlabCi);
console.error(`Score ${report.score}/100 (${report.verdict}) ${JSON.stringify(report.counts)}, ${report.todoCount} TODOs`);
for (const e of report.errors) console.error(`  [error] ${e.path}: ${e.message}`);
for (const w of report.workflows) {
  for (const f of w.findings) if (f.status !== "clean") console.error(`  [${f.status}] ${w.path}: ${f.feature} — ${f.reason}`);
}
for (const j of report.jobs) {
  for (const f of j.findings) if (f.status !== "clean") console.error(`  [${f.status}] ${j.gitlabName}: ${f.feature} — ${f.reason}`);
}
