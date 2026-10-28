/** Entry point: GitHub Actions workflow files → readiness report + .gitlab-ci.yml. */
import { parse } from "yaml";
import { emit, type EmitJob } from "./emit";
import { newContext, translateInline } from "./expressions";
import { convertConcurrency, convertJob, convertPermissions, worst } from "./jobs";
import { convertTriggers } from "./triggers";
import type { Finding, JobReport, Report, Rule, Status, WorkflowFile, WorkflowReport } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

const WEIGHT: Record<Status, number> = { clean: 1, manual: 0.5, none: 0 };

/** Push + MR triggers on GitLab run two pipelines per commit unless branch pipelines are skipped for open MRs. */
const DUPLICATE_PIPELINE_GUARD: Rule = { if: '$CI_PIPELINE_SOURCE == "push" && $CI_OPEN_MERGE_REQUESTS', when: "never" };

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "ci";
}

function and(a?: string, b?: string): string | undefined {
  const wrap = (s: string) => (s.includes("||") ? `(${s})` : s);
  if (a && b) return `${wrap(a)} && ${wrap(b)}`;
  return a ?? b;
}

function combine(trigger: Rule, job: Rule | undefined): Rule {
  const r: Rule = {};
  const cond = and(trigger.if, job?.if);
  if (cond) r.if = cond;
  if (trigger.changes) r.changes = trigger.changes;
  const when = trigger.when === "never" ? "never" : job?.when;
  if (when) r.when = when;
  return r;
}

export function verdictFor(score: number): string {
  if (score >= 85) return "Ready to migrate";
  if (score >= 60) return "Mostly ready, some manual work";
  return "Significant manual work";
}

interface ParsedWorkflow {
  path: string;
  name: string;
  stage: string;
  doc: Obj;
  jobs: Obj;
}

