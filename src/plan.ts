import { join } from "node:path";
import type { ActionInputs, MatrixSpec, Target } from "./env.ts";
import { fetchNodeStatus } from "./sources/node.ts";
import { fetchLatest, type PackageRelease } from "./sources/npm.ts";
import { raiseEnginesFloor, updatePinnedTool, widenPeerRange } from "./updaters/packageJson.ts";
import { majorOf } from "./updaters/pin.ts";
import {
  type MatrixDecision,
  updateMatrix,
  updateSetupInput,
  updateVersionFile,
} from "./updaters/workflows.ts";
import { type FileChange, Workspace } from "./workspace.ts";

export interface Logger {
  log: (message: string) => void;
  warn: (message: string) => void;
}

export interface Plan {
  target: Target;
  title: string;
  /** Why the change is being made: release dates, latest versions. */
  reasons: string[];
  changes: FileChange[];
}

export interface PlanDeps {
  fetcher: typeof fetch;
  /** ISO date (YYYY-MM-DD) that LTS and end-of-life dates are compared against. */
  today: string;
  logger: Logger;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Releases published after this instant are too new. Counted from the start
 * of `today`, so a release is at least that many days old whenever the run is.
 */
function releaseCutoff(today: string, days: number): number | undefined {
  return days > 0 ? Date.parse(`${today}T00:00:00Z`) - days * DAY : undefined;
}

const LABELS: Record<Exclude<Target["kind"], "npm">, string> = {
  node: "Node.js",
  bun: "Bun",
  pnpm: "pnpm",
};

export function labelOf(target: Target): string {
  return target.kind === "npm" ? target.name : LABELS[target.kind];
}

class Context {
  readonly ws: Workspace;
  readonly inputs: ActionInputs;
  readonly target: Target;

  constructor(inputs: ActionInputs, target: Target) {
    this.ws = new Workspace(inputs.repoRoot);
    this.inputs = inputs;
    this.target = target;
  }

  /** A project-relative file, expressed relative to the repository root. */
  project(name: string): string {
    return this.ws.relative(join(this.inputs.projectDir, name));
  }

  matrixSpecs(): MatrixSpec[] {
    return this.inputs.matrix.filter((spec) => spec.targetId === this.target.id);
  }

  /** Adds `major` to every matrix of this target whose newest entry is older. */
  async addMajorToMatrices(major: number): Promise<number[]> {
    const added = new Set<number>();
    for (const spec of this.matrixSpecs()) {
      const result = await updateMatrix(this.ws, spec.file, spec.key, (existing) => ({
        remove: new Set(),
        add: Math.max(...existing) < major ? [major] : [],
      }));
      for (const value of result.added) {
        added.add(value);
      }
    }
    return [...added];
  }

  /** The release to move to, or `undefined` (logged) when none is old enough yet. */
  async release(deps: PlanDeps, name: string): Promise<PackageRelease | undefined> {
    const days = this.inputs.minimumReleaseAge;
    const release = await fetchLatest(deps.fetcher, name, releaseCutoff(deps.today, days));
    if (!release) {
      deps.logger.log(`${name}: no release is ${days} days old yet.`);
    }
    return release;
  }

  ageNote(): string {
    const days = this.inputs.minimumReleaseAge;
    return days > 0 ? ` at least ${days} days old` : "";
  }

