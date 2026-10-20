export const REGISTRY_URL = "https://registry.npmjs.org";

export interface PackageRelease {
  name: string;
  version: string;
  /** Subresource-integrity string of the tarball, e.g. "sha512-…". */
  integrity: string | undefined;
}

interface LatestPayload {
  version?: string;
  dist?: { integrity?: string };
}

export async function fetchLatest(fetcher: typeof fetch, name: string): Promise<PackageRelease> {
  // Scoped names keep their "@" but the slash must be encoded.
  const url = `${REGISTRY_URL}/${name.replace("/", "%2F")}/latest`;
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as LatestPayload;
  if (!payload.version) {
    throw new Error(`${url} returned no version`);
  }
  return { name, version: payload.version, integrity: payload.dist?.integrity };
}
