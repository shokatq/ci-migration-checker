/**
 * GitHub Actions expressions (`${{ ... }}`) → GitLab CI.
 *
 * Two targets:
 *  - inline text (run scripts, env values, image names): known context values
 *    become `$VARIABLES`, anything else is left in place and reported.
 *  - `if:` conditions: parsed into a small AST and rewritten as a GitLab
 *    `rules:if` expression, or rejected with a reason.
 */
import type { Rule } from "./types";

export interface ExprContext {
  /** GitHub matrix key → GitLab variable name, e.g. "node-version" → "NODE_VERSION". */
  matrixVars: Map<string, string>;
  /** Collected secret names (everything referenced as `secrets.X`). */
  secrets: Set<string>;
}

export function newContext(): ExprContext {
  return { matrixVars: new Map(), secrets: new Set() };
}

/** "node-version" → "NODE_VERSION": GitLab variable names must be [A-Z0-9_]. */
export function toVarName(key: string): string {
  return key.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
}

// ---------------------------------------------------------------------------
// Tokenizer + parser
// ---------------------------------------------------------------------------

export type Node =
  | { type: "lit"; value: string | number | boolean | null }
  | { type: "path"; parts: string[] }
  | { type: "call"; name: string; args: Node[] }
  | { type: "not"; arg: Node }
  | { type: "bin"; op: string; left: Node; right: Node };

type Token = { kind: "str" | "num" | "ident" | "op"; value: string };

const OPERATORS = ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "(", ")", "[", "]", ".", ",", "*"];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "'") {
      let value = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new SyntaxError("Unterminated string");
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += src[i++];
      }
      tokens.push({ kind: "str", value });
    } else if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^-?[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      tokens.push({ kind: "num", value: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i))!;
      tokens.push({ kind: "ident", value: m[0] });
      i += m[0].length;
    } else {
      const op = OPERATORS.find((o) => src.startsWith(o, i));
      if (!op) throw new SyntaxError(`Unexpected character '${c}'`);
      tokens.push({ kind: "op", value: op });
      i += op.length;
    }
  }
  return tokens;
}

export function parseExpression(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.kind === "op" && peek().value === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new SyntaxError(`Expected '${v}'`);
    pos++;
  };

  function binary(next: () => Node, ops: string[]): () => Node {
    return () => {
      let left = next();
      while (peek()?.kind === "op" && ops.includes(peek().value)) {
        const op = tokens[pos++].value;
        left = { type: "bin", op, left, right: next() };
      }
      return left;
    };
  }

  function unary(): Node {
    if (isOp("!")) {
      pos++;
      return { type: "not", arg: unary() };
    }
    return primary();
  }

  function primary(): Node {
    const t = tokens[pos++];
    if (!t) throw new SyntaxError("Unexpected end of expression");
    if (t.kind === "str") return { type: "lit", value: t.value };
    if (t.kind === "num") return { type: "lit", value: Number(t.value) };
    if (t.kind === "op" && t.value === "(") {
      const inner = or();
      expect(")");
      return inner;
    }
    if (t.kind !== "ident") throw new SyntaxError(`Unexpected '${t.value}'`);
    if (t.value === "true" || t.value === "false") return { type: "lit", value: t.value === "true" };
    if (t.value === "null") return { type: "lit", value: null };
    if (isOp("(")) {
      pos++;
      const args: Node[] = [];
      while (!isOp(")")) {
        args.push(or());
        if (isOp(",")) pos++;
        else break;
      }
      expect(")");
      return { type: "call", name: t.value, args };
    }
    const parts = [t.value];
    for (;;) {
      if (isOp(".")) {
        pos++;
        const p = tokens[pos++];
        if (!p || (p.kind !== "ident" && !(p.kind === "op" && p.value === "*"))) {
          throw new SyntaxError("Expected property name");
        }
        parts.push(p.value);
      } else if (isOp("[")) {
        pos++;
        const p = tokens[pos++];
        if (!p || (p.kind !== "str" && p.kind !== "num" && p.value !== "*")) {
          throw new SyntaxError("Only literal index access is supported");
        }
        parts.push(p.value);
        expect("]");
      } else break;
    }
    return { type: "path", parts };
  }

  const compare = binary(unary, ["<", ">", "<=", ">="]);
  const equality = binary(compare, ["==", "!="]);
  const and = binary(equality, ["&&"]);
  const or = binary(and, ["||"]);

  const node = or();
  if (pos < tokens.length) throw new SyntaxError(`Unexpected '${tokens[pos].value}'`);
  return node;
}