  finish(title: string, reasons: string[]): Plan {
    return { target: this.target, title, reasons, changes: this.ws.changes() };
  }
}

async function planNode(context: Context, deps: PlanDeps): Promise<Plan> {
  const status = await fetchNodeStatus(
    deps.fetcher,
    deps.today,
    releaseCutoff(deps.today, context.inputs.minimumReleaseAge),
  );
  const supported = status.supported.map((line) => line.major);
  const floor = supported[0] ?? 0;

  const added = new Set<number>();
  const removed = new Set<number>();
  for (const spec of context.matrixSpecs()) {
    const result = await updateMatrix(
      context.ws,
      spec.file,
      spec.key,
      (existing): MatrixDecision => {
        const newest = Math.max(...existing);
        return {
          remove: new Set(existing.filter((major) => major < floor)),
          add: supported.filter((major) => major > newest),
        };
      },
    );
    for (const major of result.added) {
      added.add(major);
    }
    for (const major of result.removed) {
      removed.add(major);
    }
  }

  const engines = await raiseEnginesFloor(context.ws, context.project("package.json"), floor);
  if (engines.skipped) {
    deps.logger.warn(
      `engines.node is "${engines.skipped}"; only ">=N" is rewritten, so it was left as is.`,
    );
  }
  const previousFloor = engines.previousFloor;

  const latest = status.latestVersion;
  const release: PackageRelease = { name: "node", version: latest, integrity: undefined };
  const pins = [
    ...(await updateVersionFile(context.ws, context.project(".nvmrc"), latest)),
    ...(await updateVersionFile(context.ws, context.project(".node-version"), latest)),
    ...(await updatePinnedTool(context.ws, context.project("package.json"), release)),
    ...(await updateSetupInput(context.ws, "actions/setup-node", "node-version", latest)),
  ];

  // A floor raised from 20 to 24 drops 20 and 22, even if neither was in a matrix.
  const dropped = status.endOfLife
    .filter(
      (line) =>
        removed.has(line.major) ||
        (previousFloor !== undefined && line.major >= previousFloor && line.major < floor),
    )
    .map((line) => line.major);

  const titles: string[] = [];
  const reasons: string[] = [];
  const newLines = status.supported.filter((line) => added.has(line.major));
  if (newLines.length > 0) {
    titles.push(`support Node.js ${newLines.map((line) => line.major).join(", ")}`);
    for (const line of newLines) {
      reasons.push(`Node.js ${line.major} entered LTS on ${line.ltsStart}.`);
    }
  }
  if (dropped.length > 0 || previousFloor !== undefined) {
    titles.push(`drop Node.js < ${floor}`);
    for (const line of status.endOfLife.filter((line) => dropped.includes(line.major))) {
      reasons.push(`Node.js ${line.major} reached end-of-life on ${line.end}.`);
    }
  }
  if (pins.length > 0) {
    titles.push(`update Node.js to ${latest}`);
    reasons.push(`The latest LTS release${context.ageNote()} is Node.js ${latest}.`);
  }
  return context.finish(titles.join(", "), reasons);
}

async function planTool(context: Context, deps: PlanDeps, name: "bun" | "pnpm"): Promise<Plan> {
  const release = await context.release(deps, name);
  if (!release) {
    return context.finish("", []);
  }
  const latest = release.version;
  const label = labelOf(context.target);

  const pins = [
    ...(await updatePinnedTool(context.ws, context.project("package.json"), release)),
    ...(name === "bun"
      ? [
          ...(await updateVersionFile(context.ws, context.project(".bun-version"), latest)),
          ...(await updateSetupInput(context.ws, "oven-sh/setup-bun", "bun-version", latest)),
        ]
      : await updateSetupInput(context.ws, "pnpm/action-setup", "version", latest)),
  ];
  const added = await context.addMajorToMatrices(majorOf(latest));

  const titles = [
    ...(added.length > 0 ? [`support ${label} ${added.join(", ")}`] : []),
    ...(pins.length > 0 ? [`update ${label} to ${latest}`] : []),
  ];
  return context.finish(titles.join(", "), [
    `The latest release${context.ageNote()} is ${label} ${latest}.`,
  ]);
}

async function planPackage(context: Context, deps: PlanDeps, name: string): Promise<Plan> {
  const release = await context.release(deps, name);
  if (!release) {
    return context.finish("", []);
  }
  const major = majorOf(release.version);

  const widened = await widenPeerRange(context.ws, context.project("package.json"), name, major);
  const added = await context.addMajorToMatrices(major);

  const title = widened.length > 0 || added.length > 0 ? `support ${name} ${major}` : "";
  return context.finish(title, [
    `The latest release${context.ageNote()} is ${name} ${release.version}.`,
  ]);
}

export async function planTarget(
  inputs: ActionInputs,
  target: Target,
  deps: PlanDeps,
): Promise<Plan> {
  const context = new Context(inputs, target);
  switch (target.kind) {
    case "node":
      return await planNode(context, deps);
    case "bun":
    case "pnpm":
      return await planTool(context, deps, target.kind);
    case "npm":
      return await planPackage(context, deps, target.name);
  }
}
