"use client";

import { useEffect, useRef, useState } from "react";
import { analyze } from "@/engine/analyze";
import type { Report as ReportData, WorkflowFile } from "@/engine/types";
import { estimateMinutes, fetchWorkflows, GitHubError, parseRepoUrl, type MinutesEstimate } from "@/lib/github";
import { Report } from "./Report";

type Mode = "repo" | "paste";
export type MinutesState = { status: "idle" | "loading" | "unknown"; reason?: string } | { status: "ok"; value: MinutesEstimate };

const EXAMPLES = ["expressjs/express", "pallets/flask", "gin-gonic/gin", "vitejs/vite"];

const SAMPLE_YAML = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: npm
      - run: npm ci
      - run: npm test
`;

/** Split pasted text on YAML document markers so several workflows can be pasted at once. */
function splitPasted(text: string): WorkflowFile[] {
  return text
    .split(/^---\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((content, i) => ({ path: `pasted-${i + 1}.yml`, content }));
}

export function Checker() {
  const [mode, setMode] = useState<Mode>("repo");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [yaml, setYaml] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);
  const [source, setSource] = useState("");
  const [minutes, setMinutes] = useState<MinutesState>({ status: "idle" });

  async function checkRepo(input: string) {
    const ref = parseRepoUrl(input);
    if (!ref) {
      setError("Enter a GitHub repo like owner/name or https://github.com/owner/name");
      return;
    }
    setLoading(true);
    setError(null);
    setReport(null);
    setMinutes({ status: "idle" });
    try {
      const files = await fetchWorkflows(ref, token || undefined);
      setReport(analyze(files));
      setSource(`${ref.owner}/${ref.repo}`);
      // Make the report shareable: /?repo=owner/name
      window.history.replaceState(null, "", `?repo=${ref.owner}/${ref.repo}${ref.ref ? `/tree/${ref.ref}` : ""}`);
      setMinutes({ status: "loading" });
      estimateMinutes(ref, token || undefined)
        .then((value) => setMinutes(value ? { status: "ok", value } : { status: "unknown", reason: "No completed runs in the last 30 days." }))
        .catch((e) => setMinutes({ status: "unknown", reason: e instanceof GitHubError ? e.message : "Couldn't load run history." }));
    } catch (e) {
      setError(e instanceof GitHubError ? e.message : "Couldn't reach GitHub. Check your connection, or paste the YAML instead.");
    } finally {
      setLoading(false);
    }
  }

  function checkPasted() {
    const files = splitPasted(yaml);
    if (!files.length) {
      setError("Paste at least one workflow file.");
      return;
    }
    setError(null);
    setReport(analyze(files));
    setSource("pasted YAML");
    setMinutes({ status: "unknown", reason: "Run history is only available when checking a GitHub repo." });
  }

  // Run the check straight away for shared links (/?repo=owner/name).
  const started = useRef(false);
  useEffect(() => {
    const repo = new URLSearchParams(window.location.search).get("repo");
    if (!repo || started.current) return;
    started.current = true;
    setUrl(repo);
    checkRepo(repo);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on load
  }, []);

  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
        mode === m
          ? "bg-white shadow-sm dark:bg-slate-800"
          : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-4 inline-flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-950">
          {tab("repo", "GitHub repo")}
          {tab("paste", "Paste YAML")}
        </div>

        {mode === "repo" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              checkRepo(url);
            }}
            className="space-y-3"
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                aria-label="GitHub repository URL"
                className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700"
              />
              <button
                type="submit"
                disabled={loading}
                className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
              >
                {loading ? "Checking…" : "Check readiness"}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
              <span>Try:</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => {
                    setUrl(ex);
                    checkRepo(ex);
                  }}
                  className="rounded-md border border-slate-200 px-2 py-0.5 font-mono text-xs hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-700"
                >
                  {ex}
                </button>
              ))}
            </div>
            <details className="text-sm text-slate-600 dark:text-slate-400">
              <summary className="cursor-pointer select-none">Private repo or rate-limited? Add a GitHub token</summary>
              <div className="mt-2 space-y-1">
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="github_pat_…"
                  aria-label="GitHub token"
                  autoComplete="off"
                  className="w-full max-w-md rounded-lg border border-slate-300 bg-transparent px-3 py-2 font-mono text-sm dark:border-slate-700"
                />
                <p className="text-xs">
                  A fine-grained token with read-only &ldquo;Contents&rdquo; and &ldquo;Actions&rdquo; access. It stays in this
                  tab and is only sent to api.github.com.
                </p>
              </div>
            </details>
          </form>
        ) : (
          <div className="space-y-3">
            <textarea
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
              rows={12}
              spellCheck={false}
              placeholder="Paste one or more workflow files (separate them with ---)"
              aria-label="Workflow YAML"
              className="w-full rounded-lg border border-slate-300 bg-transparent p-3 font-mono text-sm outline-none focus:border-indigo-500 dark:border-slate-700"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={checkPasted}
                className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
              >
                Check readiness
              </button>
              <button
                type="button"
                onClick={() => setYaml(SAMPLE_YAML)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
              >
                Load sample
              </button>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
            {error}
          </p>
        )}
      </section>

      {report && <Report report={report} source={source} minutes={minutes} />}
    </div>
  );
}
