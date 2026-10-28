import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { conditionToRule, conditionToShell, newContext, parseExpression, translateInline } from "./expressions";

describe("parseExpression", () => {
  it("respects operator precedence", () => {
    expect(parseExpression("a == 'x' || b && !c")).toEqual({
      type: "bin",
      op: "||",
      left: { type: "bin", op: "==", left: { type: "path", parts: ["a"] }, right: { type: "lit", value: "x" } },
      right: {
        type: "bin",
        op: "&&",
        left: { type: "path", parts: ["b"] },
        right: { type: "not", arg: { type: "path", parts: ["c"] } },
      },
    });
  });

  it("handles escaped quotes, index access and calls", () => {
    expect(parseExpression("format('it''s {0}', matrix['node-version'])")).toEqual({
      type: "call",
      name: "format",
      args: [
        { type: "lit", value: "it's {0}" },
        { type: "path", parts: ["matrix", "node-version"] },
      ],
    });
  });
});

describe("translateInline", () => {
  it("maps contexts to GitLab variables and records secrets", () => {
    const ctx = newContext();
    ctx.matrixVars.set("node-version", "NODE_VERSION");
    const r = translateInline(
      "deploy --token ${{ secrets.NPM_TOKEN }} --sha ${{ github.sha }} --node ${{ matrix.node-version }} ${{ env.FOO }}",
      ctx,
    );
    expect(r.text).toBe("deploy --token $NPM_TOKEN --sha $CI_COMMIT_SHA --node $NODE_VERSION $FOO");
    expect(r.issues).toEqual([]);
    expect([...ctx.secrets]).toEqual(["NPM_TOKEN"]);
  });

  it("uses braces when a variable is followed by word characters", () => {
    expect(translateInline("v${{ github.run_number }}_build", newContext()).text).toBe("v${CI_PIPELINE_IID}_build");
  });

  it("leaves untranslatable expressions in place and reports them", () => {
    const r = translateInline("${{ steps.build.outputs.version }} ${{ hashFiles('**/x') }}", newContext());
    expect(r.text).toBe("${{ steps.build.outputs.version }} ${{ hashFiles('**/x') }}");
    expect(r.issues).toHaveLength(2);
  });

  it("flags GITHUB_TOKEN as lossy", () => {
    const r = translateInline("${{ secrets.GITHUB_TOKEN }}", newContext());
    expect(r.text).toBe("$CI_JOB_TOKEN");
    expect(r.issues[0]).toMatch(/narrower permissions/);
  });
});

describe("conditionToRule", () => {
  const rule = (expr: string) => conditionToRule(expr, newContext());

  it.each([
    ["github.event_name == 'push'", '$CI_PIPELINE_SOURCE == "push"'],
    ["github.event_name == 'pull_request'", '$CI_PIPELINE_SOURCE == "merge_request_event"'],
    ["github.ref == 'refs/heads/main'", '$CI_COMMIT_BRANCH == "main"'],
    ["github.ref != 'refs/heads/main'", '$CI_COMMIT_BRANCH != "main"'],
    ["startsWith(github.ref, 'refs/tags/')", "$CI_COMMIT_TAG"],
    ["startsWith(github.ref, 'refs/tags/v')", "$CI_COMMIT_TAG =~ /^v/"],
    ["github.repository == 'vitejs/vite'", '$CI_PROJECT_PATH == "vitejs/vite"'],
    ["matrix.os == 'ubuntu-latest' && matrix.node == 20", '$OS == "ubuntu-latest" && $NODE == "20"'],
    ["${{ github.event_name == 'push' || github.event_name == 'schedule' }}", '$CI_PIPELINE_SOURCE == "push" || $CI_PIPELINE_SOURCE == "schedule"'],
    ["!(github.ref == 'refs/heads/main')", '$CI_COMMIT_BRANCH != "main"'],
    ["contains(github.ref_name, 'release')", "$CI_COMMIT_REF_NAME =~ /release/"],
  ])("%s → %s", (expr, expected) => {
    expect(rule(expr)).toEqual({ ok: true, rule: { if: expected } });
  });

  it("parenthesises || inside &&", () => {
    expect(rule("(github.event_name == 'push' || github.event_name == 'schedule') && github.repository == 'a/b'")).toEqual({
      ok: true,
      rule: { if: '($CI_PIPELINE_SOURCE == "push" || $CI_PIPELINE_SOURCE == "schedule") && $CI_PROJECT_PATH == "a/b"' },
    });
  });

  it("turns status functions into when:", () => {
    expect(rule("always()")).toEqual({ ok: true, rule: { when: "always" } });
    expect(rule("failure()")).toEqual({ ok: true, rule: { when: "on_failure" } });
    expect(rule("!cancelled() && !failure()")).toEqual({ ok: true, rule: {} });
    expect(rule("always() && github.ref == 'refs/heads/main'")).toEqual({
      ok: true,
      rule: { when: "always", if: '$CI_COMMIT_BRANCH == "main"' },
    });
  });

  it("rejects what GitLab rules can't express", () => {
    expect(rule("needs.build.outputs.changed == 'true'").ok).toBe(false);
    expect(rule("github.event.pull_request.draft == false").ok).toBe(false);
    expect(rule("cancelled()").ok).toBe(false);
    expect(rule("always() || github.ref == 'x'").ok).toBe(false);
    expect(rule("fromJSON(env.X) > 3").ok).toBe(false);
  });
});