// ---------------------------------------------------------------------------
// Context values → GitLab predefined variables
// ---------------------------------------------------------------------------

interface Mapped {
  name?: string;
  /** Set when the mapping is lossy or missing; becomes a "manual" finding. */
  issue?: string;
}

const GITHUB_VARS: Record<string, Mapped> = {
  sha: { name: "CI_COMMIT_SHA" },
  ref_name: { name: "CI_COMMIT_REF_NAME" },
  ref: {
    name: "CI_COMMIT_REF_NAME",
    issue: "github.ref is a full ref (refs/heads/main); CI_COMMIT_REF_NAME is just the name (main)",
  },
  head_ref: { name: "CI_MERGE_REQUEST_SOURCE_BRANCH_NAME" },
  base_ref: { name: "CI_MERGE_REQUEST_TARGET_BRANCH_NAME" },
  repository: { name: "CI_PROJECT_PATH" },
  repository_owner: { name: "CI_PROJECT_NAMESPACE" },
  run_id: { name: "CI_PIPELINE_ID" },
  run_number: { name: "CI_PIPELINE_IID" },
  actor: { name: "GITLAB_USER_LOGIN" },
  triggering_actor: { name: "GITLAB_USER_LOGIN" },
  workspace: { name: "CI_PROJECT_DIR" },
  server_url: { name: "CI_SERVER_URL" },
  job: { name: "CI_JOB_NAME" },
  event_name: {
    name: "CI_PIPELINE_SOURCE",
    issue: "event names differ (pull_request → merge_request_event, workflow_dispatch → web)",
  },
  token: {
    name: "CI_JOB_TOKEN",
    issue: "CI_JOB_TOKEN has narrower permissions than GITHUB_TOKEN; API calls may need a project access token",
  },
  api_url: { name: "CI_API_V4_URL", issue: "GitLab's REST API has different endpoints" },
  workflow: { name: "CI_PIPELINE_NAME", issue: "GitLab has one pipeline per commit, not one run per workflow" },
};

export function contextVar(parts: string[], ctx: ExprContext): Mapped {
  const [root, key, ...rest] = parts;
  if (!key) return { issue: `\`${root}\` context has no GitLab equivalent` };
  switch (root) {
    case "env":
    case "vars":
      return { name: key };
    case "secrets":
      if (key === "GITHUB_TOKEN") return GITHUB_VARS.token;
      ctx.secrets.add(key);
      return { name: key };
    case "matrix":
      return { name: ctx.matrixVars.get(key) ?? toVarName(key) };
    case "inputs":
      return { name: toVarName(key), issue: "workflow inputs → declare as pipeline variables or `spec:inputs`" };
    case "github":
      if (key === "event") {
        const p = rest.join(".");
        if (p === "number" || p === "pull_request.number") return { name: "CI_MERGE_REQUEST_IID" };
        return { issue: `github.event.${p} (webhook payload) isn't exposed in GitLab CI` };
      }
      if (rest.length === 0 && GITHUB_VARS[key]) return GITHUB_VARS[key];
      return { issue: `github.${[key, ...rest].join(".")} has no GitLab equivalent` };
    case "runner":
      if (key === "temp") return { name: "CI_BUILDS_DIR", issue: "no runner temp dir; use a path under /tmp" };
      return { issue: `runner.${key} has no GitLab equivalent` };
    case "steps":
      return { issue: "step outputs don't exist in GitLab; use shell variables within the job" };
    case "needs":
      return { issue: "job outputs → pass them with `artifacts:reports:dotenv`" };
    default:
      return { issue: `\`${root}.${key}\` has no GitLab equivalent` };
  }
}

