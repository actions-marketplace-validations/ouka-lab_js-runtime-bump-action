import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { type ActionInputs, type Env, parseInputs, type Target } from "./env.ts";
import { type Exec, Git, spawnExec } from "./git.ts";
import { upsertPullRequest } from "./github.ts";
import { setOutput } from "./outputs.ts";
import { type Logger, type Plan, planTarget } from "./plan.ts";

export const REPOSITORY_URL = "https://github.com/ouka-lab/js-runtime-bump-action";
const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

export interface RunDeps {
  fetcher?: typeof fetch;
  logger?: Logger;
  exec?: Exec;
  /** ISO date (YYYY-MM-DD); defaults to today in UTC. */
  today?: string;
}

export interface RunResult {
  plans: Plan[];
  pullRequests: string[];
}

/**
 * The slug keeps the branch readable; the hash keeps it unique, since the slug
 * folds `npm:@a/b-c` and `npm:@a-b/c` together and runs for other project
 * directories or base branches would otherwise force-push over each other.
 */
export function branchOf(target: Target, projectDir: string, baseBranch: string): string {
  const slug = target.id.replace(/[^a-z0-9.-]+/gi, "-").replace(/^-|-$/g, "");
  const hash = createHash("sha256")
    .update([target.id, projectDir.split(sep).join("/"), baseBranch].join("\n"))
    .digest("hex")
    .slice(0, 8);
  return `js-runtime-bump/${slug}-${hash}`;
}

export function titleOf(plan: Plan): string {
  return `chore: ${plan.title}`;
}

export function bodyOf(plan: Plan): string {
  const rows = plan.changes.flatMap((change) =>
    change.descriptions.map((description) => `| \`${change.path}\` | ${description} |`),
  );
  return [
    `Opened by [js-runtime-bump-action](${REPOSITORY_URL}).`,
    "",
    "### Why",
    "",
    ...plan.reasons.map((reason) => `- ${reason}`),
    "",
    "### Changes",
    "",
    "| File | Change |",
    "|---|---|",
    ...rows,
    "",
    "CI on this pull request runs against the versions added here. A failure means",
    "the project needs changes before it can support them.",
    "",
  ].join("\n");
}

function logPlan(plan: Plan, logger: Logger, dryRun: boolean): void {
  if (plan.changes.length === 0) {
    logger.log(`[${plan.target.id}] Up to date.`);
    return;
  }
  logger.log(`${dryRun ? "[dry-run] " : ""}[${plan.target.id}] ${titleOf(plan)}`);
  for (const change of plan.changes) {
    for (const description of change.descriptions) {
      logger.log(`  ${change.path}: ${description}`);
    }
  }
}

