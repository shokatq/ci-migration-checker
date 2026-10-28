import { describe, expect, it } from "vitest";
import { estimateMinutes, fetchWorkflows, GitHubError, parseRepoUrl, spreadOrder, summarizeRuns } from "./github";

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

  it("scales a workflow down by the share of sampled runs that never started a job", () => {
    // 2 of 4 sampled runs ran 10 minutes, 2 had no jobs → 5 minutes per run.
    const est = summarizeRuns(100, [{ share: 1, runs: [[job("00:00", "10:00")], [job("00:00", "10:00")]], emptyRuns: 2 }])!;
    expect(est.avgMinutesPerRun).toBe(5);
    expect(est.sampledRuns).toBe(4);
  });

  it("returns null without run history", () => {
    expect(summarizeRuns(0, [])).toBeNull();
    expect(summarizeRuns(5, [{ share: 1, runs: [] }])).toBeNull();
  });
});

describe("spreadOrder", () => {
  it("visits the ends and middle first, then every index once", () => {
    expect(spreadOrder(8)).toEqual([0, 4, 2, 6, 1, 3, 5, 7]);
    expect(spreadOrder(3).sort()).toEqual([0, 1, 2]);
    expect(spreadOrder(0)).toEqual([]);
  });
});

describe("estimateMinutes", () => {
  // Regression: on expressjs/express the newest runs were fork PRs that "failed"
  // without starting a job, and sampling only those estimated ~25 min/month
  // instead of ~1,200.
  it("keeps sampling past runs that never started a job", async () => {
    const t = (m: number) => ({ started_at: "2026-10-01T10:00:00Z", completed_at: `2026-10-01T10:${String(m).padStart(2, "0")}:00Z`, labels: [] });
    const runs = Array.from({ length: 10 }, (_, i) => ({ id: i, workflow_id: 1, conclusion: "failure" }));
    const jobsByRun: Record<number, unknown[]> = { 0: [], 5: [t(20)], 2: [t(20)] };
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      if (url.includes("/actions/runs?")) return Response.json({ total_count: 10, workflow_runs: runs });
      const id = Number(/runs\/(\d+)\/jobs/.exec(url)![1]);
      return Response.json({ jobs: jobsByRun[id] ?? [] });
    }) as typeof fetch;

    const est = (await estimateMinutes({ owner: "a", repo: "b" }, undefined, fake))!;
    // Sampled runs 0 (empty), 5 and 2 (20 min each): 20 × 2/3 per run, × 10 runs.
    expect(est.avgMinutesPerRun).toBeCloseTo(13.3, 1);
    expect(est.monthlyMinutes).toBe(133);
    expect(calls).toHaveLength(4);
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
