import { isMap, isScalar, isSeq, parseDocument, type Scalar, type YAMLSeq } from "yaml";

/**
 * Edits are applied to the original text by offset rather than by
 * re-serialising the document: `yaml` would otherwise normalise quoting,
 * indentation and comments across the whole workflow file.
 */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export function applyEdits(source: string, edits: readonly TextEdit[]): string {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

export function parseWorkflow(source: string, file: string) {
  const doc = parseDocument(source, { keepSourceTokens: true });
  if (doc.errors.length > 0) {
    throw new Error(`Cannot parse ${file}: ${doc.errors[0]?.message ?? "invalid YAML"}`);
  }
  return doc;
}

type Document = ReturnType<typeof parseWorkflow>;

export function jobsOf(doc: Document): [string, unknown][] {
  const jobs = doc.get("jobs", true);
  if (!isMap(jobs)) {
    return [];
  }
  return jobs.items.map((pair) => [
    String(isScalar(pair.key) ? pair.key.value : pair.key),
    pair.value,
  ]);
}

export function matrixSequences(doc: Document, key: string): YAMLSeq[] {
  const found: YAMLSeq[] = [];
  for (const [, job] of jobsOf(doc)) {
    if (!isMap(job)) {
      continue;
    }
    const node = job.getIn(["strategy", "matrix", key], true);
    if (isSeq(node)) {
      found.push(node);
    }
  }
  return found;
}

/** A matrix item is managed only when it is a bare major such as `24` or `'24'`. */
export function majorItem(item: unknown): number | undefined {
  if (!isScalar(item)) {
    return undefined;
  }
  const value = String(item.value);
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

export function formatLike(template: Scalar, value: string): string {
  switch (template.type) {
    case "QUOTE_SINGLE":
      return `'${value}'`;
    case "QUOTE_DOUBLE":
      return `"${value}"`;
    default:
      return value;
  }
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

function lineEnd(source: string, offset: number): number {
  const end = source.indexOf("\n", offset);
  return end === -1 ? source.length : end;
}

/**
 * Rewrites a sequence so it holds `keep` (existing items, untouched) followed
 * by `add` (new values, formatted like the last existing item).
 */
export function rewriteSequence(
  source: string,
  seq: YAMLSeq,
  keep: (item: unknown) => boolean,
  add: readonly string[],
): TextEdit[] {
  const items = seq.items.filter(isScalar);
  const template = items.at(-1);
  if (!template || !seq.range) {
    return [];
  }
  const removed = items.filter((item) => !keep(item));
  if (removed.length === 0 && add.length === 0) {
    return [];
  }

  if (seq.flow) {
    const texts = items
      .filter((item) => keep(item))
      .map((item) => source.slice(item.range?.[0], item.range?.[1]));
    texts.push(...add.map((value) => formatLike(template, value)));
    const [start, end] = seq.range;
    return [{ start, end: source.lastIndexOf("]", end) + 1, text: `[${texts.join(", ")}]` }];
  }

  // Whole lines are removed and inserted, so that an item's trailing comment
  // goes with it. New lines go *after* the template's line break: the template
  // itself may be removed, and the two edits must not overlap.
  const lineAfter = (at: number) => Math.min(lineEnd(source, at) + 1, source.length);
  const edits: TextEdit[] = [];
  for (const item of removed) {
    const at = item.range?.[0] ?? 0;
    edits.push({ start: lineStart(source, at), end: lineAfter(at), text: "" });
  }
  if (add.length > 0) {
    const at = template.range?.[0] ?? 0;
    const prefix = source.slice(lineStart(source, at), at);
    const insertAt = lineAfter(at);
    const lead = source[insertAt - 1] === "\n" ? "" : "\n";
    const text = add.map((value) => `${prefix}${formatLike(template, value)}\n`).join("");
    edits.push({ start: insertAt, end: insertAt, text: lead + text });
  }
  return edits;
}

/** Replaces a scalar's value in place, keeping its quote style. */
export function replaceScalar(scalar: Scalar, value: string): TextEdit | undefined {
  if (!scalar.range) {
    return undefined;
  }
  return { start: scalar.range[0], end: scalar.range[1], text: formatLike(scalar, value) };
}
