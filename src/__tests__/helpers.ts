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
  { version: "v27.1.0", lts: "Example" },
  { version: "v26.3.0", lts: "Example" },
  { version: "v24.11.1", lts: "Krypton" },
  { version: "v22.20.0", lts: "Jod" },
];

export const PACKAGES: Record<string, { version: string; integrity?: string }> = {
  pnpm: { version: "12.0.1", integrity: `sha512-${Buffer.from("tarball").toString("base64")}` },
  bun: { version: "1.5.0" },
  eslint: { version: "11.0.0" },
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
    const registry = /^https:\/\/registry\.npmjs\.org\/(.+)\/latest$/.exec(url);
    if (registry) {
      const pkg = PACKAGES[decodeURIComponent(registry[1] ?? "")];
      return pkg
        ? json({ version: pkg.version, dist: { integrity: pkg.integrity } })
        : json({}, 404);
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
