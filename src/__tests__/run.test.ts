import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../env.ts";
import { type Exec, spawnExec } from "../git.ts";
import type { Logger } from "../plan.ts";
import { bodyOf, branchOf, run } from "../run.ts";
import { stubFetch, tempDir, workspace } from "./helpers.ts";

// Modelled on a real consumer: an ESLint plugin tested across Node.js and
// ESLint majors, with pnpm pinned through devEngines.
const WORKFLOW = `name: test
on: [push]
jobs:
  test:
    strategy:
      matrix:
        node-version:
          - 22
          - 24
          - 26
        eslint:
          - 9
          - 10
    steps:
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: \${{ matrix.node-version }}
  lint:
    steps:
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 'lts/*'
`;

const PACKAGE = `${JSON.stringify(
  {
    name: "demo",
    peerDependencies: { eslint: "^9.7 || ^10" },
    engines: { node: ">=22" },
    devEngines: { packageManager: { name: "pnpm", version: "11.3.0", onFail: "error" } },
  },
  null,
  2,
)}\n`;

const TARGETS = "node\npnpm\nnpm:eslint\n";
const MATRIX = [
  ".github/workflows/test.yml#node-version=node",
  ".github/workflows/test.yml#eslint=npm:eslint",
].join("\n");

const TODAY = "2027-05-01";

const NODE_BRANCH = branchOf({ kind: "node", id: "node" }, "", "main");
const PNPM_BRANCH = branchOf({ kind: "pnpm", id: "pnpm" }, "", "main");
const ESLINT_BRANCH = branchOf({ kind: "npm", id: "npm:eslint", name: "eslint" }, "", "main");

function silent(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line), warn: (line) => lines.push(`warn: ${line}`) };
}

function env(dir: string, overrides: Partial<Env> = {}): Env {
  return {
    INPUT_GITHUB_TOKEN: "t0ken",
    INPUT_TARGETS: TARGETS,
    INPUT_MATRIX: MATRIX,
    INPUT_REPOSITORY: "ouka-lab/demo",
    GITHUB_WORKSPACE: dir,
    ...overrides,
  };
}

