/**
 * Deterministic command executor for the scan pipeline.
 *
 * Ported from the single-package implementation's `runCommand`:
 *   - `shell: false` — the command array is exec'd directly, no shell
 *     interpretation of repo-controlled strings;
 *   - minimal environment: only a fixed allowlist of system variables plus
 *     the variables the manifest explicitly names in `passEnv` — GitHub and
 *     Ollama credentials are never inherited by collected commands;
 *   - hard timeout with SIGTERM → SIGKILL escalation (exit code 124);
 *   - output capped to the last 20k chars.
 *
 * `redactCommandOutput` scrubs explicitly forwarded env values (and obvious
 * secret shapes) from anything that later reaches the model or the audit log.
 */

import { spawn } from "node:child_process";

const ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
  "LANG",
  "LC_ALL",
];

export interface CommandOutcome {
  code: number;
  output: string;
}

export function runCommand(
  argv: string[],
  cwd: string,
  timeoutMs = 120_000,
  passEnv: readonly string[] = [],
): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = argv;
    if (!executable) return resolve({ code: 1, output: "Missing executable" });

    const commandEnv: NodeJS.ProcessEnv = {};
    for (const key of ENV_ALLOWLIST) {
      const value = process.env[key];
      if (value !== undefined) commandEnv[key] = value;
    }
    for (const key of passEnv) {
      const value = process.env[key];
      if (value !== undefined) commandEnv[key] = value;
    }
    commandEnv.CI = "true";

    const child = spawn(executable, args, { cwd, env: commandEnv, shell: false, windowsHide: true });
    let output = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    };
    const append = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > 20_000) output = output.slice(-20_000);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({
        code: timedOut ? 124 : code ?? 1,
        output: timedOut ? output + `\n[CI Agent] Command timed out after ${timeoutMs}ms.` : output,
      });
    });
  });
}

/** Redact obvious secret shapes and explicitly forwarded env values. */
export function redactCommandOutput(value: string, passEnv: readonly string[] = []): string {
  // Bearer headers: keep the scheme, drop the credential.
  let result = value.replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[REDACTED]");
  // key=value / key: value shapes: keep the key, drop the value.
  result = result.replace(
    /(password|secret|token|api[_-]?key)(\s*[:=]\s*)["']?[^\s"'&,]+/gi,
    "$1$2[REDACTED]",
  );
  // Bare token shapes: replace wholesale.
  result = result.replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]");
  result = result.replace(/ollama_[A-Za-z0-9_-]{16,}/g, "[REDACTED_API_KEY]");
  // Explicitly forwarded env values (run AFTER shape rules so a value that
  // survived them is still scrubbed).
  for (const key of passEnv) {
    const secret = process.env[key];
    if (secret && secret.length >= 4) result = result.split(secret).join(`[REDACTED_ENV:${key}]`);
  }
  return result;
}
