/** How well a GitHub Actions feature carries over to GitLab CI. */
export type Status = "clean" | "manual" | "none";

export interface Finding {
  /** Short label, e.g. "uses: actions/cache@v4" or "on: schedule". */
  feature: string;
  status: Status;
  /** Why it got this status and what to do about it. */
  reason: string;
}

export interface WorkflowFile {
  /** Path in the repo, e.g. ".github/workflows/ci.yml". */
  path: string;
  content: string;
}

export interface JobReport {
  workflow: string;
  /** Job id in the GitHub workflow. */
  id: string;
  /** Job name in the generated .gitlab-ci.yml. */
  gitlabName: string;
  /** Worst status of all findings in the job. */
  status: Status;
  findings: Finding[];
}

export interface WorkflowReport {
  path: string;
  name: string;
  /** Triggers and workflow-level keys (env, permissions, concurrency...). */
  findings: Finding[];
}

export interface Report {
  /** 0-100, see scoring in analyze.ts. */
  score: number;
  verdict: string;
  counts: Record<Status, number>;
  workflows: WorkflowReport[];
  jobs: JobReport[];
  /** Secrets referenced by the workflows; each becomes a GitLab CI/CD variable. */
  secrets: string[];
  /** Files that could not be parsed. */
  errors: { path: string; message: string }[];
  gitlabCi: string;
  todoCount: number;
}

/** A GitLab `rules:` entry. */
export interface Rule {
  if?: string;
  changes?: string[];
  when?: "never" | "always" | "on_failure" | "manual";
}

/** A script line plus an optional comment rendered above it. */
export interface Line {
  cmd?: string;
  comment?: string;
}
