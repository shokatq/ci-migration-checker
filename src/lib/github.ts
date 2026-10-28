/**
 * GitHub REST API access, run from the browser. Unauthenticated requests get
 * 60 calls/hour per IP; a token (never sent anywhere but api.github.com)
 * raises that to 5,000 and allows private repos.
 */
import type { WorkflowFile } from "@/engine/types";

export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
}

/** Accepts `owner/repo`, `https://github.com/owner/repo`, `.../tree/<branch>`, `.git` suffixes. */
export function parseRepoUrl(input: string): RepoRef | null {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/(.+))?$/i.exec(s) ??
    /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ...(m[3] ? { ref: decodeURIComponent(m[3]) } : {}) };
}

export class GitHubError extends Error {}

type Fetch = typeof fetch;

async function api<T>(path: string, token: string | undefined, fetchImpl: Fetch): Promise<T> {
  const res = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.ok) return (await res.json()) as T;
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    const when = reset ? ` Resets at ${new Date(reset).toLocaleTimeString()}.` : "";
    throw new GitHubError(`GitHub API rate limit reached (60 requests/hour without a token).${when} Add a token or paste the YAML instead.`);
  }
  if (res.status === 404) throw new GitHubError("Not found. Check the URL, or add a token if the repo is private.");
  if (res.status === 401) throw new GitHubError("GitHub rejected the token.");
  throw new GitHubError(`GitHub API error ${res.status}`);
}

interface ContentEntry {
  name: string;
  path: string;
  type: string;
  download_url: string | null;
}

export async function fetchWorkflows(ref: RepoRef, token?: string, fetchImpl: Fetch = fetch): Promise<WorkflowFile[]> {
  const q = ref.ref ? `?ref=${encodeURIComponent(ref.ref)}` : "";
  let entries: ContentEntry[];
  try {
    entries = await api<ContentEntry[]>(`/repos/${ref.owner}/${ref.repo}/contents/.github/workflows${q}`, token, fetchImpl);
  } catch (e) {
    if (e instanceof GitHubError && e.message.startsWith("Not found")) {
      throw new GitHubError(`No .github/workflows folder found in ${ref.owner}/${ref.repo} (or the repo is private).`);
    }
    throw e;
  }
  const yamls = entries.filter((e) => e.type === "file" && /\.ya?ml$/i.test(e.name) && e.download_url);
  if (!yamls.length) throw new GitHubError("The .github/workflows folder has no YAML files.");
  // raw.githubusercontent.com doesn't count against the API rate limit.
  return Promise.all(
    yamls.map(async (e) => {
      const res = await fetchImpl(e.download_url!);
      if (!res.ok) throw new GitHubError(`Couldn't download ${e.path} (${res.status})`);
      return { path: e.path, content: await res.text() };
    }),
  );
}

// ---------------------------------------------------------------------------
// CI minutes estimate
// ---------------------------------------------------------------------------

export interface JobTiming {
  started_at: string | null;
  completed_at: string | null;
  labels: string[];
}

export interface MinutesEstimate {
  runsLast30Days: number;
  sampledRuns: number;
  /** Weighted average over workflows, in job-minutes. */
  avgMinutesPerRun: number;
  /** Fraction of runs that executed jobs at all. */
  executedShare: number;
  monthlyMinutes: number;
  /** Share of sampled minutes on Windows/macOS runners, which GitLab bills at a higher cost factor. */
  nonLinuxShare: number;
}

/** One workflow's share of all runs, and the job timings of its sampled runs. */
export interface WorkflowSample {
  share: number;
  runs: JobTiming[][];
}

/** Job-minutes of one run; like GitHub and GitLab, each job is rounded up to the minute. */
function runMinutes(jobs: JobTiming[]): { total: number; nonLinux: number } {
  let total = 0;
  let nonLinux = 0;
  for (const j of jobs) {
    if (!j.started_at || !j.completed_at) continue;
    const ms = Date.parse(j.completed_at) - Date.parse(j.started_at);
    if (!(ms > 0)) continue;
    const min = Math.ceil(ms / 60000);
    total += min;
    if (j.labels.some((l) => /windows|macos/i.test(l))) nonLinux += min;
  }
  return { total, nonLinux };
}

/**
 * Workflows differ wildly in cost (a 40-job test matrix vs a labeler bot), so
 * each workflow is sampled separately and weighted by how often it runs.
 * Shares cover executed runs only; `executedShare` scales for runs that cost
 * nothing (fork PRs awaiting approval, skipped, cancelled).
 */
export function summarizeRuns(runsLast30Days: number, samples: WorkflowSample[], executedShare = 1): MinutesEstimate | null {
  const sampled = samples.filter((s) => s.runs.length);
  if (!sampled.length) return null;
  let avg = 0;
  let weighted = 0;
  let total = 0;
  let nonLinux = 0;
  for (const s of sampled) {
    const mins = s.runs.map(runMinutes);
    const wfAvg = mins.reduce((sum, m) => sum + m.total, 0) / mins.length;
    avg += s.share * wfAvg;
    weighted += s.share;
    for (const m of mins) {
      total += m.total;
      nonLinux += m.nonLinux;
    }
  }
  // Workflows that weren't sampled are assumed to cost the sampled average.
  avg /= weighted;
  return {
    runsLast30Days,
    sampledRuns: sampled.reduce((n, s) => n + s.runs.length, 0),
    avgMinutesPerRun: Math.round(avg * 10) / 10,
    executedShare,
    monthlyMinutes: Math.round(avg * runsLast30Days * executedShare),
    nonLinuxShare: total ? nonLinux / total : 0,
  };
}

const LIST_RUNS = 100;
const SAMPLE_RUNS = 6;

interface RunSummary {
  id: number;
  workflow_id: number;
  conclusion: string | null;
}

/** Costs 1 + up to SAMPLE_RUNS API calls. Returns null when there is no run history. */
export async function estimateMinutes(ref: RepoRef, token?: string, fetchImpl: Fetch = fetch): Promise<MinutesEstimate | null> {
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const list = await api<{ total_count: number; workflow_runs: RunSummary[] }>(
    `/repos/${ref.owner}/${ref.repo}/actions/runs?status=completed&created=%3E%3D${since}&per_page=${LIST_RUNS}`,
    token,
    fetchImpl,
  );
  const executed = list.workflow_runs.filter((r) => r.conclusion === "success" || r.conclusion === "failure");
  if (!executed.length) return null;

  const byWorkflow = new Map<number, RunSummary[]>();
  for (const r of executed) byWorkflow.set(r.workflow_id, [...(byWorkflow.get(r.workflow_id) ?? []), r]);
  // Busiest workflows first; spread the remaining samples over them.
  const groups = [...byWorkflow.values()].sort((a, b) => b.length - a.length).slice(0, SAMPLE_RUNS);
  const perGroup = Math.max(1, Math.floor(SAMPLE_RUNS / groups.length));

  const samples = await Promise.all(
    groups.map(async (runs) => {
      const picked = Array.from({ length: Math.min(perGroup, runs.length) }, (_, i) => runs[Math.floor((i * runs.length) / perGroup)]);
      const timings = await Promise.all(
        picked.map((r) =>
          api<{ jobs: JobTiming[] }>(`/repos/${ref.owner}/${ref.repo}/actions/runs/${r.id}/jobs?per_page=100`, token, fetchImpl).then((x) => x.jobs),
        ),
      );
      return { share: runs.length / executed.length, runs: timings };
    }),
  );
  return summarizeRuns(list.total_count, samples, executed.length / list.workflow_runs.length);
}
