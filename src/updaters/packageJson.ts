import semver from "semver";
import type { PackageRelease } from "../sources/npm.ts";
import type { Workspace } from "../workspace.ts";
import { bumpPin } from "./pin.ts";

type Json = Record<string, unknown>;

interface DevEngine {
  name?: unknown;
  version?: unknown;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keeps the file's own indentation and trailing newline. JSON.stringify
 * already preserves key order, so this is all a diff needs to stay minimal.
 */
async function editPackageJson(
  ws: Workspace,
  path: string,
  edit: (pkg: Json) => string[],
): Promise<string[]> {
  const source = await ws.read(path);
  if (source === undefined) {
    return [];
  }
  const pkg = JSON.parse(source) as unknown;
  if (!isObject(pkg)) {
    throw new Error(`${path} is not a JSON object`);
  }
  const descriptions = edit(pkg);
  if (descriptions.length === 0) {
    return [];
  }
  const indent = /^[ \t]+(?=")/m.exec(source)?.[0] ?? "  ";
  const trailing = source.endsWith("\n") ? "\n" : "";
  const content = `${JSON.stringify(pkg, null, indent)}${trailing}`;
  for (const description of descriptions) {
    await ws.write(path, content, description);
  }
  return descriptions;
}

export interface EnginesResult {
  descriptions: string[];
  /** The major the floor was raised from, when it was. */
  previousFloor?: number;
  /** Set when `engines.node` exists but has a shape this action does not rewrite. */
  skipped?: string;
}

export async function raiseEnginesFloor(
  ws: Workspace,
  path: string,
  floor: number,
): Promise<EnginesResult> {
  const result: EnginesResult = { descriptions: [] };
  result.descriptions = await editPackageJson(ws, path, (pkg) => {
    const engines = pkg.engines;
    if (!isObject(engines) || typeof engines.node !== "string") {
      return [];
    }
    const match = /^>=\s*(\d+)((?:\.\d+){0,2})$/.exec(engines.node.trim());
    if (!match) {
      result.skipped = engines.node;
      return [];
    }
    const current = Number(match[1]);
    if (current >= floor) {
      return [];
    }
    const zeros = (match[2] ?? "").replace(/\d+/g, "0");
    const next = `>=${floor}${zeros}`;
    const description = `\`engines.node\`: \`${engines.node}\` → \`${next}\``;
    engines.node = next;
    result.previousFloor = current;
    return [description];
  });
  return result;
}

/** Appends `|| ^<major>` to the peer range unless the range already allows it. */
export async function widenPeerRange(
  ws: Workspace,
  path: string,
  name: string,
  major: number,
): Promise<string[]> {
  return await editPackageJson(ws, path, (pkg) => {
    const peers = pkg.peerDependencies;
    if (!isObject(peers) || typeof peers[name] !== "string") {
      return [];
    }
    const range = peers[name];
    if (semver.satisfies(`${major}.0.0`, range)) {
      return [];
    }
    const next = `${range.trim()} || ^${major}`;
    peers[name] = next;
    return [`\`peerDependencies.${name}\`: \`${range}\` → \`${next}\``];
  });
}

function corepackHash(integrity: string | undefined, algorithm: string): string | undefined {
  const match = /^([a-z0-9]+)-(.+)$/.exec(integrity ?? "");
  if (!match || match[1] !== algorithm) {
    return undefined;
  }
  return Buffer.from(match[2] ?? "", "base64").toString("hex");
}

/**
 * Updates every place package.json pins `release.name`: the `packageManager`
 * field (recomputing a Corepack hash if one is present) and the matching
 * entries of `devEngines.packageManager` and `devEngines.runtime`.
 */
export async function updatePinnedTool(
  ws: Workspace,
  path: string,
  release: PackageRelease,
  latest = release.version,
): Promise<string[]> {
  return await editPackageJson(ws, path, (pkg) => {
    const descriptions: string[] = [];

    if (typeof pkg.packageManager === "string") {
      const match = /^([^@]+)@([^+]+)(?:\+([a-z0-9]+)\.[0-9a-f]+)?$/.exec(pkg.packageManager);
      const next = match?.[1] === release.name ? bumpPin(match[2] ?? "", latest) : undefined;
      if (match && next) {
        const algorithm = match[3];
        const hash = algorithm ? corepackHash(release.integrity, algorithm) : undefined;
        if (algorithm && !hash) {
          throw new Error(
            `\`packageManager\` pins a ${algorithm} hash, but the registry gave no matching integrity for ${release.name}@${latest}`,
          );
        }
        const value = `${release.name}@${next}${hash ? `+${algorithm}.${hash}` : ""}`;
        descriptions.push(
          `\`packageManager\`: \`${match[1]}@${match[2]}\` → \`${release.name}@${next}\``,
        );
        pkg.packageManager = value;
      }
    }

    const devEngines = pkg.devEngines;
    if (isObject(devEngines)) {
      for (const field of ["packageManager", "runtime"] as const) {
        const value = devEngines[field];
        const entries = (Array.isArray(value) ? value : [value]).filter(isObject) as DevEngine[];
        for (const entry of entries) {
          if (entry.name !== release.name || typeof entry.version !== "string") {
            continue;
          }
          const next = bumpPin(entry.version, latest);
          if (next) {
            descriptions.push(
              `\`devEngines.${field}\` (${release.name}): \`${entry.version}\` → \`${next}\``,
            );
            entry.version = next;
          }
        }
      }
    }

    return descriptions;
  });
}
