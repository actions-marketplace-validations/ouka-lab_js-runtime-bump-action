import { describe, expect, it } from "vitest";
import { bumpPin, majorOf } from "../updaters/pin.ts";

describe("bumpPin", () => {
  it.each([
    ["22", "24.11.1", "24"],
    ["v22", "24.11.1", "v24"],
    ["22.11", "24.11.1", "24.11"],
    ["22.11.0", "24.11.1", "24.11.1"],
    ["24.1.0", "24.11.1", "24.11.1"],
    ["^22.1.0", "24.11.1", "^24.11.1"],
    ["~1.2.3", "1.3.0", "~1.3.0"],
    ["22.x", "24.11.1", "24.x"],
  ])("moves %s to the latest release in the same shape", (value, latest, expected) => {
    expect(bumpPin(value, latest)).toBe(expected);
  });

  it.each([
    ["24", "24.11.1"],
    ["24.x", "24.11.1"],
    ["24.11.1", "24.11.1"],
    ["25", "24.11.1"],
  ])("leaves %s alone when it is already at or past %s", (value, latest) => {
    expect(bumpPin(value, latest)).toBeUndefined();
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
  it.each(["lts/*", "node", ">=22", "${{ matrix.node }}", "latest", ""])(
    "skips %s, which is not a plain pin",
    (value) => {
      expect(bumpPin(value, "24.11.1")).toBeUndefined();
    },
  );
});

describe("majorOf", () => {
  it("reads the major with or without a leading v", () => {
    expect(majorOf("v24.11.1")).toBe(24);
    expect(majorOf("11.0.0")).toBe(11);
  });
});
