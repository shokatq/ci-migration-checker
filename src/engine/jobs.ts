/** One GitHub Actions job → one GitLab job plus findings. */
import { convertUses, newJobBuild, type JobBuild } from "./actions";
import { conditionToRule, toVarName, translateInline, type ExprContext } from "./expressions";
import type { Finding, Line, Rule, Status } from "./types";

type Obj = Record<string, unknown>;

export interface ConvertedJob {
  /** Ordered GitLab job keys, except `stage`, `needs` and `rules` (set by the caller). */
  body: Obj;
  needs?: string[];
  rule?: Rule;
  script: Line[];
  afterScript: Line[];
  /** Comments rendered above the job. */
  todos: string[];
  findings: Finding[];
  /** Windows/macOS matrix legs, emitted as sibling jobs `<name>-<suffix>`. */
  variants: PlatformVariant[];
  /** All matrix legs were non-Linux, so only the variants are emitted. */
  noLinuxLegs?: boolean;
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const asList = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const label = (s: string, max = 48) => {
  const first = s.split("\n")[0].trim();
  return first.length > max ? first.slice(0, max - 1) + "…" : first;
};
const LINUX = /^(ubuntu|linux)/i;

/** GitHub sets these environment variables in every step; GitLab has its own names. */
const ENV_RENAMES: Record<string, string> = {
  GITHUB_SHA: "CI_COMMIT_SHA",
  GITHUB_REF_NAME: "CI_COMMIT_REF_NAME",
  GITHUB_REPOSITORY: "CI_PROJECT_PATH",
  GITHUB_REPOSITORY_OWNER: "CI_PROJECT_NAMESPACE",
  GITHUB_RUN_ID: "CI_PIPELINE_ID",
  GITHUB_RUN_NUMBER: "CI_PIPELINE_IID",
  GITHUB_ACTOR: "GITLAB_USER_LOGIN",
  GITHUB_WORKSPACE: "CI_PROJECT_DIR",
  GITHUB_SERVER_URL: "CI_SERVER_URL",
  GITHUB_HEAD_REF: "CI_MERGE_REQUEST_SOURCE_BRANCH_NAME",
  GITHUB_BASE_REF: "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
  GITHUB_JOB: "CI_JOB_NAME",
  GITHUB_ACTIONS: "GITLAB_CI",
};

const RUNNER_FILES: [RegExp, string][] = [
  [/GITHUB_OUTPUT/, "`$GITHUB_OUTPUT` → plain shell variables within the job, or `artifacts:reports:dotenv` to pass values to other jobs"],
  [/GITHUB_ENV/, "`$GITHUB_ENV` → `export NAME=value` (all script lines share one shell)"],
  [/GITHUB_PATH/, "`$GITHUB_PATH` → `export PATH=\"dir:$PATH\"`"],
  [/GITHUB_STEP_SUMMARY/, "no job summaries in GitLab; publish a report as an artifact instead"],
  [/\bGITHUB_REF\b/, "`$GITHUB_REF` is a full ref; GitLab has $CI_COMMIT_BRANCH / $CI_COMMIT_TAG"],
  [/\bRUNNER_(OS|TEMP|ARCH)\b/, "`$RUNNER_*` variables don't exist in GitLab"],
];

function worst(statuses: Status[]): Status {
  return statuses.includes("none") ? "none" : statuses.includes("manual") ? "manual" : "clean";
}

/** Shell + script text of a `run:` step, with GitHub env vars renamed. */
function convertRun(step: Obj, ctx: ExprContext): { text: string; issues: string[]; notes: string[] } {
  const t = translateInline(String(step.run), ctx);
  const notes: string[] = [];
  let text = t.text.replace(/\$\{?([A-Z_]+)\}?/g, (m, name: string) =>
    ENV_RENAMES[name] ? m.replace(name, ENV_RENAMES[name]) : m,
  );
  const issues = [...t.issues];
  for (const [re, msg] of RUNNER_FILES) if (re.test(text)) issues.push(msg);
  if (/\bsudo\s+/.test(text)) {
    text = text.replace(/\bsudo\s+/g, "");
    notes.push("removed `sudo` (Docker jobs run as root)");
  }
  if (/apt(-get)?\s+(-\S+\s+)*install/.test(text) && !/apt(-get)? update/.test(text)) {
    issues.push("Docker images ship without apt lists; run `apt-get update` first");
  }
  const shell = String(step.shell ?? "bash");
  if (!/^(bash|sh)\b/.test(shell)) issues.push(`\`shell: ${shell}\` → GitLab Linux jobs run bash/sh; rewrite or use an image with ${shell}`);
  return { text, issues, notes };
}

function convertMatrix(strategy: Obj, ctx: ExprContext, findings: Finding[]): Obj[] | undefined {
  const m = strategy.matrix;
  if (strategy["max-parallel"] != null) {
    findings.push({ feature: "strategy.max-parallel", status: "none", reason: "No equivalent; GitLab runs as many matrix jobs as runners allow" });
  }
  if (m == null) return undefined;
  if (!isObj(m)) {
    findings.push({ feature: "strategy.matrix", status: "manual", reason: "Dynamic matrix (`fromJSON`) → generate a child pipeline instead" });
    return undefined;
  }
  const notes: string[] = [];
  const keys = Object.keys(m).filter((k) => k !== "include" && k !== "exclude");
  const base: Obj = {};
  for (const k of keys) {
    const values = asList(m[k]);
    if (values.some((v) => isObj(v) || Array.isArray(v))) notes.push(`\`${k}\` has object values; flatten them into separate variables`);
    ctx.matrixVars.set(k, toVarName(k));
    base[toVarName(k)] = values.map((v) => (isObj(v) ? JSON.stringify(v) : String(v)));
  }
  const entries: Obj[] = keys.length ? [base] : [];
  for (const inc of asList(m.include)) {
    if (!isObj(inc)) continue;
    for (const k of Object.keys(inc)) ctx.matrixVars.set(k, toVarName(k));
    const addsCombination = keys.every((k) => k in inc) && keys.some((k) => !asList(m[k]).map(String).includes(String(inc[k])));
    if (!keys.length || addsCombination) {
      entries.push(Object.fromEntries(Object.entries(inc).map(([k, v]) => [toVarName(k), [String(v)]])));
    } else {
      notes.push(`\`include\` entry ${JSON.stringify(inc)} adds values to existing combinations; GitLab can't, so set them per entry`);
    }
  }
  if (m.exclude) notes.push("`exclude` isn't supported; split the matrix into several entries that skip those combinations");
  const total = entries.reduce((sum, e) => sum + Object.values(e).reduce((p: number, v) => p * (v as unknown[]).length, 1), 0);
  if (total > 200) notes.push(`${total} combinations exceeds GitLab's limit of 200`);
  findings.push(
    notes.length
      ? { feature: "strategy.matrix", status: "manual", reason: notes.join("; ") }
      : { feature: "strategy.matrix", status: "clean", reason: `→ \`parallel:matrix\` (${total} jobs)` },
  );
  return entries.length ? entries : undefined;
}

type Platform = "windows" | "macos";

/** GitLab.com hosted runners for non-Linux jobs. */
const PLATFORMS: Record<Platform, { tags: string[]; image?: string; todo: string }> = {
  windows: {
    tags: ["saas-windows-medium-amd64"],
    todo: "TODO: Windows runners (beta) run PowerShell in a VM, not bash in a container; port the script and install the toolchain",
  },
  macos: {
    tags: ["saas-macos-medium-m1"],
    image: "macos-15-xcode-16",
    todo: "TODO: macOS runners need GitLab Premium or Ultimate; pick the macOS image and install the toolchain (e.g. with Homebrew) in script",
  },
};

function platformOf(label: string): Platform | "linux" | "other" {
  if (/windows/i.test(label)) return "windows";
  if (/macos/i.test(label)) return "macos";
  if (LINUX.test(label)) return "linux";
  return "other";
}

/** Matrix legs that must run on another platform, as a sibling GitLab job. */
export interface PlatformVariant {
  platform: Platform;
  suffix: string;
  tags: string[];
  /** undefined = no image (Windows runners use a VM, not a container). */
  image?: string;
  matrix: Obj[];
  todo: string;
}

interface RunsOn {
  tags?: string[];
  /** Set when the whole job runs on Windows or macOS. */
  platform?: Platform;
  variants: PlatformVariant[];
  /** Every matrix leg moved to a variant, so the base job has nothing left to run. */
  noLinuxLegs?: boolean;
}

/**
 * `runs-on` → tags. When it's `${{ matrix.<key> }}` (optionally with a
 * `|| 'ubuntu-latest'` default), Windows/macOS legs are split out of the
 * matrix into sibling jobs on GitLab's hosted Windows/macOS runners.
 */
function convertRunsOn(runsOn: unknown, matrix: Obj[] | undefined, findings: Finding[], todos: string[]): RunsOn {
  const raw = asList(runsOn).map(String);
  const feature = `runs-on: ${raw.join(", ")}`;
  const mref = raw.length === 1 ? /^\$\{\{\s*matrix\.([\w-]+)\s*(?:\|\|\s*'([^']+)')?\s*\}\}$/.exec(raw[0]) : null;
  if (mref && matrix) {
    const v = toVarName(mref[1]);
    const fallback = mref[2] ? platformOf(mref[2]) : "other";
    const split: Record<Platform | "linux" | "other", Obj[]> = { linux: [], windows: [], macos: [], other: [] };
    for (const entry of matrix) {
      if (!entry[v]) {
        split[fallback].push(entry);
        continue;
      }
      const byPlatform = new Map<Platform | "linux" | "other", string[]>();
      for (const os of entry[v] as string[]) byPlatform.set(platformOf(os), [...(byPlatform.get(platformOf(os)) ?? []), os]);
      for (const [platform, values] of byPlatform) split[platform].push({ ...entry, [v]: values });
    }
    matrix.splice(0, matrix.length, ...split.linux);
    const variants: PlatformVariant[] = (["windows", "macos"] as const)
      .filter((p) => split[p].length)
      .map((p) => ({ platform: p, suffix: p, ...PLATFORMS[p], matrix: split[p] }));
    const notes: string[] = [];
    if (variants.length) {
      notes.push(`${variants.map((x) => x.platform === "windows" ? "Windows" : "macOS").join(" and ")} legs → sibling job${variants.length > 1 ? "s" : ""} with GitLab.com runner \`tags\` (Windows runners are beta and use PowerShell; macOS needs Premium)`);
    }
    if (split.other.length) {
      const labels = [...new Set(split.other.flatMap((e) => (e[v] as string[] | undefined) ?? [mref[2] ?? "(none)"]))];
      notes.push(`legs on ${labels.join(", ")} were dropped; register a GitLab Runner with matching tags`);
      todos.push(`TODO: matrix legs on ${labels.join(", ")} were dropped; they need a runner with matching tags`);
    }
    findings.push(
      notes.length
        ? { feature, status: "manual", reason: notes.join("; ") }
        : { feature, status: "clean", reason: "All matrix legs are Linux → GitLab.com shared Linux runners" },
    );
    return { variants, noLinuxLegs: !split.linux.length };
  }
  if (raw.some((r) => r.includes("${{"))) {
    findings.push({ feature, status: "manual", reason: "Runner chosen by expression; pick GitLab runner tags per job" });
    return { variants: [] };
  }
  const first = raw[0] ?? "ubuntu-latest";
  if (raw.includes("self-hosted")) {
    const tags = raw.filter((r) => r !== "self-hosted");
    findings.push({ feature, status: "manual", reason: "Self-hosted runner → register a GitLab Runner with matching `tags`" });
    return { tags: tags.length ? tags : undefined, variants: [] };
  }
  const platform = platformOf(first);
  if (platform === "windows" || platform === "macos") {
    findings.push({
      feature,
      status: "manual",
      reason: platform === "windows"
        ? "→ `tags: [saas-windows-medium-amd64]`; GitLab.com Windows runners are in beta and default to PowerShell"
        : "→ `tags: [saas-macos-medium-m1]`; macOS runners need GitLab Premium or Ultimate",
    });
    return { tags: PLATFORMS[platform].tags, platform, variants: [] };
  }
  if (/arm/i.test(first)) {
    findings.push({ feature, status: "manual", reason: "ARM → `tags: [saas-linux-small-arm64]`; check your image supports arm64" });
    return { tags: ["saas-linux-small-arm64"], variants: [] };
  }
  if (platform === "linux") {
    if (/(\d+)-?core/i.test(first)) {
      findings.push({ feature, status: "manual", reason: "Larger runner → `tags: [saas-linux-large-amd64]` (or medium/xlarge); billed at a higher cost factor" });
      return { tags: ["saas-linux-large-amd64"], variants: [] };
    }
    findings.push({ feature, status: "clean", reason: "→ GitLab.com shared Linux runners (no tags needed)" });
    return { variants: [] };
  }
  findings.push({ feature, status: "manual", reason: "Unknown runner label → register a GitLab Runner with matching `tags`" });
  return { tags: raw, variants: [] };
}

export function convertPermissions(perms: unknown, findings: Finding[], scope: string) {
  if (perms == null) return;
  const writes = isObj(perms)
    ? Object.entries(perms).filter(([, v]) => v === "write").map(([k]) => k)
    : perms === "write-all" ? ["all"] : [];
  if (!writes.length) {
    findings.push({ feature: `${scope}permissions`, status: "clean", reason: "Read-only token; GitLab's CI_JOB_TOKEN is already scoped to this project, nothing to migrate" });
    return;
  }
  const notes = writes.map((w) =>
    w === "id-token" ? "`id-token: write` → `id_tokens:` keyword for OIDC"
      : w === "packages" ? "`packages: write` → CI_JOB_TOKEN can push to this project's registry by default"
      : `\`${w}: write\` → use a project access token stored as a masked CI/CD variable`,
  );
  findings.push({ feature: `${scope}permissions`, status: "manual", reason: notes.join("; ") });
}

export function convertConcurrency(c: unknown, findings: Finding[], scope: string): { interruptible?: boolean; resourceGroup?: string } {
  if (c == null) return {};
  const cfg = isObj(c) ? c : { group: c };
  if (cfg["cancel-in-progress"] === true) {
    findings.push({ feature: `${scope}concurrency`, status: "clean", reason: "cancel-in-progress → `interruptible: true`; GitLab auto-cancels older pipelines on the same branch" });
    return { interruptible: true };
  }
  findings.push({ feature: `${scope}concurrency`, status: "manual", reason: "Concurrency group → `resource_group` (serialises jobs, but queued jobs aren't replaced like on GitHub)" });
  return { resourceGroup: String(cfg.group ?? "default").replace(/\$\{\{[^}]*\}\}/g, "").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "default" };
}

function pickImage(job: Obj, build: JobBuild, ctx: ExprContext, findings: Finding[], todos: string[]): string | Obj {
  const container = job.container;
  if (container) {
    const cfg = isObj(container) ? container : { image: container };
    const image = translateInline(String(cfg.image), ctx).text;
    const extra = ["options", "credentials", "volumes", "ports"].filter((k) => cfg[k]);
    findings.push(
      extra.length
        ? { feature: "container", status: "manual", reason: `→ \`image: ${image}\`; ${extra.join(", ")} need runner config or \`image:docker\` settings` }
        : { feature: "container", status: "clean", reason: `→ \`image: ${image}\`` },
    );
    if (isObj(cfg.env)) Object.assign(build.variables, cfg.env);
    return image;
  }
  if (build.services.some((s) => s.name === "docker:dind")) return "docker:27";
  const images = [...new Set(build.runtimes.values())];
  if (images.length === 1) return images[0];
  if (images.length > 1) {
    todos.push(`TODO: job needs several toolchains (${images.join(", ")}); pick or build an image that has all of them`);
    findings.push({ feature: "image", status: "manual", reason: `Multiple toolchains (${images.join(", ")}); one image must contain all of them` });
    return images[0];
  }
  todos.push("TODO: GitHub's ubuntu runner has many tools preinstalled; pick an image with what this job needs");
  findings.push({ feature: "image", status: "manual", reason: "No setup-* action to infer from; `ubuntu:24.04` is a placeholder (GitHub's runner image preinstalls Node, Python, Docker, etc.)" });
  return "ubuntu:24.04";
}

function convertServices(services: unknown, build: JobBuild, ctx: ExprContext, findings: Finding[]) {
  if (!isObj(services)) return;
  const notes: string[] = [];
  for (const [alias, svc] of Object.entries(services)) {
    const cfg = isObj(svc) ? svc : { image: svc };
    const entry: Obj = { name: translateInline(String(cfg.image), ctx).text, alias };
    if (isObj(cfg.env)) entry.variables = Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, translateInline(String(v), ctx).text]));
    build.services.push(entry);
    if (cfg.ports) notes.push(`\`${alias}\` is reachable at host \`${alias}\`, not localhost; update connection strings`);
    if (cfg.options) notes.push(`\`${alias}\` options (health checks) are dropped; GitLab waits for exposed ports instead`);
  }
  findings.push(
    notes.length
      ? { feature: "services", status: "manual", reason: notes.join("; ") }
      : { feature: "services", status: "clean", reason: "→ `services:` with matching aliases" },
  );
}

