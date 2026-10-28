import { Checker } from "@/components/Checker";

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:py-16">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">CI Migration Checker</h1>
        <p className="mt-3 max-w-2xl text-slate-600 dark:text-slate-400">
          Paste a GitHub repo and see how much of its GitHub Actions setup carries over to GitLab CI: a readiness
          score, a job-by-job report, and a starter <code className="font-mono text-sm">.gitlab-ci.yml</code> with
          TODOs where you need to step in. Everything runs in your browser.
        </p>
      </header>
      <Checker />
      <footer className="mt-16 border-t border-slate-200 pt-6 text-sm text-slate-500 dark:border-slate-800">
        Open source (MIT). Not affiliated with GitHub or GitLab. The generated file is a starting point, so review it
        before you commit it.
      </footer>
    </main>
  );
}