describe("conditionToShell", () => {
  const shell = (expr: string) => {
    const r = conditionToShell(expr, newContext());
    if (!r.ok) throw new Error(r.reason);
    return r.cond;
  };

  it.each([
    ["matrix.node_version == '20'", `[ "$NODE_VERSION" = '20' ]`],
    ["matrix.os != 'ubuntu-latest'", `[ "$OS" != 'ubuntu-latest' ]`],
    ["github.event_name == 'pull_request'", `[ "$CI_PIPELINE_SOURCE" = 'merge_request_event' ]`],
    ["github.ref == 'refs/heads/main'", `[ "$CI_COMMIT_BRANCH" = 'main' ]`],
    ["startsWith(github.ref, 'refs/tags/')", `[ -n "$CI_COMMIT_TAG" ]`],
    ["startsWith(github.ref, 'refs/tags/v')", `case "$CI_COMMIT_TAG" in 'v'*) true ;; *) false ;; esac`],
    ["contains(matrix.python, 'pypy')", `case "$PYTHON" in *'pypy'*) true ;; *) false ;; esac`],
    ["env.DEPLOY", `[ -n "$DEPLOY" ]`],
    ["!env.SKIP", `[ -z "$SKIP" ]`],
    ["success() && matrix.coverage == 'true'", `[ "$COVERAGE" = 'true' ]`],
    ["(matrix.a == '1' || matrix.b == '2') && env.C", `{ [ "$A" = '1' ] || [ "$B" = '2' ]; } && [ -n "$C" ]`],
  ])("%s → %s", (expr, expected) => {
    expect(shell(expr)).toBe(expected);
  });

  it("rejects what a script can't check", () => {
    for (const expr of ["steps.x.outputs.y == 'true'", "runner.os == 'Linux'", "always() || env.X", "fromJSON(env.X)", "env.X == 'it''s'"]) {
      expect(conditionToShell(expr, newContext()).ok, expr).toBe(false);
    }
  });

  // Run the generated conditions in a real POSIX shell, so quoting mistakes fail the build.
  const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;
  it.skipIf(!hasSh).each([
    ["(matrix.a == '1' || matrix.b == '2') && env.C", { A: "1", B: "x", C: "yes" }, true],
    ["(matrix.a == '1' || matrix.b == '2') && env.C", { A: "0", B: "x", C: "yes" }, false],
    ["startsWith(github.ref, 'refs/tags/v')", { CI_COMMIT_TAG: "v1.2.0" }, true],
    ["startsWith(github.ref, 'refs/tags/v')", { CI_COMMIT_TAG: "release-1" }, false],
    ["contains(matrix.python, 'pypy')", { PYTHON: "pypy-3.11" }, true],
    ["!env.SKIP && matrix.os != 'windows-latest'", { SKIP: "", OS: "ubuntu-latest" }, true],
    ["!env.SKIP && matrix.os != 'windows-latest'", { SKIP: "1", OS: "ubuntu-latest" }, false],
  ] as const)("runs %s with %o in sh", (expr, env, expected) => {
    const r = spawnSync("sh", ["-c", `if ${shell(expr)}; then exit 0; else exit 1; fi`], { env: { ...process.env, ...env } });
    expect(r.status === 0).toBe(expected);
  });
});
