import { resolve } from "node:path";

export interface Env {
  INPUT_GITHUB_TOKEN?: string | undefined;
  INPUT_TARGETS?: string | undefined;
  INPUT_MATRIX?: string | undefined;
  INPUT_WORKING_DIRECTORY?: string | undefined;
  INPUT_BASE_BRANCH?: string | undefined;
  INPUT_POST_UPDATE?: string | undefined;
  INPUT_REPOSITORY?: string | undefined;
  INPUT_DRY_RUN?: string | undefined;
  INPUT_MINIMUM_RELEASE_AGE?: string | undefined;
  GITHUB_WORKSPACE?: string | undefined;
  GITHUB_OUTPUT?: string | undefined;
  GITHUB_SERVER_URL?: string | undefined;
  GITHUB_API_URL?: string | undefined;
}

export type Target =
  | { kind: "node"; id: "node" }
  | { kind: "bun"; id: "bun" }
  | { kind: "pnpm"; id: "pnpm" }
  | { kind: "npm"; id: `npm:${string}`; name: string };

export interface MatrixSpec {
  /** Workflow file, relative to the repository root. */
  file: string;
  /** Key under `strategy.matrix`. */
  key: string;
  targetId: Target["id"];
}

export interface ActionInputs {
  token: string | undefined;
  targets: Target[];
  matrix: MatrixSpec[];
  /** Repository root: workflow files and git live here. */
  repoRoot: string;
  /** Where package.json and the version files live. */
  projectDir: string;
  baseBranch: string | undefined;
  postUpdate: string | undefined;
  owner: string;
  repo: string;
  dryRun: boolean;
  /** Days a release must have been out before it is proposed; 0 takes the latest. */
  minimumReleaseAge: number;
  serverUrl: string;
  apiUrl: string;
  outputFile: string | undefined;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function lines(value: string | undefined): string[] {
  return (
    (value ?? "")
      .split("\n")
      .map((line) => line.trim())
      // Only whole-line comments: "#" also separates the file from the key in `matrix`.
      .filter((line) => line !== "" && !line.startsWith("#"))
  );
}

// npm package names cannot contain whitespace, "#" or "=", which is what lets
// both inputs stay one-entry-per-line with no quoting rules.
const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

export function parseTarget(entry: string): Target {
  switch (entry) {
    case "node":
      return { kind: "node", id: "node" };
    case "bun":
      return { kind: "bun", id: "bun" };
    case "pnpm":
      return { kind: "pnpm", id: "pnpm" };
  }
  if (entry.startsWith("npm:")) {
    const name = entry.slice("npm:".length);
    if (!NPM_NAME.test(name)) {
      throw new Error(`\`targets\` has an invalid npm package name: "${name}"`);
    }
    return { kind: "npm", id: `npm:${name}`, name };
  }
  throw new Error(
    `\`targets\` has an unknown entry "${entry}". Use node, bun, pnpm or npm:<package>.`,
  );
}

export function parseMatrixSpec(entry: string, targets: readonly Target[]): MatrixSpec {
  const match = /^([^#=]+)#([^#=]+)=(.+)$/.exec(entry);
  if (!match) {
    throw new Error(
      `\`matrix\` entry "${entry}" must look like <workflow file>#<matrix key>=<target>`,
    );
  }
  const [, file = "", key = "", targetId = ""] = match;
  const target = targets.find((candidate) => candidate.id === targetId.trim());
  if (!target) {
    throw new Error(
      `\`matrix\` entry "${entry}" refers to "${targetId.trim()}", which is not listed in \`targets\``,
    );
  }
  return { file: file.trim(), key: key.trim(), targetId: target.id };
}

export function parseInputs(env: Env): ActionInputs {
  const dryRun = trimmed(env.INPUT_DRY_RUN)?.toLowerCase() === "true";

  const token = trimmed(env.INPUT_GITHUB_TOKEN);
  if (!token && !dryRun) {
    throw new Error("`github-token` is required unless `dry-run` is true");
  }

  const targets: Target[] = [];
  for (const entry of lines(env.INPUT_TARGETS)) {
    const target = parseTarget(entry);
    if (!targets.some((existing) => existing.id === target.id)) {
      targets.push(target);
    }
  }
  if (targets.length === 0) {
    throw new Error("`targets` must list at least one of node, bun, pnpm or npm:<package>");
  }

  const matrix = lines(env.INPUT_MATRIX).map((entry) => parseMatrixSpec(entry, targets));

  const repository = trimmed(env.INPUT_REPOSITORY);
  const [owner, repo, ...rest] = (repository ?? "").split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`\`repository\` must be in "owner/repo" format, got: "${repository ?? ""}"`);
  }

  const age = trimmed(env.INPUT_MINIMUM_RELEASE_AGE) ?? "0";
  if (!/^\d+$/.test(age)) {
    throw new Error(`\`minimum-release-age\` must be a whole number of days, got: "${age}"`);
  }

  const repoRoot = trimmed(env.GITHUB_WORKSPACE) ?? process.cwd();

  return {
    token,
    targets,
    matrix,
    repoRoot,
    projectDir: resolve(repoRoot, trimmed(env.INPUT_WORKING_DIRECTORY) ?? "."),
    baseBranch: trimmed(env.INPUT_BASE_BRANCH),
    postUpdate: trimmed(env.INPUT_POST_UPDATE),
    owner,
    repo,
    dryRun,
    minimumReleaseAge: Number(age),
    serverUrl: trimmed(env.GITHUB_SERVER_URL) ?? "https://github.com",
    apiUrl: trimmed(env.GITHUB_API_URL) ?? "https://api.github.com",
    outputFile: trimmed(env.GITHUB_OUTPUT),
  };
}
