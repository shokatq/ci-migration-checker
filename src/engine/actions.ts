/** Catalog of well-known `uses:` actions and how each maps onto a GitLab job. */
import { translateInline, type ExprContext } from "./expressions";
import type { Finding, Line, Status } from "./types";

/** Mutable GitLab job being assembled from a GitHub job. */
export interface JobBuild {
  /** Runtime → image, collected from setup-* actions, e.g. node → node:20. */
  runtimes: Map<string, string>;
  variables: Record<string, string>;
  cache: Record<string, unknown>[];
  artifacts?: { name?: string; paths: string[]; exclude?: string[]; expire_in?: string; when?: string };
  services: Record<string, unknown>[];
  script: Line[];
  afterScript: Line[];
}

export function newJobBuild(): JobBuild {
  return { runtimes: new Map(), variables: {}, cache: [], services: [], script: [], afterScript: [] };
}

type With = Record<string, unknown>;

interface ActionContext {
  ref: string;
  with: With;
  job: JobBuild;
  ctx: ExprContext;
  /** `if: always()` on the step; artifacts should be kept on failure too. */
  always: boolean;
}

type Handler = (a: ActionContext) => { status: Status; reason: string };

const str = (v: unknown): string => (v == null ? "" : String(v));
const lines = (v: unknown): string[] => str(v).split("\n").map((s) => s.trim()).filter(Boolean);