/** Builds the remote URL the token authenticates, without persisting it in git config. */
function authenticatedRemote(inputs: ActionInputs, token: string): string {
  const url = new URL(`${inputs.serverUrl}/${inputs.owner}/${inputs.repo}.git`);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

async function publish(
  plan: Plan,
  inputs: ActionInputs,
  git: Git,
  baseSha: string,
  baseBranch: string,
  deps: Required<Pick<RunDeps, "fetcher" | "exec" | "logger">>,
): Promise<string> {
  const token = inputs.token ?? "";
  const branch = branchOf(plan.target, relative(inputs.repoRoot, inputs.projectDir), baseBranch);
  const title = titleOf(plan);
  const body = bodyOf(plan);

  await git.run("checkout", "--force", "-B", branch, baseSha);
  for (const change of plan.changes) {
    const path = join(inputs.repoRoot, change.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, change.after);
  }
  if (inputs.postUpdate) {
    const result = await deps.exec(["bash", "-c", inputs.postUpdate], { cwd: inputs.projectDir });
    if (result.code !== 0) {
      throw new Error(`\`post-update\` failed for ${plan.target.id}: ${result.stderr.trim()}`);
    }
  }
  // Not `--all`: untracked output of `post-update` (or of an earlier target on
  // the same runner) must not end up in this pull request.
  await git.run("add", "--update");
  await git.run("add", "--", ...plan.changes.map((change) => change.path));
  await git.run(
    "-c",
    `user.name=${BOT_NAME}`,
    "-c",
    `user.email=${BOT_EMAIL}`,
    // The runner's own git config must not decide whether this commit is signed.
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--no-verify",
    "--message",
    title,
    "--message",
    plan.reasons.join("\n"),
  );

  // actions/checkout stores its own token as an extra header. An empty value
  // resets that list, so the token given to this action is the one that pushes.
  const remote = authenticatedRemote(inputs, token);
  const auth = ["-c", `http.${inputs.serverUrl}/.extraheader=`];

  // Re-running weekly must not force-push an identical commit every time:
  // that would re-trigger CI and notify reviewers for no change.
  const unchanged =
    (await git.succeeds(...auth, "fetch", "--no-tags", "--depth=2", remote, branch)) &&
    (await git.run("rev-parse", "FETCH_HEAD^{tree}")) ===
      (await git.run("rev-parse", "HEAD^{tree}")) &&
    (await git.succeeds("rev-parse", "--verify", "FETCH_HEAD^")) &&
    (await git.run("rev-parse", "FETCH_HEAD^")) === baseSha;

  if (unchanged) {
    deps.logger.log(`[${plan.target.id}] ${branch} already has these changes; not pushing.`);
  } else {
    try {
      await git.run(...auth, "push", "--force", remote, `HEAD:refs/heads/${branch}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = /workflow/i.test(message)
        ? " The token cannot update files under .github/workflows/. Use a GitHub App token or a PAT with the workflow scope; GITHUB_TOKEN never has it."
        : "";
      throw new Error(`${message}${hint}`);
    }
  }

  const pr = await upsertPullRequest(
    {
      token,
      owner: inputs.owner,
      repo: inputs.repo,
      apiUrl: inputs.apiUrl,
      fetcher: deps.fetcher,
    },
    { head: branch, base: baseBranch, title, body },
  );
  deps.logger.log(`[${plan.target.id}] ${pr.created ? "Opened" : "Updated"} ${pr.url}`);
  return pr.url;
}

export async function run(env: Env, deps: RunDeps = {}): Promise<RunResult> {
  const logger = deps.logger ?? console;
  const fetcher = deps.fetcher ?? fetch;
  const exec = deps.exec ?? spawnExec;
  const today = deps.today ?? new Date().toISOString().slice(0, 10);

  const inputs = parseInputs(env);

  const plans: Plan[] = [];
  for (const target of inputs.targets) {
    const plan = await planTarget(inputs, target, { fetcher, today, logger });
    logPlan(plan, logger, inputs.dryRun);
    plans.push(plan);
  }
  const pending = plans.filter((plan) => plan.changes.length > 0);

  const pullRequests: string[] = [];
  if (!inputs.dryRun && pending.length > 0) {
    const git = new Git(exec, inputs.repoRoot, [inputs.token ?? ""]);
    const baseSha = await git.run("rev-parse", "HEAD");
    const baseBranch = inputs.baseBranch ?? (await git.run("rev-parse", "--abbrev-ref", "HEAD"));
    if (baseBranch === "HEAD") {
      throw new Error("HEAD is detached, so the base branch is unknown. Set `base-branch`.");
    }
    try {
      for (const plan of pending) {
        pullRequests.push(
          await publish(plan, inputs, git, baseSha, baseBranch, { fetcher, exec, logger }),
        );
      }
    } finally {
      await git
        .run("checkout", "--force", baseBranch)
        .catch(() => git.run("checkout", "--force", baseSha));
    }
  }

  await setOutput(
    "changes",
    JSON.stringify(
      pending.map((plan) => ({
        target: plan.target.id,
        title: titleOf(plan),
        files: plan.changes.map((change) => change.path),
      })),
    ),
    inputs.outputFile,
  );
  await setOutput("pull-requests", pullRequests.join(","), inputs.outputFile);
  return { plans, pullRequests };
}
