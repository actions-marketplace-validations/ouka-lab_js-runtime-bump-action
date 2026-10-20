import { describe, expect, it } from "vitest";
import { Git } from "../git.ts";
import { upsertPullRequest } from "../github.ts";
import { fetchNodeStatus } from "../sources/node.ts";
import { fetchLatest } from "../sources/npm.ts";
import { NODE_INDEX, SCHEDULE, stubFetch } from "./helpers.ts";

const respond = (routes: Record<string, unknown>, status = 200) =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find((suffix) => url.endsWith(suffix));
    return key
      ? new Response(JSON.stringify(routes[key]), { status })
      : new Response("nope", { status: 404, statusText: "Not Found" });
  }) as typeof fetch;

describe("fetchNodeStatus", () => {
  it("splits LTS lines into supported and end-of-life by date", async () => {
    const status = await fetchNodeStatus(stubFetch().fetcher, "2027-05-01");
    expect(status.supported.map((line) => line.major)).toEqual([24, 26, 27]);
    expect(status.endOfLife.map((line) => line.major)).toEqual([20, 22]);
    expect(status.latestVersion).toBe("27.1.0");
  });

  it("does not count a line before its LTS date, nor a line that never had one", async () => {
    const status = await fetchNodeStatus(stubFetch().fetcher, "2027-04-27");
    expect(status.supported.map((line) => line.major)).toEqual([22, 24, 26]);
    expect(status.latestVersion).toBe("26.3.0");
  });

  it("fails when nothing is in LTS or the index lacks the line", async () => {
    await expect(fetchNodeStatus(stubFetch().fetcher, "2000-01-01")).rejects.toThrow(
      "no Node.js line",
    );
    const fetcher = respond({ "/schedule.json": SCHEDULE, "/index.json": NODE_INDEX.slice(1) });
    await expect(fetchNodeStatus(fetcher, "2027-05-01")).rejects.toThrow(
      "no release for Node.js 27",
    );
  });

  it("surfaces HTTP failures", async () => {
    await expect(fetchNodeStatus(respond({}), "2027-05-01")).rejects.toThrow("404 Not Found");
  });
});

describe("fetchLatest", () => {
  it("encodes scoped names", async () => {
    const { fetcher, requests } = stubFetch();
    await fetchLatest(fetcher, "eslint").catch(() => undefined);
    await fetchLatest(fetcher, "@types/node").catch(() => undefined);
    expect(requests.map((request) => request.url)).toEqual([
      "https://registry.npmjs.org/eslint/latest",
      "https://registry.npmjs.org/@types%2Fnode/latest",
    ]);
  });

  it("fails on HTTP errors and on payloads without a version", async () => {
    await expect(fetchLatest(respond({}), "eslint")).rejects.toThrow("404");
    await expect(fetchLatest(respond({ "/latest": {} }), "eslint")).rejects.toThrow("no version");
  });
});

describe("upsertPullRequest", () => {
  const context = (fetcher: typeof fetch) => ({
    token: "t0ken",
    owner: "ouka-lab",
    repo: "demo",
    apiUrl: "https://api.github.com",
    fetcher,
  });
  const input = { head: "js-runtime-bump/node", base: "main", title: "t", body: "b" };

  it("looks the pull request up by owner-qualified head and base", async () => {
    const { fetcher, requests } = stubFetch();
    expect(await upsertPullRequest(context(fetcher), input)).toEqual({
      url: "https://github.com/o/r/pull/1",
      created: true,
    });
    expect(requests[0]?.url).toBe(
      "https://api.github.com/repos/ouka-lab/demo/pulls?state=open&head=ouka-lab%3Ajs-runtime-bump%2Fnode&base=main",
    );
  });

  it.each(["GET", "POST", "PATCH"])(
    "reports a failed %s with the response body",
    async (failing) => {
      const fetcher = (async (_: unknown, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === failing) {
          return new Response("boom", { status: 422, statusText: "Unprocessable" });
        }
        return new Response(
          JSON.stringify(method === "GET" && failing === "PATCH" ? [{ number: 3 }] : []),
        );
      }) as typeof fetch;
      await expect(upsertPullRequest(context(fetcher), input)).rejects.toThrow(
        "422 Unprocessable: boom",
      );
    },
  );
});

describe("Git", () => {
  it("redacts secrets from failures", async () => {
    const git = new Git(async () => ({ code: 1, stdout: "", stderr: "denied for s3cret" }), "/", [
      "s3cret",
    ]);
    await expect(git.run("push", "https://x:s3cret@example.com")).rejects.toThrow(
      "git push https://x:***@example.com failed: denied for ***",
    );
  });
});
