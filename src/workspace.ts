import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export interface FileChange {
  /** Relative to the repository root. */
  path: string;
  before: string;
  after: string;
  descriptions: string[];
}

/**
 * Collects the edits for one target in memory. Nothing touches the disk until
 * the plan is committed, so every target starts from the same base tree and a
 * dry run writes nothing at all.
 */
export class Workspace {
  readonly #root: string;
  readonly #files = new Map<string, FileChange>();

  constructor(root: string) {
    this.#root = root;
  }

  get root(): string {
    return this.#root;
  }

  relative(absolute: string): string {
    return relative(this.#root, absolute) || ".";
  }

  async read(path: string): Promise<string | undefined> {
    const pending = this.#files.get(path);
    if (pending) {
      return pending.after;
    }
    return await readFile(join(this.#root, path), "utf8").catch(() => undefined);
  }

  async write(path: string, content: string, description: string): Promise<void> {
    const pending = this.#files.get(path);
    if (pending) {
      pending.after = content;
      pending.descriptions.push(description);
      return;
    }
    const before = (await this.read(path)) ?? "";
    if (before !== content) {
      this.#files.set(path, { path, before, after: content, descriptions: [description] });
    }
  }

  changes(): FileChange[] {
    return [...this.#files.values()].filter((change) => change.before !== change.after);
  }

  async workflowFiles(): Promise<string[]> {
    const dir = join(this.#root, ".github", "workflows");
    const entries = await readdir(dir).catch(() => [] as string[]);
    return entries
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort()
      .map((name) => `.github/workflows/${name}`);
  }
}
