import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

export function tempDir(prefix = "js-runtime-bump-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export async function workspace(files: Record<string, string>): Promise<string> {
  const dir = tempDir();
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return dir;
}

export const SCHEDULE = {
  v20: { start: "2023-04-18", lts: "2023-10-24", end: "2026-04-30" },
  v22: { start: "2024-04-24", lts: "2024-10-29", end: "2027-04-30" },
  v23: { start: "2024-10-16", end: "2025-06-01" },
  v24: { start: "2025-05-06", lts: "2025-10-28", end: "2028-04-30" },
  v26: { start: "2026-04-22", lts: "2026-10-28", end: "2029-04-30" },
  v27: { start: "2027-04-20", lts: "2027-04-28", end: "2030-04-30" },
};

export const NODE_INDEX = [
  { version: "v27.1.0", date: "2027-04-29", lts: "Example" },
  { version: "v27.0.0", date: "2027-04-20", lts: false },
  { version: "v26.3.0", date: "2027-03-01", lts: "Example" },
  { version: "v24.11.1", date: "2026-01-01", lts: "Krypton" },
  { version: "v22.20.0", date: "2025-10-01", lts: "Jod" },
];

export const integrityOf = (spec: string) => `sha512-${Buffer.from(spec).toString("base64")}`;

/** `latest` and the publish time of every version, as the full packument has it. */
export const PACKAGES: Record<string, { latest: string; time: Record<string, string> }> = {
  pnpm: {
    latest: "12.0.1",
    time: {
      "11.9.0": "2027-03-01T00:00:00.000Z",
      "12.0.0": "2027-04-10T12:00:00.000Z",
      "12.0.1": "2027-04-30T12:00:00.000Z",
      // a prerelease and a version past `latest` are never proposed
      "13.0.0-rc.0": "2027-01-01T00:00:00.000Z",
      "13.0.0": "2027-01-01T00:00:00.000Z",
    },
  },
  bun: { latest: "1.5.0", time: { "1.5.0": "2027-01-01T00:00:00.000Z" } },
  eslint: {
    latest: "11.0.0",
    time: { "10.5.0": "2027-03-01T00:00:00.000Z", "11.0.0": "2027-04-25T00:00:00.000Z" },
  },
};

export interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

/** Serves the Node.js release data, the npm registry and the pulls API. */
export function stubFetch(options: { pulls?: { number: number; html_url: string }[] } = {}): {
  fetcher: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (url.endsWith("/schedule.json")) {
      return json(SCHEDULE);
    }
    if (url.endsWith("/dist/index.json")) {
      return json(NODE_INDEX);
    }
    const registry = /^https:\/\/registry\.npmjs\.org\/([^/]+)(\/latest)?$/.exec(url);
    if (registry) {
      const name = decodeURIComponent(registry[1] ?? "");
      const pkg = PACKAGES[name];
      if (!pkg) {
        return json({}, 404);
      }
      if (registry[2]) {
        return json({
          version: pkg.latest,
          dist: { integrity: integrityOf(`${name}@${pkg.latest}`) },
        });
      }
      const versions = Object.fromEntries(
        Object.keys(pkg.time).map((v) => [v, { dist: { integrity: integrityOf(`${name}@${v}`) } }]),
      );
      return json({ "dist-tags": { latest: pkg.latest }, versions, time: pkg.time });
    }
    if (url.includes("/pulls")) {
      if (method === "GET") {
        return json(options.pulls ?? []);
      }
      if (method === "POST") {
        return json({ number: 1, html_url: "https://github.com/o/r/pull/1" }, 201);
      }
      return json({});
    }
    return json({ message: `unexpected ${url}` }, 500);
  }) as typeof fetch;

  return { fetcher, requests };
}
