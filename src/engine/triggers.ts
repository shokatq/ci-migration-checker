/** `on:` triggers → GitLab `rules:` (used in `workflow:rules` or per job). */
import type { Finding, Rule } from "./types";

export interface TriggerResult {
  rules: Rule[];
  findings: Finding[];
  hasPush: boolean;
  hasMergeRequest: boolean;
}

const PUSH = '$CI_PIPELINE_SOURCE == "push"';
const MR = '$CI_PIPELINE_SOURCE == "merge_request_event"';
const DEFAULT_PR_TYPES = new Set(["opened", "synchronize", "reopened"]);

const NO_EQUIVALENT_EVENTS = new Set([
  "issues", "issue_comment", "pull_request_review", "pull_request_review_comment", "label",
  "discussion", "discussion_comment", "deployment", "deployment_status", "page_build", "status",
  "check_run", "check_suite", "create", "delete", "fork", "gollum", "milestone", "project",
  "project_card", "project_column", "public", "registry_package", "watch", "branch_protection_rule",
]);

/**
 * GitHub branch/tag filter glob → regex body. GitHub's `?` and `+` already act
 * as regex quantifiers on the previous character, and `[...]` is a class.
 * Returns null for negated (`!`) patterns, which rules can't express in one regex.
 */
export function globToRegex(glob: string): string | null {
  if (glob.startsWith("!")) return null;
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
    } else if (c === "*") out += "[^\\/]*";
    else if (c === "?" || c === "+") out += c;
    else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end === -1) return null;
      out += glob.slice(i, end + 1).replace(/\//g, "\\/");
      i = end;
    } else out += c.replace(/[.^${}()|\\/]/g, "\\$&");
  }
  return out;
}

const isLiteral = (glob: string) => !/[*?+[\]!]/.test(glob);

/** `$VAR == "main"` or `$VAR =~ /^(main|release\/.*)$/`; null if a pattern is unsupported. */
export function matchExpression(variable: string, globs: string[]): string | null {
  if (globs.length === 1 && isLiteral(globs[0])) return `${variable} == "${globs[0]}"`;
  const parts = globs.map(globToRegex);
  if (parts.some((p) => p === null)) return null;
  const body = parts.length === 1 ? parts[0] : `(${parts.join("|")})`;
  return `${variable} =~ /^${body}$/`;
}

function asList(v: unknown): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

function normalize(on: unknown): Record<string, Record<string, unknown> | null> {
  if (typeof on === "string") return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [String(e), null]));
  if (on && typeof on === "object") return on as Record<string, Record<string, unknown> | null>;
  return {};
}