export function analyze(files: WorkflowFile[]): Report {
  const errors: Report["errors"] = [];
  const parsed: ParsedWorkflow[] = [];
  const usedStages = new Set<string>();

  for (const file of files) {
    let doc: unknown;
    try {
      doc = parse(file.content);
    } catch (e) {
      errors.push({ path: file.path, message: e instanceof Error ? e.message.split("\n")[0] : String(e) });
      continue;
    }
    if (!isObj(doc) || !isObj(doc.jobs)) {
      errors.push({ path: file.path, message: "Not a GitHub Actions workflow (no `jobs:` map)" });
      continue;
    }
    const base = file.path.split("/").pop()!.replace(/\.ya?ml$/, "");
    const name = typeof doc.name === "string" ? doc.name : base;
    let stage = slug(base);
    for (let n = 2; usedStages.has(stage); n++) stage = `${slug(base)}-${n}`;
    usedStages.add(stage);
    parsed.push({ path: file.path, name, stage, doc, jobs: doc.jobs });
  }

  // GitLab job names are global; prefix with the stage only when ids collide.
  const idCount = new Map<string, number>();
  for (const wf of parsed) for (const id of Object.keys(wf.jobs)) idCount.set(id, (idCount.get(id) ?? 0) + 1);
  const gitlabName = (wf: ParsedWorkflow, id: string) => ((idCount.get(id) ?? 0) > 1 ? `${wf.stage}-${id}` : id);

  const single = parsed.length === 1;
  const secrets = new Set<string>();
  const workflows: WorkflowReport[] = [];
  const jobs: JobReport[] = [];
  const emitJobs: EmitJob[] = [];
  const workflowRules: Rule[] = [];
  let topVariables: Record<string, string> | undefined;
  let topDefault: Obj | undefined;
  let needsDuplicateGuard = false;

  parsed.forEach((wf, wfIndex) => {
    const findings: Finding[] = [];
    const ctx = { ...newContext(), secrets };
    const triggers = convertTriggers(wf.doc.on);
    findings.push(...triggers.findings);
    if (triggers.hasPush && triggers.hasMergeRequest) {
      needsDuplicateGuard = true;
      findings.push({
        feature: "push + pull_request",
        status: "clean",
        reason: "GitLab would run a branch pipeline and an MR pipeline per commit; a `workflow:rules` guard skips branch pipelines while an MR is open",
      });
    }

    // Workflow-level env / concurrency go to the top level for one workflow, into each job otherwise.
    const wfVars: Record<string, string> = {};
    if (isObj(wf.doc.env)) {
      const issues: string[] = [];
      for (const [k, v] of Object.entries(wf.doc.env)) {
        const t = translateInline(String(v), ctx);
        wfVars[k] = t.text;
        issues.push(...t.issues);
      }
      findings.push(issues.length
        ? { feature: "env", status: "manual", reason: `→ \`variables:\`; ${[...new Set(issues)].join("; ")}` }
        : { feature: "env", status: "clean", reason: "→ top-level `variables:`" });
    }
    const conc = convertConcurrency(wf.doc.concurrency, findings, "");
    convertPermissions(wf.doc.permissions, findings, "");
    const defaults = isObj(wf.doc.defaults) ? wf.doc.defaults : undefined;
    if (defaults && isObj(defaults.run)) {
      const shell = defaults.run.shell;
      findings.push(shell && !/^(bash|sh)/.test(String(shell))
        ? { feature: "defaults.run", status: "manual", reason: `Default shell \`${shell}\` → GitLab Linux jobs use bash/sh` }
        : { feature: "defaults.run", status: "clean", reason: "Default working directory → `cd` at the start of each job" });
    }

    if (single) {
      workflowRules.push(...triggers.rules);
      if (Object.keys(wfVars).length) topVariables = wfVars;
      if (conc.interruptible) topDefault = { interruptible: true };
    } else {
      for (const r of triggers.rules) {
        if (r.when === "never") continue;
        if (!workflowRules.some((x) => JSON.stringify(x) === JSON.stringify(r))) workflowRules.push(r);
      }
    }

    for (const [id, rawJob] of Object.entries(wf.jobs)) {
      if (!isObj(rawJob)) continue;
      const jobCtx = { ...newContext(), secrets };
      const name = gitlabName(wf, id);
      const converted = convertJob(id, rawJob, jobCtx, defaults, (n) => gitlabName(wf, n));
      const body: Obj = { stage: wf.stage, ...converted.body };

      let needs = converted.needs;
      if (!needs && wfIndex > 0) needs = []; // don't wait for earlier workflows' stages
      if (needs) body.needs = needs;

      let rules: Rule[] | undefined;
      if (!single) {
        if (triggers.rules.length) rules = triggers.rules.map((r) => combine(r, converted.rule));
        else {
          rules = [{ when: "never" }];
          converted.todos.push("TODO: this workflow has no push/MR/schedule trigger; decide when this job should run");
        }
      } else if (converted.rule && (converted.rule.if || converted.rule.when)) {
        rules = [converted.rule];
      }
      if (rules) body.rules = rules;
      if (!single) {
        if (Object.keys(wfVars).length) body.variables = { ...wfVars, ...(body.variables as Obj | undefined) };
        if (conc.interruptible && body.interruptible === undefined) body.interruptible = true;
      }

      emitJobs.push({ name, body, script: converted.script, afterScript: converted.afterScript, todos: converted.todos });
      jobs.push({
        workflow: wf.name,
        id,
        gitlabName: name,
        status: worst(converted.findings.map((f) => f.status)),
        findings: converted.findings,
      });
    }
    workflows.push({ path: wf.path, name: wf.name, findings });
  });

  if (needsDuplicateGuard && workflowRules.length) workflowRules.unshift(DUPLICATE_PIPELINE_GUARD);

  const all = [...workflows.flatMap((w) => w.findings), ...jobs.flatMap((j) => j.findings)];
  const counts: Record<Status, number> = { clean: 0, manual: 0, none: 0 };
  for (const f of all) counts[f.status]++;
  const score = all.length ? Math.round((100 * all.reduce((s, f) => s + WEIGHT[f.status], 0)) / all.length) : 0;

  const header = [
    `Generated by CI Migration Checker from ${parsed.map((p) => p.path).join(", ") || "no workflows"}.`,
    "This is a starting point: search for TODO, review every job, and test on a branch.",
  ];
  if (secrets.size) {
    header.push(`Add these as masked CI/CD variables (Settings > CI/CD > Variables): ${[...secrets].sort().join(", ")}`);
  }
  const gitlabCi = parsed.length
    ? emit({
        header,
        workflowRules: workflowRules.length ? workflowRules : undefined,
        stages: parsed.map((p) => p.stage),
        variables: topVariables,
        default: topDefault,
        jobs: emitJobs,
      })
    : "";
  const todoCount = (gitlabCi.match(/TODO:/g) ?? []).length;

  return {
    score,
    verdict: parsed.length ? verdictFor(score) : "No workflows found",
    counts,
    workflows,
    jobs,
    secrets: [...secrets].sort(),
    errors,
    gitlabCi,
    todoCount,
  };
}
