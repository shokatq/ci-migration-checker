// Survey: run the converter over folders of downloaded workflows (one folder per repo)
// and print a summary table plus the most common gaps.
// Usage: npm run survey -- <dir-with-one-subfolder-per-repo>
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { analyze } from "../src/engine/analyze";

const root = process.argv[2];
if (!root) {
  console.error("Usage: npm run survey -- <dir>");
  process.exit(1);
}

const gaps = new Map<string, number>();
const rows: string[] = [];
for (const repo of readdirSync(root).filter((d) => statSync(path.join(root, d)).isDirectory())) {
  const dir = path.join(root, repo);
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ path: `.github/workflows/${f}`, content: readFileSync(path.join(dir, f), "utf8") }));
  let report;
  try {
    report = analyze(files);
  } catch (e) {
    rows.push(`| ${repo} | CRASH: ${(e as Error).message} |`);
    continue;
  }
  let valid = "yes";
  let broken = 0;
  try {
    // Every `needs:` entry must name a job that exists in the generated file.
    const ci = (parse(report.gitlabCi) ?? {}) as Record<string, { needs?: string[] } | null>;
    for (const job of Object.values(ci)) for (const n of job?.needs ?? []) if (!ci[n]) broken++;
  } catch (e) {
    valid = `NO: ${(e as Error).message.split("\n")[0]}`;
  }
  const { clean, manual, none } = report.counts;
  rows.push(`| ${repo} | ${files.length} | ${report.jobs.length} | ${report.score} | ${clean} | ${manual} | ${none} | ${report.errors.length} | ${valid} | ${broken} |`);
  for (const f of [...report.workflows.flatMap((w) => w.findings), ...report.jobs.flatMap((j) => j.findings)]) {
    if (f.status === "clean") continue;
    const key = `[${f.status}] ${f.feature.replace(/^.*\((uses: [^@)]+).*$/, "$1").replace(/@.*/, "").replace(/^(if|runs-on): .*/, "$1")}`;
    gaps.set(key, (gaps.get(key) ?? 0) + 1);
  }
}
console.log("| Repo | Workflows | Jobs | Score | Clean | Manual | None | Parse errors | Valid YAML | Broken needs |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |");
console.log(rows.join("\n"));
console.log("\nMost common gaps:");
for (const [k, n] of [...gaps].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${String(n).padStart(4)}  ${k}`);