export function convertTriggers(on: unknown): TriggerResult {
  const rules: Rule[] = [];
  const findings: Finding[] = [];
  let hasPush = false;
  let hasMergeRequest = false;
  const events = normalize(on);

  const pathFilter = (cfg: Record<string, unknown>, notes: string[]): string[] | undefined => {
    if (cfg["paths-ignore"]) notes.push("`paths-ignore` has no exact equivalent (`rules:changes` can't exclude); jobs will run on every change");
    const paths = asList(cfg.paths);
    if (paths.some((p) => p.startsWith("!"))) {
      notes.push("negated `paths` patterns dropped; `rules:changes` can't exclude files");
      return paths.filter((p) => !p.startsWith("!"));
    }
    return paths.length ? paths : undefined;
  };

  for (const [event, rawCfg] of Object.entries(events)) {
    const cfg = rawCfg ?? {};
    const feature = `on: ${event}`;
    const notes: string[] = [];

    switch (event) {
      case "push": {
        hasPush = true;
        const changes = pathFilter(cfg, notes);
        const branches = asList(cfg.branches);
        const tags = asList(cfg.tags);
        for (const [key, variable] of [["branches-ignore", "$CI_COMMIT_BRANCH"], ["tags-ignore", "$CI_COMMIT_TAG"]] as const) {
          const ignore = asList(cfg[key]);
          if (!ignore.length) continue;
          const m = matchExpression(variable, ignore);
          if (m) rules.push({ if: `${PUSH} && ${m}`, when: "never" });
          else notes.push(`\`${key}\` pattern couldn't be converted`);
        }
        const positive: string[] = [];
        if (!branches.length && !tags.length) positive.push(PUSH);
        for (const [list, variable] of [[branches, "$CI_COMMIT_BRANCH"], [tags, "$CI_COMMIT_TAG"]] as const) {
          if (!list.length) continue;
          const m = matchExpression(variable, list);
          if (m) positive.push(`${PUSH} && ${m}`);
          else notes.push(`negated branch/tag patterns (\`!\`) need a separate \`when: never\` rule`);
        }
        for (const p of positive) rules.push(changes ? { if: p, changes } : { if: p });
        findings.push(
          notes.length
            ? { feature, status: "manual", reason: notes.join("; ") }
            : { feature, status: "clean", reason: "Push filters become `rules:if` on `$CI_COMMIT_BRANCH` / `$CI_COMMIT_TAG`" + (changes ? " with `rules:changes`" : "") },
        );
        break;
      }
      case "pull_request":
      case "pull_request_target": {
        hasMergeRequest = true;
        const changes = pathFilter(cfg, notes);
        const branches = asList(cfg.branches);
        let cond = MR;
        if (branches.length) {
          const m = matchExpression("$CI_MERGE_REQUEST_TARGET_BRANCH_NAME", branches);
          if (m) cond += ` && ${m}`;
          else notes.push("negated target-branch patterns need a separate `when: never` rule");
        }
        if (cfg["branches-ignore"]) notes.push("`branches-ignore` → add a `when: never` rule on `$CI_MERGE_REQUEST_TARGET_BRANCH_NAME`");
        const types = asList(cfg.types);
        if (types.some((t) => !DEFAULT_PR_TYPES.has(t))) {
          notes.push(`PR activity types (${types.join(", ")}) beyond push/open aren't pipeline events in GitLab`);
        }
        if (event === "pull_request_target") {
          notes.push("pull_request_target runs with base-repo secrets; review how fork MRs get secrets in GitLab (they don't by default)");
        }
        rules.push(changes ? { if: cond, changes } : { if: cond });
        findings.push(
          notes.length
            ? { feature, status: "manual", reason: notes.join("; ") }
            : { feature, status: "clean", reason: "Pull requests → merge request pipelines (`$CI_PIPELINE_SOURCE == \"merge_request_event\"`)" },
        );
        break;
      }
      case "schedule": {
        const crons = (Array.isArray(rawCfg) ? rawCfg : []).map((s: { cron?: string }) => s?.cron).filter(Boolean);
        rules.push({ if: '$CI_PIPELINE_SOURCE == "schedule"' });
        findings.push({
          feature,
          status: "manual",
          reason: `Schedules live in project settings, not YAML: create one under Build › Pipeline schedules${crons.length ? ` (cron: ${crons.join(", ")}, note GitHub cron is UTC)` : ""}`,
        });
        break;
      }
      case "workflow_dispatch": {
        rules.push({ if: '$CI_PIPELINE_SOURCE == "web"' });
        const inputs = cfg.inputs && typeof cfg.inputs === "object" ? Object.keys(cfg.inputs) : [];
        findings.push(
          inputs.length
            ? { feature, status: "manual", reason: `Manual runs map to "Run pipeline" (\`web\` source); inputs (${inputs.join(", ")}) → pipeline variables or \`spec:inputs\`` }
            : { feature, status: "clean", reason: 'Manual runs → "Run pipeline" button (`$CI_PIPELINE_SOURCE == "web"`)' },
        );
        break;
      }
      case "workflow_call":
        findings.push({ feature, status: "manual", reason: "Reusable workflow → turn it into a CI/CD component or a file pulled in with `include:`" });
        break;
      case "workflow_run":
        findings.push({ feature, status: "manual", reason: "Chained workflows → use `needs` within one pipeline, or downstream pipelines (`trigger:`)" });
        break;
      case "release":
        rules.push({ if: "$CI_COMMIT_TAG" });
        findings.push({ feature, status: "manual", reason: "GitLab has no release event; tag pipelines (`$CI_COMMIT_TAG`) are the closest match" });
        break;
      case "repository_dispatch":
        rules.push({ if: '$CI_PIPELINE_SOURCE == "trigger" || $CI_PIPELINE_SOURCE == "api"' });
        findings.push({ feature, status: "manual", reason: "External triggers → create a pipeline trigger token and call the trigger API" });
        break;
      case "merge_group":
        rules.push({ if: '$CI_MERGE_REQUEST_EVENT_TYPE == "merge_train"' });
        findings.push({ feature, status: "manual", reason: "Merge queues → GitLab merge trains (Premium tier)" });
        break;
      default:
        findings.push({
          feature,
          status: "none",
          reason: NO_EQUIVALENT_EVENTS.has(event)
            ? "GitLab CI only runs on code events; for this use a webhook + pipeline trigger, or a bot"
            : "Unknown event",
        });
    }
  }
  return { rules, findings, hasPush, hasMergeRequest };
}
