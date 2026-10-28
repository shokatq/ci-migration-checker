"use client";

import { useState } from "react";
import type { Finding, Report as ReportData, Status } from "@/engine/types";
import type { MinutesState } from "./Checker";

const STATUS: Record<Status, { label: string; dot: string; badge: string }> = {
  clean: {
    label: "Converts cleanly",
    dot: "bg-emerald-500",
    badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/60 dark:text-emerald-300",
  },
  manual: {
    label: "Needs manual change",
    dot: "bg-amber-500",
    badge: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950/60 dark:text-amber-300",
  },
  none: {
    label: "No equivalent",
    dot: "bg-rose-500",
    badge: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/60 dark:text-rose-300",
  },
};

// Published plan limits as of Oct 2026; see README for sources.
const GITLAB_FREE_MINUTES = 400;
const GITHUB_FREE_PRIVATE_MINUTES = 2000;

const card = "rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900";

function Badge({ status }: { status: Status }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS[status].badge}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS[status].dot}`} />
      {STATUS[status].label}
    </span>
  );
}

function FindingList({ findings }: { findings: Finding[] }) {
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {findings.map((f, i) => (
        <li key={i} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:gap-4">
          <div className="sm:w-64 sm:shrink-0">
            <code className="break-words font-mono text-xs text-slate-700 dark:text-slate-300">{f.feature}</code>
          </div>
          <div className="flex flex-1 flex-col items-start gap-1">
            <Badge status={f.status} />
            <p className="text-sm text-slate-600 dark:text-slate-400">{f.reason}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Minutes({ state }: { state: MinutesState }) {
  if (state.status === "idle") return null;
  return (
    <div className={card}>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">CI minutes / month</h3>
      {state.status === "loading" && <p className="mt-2 text-sm text-slate-500">Reading recent workflow runs…</p>}
      {state.status === "unknown" && (
        <>
          <p className="mt-2 text-2xl font-semibold">Unknown</p>
          <p className="mt-1 text-sm text-slate-500">{state.reason}</p>
        </>
      )}
      {state.status === "ok" && (
        <>
          <p className="mt-2 text-3xl font-bold tabular-nums">~{state.value.monthlyMinutes.toLocaleString()}</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {state.value.runsLast30Days.toLocaleString()} workflow runs in the last 30 days
            {state.value.executedShare < 1 && <> ({Math.round(state.value.executedShare * 100)}% ran jobs)</>}, ~
            {state.value.avgMinutesPerRun} job-minutes each (sampled {state.value.sampledRuns} runs).
          </p>
          <div className="mt-3 space-y-1.5 text-sm">
            <Bar label="GitLab Free" limit={GITLAB_FREE_MINUTES} used={state.value.monthlyMinutes} />
            <Bar label="GitHub Free (private repos)" limit={GITHUB_FREE_PRIVATE_MINUTES} used={state.value.monthlyMinutes} />
          </div>
          {state.value.nonLinuxShare > 0.05 && (
            <p className="mt-2 text-xs text-slate-500">
              {Math.round(state.value.nonLinuxShare * 100)}% of these minutes ran on Windows/macOS, which GitLab bills at a higher cost factor.
            </p>
          )}
          <p className="mt-2 text-xs text-slate-500">
            Rough estimate: public open-source projects get free minutes on GitHub and can apply for GitLab&apos;s open source program.
          </p>
        </>
      )}
    </div>
  );
}

function Bar({ label, limit, used }: { label: string; limit: number; used: number }) {
  const pct = Math.min(100, (used / limit) * 100);
  const over = used > limit;
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span className={over ? "font-medium text-rose-600 dark:text-rose-400" : ""}>
          {over ? `${(used / limit).toFixed(1)}× the ${limit.toLocaleString()} included` : `fits in ${limit.toLocaleString()}`}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className={`h-full ${over ? "bg-rose-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function GeneratedFile({ yaml }: { yaml: string }) {
  const [copied, setCopied] = useState(false);
  const download = () => {
    const url = URL.createObjectURL(new Blob([yaml], { type: "text/yaml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = ".gitlab-ci.yml";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className={card}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          Generated <code className="font-mono">.gitlab-ci.yml</code>
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(yaml);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={download}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            Download
          </button>
        </div>
      </div>
      <pre className="max-h-[32rem] overflow-auto rounded-lg bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-100">
        {yaml.split("\n").map((line, i) => (
          <div key={i} className={line.trimStart().startsWith("# TODO") ? "text-amber-300" : line.trimStart().startsWith("#") ? "text-slate-400" : ""}>
            {line || " "}
          </div>
        ))}
      </pre>
    </section>
  );
}

export function Report({ report, source, minutes }: { report: ReportData; source: string; minutes: MinutesState }) {
  const total = report.counts.clean + report.counts.manual + report.counts.none;
  const tone = report.score >= 85 ? "text-emerald-600 dark:text-emerald-400" : report.score >= 60 ? "text-amber-600 dark:text-amber-400" : "text-rose-600 dark:text-rose-400";

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <section className={card}>
          <p className="text-sm text-slate-500">
            Results for <span className="font-mono">{source}</span> · {report.workflows.length} workflow
            {report.workflows.length === 1 ? "" : "s"}, {report.jobs.length} job{report.jobs.length === 1 ? "" : "s"}
          </p>
          <div className="mt-3 flex items-end gap-4">
            <p className={`text-6xl font-bold tabular-nums ${tone}`}>{report.score}</p>
            <div className="pb-2">
              <p className="text-lg font-semibold">{report.verdict}</p>
              <p className="text-sm text-slate-500">readiness score out of 100</p>
            </div>
          </div>
          {total > 0 && (
            <div className="mt-4">
              <div className="flex h-2.5 overflow-hidden rounded-full">
                {(["clean", "manual", "none"] as Status[]).map((s) =>
                  report.counts[s] ? <div key={s} className={STATUS[s].dot} style={{ width: `${(report.counts[s] / total) * 100}%` }} /> : null,
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600 dark:text-slate-400">
                {(["clean", "manual", "none"] as Status[]).map((s) => (
                  <span key={s} className="inline-flex items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${STATUS[s].dot}`} />
                    {report.counts[s]} {STATUS[s].label.toLowerCase()}
                  </span>
                ))}
                <span>· {report.todoCount} TODOs in the generated file</span>
              </div>
            </div>
          )}
          {report.secrets.length > 0 && (
            <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">
              Secrets to recreate as masked CI/CD variables:{" "}
              {report.secrets.map((s) => (
                <code key={s} className="mr-1 rounded bg-slate-100 px-1 font-mono text-xs dark:bg-slate-800">
                  {s}
                </code>
              ))}
            </p>
          )}
          {report.errors.map((e) => (
            <p key={e.path} className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
              Skipped <span className="font-mono">{e.path}</span>: {e.message}
            </p>
          ))}
        </section>
        <Minutes state={minutes} />
      </div>

      {report.workflows.map((w) => (
        <section key={w.path} className={card}>
          <h2 className="text-lg font-semibold">
            {w.name} <span className="font-mono text-sm font-normal text-slate-500">{w.path}</span>
          </h2>
          <p className="mb-2 text-sm text-slate-500">Triggers and workflow settings</p>
          <FindingList findings={w.findings} />
        </section>
      ))}

      <section className={card}>
        <h2 className="mb-3 text-lg font-semibold">Jobs</h2>
        <div className="space-y-2">
          {report.jobs.map((j) => (
            <details key={`${j.workflow}/${j.id}`} className="group rounded-lg border border-slate-200 dark:border-slate-800">
              <summary className="flex cursor-pointer select-none flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span className="font-mono text-sm">
                  {j.gitlabName}
                  {j.gitlabName !== j.id && <span className="text-slate-500"> (was {j.id})</span>}
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">
                    {j.findings.filter((f) => f.status !== "clean").length} of {j.findings.length} need attention
                  </span>
                  <Badge status={j.status} />
                </span>
              </summary>
              <div className="border-t border-slate-200 px-4 dark:border-slate-800">
                <FindingList findings={j.findings} />
              </div>
            </details>
          ))}
        </div>
      </section>

      {report.gitlabCi && <GeneratedFile yaml={report.gitlabCi} />}
    </div>
  );
}
