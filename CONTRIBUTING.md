# Contributing

## Setup

This repository uses [pnpm](https://pnpm.io/) only: its version is pinned in
`devEngines.packageManager` of `package.json`.

```sh
pnpm install
```

New versions of dependencies are installed only after 2 weeks
(`minimumReleaseAge` in `pnpm-workspace.yaml`).

## Commands

| Command | Description |
| --- | --- |
| `pnpm test` | Run the tests with Vitest. Coverage thresholds are enforced. |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | `biome lint` |
| `pnpm format` | `biome format --write` |
| `pnpm build` | Regenerate `dist/main.js` |
| `pnpm changeset` | Add a changeset (see below) |

Before opening a pull request:

```sh
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Pull Requests

- Every PR needs a [changeset](.changeset/README.md), which becomes the release
  note in `CHANGELOG.md`. Use `pnpm changeset --empty` for changes that should
  not appear in the release notes (CI, docs, ...).
- CI checks formatting, lint, types, tests and that `dist/` is current, and runs
  the action itself against this repository in dry-run mode.

## Generated files

`dist/main.js` is generated **and committed**. GitHub never runs an install step
for an action, so the bundle has to be in the repository with every dependency
inlined. Never edit it by hand; run `pnpm build`.

## Tests

Tests live in `src/__tests__`.

- Anything reaching the network takes an injectable `fetcher`; anything running
  a process takes an injectable `exec`; the date takes `today`. Use them rather
  than mocking globals.
- **Tests that run git must isolate it.** `run.test.ts` passes every git process
  `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` with a test identity,
  so a developer's own config — identity, commit signing, hooks — never takes
  part. Keep it that way for any new test that touches git.
- **`await` your rejection assertions.** `expect(promise).rejects.toThrow(...)`
  without `await` passes even when the assertion is wrong.

## Code style

Biome handles formatting and linting. Comments explain *why*, not *what*.

## Releasing

1. `pnpm changeset version` — bumps `package.json` and writes `CHANGELOG.md`
   from the pending changesets.
2. Commit, then tag that commit `v<version>` and push the tag.
3. The `Release` workflow checks the tag against `package.json`, moves the major
   tag (`v1`), and creates the GitHub release with that version's
   `CHANGELOG.md` section as its notes.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
