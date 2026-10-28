/** Render the GitLab pipeline model as YAML with TODO comments. */
import { Document, isMap, isScalar, isSeq, Scalar, type YAMLMap } from "yaml";
import type { Line, Rule } from "./types";

type Obj = Record<string, unknown>;

export interface EmitJob {
  name: string;
  body: Obj;
  script: Line[];
  afterScript: Line[];
  todos: string[];
}

export interface PipelineModel {
  header: string[];
  workflowRules?: Rule[];
  stages: string[];
  variables?: Record<string, string>;
  default?: Obj;
  jobs: EmitJob[];
}

const JOB_KEY_ORDER = [
  "stage", "image", "services", "tags", "needs", "variables", "parallel", "rules", "timeout",
  "allow_failure", "environment", "interruptible", "resource_group", "trigger", "cache",
  "script", "after_script", "artifacts",
];

const asComment = (lines: string[]) => lines.flatMap((l) => l.split("\n")).map((l) => ` ${l}`).join("\n");

function orderJob(job: EmitJob): Obj {
  const all: Obj = { ...job.body };
  if (!all.trigger) all.script = job.script.filter((l) => l.cmd).map((l) => l.cmd);
  const after = job.afterScript.filter((l) => l.cmd).map((l) => l.cmd);
  if (after.length) all.after_script = after;
  const ordered: Obj = {};
  for (const k of JOB_KEY_ORDER) if (all[k] !== undefined) ordered[k] = all[k];
  return ordered;
}

/** Attach comment-only lines and per-line comments to the matching sequence items. */
function attachLineComments(doc: Document, path: string[], lines: Line[]) {
  const seq = doc.getIn(path, true);
  if (!isSeq(seq)) {
    const orphan = lines.map((l) => l.comment).filter((c): c is string => !!c);
    if (orphan.length && isMap(doc.getIn(path.slice(0, 1), true))) {
      const job = doc.getIn(path.slice(0, 1), true) as YAMLMap;
      job.comment = asComment(orphan);
    }
    return;
  }
  let pending: string[] = [];
  let i = 0;
  for (const line of lines) {
    if (line.comment) pending.push(line.comment);
    if (!line.cmd) continue;
    const item = seq.items[i++];
    if (pending.length && isScalar(item)) item.commentBefore = asComment(pending);
    pending = [];
  }
  if (pending.length) seq.comment = asComment(pending);
}

export function emit(model: PipelineModel): string {
  const root: Obj = {};
  if (model.workflowRules?.length) root.workflow = { rules: model.workflowRules };
  root.stages = model.stages;
  if (model.variables && Object.keys(model.variables).length) root.variables = model.variables;
  if (model.default) root.default = model.default;
  for (const job of model.jobs) root[job.name] = orderJob(job);

  // Plain repeated values instead of &anchors/*aliases: easier to read and edit.
  const doc = new Document(root, { aliasDuplicateObjects: false });
  doc.commentBefore = asComment(model.header);
  const top = doc.contents as YAMLMap;
  top.items.forEach((pair, idx) => {
    if (!isScalar(pair.key)) pair.key = new Scalar(pair.key);
    if (idx > 0) (pair.key as Scalar).spaceBefore = true;
  });

  for (const job of model.jobs) {
    const pair = top.items.find((p) => (p.key as Scalar).value === job.name);
    if (pair && job.todos.length) (pair.key as Scalar).commentBefore = asComment(job.todos);
    attachLineComments(doc, [job.name, "script"], job.script);
    attachLineComments(doc, [job.name, "after_script"], job.afterScript);
  }
  return doc.toString({ lineWidth: 0 });
}
