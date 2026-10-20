# js-runtime-bump-action

**Keep the Node.js, Bun, pnpm and peer dependency versions your project supports up to date — with a pull request.**

[![CI](https://github.com/ouka-lab/js-runtime-bump-action/actions/workflows/ci.yml/badge.svg)](https://github.com/ouka-lab/js-runtime-bump-action/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ouka-lab/js-runtime-bump-action?label=release&color=blue)](https://github.com/ouka-lab/js-runtime-bump-action/releases)
[![License: MIT](https://img.shields.io/github/license/ouka-lab/js-runtime-bump-action)](LICENSE)

---

## Why this action exists

Dependabot keeps your *dependencies* current. It does not keep track of what
your project *supports*:

- Node.js 28 enters LTS, but your CI matrix still tests 22, 24 and 26.
- Node.js 22 reaches end-of-life, but `engines.node` still says `>=22`.
- ESLint 11 ships, but `peerDependencies` still says `^9 || ^10`, so your users
  get a peer warning and nothing tells you whether the plugin works on 11.
- pnpm pinned in `devEngines.packageManager` stays where it was.

This action watches the runtimes and tools you list and opens one pull request
per target. CI then runs on that pull request against the newly added versions,
so you learn whether the project works on them before merging.

## What it updates

| Target | Watches | Updates |
|---|---|---|
| `node` | [Node.js release schedule](https://github.com/nodejs/Release) | **Matrix:** adds a line once it **enters LTS**, removes lines past end-of-life. **`engines.node`:** raises a `>=N` floor to the oldest supported LTS. **Pins:** `.nvmrc`, `.node-version`, `devEngines.runtime`, literal `node-version` of `actions/setup-node` → latest LTS release. |
| `bun` | npm registry | **Pins:** `.bun-version`, `packageManager`, `devEngines`, literal `bun-version` of `oven-sh/setup-bun`. **Matrix:** adds a new major. |
| `pnpm` | npm registry | **Pins:** `packageManager` (Corepack hash recomputed), `devEngines.packageManager`, literal `version` of `pnpm/action-setup`. **Matrix:** adds a new major. |
| `npm:<package>` | npm registry | **`peerDependencies`:** appends `\|\| ^N` for a new major. **Matrix:** adds the new major. Nothing is ever removed — dropping support is your call. |

What it leaves alone, on purpose:

- **Matrix entries that are not a bare major** — `lts/*`, `5.5`, `latest` are
  your own choices.
- **`engines.node` that is not `>=N`**, such as `^20.19.0 || >=22.12.0`. The
  action logs a warning instead of guessing.
- **Pins written as aliases or expressions** — `lts/*`, `${{ matrix.node }}`.
- **A pin ahead of LTS.** A project on the Current release is not downgraded.

Pins keep their shape: `22` → `24`, `22.11.0` → `24.11.1`, `^22.1.0` → `^24.11.1`,
`22.x` → `24.x`. Workflow files are edited in place, so comments, quotes and
indentation survive.

### Why LTS, not first release

A Node.js line is added when it enters LTS, not when it is released. That is the
point at which its API is settled and most projects start supporting it. The
decision is read from each line's `lts` date in the release schedule rather than
from "even majors only", so it keeps working after Node.js changes its release
cadence.

## Quick start

```yaml
name: Runtime bump

on:
  schedule:
    - cron: '0 1 * * 6'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  bump:
    runs-on: ubuntu-latest
    steps:
      - id: app-token
        uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0
        with:
          app-id: ${{ vars.BUMP_APP_ID }}
          private-key: ${{ secrets.BUMP_APP_PRIVATE_KEY }}

      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - uses: ouka-lab/js-runtime-bump-action@<commit-sha> # v1.0.0
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          targets: |
            node
            pnpm
            npm:eslint
          matrix: |
            .github/workflows/test.yml#node-version=node
            .github/workflows/test.yml#eslint=npm:eslint
```

A fuller example is in [`examples/caller-workflow.yml`](examples/caller-workflow.yml).

### The `matrix` input

A *matrix* is the `strategy.matrix` of a GitHub Actions job: the same job run
once per combination of values. In

```yaml
strategy:
  matrix:
    node-version: [22, 24, 26]
    eslint: [9, 10]
```

the job runs six times, and those lists are, in effect, the versions your
project promises to support. Each `matrix` line tells the action which list
belongs to which target:

```text
<workflow file>#<matrix key>=<target>
```

Every job in the file with that key is updated. A line that names a missing file
or key fails the run, so a renamed workflow does not silently stop being
maintained.

## Token

**`GITHUB_TOKEN` is not enough.** It cannot push changes to
`.github/workflows/` — and matrix updates live there — and pull requests it
opens do not trigger CI, which is the whole point.

Use a GitHub App token (recommended) or a fine-grained PAT with:

| Permission | Access |
|---|---|
| Contents | Read and write |
| Pull requests | Read and write |
| Workflows | Read and write |

Check out with `persist-credentials: false`. The action pushes with the token you
give it either way, but there is no reason to leave a second credential in the
workspace.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `targets` | Yes | — | One per line: `node`, `bun`, `pnpm`, `npm:<package>`. |
| `matrix` | No | `""` | One per line: `<workflow file>#<matrix key>=<target>`. |
| `github-token` | Unless `dry-run` | `""` | See [Token](#token). |
| `working-directory` | No | `.` | Directory holding `package.json` and the version files. |
| `base-branch` | No | checked-out branch | Branch the pull requests target. |
| `post-update` | No | `""` | Command run before committing, e.g. `pnpm install --lockfile-only`. |
| `repository` | No | `github.repository` | `owner/repo`. |
| `minimum-release-age` | No | `0` | Days a release must have been out before it is proposed. See [Release age](#release-age). |
| `dry-run` | No | `false` | Log the planned changes; write, push and open nothing. |

## Release age

`minimum-release-age: 14` makes the action propose only releases published at
least 14 days ago — the same idea as pnpm's
[`minimumReleaseAge`](https://pnpm.io/settings#minimumreleaseage), and worth
setting to the same value if you use it, or the pull request would pin a
version your own install refuses.

- **Pins and new majors** use the newest stable version, up to `latest`, that is
  old enough. If pnpm 12.0.1 is a day old, you get 12.0.0; if ESLint 11.0.0 is a
  day old, `peerDependencies` and the matrix wait.
- **Node.js lines are not delayed**: a line is added on its LTS date and removed
  on its end-of-life date, since by then it has been out for months. The pinned
  Node.js version still respects the age.
- The age is counted from the start of the day (UTC) of the run, in whole days.

## Outputs

| Output | Description |
|---|---|
| `changes` | JSON array of `{ target, title, files }`, one per target that needed a change. |
| `pull-requests` | Comma-separated URLs of the pull requests opened or updated. |

## How pull requests behave

- **One pull request per target**, on the branch `js-runtime-bump/<target>-<hash>`
  (`npm:@scope/pkg` → `js-runtime-bump/npm-scope-pkg-1a2b3c4d`), each built from
  the base branch on its own. The hash covers the target, `working-directory`
  and the base branch, so runs for different packages of a monorepo, or for
  different base branches, never share a branch.
- **Re-runs are quiet.** When the branch already holds the same change on the
  same base, nothing is pushed, so CI and reviewers are not pinged again. When
  the base has moved, the branch is rebuilt and force-pushed, and the open pull
  request is updated.
- **The body explains why**: the LTS start or end-of-life date, or the release
  that prompted the change.

## Runtime

The action runs a single pre-bundled file on the runner's own Node.js (20 or
later; every GitHub-hosted runner has one). It does not set up a runtime itself,
since that would change the `node` on `PATH` for the rest of your job, and it
installs nothing at run time.

## Versioning

**Pin by commit SHA.** A tag can be moved; a SHA cannot. This action runs with a
token that can push to your repository:

```yaml
uses: ouka-lab/js-runtime-bump-action@<commit-sha> # v1.0.0
```

Dependabot updates both the SHA and the comment. `@v1` also works and follows the
latest `v1.x.y`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
