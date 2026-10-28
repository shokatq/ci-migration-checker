# CI Migration Checker

**How ready is your GitHub Actions setup to move to GitLab CI?** Paste a public GitHub repo URL (or workflow YAML) and get:

- a **readiness score** (0–100) and a verdict
- a **job-by-job report**: every trigger, job setting and step is marked *Converts cleanly*, *Needs manual change* or *No equivalent*, with the reason and what to do instead
- a **starter `.gitlab-ci.yml`** with `# TODO` comments wherever a person needs to make a call
- a rough **monthly CI-minutes estimate** from the repo's recent workflow runs, compared to GitLab Free (400) and GitHub Free (2,000)

Everything runs in the browser. There is no backend and nothing is stored.

![Report for gin-gonic/gin: readiness score, CI-minutes estimate and per-workflow findings](docs/screenshot.png)

## Why this exists

I wrote [an analysis of GitLab's public financials](https://www.linkedin.com/pulse/gitlab-doesnt-have-demand-problem-has-three-leaks-engineers-shokat-v8alf/) arguing that one reason GitLab converts so few of its free users is that **switching CI is the hardest part of leaving GitHub**. Repos and issues move with an importer. CI pipelines have to be rewritten by hand. This tool answers the first question a team asks before a migration: *how much of our CI would we have to rewrite?*

## How well does it do on real repos?

**Test fixtures.** The test suite runs the converter on unmodified workflows from popular projects ([sources](src/engine/__fixtures__/README.md)). The generated files are checked in under [`src/engine/__fixtures__/expected/`](src/engine/__fixtures__/expected/), so you can read exactly what it produces.

| Workflow | Score | Clean | Manual | No equivalent |
| --- | ---: | ---: | ---: | ---: |
| expressjs/express `ci.yml` | 88 | 21 | 7 | 0 |
| vitejs/vite `ci.yml` | 86 | 33 | 13 | 0 |
| pallets/flask `tests.yaml` | 85 | 12 | 5 | 0 |
| gin-gonic/gin `gin.yml` | 82 | 11 | 6 | 0 |
| fastapi/fastapi `test.yml` | 75 | 38 | 28 | 3 |

**Survey of 12 more repos** (every workflow in each, 490 jobs in total, run with `npm run survey`). Every one produced valid YAML, with no crashes or parse errors.

| Repo | Workflows | Jobs | Score |
| --- | ---: | ---: | ---: |
| django/django | 17 | 33 | 88 |
| rails/rails | 9 | 9 | 83 |
| prettier/prettier | 17 | 23 | 81 |
| psf/requests | 8 | 13 | 80 |
| tailwindlabs/tailwindcss | 4 | 11 | 80 |
| sveltejs/svelte | 4 | 8 | 74 |
| astral-sh/ruff | 26 | 105 | 73 |
| supabase/supabase | 57 | 72 | 73 |
| nestjs/nest | 2 | 2 | 72 |
| vercel/next.js | 30 | 97 | 66 |
| denoland/deno | 11 | 51 | 64 |
| microsoft/vscode | 14 | 66 | 64 |

Library-style projects with Linux test matrices score highest. Large products score lowest because of what makes them large: Windows/macOS builds, custom runner labels, reusable workflows and local composite actions, and PowerShell steps. The most common manual items across all of them were runner choice, `node-version-file`, job outputs, step-level `if:` conditions and OIDC permissions.

## What it maps

| GitHub Actions | GitLab CI | Notes |
| --- | --- | --- |
| `on: push` (branches, tags, paths) | `workflow:rules` with `$CI_COMMIT_BRANCH` / `$CI_COMMIT_TAG` regexes, `rules:changes` | Globs are converted to regexes. `paths-ignore` has no exact equivalent. |
| `on: pull_request` | `$CI_PIPELINE_SOURCE == "merge_request_event"` | Adds the standard guard against duplicate branch + MR pipelines. |
| `on: schedule` / `workflow_dispatch` | `schedule` / `web` pipeline sources | Schedules must be created in project settings; the report includes the cron. |
| `jobs.<id>` / `needs` | jobs / `needs` | Jobs keep their ids. Each workflow becomes a stage. |
| `runs-on` | GitLab.com shared runners or `tags` | Windows, macOS, ARM, larger and self-hosted runners are flagged. |
| `actions/setup-node`, `-python`, `-go`, `-java`, `-dotnet`, `ruby/setup-ruby`, Rust, Bun, Deno | job `image` | `node:20`, `python:3.12`, `golang:1.23`… including matrix values (`node:$NODE_VERSION`). |
| `strategy.matrix` | `parallel:matrix` | `include` entries that add new combinations are supported. `exclude` is flagged. |
| `env`, `vars.*` | `variables` | |
| `secrets.*` | CI/CD variables | Listed in the report and the file header so you can recreate them as masked variables. |
| `actions/checkout` | implicit clone | `fetch-depth` → `GIT_DEPTH`, `submodules` → `GIT_SUBMODULE_STRATEGY` |
| `actions/cache`, setup-* `cache:` | `cache` with `key:files` | Paths outside the project directory are flagged (GitLab can't cache them). |
| `actions/upload-artifact` / `download-artifact` | `artifacts` / automatic via `needs` | `retention-days` → `expire_in` |
| `services` | `services` with aliases | Flagged when the job connects via `localhost` ports, since GitLab services are reachable by alias. |
| `container` | `image` | |
| `if:` on jobs | `rules:if` | A real expression parser handles `==`, `!=`, `&&`, `||`, `!`, `startsWith`/`endsWith`/`contains`, `github.ref`, `github.event_name` and status functions (`always()` → `when: always`). |
| `if:` on steps | TODO comment, or `after_script` for `always()` / `failure()` | GitLab has no per-line conditions. |
| `${{ github.sha }}`, `$GITHUB_SHA`, … | `$CI_COMMIT_SHA`, … | ~20 context values and env vars are renamed. |
| `timeout-minutes`, `continue-on-error`, `environment`, `concurrency` | `timeout`, `allow_failure`, `environment`, `interruptible` / `resource_group` | |

About 60 well-known actions are in the catalog ([`src/engine/actions.ts`](src/engine/actions.ts)), including Docker build/push, Codecov, GitHub Pages, CodeQL and release actions, each with a specific suggestion. Unknown actions are marked *No equivalent*.

### Scoring

Every finding counts once: clean = 1, manual = 0.5, no equivalent = 0. The score is the average × 100.
85+ is "Ready to migrate", 60–84 "Mostly ready, some manual work", below 60 "Significant manual work".
It is deliberately simple so a reader can check it by hand.

## Design decisions

- **The converter is a pure TypeScript module** ([`src/engine`](src/engine)), with no I/O and no framework code. It is unit-tested on its own, it powers both the web app and a CLI, and it could be published as a package later.
- **No backend.** The GitHub API is called from the browser. Unauthenticated users get 60 requests/hour, which is plenty for a person checking a few repos, and an optional token never leaves the tab except to go to `api.github.com`. The Next.js app is a static export, so it can be hosted anywhere (Vercel, GitLab Pages, S3) for free.
- **Honest over impressive.** When a mapping loses meaning, the tool says so rather than emitting something that looks right and behaves differently. Examples: dropping `paths-ignore`, moving `always()` steps to `after_script` (which runs in a separate shell), Windows legs removed from a matrix. Each one is a *manual* finding with the reason.
- **Expressions are parsed, not regex-replaced.** `if:` conditions go through a small recursive-descent parser so `(a || b) && !c` keeps its meaning in GitLab's rule syntax, and anything it can't translate is rejected explicitly.
- **Comments are first-class output.** The YAML is built with the `yaml` library's document model so TODOs sit directly above the job or line they are about, not in a separate list.
- **Real fixtures, reviewed output.** Tests run on unmodified workflows from popular repos, and the generated files are snapshot files in the repo. Any change in output is a visible diff in code review.
- **Each workflow becomes a stage, and jobs use `needs`.** GitHub runs a workflow's jobs in parallel unless they declare `needs`. Using `needs` (and `needs: []` for root jobs in later stages) keeps that behavior instead of serialising everything by stage.
- **The minutes estimate is stratified by workflow.** Repos mix cheap bot workflows with expensive test matrices, so sampling the newest runs badly underestimates cost. The estimator samples runs per workflow, weights by how often each runs, and discards runs that never executed (e.g. fork PRs waiting for approval). Each job is rounded up to the minute, as both platforms bill.

## Limitations

- The generated file is a starting point. It has not been run on GitLab for you; test it on a branch.
- Reusable workflows, composite actions and `workflow_run` chains are flagged, not converted.
- The minutes estimate uses at most 6 sampled runs and ignores GitLab cost factors for non-Linux runners (it reports their share instead).
- Only `.github/workflows/*.yml` on the default branch (or the branch in a `/tree/<branch>` URL) is read.

## Running locally

Requires Node.js 20+.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000. Other scripts:

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests (vitest) |
| `npm run lint` | ESLint + TypeScript type check |
| `npm run build` | Static export to `out/` |
| `npm run convert -- path/to/workflow.yml` | CLI: prints the `.gitlab-ci.yml` and a summary of findings |
| `npm run survey -- <dir>` | Runs the converter over a folder with one subfolder of workflows per repo and prints a summary table |

## Project structure

```
src/engine/         Pure converter (no I/O)
  analyze.ts        Entry point: files → report + .gitlab-ci.yml
  triggers.ts       on: → rules
  jobs.ts           jobs, steps, matrix, runners, services
  actions.ts        Catalog of known actions
  expressions.ts    ${{ }} parser and translators
  emit.ts           YAML output with comments
  __fixtures__/     Real workflows + expected output
src/lib/github.ts   GitHub API: workflow files and run-history estimate
src/components/     UI
```

## License

MIT. Not affiliated with GitHub or GitLab.
