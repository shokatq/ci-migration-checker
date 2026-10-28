import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { analyze } from "./analyze";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function convert(content: string, file = ".github/workflows/ci.yml") {
  const report = analyze([{ path: file, content }]);
  return { report, ci: parse(report.gitlabCi) as Obj };
}

function finding(report: ReturnType<typeof analyze>, job: string, feature: string | RegExp) {
  const j = report.jobs.find((x) => x.gitlabName === job)!;
  return j.findings.find((f) => (typeof feature === "string" ? f.feature === feature : feature.test(f.feature)))!;
}

describe("job mapping", () => {
  const { report, ci } = convert(`
name: CI
on:
  push:
    branches: [main]
  pull_request:
env:
  CI_FLAG: "1"
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20.x, cache: npm }
      - run: npm ci
      - run: npm run build
        env:
          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
          retention-days: 7
  test:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      matrix:
        node-version: [18, 20]
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: pw }
        ports: ["5432:5432"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "\${{ matrix.node-version }}" }
      - uses: actions/cache@v4
        with:
          path: node_modules
          key: deps-\${{ hashFiles('**/package-lock.json') }}
      - run: npm test
        working-directory: packages/app
      - run: echo done
  deploy:
    needs: [test]
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://example.com
    steps:
      - uses: actions/checkout@v4
      - run: ./deploy.sh
`);

  it("emits valid YAML with one stage and workflow rules", () => {
    expect(ci.stages).toEqual(["ci"]);
    expect(ci.workflow.rules).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "push" && $CI_OPEN_MERGE_REQUESTS', when: "never" },
      { if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"' },
      { if: '$CI_PIPELINE_SOURCE == "merge_request_event"' },
    ]);
    expect(ci.variables).toEqual({ CI_FLAG: "1" });
  });

  it("infers the image from setup-* actions and keeps checkout implicit", () => {
    expect(ci.build.image).toBe("node:20");
    expect(ci.build.variables).toMatchObject({ GIT_DEPTH: "0", npm_config_cache: "$CI_PROJECT_DIR/.npm" });
    expect(ci.build.cache).toEqual({ key: { files: ["package-lock.json"] }, paths: [".npm/"] });
    expect(ci.build.script).toEqual(["npm ci", 'export NPM_TOKEN="$NPM_TOKEN"', "npm run build"]);
    expect(ci.build.artifacts).toEqual({ name: "dist", paths: ["dist/"], expire_in: "7 days" });
    expect(report.secrets).toEqual(["NPM_TOKEN"]);
  });

  it("maps needs, matrix, services, cache and working-directory", () => {
    expect(ci.test.needs).toEqual(["build"]);
    expect(ci.test.timeout).toBe("15 minutes");
    expect(ci.test.image).toBe("node:$NODE_VERSION");
    expect(ci.test.parallel).toEqual({ matrix: [{ NODE_VERSION: ["18", "20"] }] });
    expect(ci.test.services).toEqual([{ name: "postgres:16", alias: "postgres", variables: { POSTGRES_PASSWORD: "pw" } }]);
    expect(ci.test.cache).toEqual({ key: { files: ["package-lock.json"], prefix: "deps" }, paths: ["node_modules"] });
    expect(ci.test.script).toEqual(['cd "$CI_PROJECT_DIR/packages/app"', "npm test", 'cd "$CI_PROJECT_DIR"', "echo done"]);
    expect(finding(report, "test", "services").status).toBe("manual"); // localhost → service alias
  });

  it("turns job if: into rules and keeps environments", () => {
    expect(ci.deploy.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"' }]);
    expect(ci.deploy.environment).toEqual({ name: "production", url: "https://example.com" });
    expect(report.jobs.find((j) => j.id === "deploy")!.status).toBe("manual"); // image is a placeholder
  });

  it("scores the report", () => {
    expect(report.score).toBeGreaterThanOrEqual(85);
    expect(report.verdict).toBe("Ready to migrate");
    expect(report.errors).toEqual([]);
  });
});