/**
 * Replace `${{ ... }}` in a string with GitLab variables where possible.
 * Untranslatable expressions are left untouched and listed in `issues`.
 */
export function translateInline(text: string, ctx: ExprContext): { text: string; issues: string[] } {
  const issues: string[] = [];
  const out = text.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (whole, src: string, offset: number) => {
    let node: Node;
    try {
      node = parseExpression(src);
    } catch {
      issues.push(`can't parse expression \`${src}\``);
      return whole;
    }
    if (node.type === "lit") return node.value === null ? "" : String(node.value);
    if (node.type !== "path") {
      issues.push(`expression \`${src}\` needs rewriting as shell logic`);
      return whole;
    }
    const mapped = contextVar(node.parts, ctx);
    if (mapped.issue) issues.push(mapped.issue);
    if (!mapped.name) return whole;
    const next = text[offset + whole.length] ?? "";
    return /[A-Za-z0-9_]/.test(next) ? `\${${mapped.name}}` : `$${mapped.name}`;
  });
  return { text: out, issues };
}

// ---------------------------------------------------------------------------
// if: conditions → rules
// ---------------------------------------------------------------------------

class Unsupported extends Error {}

const EVENT_TO_SOURCE: Record<string, string> = {
  push: "push",
  pull_request: "merge_request_event",
  pull_request_target: "merge_request_event",
  schedule: "schedule",
  workflow_dispatch: "web",
  repository_dispatch: "trigger",
};

const STATUS_FUNCS = new Set(["success", "always", "failure", "cancelled"]);

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function quote(value: string | number | boolean | null): string {
  if (value === null) return "null";
  const s = String(value);
  if (s.includes('"')) throw new Unsupported("string literal contains a double quote");
  return `"${s}"`;
}

function isPath(n: Node, path: string): boolean {
  return n.type === "path" && n.parts.join(".") === path;
}

function varRef(n: Node, ctx: ExprContext): string {
  if (n.type !== "path") throw new Unsupported("only context values can be compared");
  const m = contextVar(n.parts, ctx);
  if (!m.name || m.issue) throw new Unsupported(m.issue ?? "unknown context value");
  return `$${m.name}`;
}

function compare(op: "==" | "!=", left: Node, right: Node, ctx: ExprContext): string {
  // Normalise so the literal (if any) is on the right.
  if (left.type === "lit" && right.type !== "lit") [left, right] = [right, left];
  if (right.type !== "lit") return `${varRef(left, ctx)} ${op} ${varRef(right, ctx)}`;
  const lit = right.value;

  if (isPath(left, "github.event_name")) {
    const source = EVENT_TO_SOURCE[String(lit)];
    if (!source) throw new Unsupported(`event \`${lit}\` has no GitLab pipeline source`);
    return `$CI_PIPELINE_SOURCE ${op} "${source}"`;
  }
  if (isPath(left, "github.ref") && typeof lit === "string") {
    if (lit.startsWith("refs/heads/")) return `$CI_COMMIT_BRANCH ${op} ${quote(lit.slice(11))}`;
    if (lit.startsWith("refs/tags/")) return `$CI_COMMIT_TAG ${op} ${quote(lit.slice(10))}`;
    throw new Unsupported(`ref \`${lit}\` has no GitLab equivalent`);
  }
  return `${varRef(left, ctx)} ${op} ${quote(lit)}`;
}

function stringMatch(name: string, args: Node[], negate: boolean, ctx: ExprContext): string {
  const [subject, needle] = args;
  if (!subject || needle?.type !== "lit" || typeof needle.value !== "string") {
    throw new Unsupported(`${name}() is only supported with a literal string`);
  }
  const op = negate ? "!~" : "=~";
  let target: string;
  let value = needle.value;
  if (isPath(subject, "github.ref") && name === "startsWith") {
    if (value.startsWith("refs/tags/")) {
      value = value.slice(10);
      if (!value && !negate) return "$CI_COMMIT_TAG";
      target = "$CI_COMMIT_TAG";
    } else if (value.startsWith("refs/heads/")) {
      value = value.slice(11);
      target = "$CI_COMMIT_BRANCH";
    } else throw new Unsupported(`ref prefix \`${value}\` has no GitLab equivalent`);
  } else {
    target = varRef(subject, ctx);
  }
  const re = escapeRegex(value);
  const pattern = name === "startsWith" ? `^${re}` : name === "endsWith" ? `${re}$` : re;
  return `${target} ${op} /${pattern}/`;
}

