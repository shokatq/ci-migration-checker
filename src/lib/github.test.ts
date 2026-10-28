import { describe, expect, it } from "vitest";
import { fetchWorkflows, GitHubError, parseRepoUrl, summarizeRuns } from "./github";

describe("parseRepoUrl", () => {
  it.each([
    ["expressjs/express", { owner: "expressjs", repo: "express" }],
    ["https://github.com/vitejs/vite", { owner: "vitejs", repo: "vite" }],
    ["github.com/pallets/flask.git", { owner: "pallets", repo: "flask" }],
    ["https://github.com/gin-gonic/gin/tree/release/v1", { owner: "gin-gonic", repo: "gin", ref: "release/v1" }],
  ])("%s", (input, expected) => {
    expect(parseRepoUrl(input)).toEqual(expected);
  });

  it("rejects non-GitHub input", () => {
    expect(parseRepoUrl("https://gitlab.com/a/b")).toBeNull();
    expect(parseRepoUrl("just-a-name")).toBeNull();
  });
});

describe("summarizeRuns", () => {
  const job = (start: string, end: string, labels = ["ubuntu-latest"]) => ({
    started_at: `2026-10-01T10:${start}Z`,
    completed_at: `2026-10-01T10:${end}Z`,
    labels,
  });

  it("rounds each job up to the minute and scales to 30 days", () => {
    const est = summarizeRuns(100, [
      { share: 1, runs: [[job("00:00", "02:10"), job("00:00", "00:30", ["windows-latest"])], [job("00:00", "04:00")]] }, // (3 + 1 + 4) / 2
    ])!;
    expect(est.avgMinutesPerRun).toBe(4);
    expect(est.monthlyMinutes).toBe(400);
    expect(est.nonLinuxShare).toBeCloseTo(1 / 8);
  });

  it("weights each workflow by how often it runs", () => {
    const est = summarizeRuns(100, [
      { share: 0.8, runs: [[job("00:00", "01:00")]] }, // cheap bot: 1 min
      { share: 0.2, runs: [[job("00:00", "40:00")]] }, // test matrix: 40 min
    ])!;
    expect(est.avgMinutesPerRun).toBe(8.8);
    expect(est.monthlyMinutes).toBe(880);
  });

  it("scales by the share of runs that actually executed jobs", () => {
    expect(summarizeRuns(100, [{ share: 1, runs: [[job("00:00", "10:00")]] }], 0.5)!.monthlyMinutes).toBe(500);
  });

  it("returns null without run history", () => {
    expect(summarizeRuns(0, [])).toBeNull();
    expect(summarizeRuns(5, [{ share: 1, runs: [] }])).toBeNull();
  });
});

describe("fetchWorkflows", () => {
  it("lists the workflows folder and downloads YAML files", async () => {
    const fake = (async (url: string) => {
      if (url.includes("/contents/.github/workflows")) {
        return Response.json([
          { name: "ci.yml", path: ".github/workflows/ci.yml", type: "file", download_url: "https://raw/ci.yml" },
          { name: "README.md", path: ".github/workflows/README.md", type: "file", download_url: "https://raw/README.md" },
        ]);
      }
      return new Response("on: push");
    }) as typeof fetch;
    expect(await fetchWorkflows({ owner: "a", repo: "b" }, undefined, fake)).toEqual([
      { path: ".github/workflows/ci.yml", content: "on: push" },
    ]);
  });

  it("explains rate limiting", async () => {
    const fake = (async () =>
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })) as unknown as typeof fetch;
    await expect(fetchWorkflows({ owner: "a", repo: "b" }, undefined, fake)).rejects.toThrow(GitHubError);
    await expect(fetchWorkflows({ owner: "a", repo: "b" }, undefined, fake)).rejects.toThrow(/rate limit/);
  });
});