export function convertJob(id: string, job: Obj, ctx: ExprContext, defaults: Obj | undefined, nameOf: (id: string) => string): ConvertedJob {
  const findings: Finding[] = [];
  const todos: string[] = [];
  const build = newJobBuild();
  const body: Obj = {};

  // Reusable workflow call at job level.
  if (typeof job.uses === "string") {
    const local = job.uses.startsWith("./");
    findings.push({
      feature: `uses: ${job.uses}`,
      status: "manual",
      reason: local
        ? "Reusable workflow → convert that file and run it as a child pipeline (`trigger:include`)"
        : "Reusable workflow from another repo → `include: project:` or a CI/CD component",
    });
    todos.push(`TODO: was a call to reusable workflow ${job.uses}; convert it and include it here`);
    body.trigger = { include: local ? job.uses.replace(/^\.\/\.github\/workflows\//, ".gitlab/ci/") : "TODO.yml" };
    return { body, needs: asList(job.needs).map((n) => nameOf(String(n))), script: [], afterScript: [], todos, findings, variants: [] };
  }

  const strategy = isObj(job.strategy) ? job.strategy : {};
  const matrix = convertMatrix(strategy, ctx, findings);
  const runsOn = convertRunsOn(job["runs-on"], matrix, findings, todos);

  if (isObj(job.env)) {
    const issues: string[] = [];
    for (const [k, v] of Object.entries(job.env)) {
      const t = translateInline(String(v), ctx);
      build.variables[k] = t.text;
      issues.push(...t.issues);
    }
    findings.push(issues.length
      ? { feature: "env", status: "manual", reason: `→ \`variables:\`; ${[...new Set(issues)].join("; ")}` }
      : { feature: "env", status: "clean", reason: "→ `variables:`" });
  }
  convertServices(job.services, build, ctx, findings);

  // Steps
  const runDefaults = isObj(defaults?.run) ? (defaults!.run as Obj) : {};
  const jobRunDefaults = isObj(job.defaults) && isObj((job.defaults as Obj).run) ? ((job.defaults as Obj).run as Obj) : {};
  const defaultDir = String(jobRunDefaults["working-directory"] ?? runDefaults["working-directory"] ?? "");
  const defaultShell = jobRunDefaults.shell ?? runDefaults.shell;
  let cwd = "";
  for (const raw of asList(job.steps)) {
    if (!isObj(raw)) continue;
    const step = raw;
    let ifRaw = step.if as string | boolean | undefined;
    const ifText = ifRaw == null ? "" : String(ifRaw).replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();
    const always = /^(always|!cancelled)\(\)$/.test(ifText);
    const onFailure = ifText === "failure()";
    if (always || onFailure || ifText === "success()") ifRaw = undefined;
    const target = always || onFailure ? build.afterScript : build.script;

    let finding: Finding;
    // Index of this step's first script line, so comments land above the whole step.
    const stepStart = target.length;
    if (typeof step.uses === "string") {
      finding = convertUses(step.uses, isObj(step.with) ? step.with : {}, build, ctx, always ? "always" : onFailure ? "on_failure" : undefined);
      if (step.name) finding.feature = `${label(String(step.name))} (${finding.feature})`;
      if (finding.status !== "clean") {
        target.splice(stepStart, 0, { comment: `TODO: ${finding.feature}: ${finding.reason}` });
      }
    } else if (step.run != null) {
      const run = convertRun({ ...step, shell: step.shell ?? defaultShell }, ctx);
      const dir = String(step["working-directory"] ?? defaultDir);
      if (dir !== cwd) {
        target.push({ cmd: dir ? `cd "$CI_PROJECT_DIR/${dir.replace(/^\.\//, "")}"` : 'cd "$CI_PROJECT_DIR"' });
        cwd = dir;
      }
      const stepIssues = [...run.issues];
      const stepLines: Line[] = [];
      if (isObj(step.env)) {
        for (const [k, v] of Object.entries(step.env)) {
          const t = translateInline(String(v), ctx);
          stepIssues.push(...t.issues);
          stepLines.push({ cmd: `export ${k}="${t.text.replace(/"/g, '\\"')}"` });
        }
      }
      if (step["continue-on-error"]) stepIssues.push("`continue-on-error` on a step → append `|| true` or move it to its own job with `allow_failure`");
      if (step["timeout-minutes"]) stepIssues.push("step timeouts don't exist; use the job `timeout` or `timeout` command");
      const status: Status = stepIssues.length ? "manual" : "clean";
      const notes = [...new Set(stepIssues), ...run.notes];
      finding = {
        feature: step.name ? label(String(step.name)) : `run: ${label(String(step.run))}`,
        status,
        reason: notes.length ? notes.join("; ") : "→ `script:` line",
      };
      const cmd = onFailure ? `if [ "$CI_JOB_STATUS" = "failed" ]; then\n${run.text.trimEnd()}\nfi` : run.text.trimEnd();
      stepLines.push({ cmd });
      if (status === "manual") stepLines[0].comment = `TODO: ${[...new Set(stepIssues)].join("; ")}`;
      target.push(...stepLines);
    } else {
      continue;
    }

    if ((always || onFailure) && typeof step.uses === "string" && /^actions\/upload-artifact@/i.test(step.uses)) {
      finding.reason += `; \`if: ${ifText}\` → \`artifacts:when: ${always ? "always" : "on_failure"}\``;
    } else if (always || onFailure) {
      finding.status = worst([finding.status, "manual"]);
      finding.reason += `; \`if: ${ifText}\` → moved to \`after_script\` (runs in a separate shell, so exported variables aren't available)`;
    } else if (ifRaw != null) {
      const r = conditionToRule(ifRaw, ctx);
      finding.status = worst([finding.status, "manual"]);
      finding.reason += `; step condition \`${ifText}\` must become a shell \`if\` or a separate job${r.ok && r.rule.if ? ` with \`rules: - if: ${r.rule.if}\`` : ""}`;
      const first = target[stepStart];
      const note = `TODO: only run when \`${ifText}\``;
      if (first) first.comment = first.comment ? `${note}\n${first.comment}` : note;
    }
    findings.push(finding);
  }
  if (!build.script.length || build.script.every((l) => !l.cmd)) {
    build.script.push({ cmd: 'echo "TODO: port this job"' });
  }

  const image = pickImage(job, build, ctx, findings, todos);

  // Job-level keys
  let rule: Rule | undefined;
  if (job.if != null) {
    const ifText = String(job.if);
    const r = conditionToRule(job.if as string | boolean, ctx);
    if (r.ok) {
      rule = r.rule;
      findings.push({
        feature: `if: ${label(ifText)}`,
        status: "clean",
        reason: rule.if || rule.when
          ? `→ \`rules:\`${rule.if ? ` with \`if: ${rule.if}\`` : ""}${rule.when ? ` (when: ${rule.when})` : ""}`
          : "Same as GitLab's default (run when earlier jobs succeed); no rule needed",
      });
    } else {
      findings.push({ feature: `if: ${label(ifText)}`, status: "manual", reason: `Couldn't convert to \`rules:\` (${r.reason}); the job currently always runs` });
      todos.push(`TODO: job condition not converted: ${ifText}`);
    }
  }
  if (job.outputs) {
    findings.push({ feature: "outputs", status: "manual", reason: "Job outputs → write KEY=value to a file and publish it with `artifacts:reports:dotenv`; jobs that `need` it get the variables" });
    todos.push("TODO: job outputs → artifacts:reports:dotenv");
  }
  convertPermissions(job.permissions, findings, "");
  const conc = convertConcurrency(job.concurrency, findings, "");

  let timeout: string | undefined;
  if (job["timeout-minutes"] != null) {
    const n = Number(job["timeout-minutes"]);
    if (Number.isFinite(n)) {
      timeout = `${n} minutes`;
      findings.push({ feature: "timeout-minutes", status: "clean", reason: `→ \`timeout: ${timeout}\`` });
    } else findings.push({ feature: "timeout-minutes", status: "manual", reason: "Expression timeout; set a fixed `timeout`" });
  }
  let allowFailure: boolean | undefined;
  if (job["continue-on-error"] != null) {
    if (job["continue-on-error"] === true) {
      allowFailure = true;
      findings.push({ feature: "continue-on-error", status: "clean", reason: "→ `allow_failure: true`" });
    } else if (job["continue-on-error"] !== false) {
      findings.push({ feature: "continue-on-error", status: "manual", reason: "Expression (often per matrix leg) → `allow_failure` on separate jobs, or `allow_failure:exit_codes`" });
    }
  }
  let environment: Obj | undefined;
  if (job.environment != null) {
    const env = isObj(job.environment) ? job.environment : { name: job.environment };
    environment = { name: translateInline(String(env.name), ctx).text };
    if (env.url) environment.url = translateInline(String(env.url), ctx).text;
    findings.push({ feature: "environment", status: "clean", reason: "→ `environment:` (protection rules/approvals are configured in project settings)" });
  }

  if (runsOn.platform) {
    // The whole job runs on Windows/macOS: no container image there.
    const p = PLATFORMS[runsOn.platform];
    if (p.image) body.image = p.image;
    todos.push(p.todo);
  } else {
    body.image = image;
  }
  if (build.services.length) body.services = build.services;
  if (runsOn.tags) body.tags = runsOn.tags;
  if (Object.keys(build.variables).length) body.variables = build.variables;
  if (matrix?.length) body.parallel = { matrix };
  if (timeout) body.timeout = timeout;
  if (allowFailure) body.allow_failure = true;
  if (environment) body.environment = environment;
  if (conc.interruptible) body.interruptible = true;
  if (conc.resourceGroup) body.resource_group = conc.resourceGroup;
  if (build.cache.length) body.cache = build.cache.length === 1 ? build.cache[0] : build.cache;

  const result: ConvertedJob = {
    body,
    needs: job.needs != null ? asList(job.needs).map((n) => nameOf(String(n))) : undefined,
    rule,
    script: build.script,
    afterScript: build.afterScript,
    todos,
    findings,
    variants: runsOn.variants,
    noLinuxLegs: runsOn.noLinuxLegs,
  };
  if (build.artifacts) {
    const { name, paths, exclude, expire_in, when } = build.artifacts;
    body.artifacts = Object.fromEntries(Object.entries({ name, paths, exclude, expire_in, when }).filter(([, v]) => v !== undefined));
  }
  return result;
}

export { worst };
