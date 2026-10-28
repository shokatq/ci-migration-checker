import { describe, expect, it } from "vitest";
import { convertTriggers, globToRegex, matchExpression } from "./triggers";

describe("branch filter globs", () => {
  it.each([
    ["main", "main"],
    ["release/*", "release\\/[^\\/]*"],
    ["feature/**", "feature\\/.*"],
    ["v[0-9]+.[0-9]+", "v[0-9]+\\.[0-9]+"],
  ])("%s → %s", (glob, re) => {
    expect(globToRegex(glob)).toBe(re);
    // The generated regex must match what GitHub would match.
  });

  it("produces regexes that behave like GitHub filters", () => {
    const re = (g: string) => new RegExp(`^${globToRegex(g)!.replace(/\\\//g, "/")}$`);
    expect(re("release/*").test("release/1.0")).toBe(true);
    expect(re("release/*").test("release/1.0/hotfix")).toBe(false);
    expect(re("release/**").test("release/1.0/hotfix")).toBe(true);
    expect(re("v[0-9]+").test("v12")).toBe(true);
  });

  it("uses == for a single literal branch and a regex otherwise", () => {
    expect(matchExpression("$CI_COMMIT_BRANCH", ["main"])).toBe('$CI_COMMIT_BRANCH == "main"');
    expect(matchExpression("$CI_COMMIT_BRANCH", ["main", "dev"])).toBe("$CI_COMMIT_BRANCH =~ /^(main|dev)$/");
    expect(matchExpression("$CI_COMMIT_BRANCH", ["!main"])).toBeNull();
  });
});

describe("convertTriggers", () => {
  it("accepts string and list forms", () => {
    expect(convertTriggers("push").rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "push"' }]);
    expect(convertTriggers(["push", "pull_request"]).rules).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "push"' },
      { if: '$CI_PIPELINE_SOURCE == "merge_request_event"' },
    ]);
  });

  it("maps push branches, tags, paths and ignores", () => {
    const r = convertTriggers({
      push: { branches: ["main"], tags: ["v*"], paths: ["src/**"], "branches-ignore": ["wip/*"] },
    });
    expect(r.rules).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH =~ /^wip\\/[^\\/]*$/', when: "never" },
      { if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"', changes: ["src/**"] },
      { if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_TAG =~ /^v[^\\/]*$/', changes: ["src/**"] },
    ]);
    expect(r.findings[0].status).toBe("clean");
  });

  it("filters pull requests by target branch", () => {
    const r = convertTriggers({ pull_request: { branches: ["main"] } });
    expect(r.rules).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "main"' },
    ]);
    expect(r.hasMergeRequest).toBe(true);
  });

  it("marks lossy triggers as manual and GitHub-only events as none", () => {
    const r = convertTriggers({
      push: { "paths-ignore": ["docs/**"] },
      schedule: [{ cron: "0 0 * * 1" }],
      workflow_dispatch: { inputs: { level: { type: "string" } } },
      pull_request_target: null,
      issues: { types: ["opened"] },
    });
    const status = Object.fromEntries(r.findings.map((f) => [f.feature, f.status]));
    expect(status).toEqual({
      "on: push": "manual",
      "on: schedule": "manual",
      "on: workflow_dispatch": "manual",
      "on: pull_request_target": "manual",
      "on: issues": "none",
    });
    expect(r.findings[1].reason).toContain("0 0 * * 1");
  });
});
