// The esbuild CLI shim breaks under pnpm once esbuild's postinstall swaps in
// its native binary, so the build goes through the JS API instead.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/main.js",
  legalComments: "none",
  // yaml and semver are CommonJS and require Node built-ins, which an ESM
  // bundle can only do through a real `require`.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