function cond(n: Node, ctx: ExprContext): string {
  switch (n.type) {
    case "bin": {
      if (n.op === "&&" || n.op === "||") {
        const wrap = (c: Node) => {
          const s = cond(c, ctx);
          return c.type === "bin" && (c.op === "&&" || c.op === "||") && c.op !== n.op ? `(${s})` : s;
        };
        return `${wrap(n.left)} ${n.op} ${wrap(n.right)}`;
      }
      if (n.op === "==" || n.op === "!=") return compare(n.op, n.left, n.right, ctx);
      throw new Unsupported(`operator \`${n.op}\` isn't supported in GitLab rules`);
    }
    case "not": {
      const a = n.arg;
      if (a.type === "bin" && (a.op === "==" || a.op === "!=")) {
        return compare(a.op === "==" ? "!=" : "==", a.left, a.right, ctx);
      }
      if (a.type === "call" && ["startsWith", "endsWith", "contains"].includes(a.name)) {
        return stringMatch(a.name, a.args, true, ctx);
      }
      if (a.type === "path") {
        const v = varRef(a, ctx);
        return `(${v} == null || ${v} == "")`;
      }
      throw new Unsupported("negation of a complex expression");
    }
    case "call":
      if (["startsWith", "endsWith", "contains"].includes(n.name)) return stringMatch(n.name, n.args, false, ctx);
      if (STATUS_FUNCS.has(n.name)) throw new Unsupported(`${n.name}() can only be combined with &&`);
      throw new Unsupported(`function ${n.name}() has no GitLab equivalent`);
    case "path":
      return varRef(n, ctx);
    case "lit":
      throw new Unsupported("literal used as a condition");
  }
}

function conjuncts(n: Node): Node[] {
  return n.type === "bin" && n.op === "&&" ? [...conjuncts(n.left), ...conjuncts(n.right)] : [n];
}

export type RuleResult = { ok: true; rule: Rule } | { ok: false; reason: string };

/** Convert a job/step `if:` into a GitLab rule. */
export function conditionToRule(raw: string | boolean, ctx: ExprContext): RuleResult {
  if (typeof raw === "boolean") return raw ? { ok: true, rule: {} } : { ok: true, rule: { when: "never" } };
  const src = raw.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  try {
    const parts = conjuncts(parseExpression(src));
    const rule: Rule = {};
    const rest: Node[] = [];
    // `!failure()` rules out running after a failure, i.e. GitLab's default on_success.
    const notFailure = parts.some((p) => p.type === "not" && p.arg.type === "call" && p.arg.name === "failure");
    for (const p of parts) {
      const call = p.type === "call" ? p : p.type === "not" && p.arg.type === "call" ? p.arg : null;
      if (call && STATUS_FUNCS.has(call.name) && call.args.length === 0) {
        const negated = p.type === "not";
        if (negated && call.name === "failure") continue;
        if (call.name === "always" || (negated && call.name === "cancelled")) {
          if (!notFailure) rule.when = "always";
        }
        else if (call.name === "failure" && !negated) rule.when = "on_failure";
        else if (call.name !== "success" || negated) throw new Unsupported(`${p.type === "not" ? "!" : ""}${call.name}() has no GitLab equivalent`);
      } else if (!(p.type === "lit" && p.value === true)) {
        rest.push(p);
      }
    }
    if (rest.length) {
      rule.if = rest
        .map((p) => {
          const s = cond(p, ctx);
          return rest.length > 1 && p.type === "bin" && p.op === "||" ? `(${s})` : s;
        })
        .join(" && ");
    }
    return { ok: true, rule };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
