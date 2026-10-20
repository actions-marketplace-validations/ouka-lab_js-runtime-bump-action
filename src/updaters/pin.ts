function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Moves a pinned version to `latest` while keeping the shape the author chose:
 * `22` → `24`, `v22.11` → `v24.11`, `^22.1.0` → `^24.11.1`, `22.x` → `24.x`.
 *
 * Returns undefined when the value is not a plain pin (`lts/*`, `>=22`,
 * `${{ … }}`) or is already at or past `latest` — a project pinned to a newer
 * Current release is not downgraded to LTS.
 */
export function bumpPin(value: string, latest: string): string | undefined {
  const match = /^([\^~]?)(v?)(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/.exec(value.trim());
  const target = latest.split(".").map(Number);
  if (!match || target.some(Number.isNaN)) {
    return undefined;
  }
  const [, operator = "", prefix = "", ...parts] = match;
  const given = parts.filter((part): part is string => part !== undefined);
  const numeric = given.filter((part) => part !== "x").map(Number);

  const shaped = given.map((part, i) => (part === "x" ? "x" : String(target[i] ?? 0)));
  const next = `${operator}${prefix}${shaped.join(".")}`;

  const current = numeric.slice(0, shaped.length);
  const proposed = target.slice(0, numeric.length);
  return compare(proposed, current) > 0 ? next : undefined;
}

export function majorOf(version: string): number {
  return Number(version.replace(/^v/, "").split(".")[0]);
}
