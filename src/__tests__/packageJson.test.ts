import { describe, expect, it } from "vitest";
import { raiseEnginesFloor, updatePinnedTool, widenPeerRange } from "../updaters/packageJson.ts";
import { Workspace } from "../workspace.ts";
import { workspace } from "./helpers.ts";

async function project(pkg: unknown, indent: string | number = 2) {
  const ws = new Workspace(
    await workspace({ "package.json": `${JSON.stringify(pkg, null, indent)}\n` }),
  );
  const read = async () => JSON.parse((await ws.read("package.json")) ?? "{}");
  return { ws, read };
}

describe("raiseEnginesFloor", () => {
  it("raises a >=N floor and keeps the number of version parts", async () => {
    const { ws, read } = await project({ engines: { node: ">=22.12.0" } });
    const result = await raiseEnginesFloor(ws, "package.json", 24);
    expect(result.previousFloor).toBe(22);
    expect((await read()).engines.node).toBe(">=24.0.0");
  });

  it("leaves a floor that is already high enough", async () => {
    const { ws } = await project({ engines: { node: ">=24" } });
    expect((await raiseEnginesFloor(ws, "package.json", 24)).descriptions).toEqual([]);
    expect(ws.changes()).toEqual([]);
  });

  it("reports ranges it does not rewrite", async () => {
    const { ws } = await project({ engines: { node: "^20.19.0 || >=22.12.0" } });
    const result = await raiseEnginesFloor(ws, "package.json", 24);
    expect(result.skipped).toBe("^20.19.0 || >=22.12.0");
    expect(ws.changes()).toEqual([]);
  });

  it("keeps the file's indentation", async () => {
    const { ws } = await project({ engines: { node: ">=22" } }, "\t");
    await raiseEnginesFloor(ws, "package.json", 24);
    expect(await ws.read("package.json")).toBe('{\n\t"engines": {\n\t\t"node": ">=24"\n\t}\n}\n');
  });
});

describe("widenPeerRange", () => {
  it("appends the new major", async () => {
    const { ws, read } = await project({ peerDependencies: { eslint: "^9.7 || ^10" } });
    await widenPeerRange(ws, "package.json", "eslint", 11);
    expect((await read()).peerDependencies.eslint).toBe("^9.7 || ^10 || ^11");
  });

  it.each([">=9", "*", "^9 || ^11"])("leaves %s, which already allows it", async (range) => {
    const { ws } = await project({ peerDependencies: { eslint: range } });
    expect(await widenPeerRange(ws, "package.json", "eslint", 11)).toEqual([]);
  });

  it("does nothing when the package is not a peer dependency", async () => {
    const { ws } = await project({ devDependencies: { eslint: "^10.0.0" } });
    expect(await widenPeerRange(ws, "package.json", "eslint", 11)).toEqual([]);
  });
});

describe("updatePinnedTool", () => {
  const integrity = `sha512-${Buffer.from("tarball").toString("base64")}`;
  const pnpm = { name: "pnpm", version: "12.0.1", integrity };

  it("updates packageManager and recomputes its Corepack hash", async () => {
    const { ws, read } = await project({ packageManager: "pnpm@11.3.0+sha512.abc123" });
    await updatePinnedTool(ws, "package.json", pnpm);
    const hex = Buffer.from("tarball").toString("hex");
    expect((await read()).packageManager).toBe(`pnpm@12.0.1+sha512.${hex}`);
  });

  it("refuses to drop a hash it cannot recompute", async () => {
    const { ws } = await project({ packageManager: "pnpm@11.3.0+sha512.abc123" });
    await expect(
      updatePinnedTool(ws, "package.json", { ...pnpm, integrity: undefined }),
    ).rejects.toThrow("hash");
  });

  it("updates matching devEngines entries in object and array form", async () => {
    const { ws, read } = await project({
      devEngines: {
        packageManager: { name: "pnpm", version: "11.3.0", onFail: "error" },
        runtime: [
          { name: "node", version: "^22" },
          { name: "bun", version: "1.4.0" },
        ],
      },
    });
    await updatePinnedTool(ws, "package.json", pnpm);
    await updatePinnedTool(ws, "package.json", {
      name: "bun",
      version: "1.5.0",
      integrity: undefined,
    });
    const pkg = await read();
    expect(pkg.devEngines.packageManager.version).toBe("12.0.1");
    expect(pkg.devEngines.runtime).toEqual([
      { name: "node", version: "^22" },
      { name: "bun", version: "1.5.0" },
    ]);
    expect(ws.changes()[0]?.descriptions).toHaveLength(2);
  });

  it("ignores another tool's packageManager", async () => {
    const { ws } = await project({ packageManager: "yarn@4.0.0" });
    expect(await updatePinnedTool(ws, "package.json", pnpm)).toEqual([]);
  });
});
