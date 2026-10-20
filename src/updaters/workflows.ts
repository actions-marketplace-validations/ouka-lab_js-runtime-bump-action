import { isMap, isScalar, isSeq } from "yaml";
import type { Workspace } from "../workspace.ts";
import { bumpPin } from "./pin.ts";
import {
  applyEdits,
  jobsOf,
  majorItem,
  matrixSequences,
  parseWorkflow,
  replaceScalar,
  rewriteSequence,
  type TextEdit,
} from "./yaml.ts";

export interface MatrixDecision {
  remove: ReadonlySet<number>;
  add: readonly number[];
}

export interface MatrixResult {
  added: number[];
  removed: number[];
}

/**
 * Only bare-major items are managed. Anything else in the list — `lts/*`,
 * `5.5`, `latest` — is the author's own choice and is left exactly as is.
 */
export async function updateMatrix(
  ws: Workspace,
  file: string,
  key: string,
  decide: (existing: readonly number[]) => MatrixDecision,
): Promise<MatrixResult> {
  const source = await ws.read(file);
  if (source === undefined) {
    throw new Error(`\`matrix\` refers to ${file}, which does not exist`);
  }
  const sequences = matrixSequences(parseWorkflow(source, file), key);
  if (sequences.length === 0) {
    throw new Error(`${file} has no job with a list at \`strategy.matrix.${key}\``);
  }

  const edits: TextEdit[] = [];
  const added = new Set<number>();
  const removed = new Set<number>();
  for (const seq of sequences) {
    const existing = seq.items.map(majorItem).filter((major) => major !== undefined);
    if (existing.length === 0) {
      continue;
    }
    const decision = decide(existing);
    const add = decision.add.filter((major) => !existing.includes(major));
    const keep = (item: unknown) => {
      const major = majorItem(item);
      return major === undefined || !decision.remove.has(major);
    };
    edits.push(...rewriteSequence(source, seq, keep, add.map(String)));
    for (const major of add) {
      added.add(major);
    }
    for (const major of existing.filter((major) => decision.remove.has(major))) {
      removed.add(major);
    }
  }

  const result = {
    added: [...added].sort((a, b) => a - b),
    removed: [...removed].sort((a, b) => a - b),
  };
  if (edits.length > 0) {
    const parts = [
      ...(result.added.length > 0 ? [`add ${result.added.join(", ")}`] : []),
      ...(result.removed.length > 0 ? [`remove ${result.removed.join(", ")}`] : []),
    ];
    await ws.write(
      file,
      applyEdits(source, edits),
      `\`strategy.matrix.${key}\`: ${parts.join(", ")}`,
    );
  }
  return result;
}

/**
 * Bumps a literal version input of a setup action, e.g. `node-version: 22` on
 * `actions/setup-node`. Expressions and aliases such as `lts/*` are skipped.
 */
export async function updateSetupInput(
  ws: Workspace,
  action: string,
  input: string,
  latest: string,
): Promise<string[]> {
  const descriptions: string[] = [];
  for (const file of await ws.workflowFiles()) {
    const source = await ws.read(file);
    if (source === undefined) {
      continue;
    }
    const doc = parseWorkflow(source, file);
    const edits: TextEdit[] = [];
    const changed: string[] = [];
    for (const [, job] of jobsOf(doc)) {
      const steps = isMap(job) ? job.get("steps", true) : undefined;
      if (!isSeq(steps)) {
        continue;
      }
      for (const step of steps.items) {
        if (!isMap(step) || !String(step.get("uses") ?? "").startsWith(`${action}@`)) {
          continue;
        }
        const scalar = step.getIn(["with", input], true);
        if (!isScalar(scalar)) {
          continue;
        }
        const current = String(scalar.value);
        const next = current.includes("${{") ? undefined : bumpPin(current, latest);
        const edit = next ? replaceScalar(scalar, next) : undefined;
        if (next && edit) {
          edits.push(edit);
          changed.push(`\`${current}\` → \`${next}\``);
        }
      }
    }
    if (edits.length > 0) {
      const description = `${action} \`${input}\` in ${file}: ${[...new Set(changed)].join(", ")}`;
      await ws.write(file, applyEdits(source, edits), description);
      descriptions.push(description);
    }
  }
  return descriptions;
}

/** Single-value files such as `.nvmrc`, `.node-version` and `.bun-version`. */
export async function updateVersionFile(
  ws: Workspace,
  path: string,
  latest: string,
): Promise<string[]> {
  const source = await ws.read(path);
  if (source === undefined) {
    return [];
  }
  const current = source.trim();
  const next = bumpPin(current, latest);
  if (!next) {
    return [];
  }
  const description = `\`${path}\`: \`${current}\` → \`${next}\``;
  await ws.write(path, source.replace(current, next), description);
  return [description];
}
