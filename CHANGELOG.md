# js-runtime-bump-action

## 0.2.0

### Minor Changes

- c00c2d0: Branch names now end in a hash of the target, `working-directory` and base branch, so targets such as `npm:@a/b-c` and `npm:@a-b/c`, monorepo packages and different base branches no longer force-push over each other. Pull requests opened by 0.1.0 are not reused; close them after the first run.

## 0.1.0

### Minor Changes

- 1af0828: First release: keep Node.js, Bun, pnpm and peer dependency support up to date with one pull request per target.
- a0965ba: Add `minimum-release-age`: only propose releases published at least that many days ago, like pnpm's `minimumReleaseAge`.