// Every git process in these tests — the helper's and the action's — runs
// without the developer's global or system config, so nothing here can pick up
// their identity, signing key or hooks.
const ISOLATED_GIT = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const exec: Exec = (args, options) =>
  spawnExec(args, { ...options, env: { ...options.env, ...ISOLATED_GIT } });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec(["git", ...args], { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

/** A clone of a local bare repository standing in for GitHub. */
async function repository() {
  const server = tempDir();
  const remote = join(server, "ouka-lab", "demo.git");
  mkdirSync(remote, { recursive: true });
  await git(remote, "init", "--bare", "--quiet", "--initial-branch=main");

  const dir = await workspace({
    ".github/workflows/test.yml": WORKFLOW,
    "package.json": PACKAGE,
  });
  await git(dir, "init", "--quiet", "--initial-branch=main");
  await git(dir, "add", ".");
  await git(dir, "commit", "--quiet", "--message", "init");
  await git(dir, "remote", "add", "origin", remote);
  await git(dir, "push", "--quiet", "origin", "main");
  return { dir, remote, serverUrl: `file://${server}` };
}

describe("run (dry-run)", () => {
  it("plans one change set per target without touching the disk", async () => {
    const dir = await workspace({
      ".github/workflows/test.yml": WORKFLOW,
      "package.json": PACKAGE,
    });
    const { fetcher } = stubFetch();
    const logger = silent();

    const result = await run(env(dir, { INPUT_DRY_RUN: "true", INPUT_GITHUB_TOKEN: "" }), {
      fetcher,
      logger,
      today: TODAY,
    });

    const [node, pnpm, eslint] = result.plans;
    expect(node?.title).toBe("support Node.js 27, drop Node.js < 24");
    expect(node?.reasons).toEqual([
      "Node.js 27 entered LTS on 2027-04-28.",
      "Node.js 22 reached end-of-life on 2027-04-30.",
    ]);
    const nodeFiles = Object.fromEntries(node?.changes.map((c) => [c.path, c.after]) ?? []);
    expect(nodeFiles[".github/workflows/test.yml"]).toContain(
      "node-version:\n          - 24\n          - 26\n          - 27\n",
    );
    expect(JSON.parse(nodeFiles["package.json"] ?? "{}").engines.node).toBe(">=24");

    expect(pnpm?.title).toBe("update pnpm to 12.0.1");
    expect(eslint?.title).toBe("support eslint 11");
    const eslintFiles = Object.fromEntries(eslint?.changes.map((c) => [c.path, c.after]) ?? []);
    expect(eslintFiles[".github/workflows/test.yml"]).toContain(
      "eslint:\n          - 9\n          - 10\n          - 11\n",
    );
    // Each target starts from the base tree, not from the previous target's edits.
    expect(eslintFiles[".github/workflows/test.yml"]).toContain("          - 22\n");

    expect(result.pullRequests).toEqual([]);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(PACKAGE);
    expect(logger.lines[0]).toBe("[dry-run] [node] chore: support Node.js 27, drop Node.js < 24");
  });

  it("holds back releases younger than minimum-release-age", async () => {
    const dir = await workspace({
      ".github/workflows/test.yml": WORKFLOW,
      "package.json": PACKAGE,
    });
    const dryRun = { INPUT_DRY_RUN: "true", INPUT_GITHUB_TOKEN: "" };
    const logger = silent();

    // Cut-off 2027-04-24: pnpm 12.0.1 (04-30) and eslint 11.0.0 (04-25) are too new.
    const result = await run(env(dir, { ...dryRun, INPUT_MINIMUM_RELEASE_AGE: "7" }), {
      fetcher: stubFetch().fetcher,
      logger,
      today: TODAY,
    });
    const [node, pnpm, eslint] = result.plans;
    // LTS and end-of-life dates are not release ages: Node.js 27 is still added.
    expect(node?.title).toBe("support Node.js 27, drop Node.js < 24");
    expect(pnpm?.title).toBe("update pnpm to 12.0.0");
    expect(pnpm?.reasons).toEqual(["The latest release at least 7 days old is pnpm 12.0.0."]);
    expect(eslint?.changes).toEqual([]);

    const none = await run(
      env(dir, {
        ...dryRun,
        INPUT_MINIMUM_RELEASE_AGE: "365",
        INPUT_TARGETS: "bun",
        INPUT_MATRIX: "",
      }),
      { fetcher: stubFetch().fetcher, logger, today: TODAY },
    );
    expect(none.plans[0]?.changes).toEqual([]);
    expect(logger.lines).toContain("bun: no release is 365 days old yet.");
  });

  it("writes the outputs", async () => {
    const dir = await workspace({
      ".github/workflows/test.yml": WORKFLOW,
      "package.json": PACKAGE,
    });
    const outputFile = join(dir, "output.txt");
    await run(
      env(dir, {
        INPUT_DRY_RUN: "true",
        INPUT_TARGETS: "npm:eslint",
        INPUT_MATRIX: "",
        GITHUB_OUTPUT: outputFile,
      }),
      { fetcher: stubFetch().fetcher, logger: silent(), today: TODAY, exec },
    );
    const output = readFileSync(outputFile, "utf8");
    expect(output).toContain(
      '[{"target":"npm:eslint","title":"chore: support eslint 11","files":["package.json"]}]',
    );
    expect(output).toMatch(/pull-requests<<\S+\n\n/);
  });

  it("reports targets that are already current", async () => {
    const dir = await workspace({ "package.json": '{"engines":{"node":">=24"}}\n' });
    const logger = silent();
    const result = await run(
      env(dir, { INPUT_DRY_RUN: "true", INPUT_TARGETS: "node\nbun", INPUT_MATRIX: "" }),
      {
        fetcher: stubFetch().fetcher,
        logger,
        today: TODAY,
      },
    );
    expect(result.plans.every((plan) => plan.changes.length === 0)).toBe(true);
    expect(logger.lines).toEqual(["[node] Up to date.", "[bun] Up to date."]);
  });
});

describe("run (publishing)", () => {
  it("pushes one branch per target and opens a pull request for each", async () => {
    const { dir, remote, serverUrl } = await repository();
    const { fetcher, requests } = stubFetch();

    const result = await run(env(dir, { GITHUB_SERVER_URL: serverUrl }), {
      fetcher,
      logger: silent(),
      today: TODAY,
      exec,
    });

    expect(result.pullRequests).toHaveLength(3);
    const branches = (await git(remote, "branch", "--format=%(refname:short)")).split("\n").sort();
    expect(branches).toEqual([NODE_BRANCH, ESLINT_BRANCH, PNPM_BRANCH, "main"].sort());

    const nodePackage = await git(remote, "show", `${NODE_BRANCH}:package.json`);
    expect(JSON.parse(nodePackage).engines.node).toBe(">=24");
    // The node branch carries only the node change.
    expect(JSON.parse(nodePackage).peerDependencies.eslint).toBe("^9.7 || ^10");
    expect(await git(remote, "log", "-1", "--format=%s", NODE_BRANCH)).toBe(
      "chore: support Node.js 27, drop Node.js < 24",
    );

    const created = requests.filter((request) => request.method === "POST");
    expect(created.map((request) => (request.body as { head: string }).head)).toEqual([
      NODE_BRANCH,
      PNPM_BRANCH,
      ESLINT_BRANCH,
    ]);
    expect(created[0]?.body).toMatchObject({ base: "main" });

    // The workspace is back on the base branch with a clean tree.
    expect(await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(dir, "status", "--porcelain")).toBe("");
  });

  it("does not push again when the branch already holds the same change", async () => {
    const { dir, remote, serverUrl } = await repository();
    const options = { INPUT_TARGETS: "npm:eslint", INPUT_MATRIX: "", GITHUB_SERVER_URL: serverUrl };
    await run(env(dir, options), {
      fetcher: stubFetch().fetcher,
      logger: silent(),
      today: TODAY,
      exec,
    });
    const first = await git(remote, "rev-parse", ESLINT_BRANCH);

    const logger = silent();
    const { fetcher, requests } = stubFetch({
      pulls: [{ number: 5, html_url: "https://github.com/ouka-lab/demo/pull/5" }],
    });
    const result = await run(env(dir, options), { fetcher, logger, today: TODAY, exec });

    expect(await git(remote, "rev-parse", ESLINT_BRANCH)).toBe(first);
    expect(logger.lines).toContain(
      `[npm:eslint] ${ESLINT_BRANCH} already has these changes; not pushing.`,
    );
    expect(requests.some((request) => request.method === "PATCH")).toBe(true);
    expect(result.pullRequests).toEqual(["https://github.com/ouka-lab/demo/pull/5"]);
  });

  it("runs post-update and commits what it changes", async () => {
    const { dir, remote, serverUrl } = await repository();
    await run(
      env(dir, {
        INPUT_TARGETS: "npm:eslint",
        INPUT_MATRIX: "",
        INPUT_POST_UPDATE: "echo regenerated > lock.txt && git add lock.txt && touch stray.txt",
        GITHUB_SERVER_URL: serverUrl,
      }),
      { fetcher: stubFetch().fetcher, logger: silent(), today: TODAY, exec },
    );
    const files = await git(remote, "ls-tree", "--name-only", ESLINT_BRANCH);
    expect(files.split("\n")).toContain("lock.txt");
    expect(files.split("\n")).not.toContain("stray.txt");
  });

  it("explains a push rejected for touching workflow files, and restores the base branch", async () => {
    const { dir, serverUrl } = await repository();
    const rejecting: Exec = async (args, options) =>
      args.includes("push")
        ? {
            code: 1,
            stdout: "",
            stderr:
              "refusing to allow a GitHub App to create or update workflow `.github/workflows/test.yml`",
          }
        : await exec(args, options);

    await expect(
      run(env(dir, { GITHUB_SERVER_URL: serverUrl }), {
        fetcher: stubFetch().fetcher,
        logger: silent(),
        today: TODAY,
        exec: rejecting,
      }),
    ).rejects.toThrow("GITHUB_TOKEN never has it");
    expect(await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("fails when post-update fails", async () => {
    const { dir, serverUrl } = await repository();
    await expect(
      run(
        env(dir, {
          INPUT_TARGETS: "npm:eslint",
          INPUT_MATRIX: "",
          INPUT_POST_UPDATE: "echo broken >&2; exit 3",
          GITHUB_SERVER_URL: serverUrl,
        }),
        { fetcher: stubFetch().fetcher, logger: silent(), today: TODAY, exec },
      ),
    ).rejects.toThrow("`post-update` failed for npm:eslint: broken");
  });

  it("refuses to guess the base branch from a detached HEAD", async () => {
    const { dir, serverUrl } = await repository();
    await git(dir, "checkout", "--quiet", "--detach");
    await expect(
      run(
        env(dir, { INPUT_TARGETS: "npm:eslint", INPUT_MATRIX: "", GITHUB_SERVER_URL: serverUrl }),
        {
          fetcher: stubFetch().fetcher,
          logger: silent(),
          today: TODAY,
          exec,
        },
      ),
    ).rejects.toThrow("base-branch");
  });
});

describe("branchOf / bodyOf", () => {
  it("makes scoped package names safe for a branch", () => {
    expect(
      branchOf({ kind: "npm", id: "npm:@types/node", name: "@types/node" }, "", "main"),
    ).toMatch(/^js-runtime-bump\/npm-types-node-[0-9a-f]{8}$/);
  });

  it("keeps targets whose slugs collide on separate branches", () => {
    const npm = (name: string) => ({ kind: "npm", id: `npm:${name}`, name }) as const;
    const pairs = [
      ["@types/node", "types-node"],
      ["foo_bar", "foo-bar"],
      ["@a/b-c", "@a-b/c"],
    ];
    for (const [a = "", b = ""] of pairs) {
      expect(branchOf(npm(a), "", "main")).not.toBe(branchOf(npm(b), "", "main"));
    }
  });

  it("keeps project directories and base branches on separate branches", () => {
    const node = { kind: "node", id: "node" } as const;
    expect(branchOf(node, "packages/a", "main")).not.toBe(branchOf(node, "packages/b", "main"));
    expect(branchOf(node, "", "main")).not.toBe(branchOf(node, "", "release/v1"));
    expect(branchOf(node, "", "main")).toBe(branchOf(node, "", "main"));
  });

  it("lists every change and reason", () => {
    const body = bodyOf({
      target: { kind: "node", id: "node" },
      title: "support Node.js 27",
      reasons: ["Node.js 27 entered LTS on 2027-04-28."],
      changes: [{ path: "package.json", before: "", after: "", descriptions: ["a", "b"] }],
    });
    expect(body).toContain("- Node.js 27 entered LTS on 2027-04-28.");
    expect(body).toContain("| `package.json` | a |\n| `package.json` | b |");
  });
});
