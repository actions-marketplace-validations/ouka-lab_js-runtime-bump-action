import { describe, expect, it } from "vitest";
import { type Env, parseInputs, parseTarget } from "../env.ts";

const base: Env = {
  INPUT_GITHUB_TOKEN: "t0ken",
  INPUT_TARGETS: "node",
  INPUT_REPOSITORY: "ouka-lab/demo",
  GITHUB_WORKSPACE: "/work",
};

describe("parseTarget", () => {
  it("accepts the built-in targets and npm packages", () => {
    expect(parseTarget("node")).toEqual({ kind: "node", id: "node" });
    expect(parseTarget("npm:@types/node")).toEqual({
      kind: "npm",
      id: "npm:@types/node",
      name: "@types/node",
    });
  });

  it.each(["deno", "npm:", "npm:has space"])("rejects %s", (entry) => {
    expect(() => parseTarget(entry)).toThrow("targets");
  });
});

describe("parseInputs", () => {
  it("reads one entry per line, skipping blanks, comments and duplicates", () => {
    const inputs = parseInputs({
      ...base,
      INPUT_TARGETS: "\nnode\n# comment\nnpm:eslint\nnode\n",
      INPUT_MATRIX: ".github/workflows/ci.yml#node-version=node\n",
      INPUT_WORKING_DIRECTORY: "packages/app",
    });
    expect(inputs.targets.map((target) => target.id)).toEqual(["node", "npm:eslint"]);
    expect(inputs.matrix).toEqual([
      { file: ".github/workflows/ci.yml", key: "node-version", targetId: "node" },
    ]);
    expect(inputs.repoRoot).toBe("/work");
    expect(inputs.projectDir).toBe("/work/packages/app");
    expect(inputs.dryRun).toBe(false);
  });

  it("requires a token unless dry-run is on", () => {
    expect(() => parseInputs({ ...base, INPUT_GITHUB_TOKEN: "" })).toThrow("github-token");
    expect(parseInputs({ ...base, INPUT_GITHUB_TOKEN: "", INPUT_DRY_RUN: "TRUE" }).dryRun).toBe(
      true,
    );
  });

  it("reads minimum-release-age as whole days", () => {
    expect(parseInputs(base).minimumReleaseAge).toBe(0);
    expect(parseInputs({ ...base, INPUT_MINIMUM_RELEASE_AGE: " 14 " }).minimumReleaseAge).toBe(14);
    for (const value of ["-1", "1.5", "two weeks"]) {
      expect(() => parseInputs({ ...base, INPUT_MINIMUM_RELEASE_AGE: value })).toThrow(
        "minimum-release-age",
      );
    }
  });

  it("requires at least one target", () => {
    expect(() => parseInputs({ ...base, INPUT_TARGETS: " \n" })).toThrow("targets");
  });

  it("rejects matrix entries that are malformed or name an unlisted target", () => {
    expect(() => parseInputs({ ...base, INPUT_MATRIX: "ci.yml=node" })).toThrow("must look like");
    expect(() => parseInputs({ ...base, INPUT_MATRIX: "ci.yml#node=bun" })).toThrow(
      "not listed in `targets`",
    );
  });

  it("validates the repository", () => {
    expect(() => parseInputs({ ...base, INPUT_REPOSITORY: "demo" })).toThrow("owner/repo");
  });
});