/** "20.x" → "20", "^1" → "1", "lts/*" → "lts", "${{ matrix.node }}" → "$NODE". */
export function imageTag(raw: unknown, ctx: ExprContext): string {
  let v = translateInline(str(raw).trim(), ctx).text;
  v = v.replace(/^[\^~>=v]+/, "").replace(/(\.x)+$/, "").replace(/\.\*$/, "");
  if (/^lts\//.test(v) || v === "lts") return "lts";
  if (!v || v === "latest" || v === "stable" || v === "*") return "latest";
  return v;
}

function runtime(name: string, image: string, versionKey: string, fileKey?: string): Handler {
  return ({ with: w, job, ctx }) => {
    const notes: string[] = [];
    if (!w[versionKey] && fileKey && w[fileKey]) {
      job.runtimes.set(name, `${image}:latest`);
      return { status: "manual", reason: `Version comes from \`${str(w[fileKey])}\`; pin the matching tag on the \`${image}\` image` };
    }
    const tag = imageTag(w[versionKey], ctx);
    job.runtimes.set(name, `${image}:${tag}`);
    if (!w[versionKey]) notes.push(`no version given, using \`${image}:latest\``);
    return { status: notes.length ? "manual" : "clean", reason: [`Becomes the job image \`${image}:${tag}\``, ...notes].join("; ") };
  };
}

function addCache(job: JobBuild, files: string[], paths: string[], variables: Record<string, string> = {}) {
  job.cache.push({ key: { files }, paths });
  Object.assign(job.variables, variables);
}

/** Built-in dependency caching offered by setup-node / setup-python. */
const PACKAGE_CACHES: Record<string, () => [string[], string[], Record<string, string>]> = {
  npm: () => [["package-lock.json"], [".npm/"], { npm_config_cache: "$CI_PROJECT_DIR/.npm" }],
  yarn: () => [["yarn.lock"], [".yarn-cache/"], { YARN_CACHE_FOLDER: "$CI_PROJECT_DIR/.yarn-cache" }],
  pnpm: () => [["pnpm-lock.yaml"], [".pnpm-store/"], { npm_config_store_dir: "$CI_PROJECT_DIR/.pnpm-store" }],
  pip: () => [["requirements.txt"], [".cache/pip/"], { PIP_CACHE_DIR: "$CI_PROJECT_DIR/.cache/pip" }],
};

function withPackageCache(inner: Handler): Handler {
  return (a) => {
    const result = inner(a);
    const kind = str(a.with.cache);
    if (kind && PACKAGE_CACHES[kind]) {
      addCache(a.job, ...PACKAGE_CACHES[kind]());
      result.reason += `; \`cache: ${kind}\` → \`cache:\` keyed on the lockfile`;
    }
    return result;
  };
}

const manual = (reason: string): Handler => () => ({ status: "manual", reason });
const none = (reason: string): Handler => () => ({ status: "none", reason });

/** Paths GitLab can cache/archive must live inside the project directory. */
const outsideProject = (p: string) => /^(~|\/|\$HOME|\$\{\{)/.test(p);

const HANDLERS: Record<string, Handler> = {
  "actions/checkout": ({ with: w, job }) => {
    const notes: string[] = [];
    let status: Status = "clean";
    if (w["fetch-depth"] != null) {
      // Both use 0 for a full clone.
      const depth = str(w["fetch-depth"]);
      job.variables.GIT_DEPTH = depth;
      notes.push(`\`fetch-depth: ${depth}\` → \`GIT_DEPTH: "${depth}"\``);
    }
    if (w.submodules) {
      job.variables.GIT_SUBMODULE_STRATEGY = str(w.submodules) === "recursive" ? "recursive" : "normal";
      notes.push("`submodules` → `GIT_SUBMODULE_STRATEGY`");
    }
    if (w.repository || w.path) {
      status = "manual";
      notes.push("checking out another repo/path → clone it in `script` with `CI_JOB_TOKEN`");
    }
    if (w.ref && !/github\.(ref|sha|head_ref)/.test(str(w.ref))) {
      status = "manual";
      notes.push(`custom \`ref: ${str(w.ref)}\` → \`git checkout\` in script`);
    }
    return { status, reason: ["GitLab clones the repo automatically", ...notes].join("; ") };
  },

  "actions/setup-node": withPackageCache((a) => {
    const r = runtime("node", "node", "node-version", "node-version-file")(a);
    if (a.with["registry-url"]) {
      return { status: "manual", reason: `${r.reason}; \`registry-url\` → write an .npmrc with your token in \`script\`` };
    }
    return r;
  }),
  "actions/setup-python": withPackageCache((a) => {
    const v = str(a.with["python-version"]);
    if (v.startsWith("pypy")) {
      a.job.runtimes.set("python", `pypy:${v.replace(/^pypy-?/, "") || "3"}`);
      return { status: "clean", reason: "PyPy → the `pypy` image" };
    }
    const r = runtime("python", "python", "python-version", "python-version-file")(a);
    if (/^\d+\.\d+t$/.test(v)) return { status: "manual", reason: "Free-threaded Python builds have no official Docker image; build or pick one" };
    if (/\$\{\{/.test(v) && /\$\{\{.*\|\|/.test(v)) r.status = "manual";
    return r;
  }),
  "actions/setup-go": runtime("go", "golang", "go-version", "go-version-file"),
  "actions/setup-java": runtime("java", "eclipse-temurin", "java-version", "java-version-file"),
  "actions/setup-dotnet": runtime("dotnet", "mcr.microsoft.com/dotnet/sdk", "dotnet-version"),
  "ruby/setup-ruby": (a) => {
    const r = runtime("ruby", "ruby", "ruby-version")(a);
    if (a.with["bundler-cache"]) {
      addCache(a.job, ["Gemfile.lock"], ["vendor/bundle/"], { BUNDLE_PATH: "vendor/bundle" });
      a.job.script.push({ cmd: "bundle install" });
      r.reason += "; `bundler-cache` → `bundle install` + cache on Gemfile.lock";
    }
    return r;
  },
  "dtolnay/rust-toolchain": ({ ref, with: w, job, ctx }) => {
    const toolchain = str(w.toolchain) || ref;
    job.runtimes.set("rust", `rust:${imageTag(toolchain, ctx)}`);
    const components = str(w.components).split(/[,\s]+/).filter(Boolean);
    if (components.length) job.script.push({ cmd: `rustup component add ${components.join(" ")}` });
    if (toolchain === "nightly") {
      return { status: "manual", reason: "Nightly toolchain → `rustup toolchain install nightly` on the `rust` image" };
    }
    return { status: "clean", reason: "Becomes the `rust` image" + (components.length ? " plus `rustup component add`" : "") };
  },
  "actions-rs/toolchain": (a) => HANDLERS["dtolnay/rust-toolchain"]({ ...a, ref: str(a.with.toolchain) || "stable" }),
  "swatinem/rust-cache": ({ job }) => {
    addCache(job, ["Cargo.lock"], ["target/", ".cargo/"], { CARGO_HOME: "$CI_PROJECT_DIR/.cargo" });
    return { status: "clean", reason: "→ `cache:` for target/ and CARGO_HOME, keyed on Cargo.lock" };
  },
  "pnpm/action-setup": ({ with: w, job }) => {
    const v = str(w.version);
    job.script.push({ cmd: v ? `npm install -g pnpm@${v}` : "corepack enable" });
    return { status: "clean", reason: v ? `→ \`npm install -g pnpm@${v}\`` : "→ `corepack enable`" };
  },
  "oven-sh/setup-bun": runtime("bun", "oven/bun", "bun-version"),
  "denoland/setup-deno": runtime("deno", "denoland/deno", "deno-version"),
  "astral-sh/setup-uv": ({ with: w, job }) => {
    job.script.push({ cmd: "pip install uv" });
    if (w["enable-cache"]) addCache(job, ["uv.lock"], [".cache/uv/"], { UV_CACHE_DIR: "$CI_PROJECT_DIR/.cache/uv" });
    return { status: "clean", reason: "→ `pip install uv` (needs a Python image)" + (w["enable-cache"] ? " + `cache:` on uv.lock" : "") };
  },

  "actions/cache": ({ with: w, job, ctx }) => {
    const paths = lines(w.path).map((p) => translateInline(p, ctx).text);
    const notes: string[] = [];
    let status: Status = "clean";
    const inside = paths.filter((p) => !outsideProject(p));
    if (inside.length < paths.length) {
      status = "manual";
      notes.push("GitLab only caches paths inside the project dir; point the tool's cache directory there with an env var");
    }
    const key = str(w.key);
    const hash = /\$\{\{\s*hashFiles\(([^)]*)\)\s*\}\}/.exec(key);
    const entry: Record<string, unknown> = { key: undefined, paths: inside.length ? inside : paths };
    if (hash) {
      const files = [...hash[1].matchAll(/'([^']+)'/g)].map((m) => m[1].replace(/^\*\*\//, ""));
      const prefix = translateInline(key.slice(0, hash.index), ctx).text.replace(/[-|_]+$/, "");
      entry.key = prefix && !/\$\{\{/.test(prefix) ? { files: files.slice(0, 2), prefix } : { files: files.slice(0, 2) };
      if (files.length > 2) {
        status = "manual";
        notes.push("`cache:key:files` takes at most 2 files");
      }
    } else {
      const t = translateInline(key, ctx);
      entry.key = t.text;
      if (t.issues.length) {
        status = "manual";
        notes.push(...t.issues);
      }
    }
    if (w["restore-keys"]) notes.push("`restore-keys` → `cache:fallback_keys` if you need them");
    job.cache.push(entry);
    return { status, reason: ["→ `cache:` with the same paths and key", ...notes].join("; ") };
  },
  "actions/upload-artifact": ({ with: w, job, ctx, always }) => {
    const all = lines(w.path).map((p) => translateInline(p, ctx).text);
    const paths = all.filter((p) => !p.startsWith("!"));
    const exclude = all.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
    const a = job.artifacts ?? { paths: [] };
    a.paths.push(...paths);
    if (exclude.length) a.exclude = [...(a.exclude ?? []), ...exclude];
    if (w.name && !a.name) a.name = translateInline(str(w.name), ctx).text;
    if (w["retention-days"]) a.expire_in = `${str(w["retention-days"])} day${str(w["retention-days"]) === "1" ? "" : "s"}`;
    if (always) a.when = "always";
    job.artifacts = a;
    const outside = paths.some(outsideProject);
    return outside
      ? { status: "manual", reason: "→ `artifacts:paths`, but artifacts must be inside the project dir" }
      : { status: "clean", reason: "→ `artifacts:paths`" + (w["retention-days"] ? " + `expire_in`" : "") };
  },
  "actions/download-artifact": ({ with: w }) =>
    w.path
      ? { status: "manual", reason: "Artifacts from `needs` jobs are restored automatically, but at their original paths, not under `path:`" }
      : { status: "clean", reason: "Artifacts from jobs listed in `needs` are downloaded automatically" },

  "docker/login-action": manual("→ `docker login` in `script`; for the GitLab registry use $CI_REGISTRY_USER / $CI_REGISTRY_PASSWORD"),
  "docker/build-push-action": ({ job, with: w }) => {
    if (!job.services.some((s) => s.name === "docker:dind")) {
      job.services.push({ name: "docker:dind" });
      job.variables.DOCKER_TLS_CERTDIR = "/certs";
    }
    const tags = lines(str(w.tags).replace(/,/g, "\n"));
    job.script.push({
      cmd: `docker build -t ${tags[0] ?? "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"} ${str(w.context) || "."}`,
      comment: "TODO: was docker/build-push-action; check tags, build args and push",
    });
    return { status: "manual", reason: "→ `docker build`/`docker push` with a `docker:dind` service (or Kaniko/Buildah); job image should be `docker`" };
  },
  "docker/setup-buildx-action": manual("Buildx ships with the `docker` image; usually just remove this step"),
  "docker/setup-qemu-action": manual("Multi-arch builds → run `docker run --privileged tonistiigi/binfmt --install all` in script"),
  "docker/metadata-action": manual("Compute image tags in shell from $CI_COMMIT_REF_SLUG / $CI_COMMIT_TAG / $CI_COMMIT_SHORT_SHA"),

  "codecov/codecov-action": manual("→ run the Codecov CLI in `script` with CODECOV_TOKEN, or use GitLab's `artifacts:reports:coverage_report`"),
  "coverallsapp/github-action": manual("→ run the Coveralls CLI in `script` with COVERALLS_REPO_TOKEN"),
  "golangci/golangci-lint-action": ({ with: w, job }) => {
    job.script.push({ cmd: `golangci-lint run ${str(w.args)}`.trim(), comment: `TODO: install golangci-lint ${str(w.version)} or use the golangci/golangci-lint image` });
    return { status: "manual", reason: "→ `golangci-lint run` using the `golangci/golangci-lint` image" };
  },

  "softprops/action-gh-release": manual("→ GitLab `release:` keyword (uses the release-cli image) in a tag pipeline"),
  "actions/create-release": manual("→ GitLab `release:` keyword in a tag pipeline"),
  "ncipollo/release-action": manual("→ GitLab `release:` keyword in a tag pipeline"),
  "peaceiris/actions-gh-pages": manual("→ GitLab Pages: a job named `pages` whose `artifacts:paths` include `public/`"),
  "jamesives/github-pages-deploy-action": manual("→ GitLab Pages: a job named `pages` publishing `public/`"),
  "actions/upload-pages-artifact": manual("→ GitLab Pages: a job named `pages` publishing `public/`"),
  "actions/deploy-pages": manual("→ GitLab Pages: deployment happens automatically for the `pages` job"),
  "actions/configure-pages": manual("Not needed for GitLab Pages; remove"),
  "github/codeql-action": manual("→ GitLab SAST: `include: - template: Jobs/SAST.gitlab-ci.yml` (all tiers)"),
  "actions/dependency-review-action": manual("→ GitLab Dependency Scanning (Ultimate tier)"),
  "tj-actions/changed-files": manual("→ `rules:changes` on the jobs that should be skipped"),
  "dorny/paths-filter": manual("→ `rules:changes` on the jobs that should be skipped"),

  "actions/github-script": none("Scripts against the GitHub API; rewrite against the GitLab API (curl/glab) if still needed"),
  "actions/labeler": none("GitHub issue/PR automation; no CI equivalent (use GitLab triage bots/webhooks)"),
  "actions/stale": none("GitHub issue/PR automation; use gitlab-triage on a schedule"),
  "actions/first-interaction": none("GitHub issue/PR automation; no CI equivalent"),
  "peter-evans/create-pull-request": none("Creates GitHub PRs; rewrite with the GitLab API (glab mr create)"),
};

/** Normalise `owner/repo/sub@ref` → catalog key + ref. */
export function parseUses(uses: string): { key: string; ref: string } {
  const [path, ref = ""] = uses.split("@");
  const [owner, repo] = path.split("/");
  return { key: `${owner}/${repo}`.toLowerCase(), ref };
}

export function convertUses(
  uses: string,
  w: With,
  job: JobBuild,
  ctx: ExprContext,
  always: boolean,
): Finding {
  const feature = `uses: ${uses.replace(/@[0-9a-f]{40}$/, "@<sha>")}`;
  if (uses.startsWith("./")) {
    return { feature, status: "manual", reason: "Local composite action → copy its steps into the job or make it a CI/CD component" };
  }
  if (uses.startsWith("docker://")) {
    return { feature, status: "manual", reason: `Run inside \`${uses.slice(9)}\` → use it as the job \`image\`` };
  }
  const { key, ref } = parseUses(uses);
  const handler = HANDLERS[key] ?? (key.startsWith("actions/cache") ? HANDLERS["actions/cache"] : undefined);
  if (!handler) {
    return {
      feature,
      status: "none",
      reason: "Not in the checker's catalog of known actions; reimplement in shell or look for a GitLab CI/CD Catalog component",
    };
  }
  return { feature, ...handler({ ref, with: w, job, ctx, always }) };
}