describe("step handling", () => {
  it("moves always()/failure() steps to after_script and flags step conditions", () => {
    const { report, ci } = convert(`
on: push
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-python@v5
        with: { python-version: "3.12", cache: pip }
      - run: pytest
      - run: echo "version=1" >> $GITHUB_OUTPUT
        id: v
      - run: ./notify.sh
        if: failure()
      - run: ./cleanup.sh
        if: always()
      - run: ./only-main.sh
        if: github.ref == 'refs/heads/main'
      - uses: some-org/unknown-action@v1
`);
    expect(ci.t.image).toBe("python:3.12");
    expect(ci.t.after_script).toEqual(['if [ "$CI_JOB_STATUS" = "failed" ]; then\n./notify.sh\nfi', "./cleanup.sh"]);
    expect(report.gitlabCi).toContain("# TODO: only run when `github.ref == 'refs/heads/main'`");
    expect(report.gitlabCi).toContain("# TODO: uses: some-org/unknown-action@v1");
    expect(finding(report, "t", /GITHUB_OUTPUT|version=1/).status).toBe("manual");
    expect(finding(report, "t", "uses: some-org/unknown-action@v1").status).toBe("none");
  });

  it("renames GitHub env vars and strips sudo", () => {
    const { ci } = convert(`
on: push
jobs:
  t:
    runs-on: ubuntu-latest
    container: node:22
    steps:
      - run: sudo apt-get update && sudo apt-get install -y jq && echo $GITHUB_SHA
`);
    expect(ci.t.image).toBe("node:22");
    expect(ci.t.script).toEqual(["apt-get update && apt-get install -y jq && echo $CI_COMMIT_SHA"]);
  });

  it("drops non-Linux matrix legs and marks the job manual", () => {
    const { report, ci } = convert(`
on: push
jobs:
  t:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        go: ["1.22", "1.23"]
    steps:
      - uses: actions/setup-go@v5
        with: { go-version: "\${{ matrix.go }}" }
      - run: go test ./...
`);
    expect(ci.t.parallel.matrix).toEqual([{ OS: ["ubuntu-latest"], GO: ["1.22", "1.23"] }]);
    expect(ci.t.image).toBe("golang:$GO");
    expect(finding(report, "t", /^runs-on/).status).toBe("manual");
  });
});

describe("multiple workflows", () => {
  it("gives each workflow a stage, per-job trigger rules, and unique job names", () => {
    const report = analyze([
      { path: ".github/workflows/ci.yml", content: "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: [{ run: make test }]" },
      { path: ".github/workflows/release.yml", content: "on:\n  push:\n    tags: ['v*']\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: [{ run: make test }]\n  publish:\n    needs: test\n    runs-on: ubuntu-latest\n    steps: [{ run: make publish }]" },
    ]);
    const ci = parse(report.gitlabCi);
    expect(ci.stages).toEqual(["ci", "release"]);
    expect(Object.keys(ci)).toEqual(expect.arrayContaining(["ci-test", "release-test", "publish"]));
    expect(ci.publish.needs).toEqual(["release-test"]);
    expect(ci["release-test"].needs).toEqual([]);
    expect(ci["release-test"].rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_TAG =~ /^v[^\\/]*$/' }]);
  });

  it("reports unparseable files without failing the rest", () => {
    const report = analyze([
      { path: "bad.yml", content: "jobs: [" },
      { path: "notes.yml", content: "hello: world" },
      { path: "ok.yml", content: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo hi }]" },
    ]);
    expect(report.errors.map((e) => e.path)).toEqual(["bad.yml", "notes.yml"]);
    expect(report.jobs).toHaveLength(1);
  });
});

// Real workflows from popular open-source repos (see __fixtures__/README.md).
const FIXTURES = ["express-ci.yml", "flask-tests.yml", "gin.yml", "vite-ci.yml", "fastapi-test.yml"];

describe.each(FIXTURES)("fixture %s", (name) => {
  const content = readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");
  const report = analyze([{ path: `.github/workflows/${name}`, content }]);

  it("converts every job into valid GitLab YAML", () => {
    expect(report.errors).toEqual([]);
    const ci = parse(report.gitlabCi);
    for (const job of report.jobs) {
      const out = ci[job.gitlabName];
      expect(out, job.gitlabName).toBeDefined();
      expect(out.script ?? out.trigger, job.gitlabName).toBeDefined();
      for (const need of out.needs ?? []) expect(ci[need], `${job.gitlabName} needs ${need}`).toBeDefined();
    }
    // Every finding has a reason a user can act on.
    for (const f of [...report.workflows.flatMap((w) => w.findings), ...report.jobs.flatMap((j) => j.findings)]) {
      expect(f.reason.length).toBeGreaterThan(10);
    }
  });

  it("matches the reviewed output", async () => {
    await expect(report.gitlabCi).toMatchFileSnapshot(`__fixtures__/expected/${name.replace(/\.ya?ml$/, "")}.gitlab-ci.yml`);
    expect({ score: report.score, counts: report.counts }).toMatchSnapshot();
  });
});

describe("fixture specifics", () => {
  const load = (name: string) =>
    analyze([{ path: `.github/workflows/${name}`, content: readFileSync(path.join(__dirname, "__fixtures__", name), "utf8") }]);

  it("express: 9 Node versions on Linux, Windows legs flagged", () => {
    const ci = parse(load("express-ci.yml").gitlabCi);
    expect(ci.test.parallel.matrix[0].NODE_VERSION).toHaveLength(9);
    expect(ci.test.parallel.matrix[0].OS).toEqual(["ubuntu-latest"]);
    expect(ci.coverage.needs).toEqual(["test"]);
  });

  it("gin: full clone for lint, codecov flagged", () => {
    const r = load("gin.yml");
    const ci = parse(r.gitlabCi);
    expect(ci.lint.variables.GIT_DEPTH).toBe("0");
    expect(ci.test.needs).toEqual(["lint"]);
    expect(finding(r, "test", /codecov/).status).toBe("manual");
  });

  it("fastapi: the weekly schedule needs manual setup", () => {
    const r = load("fastapi-test.yml");
    expect(r.workflows[0].findings.find((f) => f.feature === "on: schedule")!.status).toBe("manual");
  });
});
