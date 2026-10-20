import { describe, expect, it } from "vitest";
import { updateMatrix, updateSetupInput, updateVersionFile } from "../updaters/workflows.ts";
import { Workspace } from "../workspace.ts";
import { workspace } from "./helpers.ts";

const FILE = ".github/workflows/test.yml";

async function edit(source: string, run: (ws: Workspace) => Promise<unknown>) {
  const ws = new Workspace(await workspace({ [FILE]: source }));
  const result = await run(ws);
  return { text: await ws.read(FILE), result, changes: ws.changes() };
}

const dropBelow24 = (existing: readonly number[]) => ({
  remove: new Set(existing.filter((major) => major < 24)),
  add: [26, 27].filter((major) => major > Math.max(...existing)),
});

describe("updateMatrix", () => {
  it("removes and adds whole lines in a block list, keeping comments and quotes", async () => {
    const source = [
      "jobs:",
      "  test:",
      "    strategy:",
      "      matrix:",
      "        node-version:",
      "          - '22' # oldest",
      "          - 'lts/*'",
      "          - '24'",
      "        os: [ubuntu-latest]",
      "    steps: []",
      "",
    ].join("\n");

    const { text, result } = await edit(source, (ws) =>
      updateMatrix(ws, FILE, "node-version", dropBelow24),
    );

    expect(result).toEqual({ added: [26, 27], removed: [22] });
    expect(text).toBe(
      [
        "jobs:",
        "  test:",
        "    strategy:",
        "      matrix:",
        "        node-version:",
        "          - 'lts/*'",
        "          - '24'",
        "          - '26'",
        "          - '27'",
        "        os: [ubuntu-latest]",
        "    steps: []",
        "",
      ].join("\n"),
    );
  });

  it("rewrites a flow list in place", async () => {
    const source =
      "jobs:\n  a:\n    strategy:\n      matrix:\n        node: [22, 24] # supported\n";
    const { text } = await edit(source, (ws) => updateMatrix(ws, FILE, "node", dropBelow24));
    expect(text).toBe(
      "jobs:\n  a:\n    strategy:\n      matrix:\n        node: [24, 26, 27] # supported\n",
    );
  });

  it("can remove the item that new entries are formatted after", async () => {
    const source =
      "jobs:\n  a:\n    strategy:\n      matrix:\n        node:\n          - 20\n          - 22\n";
    const { text } = await edit(source, (ws) => updateMatrix(ws, FILE, "node", dropBelow24));
    expect(text).toBe(
      "jobs:\n  a:\n    strategy:\n      matrix:\n        node:\n          - 26\n          - 27\n",
    );
  });

  it("updates the key in every job of the file", async () => {
    const job = (name: string) => `  ${name}:\n    strategy:\n      matrix:\n        node: [24]\n`;
    const { text } = await edit(`jobs:\n${job("a")}${job("b")}`, (ws) =>
      updateMatrix(ws, FILE, "node", dropBelow24),
    );
    expect(text?.match(/\[24, 26, 27\]/g)).toHaveLength(2);
  });

  it("records nothing when the matrix is current", async () => {
    const source = "jobs:\n  a:\n    strategy:\n      matrix:\n        node: [24, 27]\n";
    const { changes } = await edit(source, (ws) => updateMatrix(ws, FILE, "node", dropBelow24));
    expect(changes).toEqual([]);
  });

  it("fails loudly when the configured key does not exist", async () => {
    const source = "jobs:\n  a:\n    strategy:\n      matrix:\n        node: [24]\n";
    await expect(edit(source, (ws) => updateMatrix(ws, FILE, "nope", dropBelow24))).rejects.toThrow(
      "strategy.matrix.nope",
    );
    await expect(
      edit(source, (ws) => updateMatrix(ws, ".github/workflows/missing.yml", "node", dropBelow24)),
    ).rejects.toThrow("does not exist");
  });
});

describe("updateSetupInput", () => {
  it("bumps literal versions and skips aliases and expressions", async () => {
    const source = [
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: actions/setup-node@0123456789abcdef # v6",
      "        with:",
      '          node-version: "22.11.0"',
      "      - uses: actions/setup-node@0123456789abcdef",
      "        with:",
      "          node-version: lts/*",
      "      - uses: actions/setup-node@0123456789abcdef",
      "        with:",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
      "          node-version: ${{ matrix.node }}",
      "      - uses: other/setup-node@v1",
      "        with:",
      "          node-version: 22",
      "",
    ].join("\n");

    const { text, result } = await edit(source, (ws) =>
      updateSetupInput(ws, "actions/setup-node", "node-version", "24.11.1"),
    );

    expect(result).toEqual([
      `actions/setup-node \`node-version\` in ${FILE}: \`22.11.0\` → \`24.11.1\``,
    ]);
    expect(text).toBe(source.replace('"22.11.0"', '"24.11.1"'));
  });
});

describe("updateVersionFile", () => {
  it("keeps the file's own shape and newline", async () => {
    const ws = new Workspace(await workspace({ ".nvmrc": "v22\n", ".node-version": "lts/*\n" }));
    expect(await updateVersionFile(ws, ".nvmrc", "24.11.1")).toHaveLength(1);
    expect(await updateVersionFile(ws, ".node-version", "24.11.1")).toEqual([]);
    expect(await updateVersionFile(ws, ".bun-version", "1.5.0")).toEqual([]);
    expect(await ws.read(".nvmrc")).toBe("v24\n");
  });
});
