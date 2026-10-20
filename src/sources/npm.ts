import semver from "semver";

export const REGISTRY_URL = "https://registry.npmjs.org";

export interface PackageRelease {
  name: string;
  version: string;
  /** Subresource-integrity string of the tarball, e.g. "sha512-…". */
  integrity: string | undefined;
  /** Publish time (ISO 8601), when the registry reported it. */
  published?: string | undefined;
}

interface LatestPayload {
  version?: string;
  dist?: { integrity?: string };
}

interface Packument {
  "dist-tags"?: { latest?: string };
  versions?: Record<string, { dist?: { integrity?: string } }>;
  time?: Record<string, string>;
}

function packageUrl(name: string): string {
  // Scoped names keep their "@" but the slash must be encoded.
  return `${REGISTRY_URL}/${name.replace("/", "%2F")}`;
}

async function getJson<T>(fetcher: typeof fetch, url: string): Promise<T> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/**
 * The `latest` dist-tag. With `releasedBy` (an instant in ms), the newest
 * stable version up to `latest` that was published by then, so a release gets
 * time to be yanked or found compromised before it is proposed — the same idea
 * as pnpm's `minimumReleaseAge`. `undefined` when no version is old enough.
 */
export async function fetchLatest(
  fetcher: typeof fetch,
  name: string,
  releasedBy?: number,
): Promise<PackageRelease | undefined> {
  if (releasedBy === undefined) {
    const url = `${packageUrl(name)}/latest`;
    const payload = await getJson<LatestPayload>(fetcher, url);
    if (!payload.version) {
      throw new Error(`${url} returned no version`);
    }
    return { name, version: payload.version, integrity: payload.dist?.integrity };
  }

  // The abbreviated packument has no per-version publish times, so this is the full one.
  const url = packageUrl(name);
  const payload = await getJson<Packument>(fetcher, url);
  const latest = payload["dist-tags"]?.latest;
  if (!latest || !payload.versions) {
    throw new Error(`${url} returned no version`);
  }
  let best: string | undefined;
  for (const version of Object.keys(payload.versions)) {
    const published = Date.parse(payload.time?.[version] ?? "");
    if (
      semver.valid(version) &&
      !semver.prerelease(version) &&
      semver.lte(version, latest) &&
      published <= releasedBy &&
      (best === undefined || semver.gt(version, best))
    ) {
      best = version;
    }
  }
  if (best === undefined) {
    return undefined;
  }
  return {
    name,
    version: best,
    integrity: payload.versions[best]?.dist?.integrity,
    published: payload.time?.[best],
  };
}
