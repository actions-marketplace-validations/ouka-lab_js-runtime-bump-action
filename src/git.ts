import { spawn } from "node:child_process";

export type Exec = (
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const spawnExec: Exec = (args, { cwd, env }) =>
  new Promise((resolve, reject) => {
    const [command = "", ...rest] = args;
    const child = spawn(command, rest, { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

export class Git {
  readonly #exec: Exec;
  readonly #cwd: string;
  readonly #secrets: string[];

  constructor(exec: Exec, cwd: string, secrets: string[] = []) {
    this.#exec = exec;
    this.#cwd = cwd;
    this.#secrets = secrets.filter((secret) => secret !== "");
  }

  #redact(text: string): string {
    return this.#secrets.reduce((result, secret) => result.replaceAll(secret, "***"), text);
  }

  async run(...args: string[]): Promise<string> {
    const result = await this.#exec(["git", ...args], { cwd: this.#cwd });
    if (result.code !== 0) {
      const detail = this.#redact(result.stderr.trim() || result.stdout.trim());
      throw new Error(`git ${this.#redact(args.join(" "))} failed: ${detail}`);
    }
    return result.stdout.trim();
  }

  async succeeds(...args: string[]): Promise<boolean> {
    return (await this.#exec(["git", ...args], { cwd: this.#cwd })).code === 0;
  }
}
