---
"js-runtime-bump-action": minor
---

Branch names now end in a hash of the target, `working-directory` and base branch, so targets such as `npm:@a/b-c` and `npm:@a-b/c`, monorepo packages and different base branches no longer force-push over each other. Pull requests opened by 0.1.0 are not reused; close them after the first run.
