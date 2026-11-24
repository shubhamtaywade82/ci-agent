#!/usr/bin/env node
/**
 * ci-agent — CLI entrypoint.
 *
 * Usage:
 *   ci-agent run    [--config <path>]     run the agent for the current event
 *   ci-agent doctor                        pre-flight adoption checks
 *
 * The exit-code contract is documented in run.ts.
 */

import { run } from "./run.js";
import { doctor, doctorVerdict } from "./doctor.js";

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "doctor") {
    const checks = await doctor(process.env);
    for (const c of checks) {
      const icon = c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✗";
      console.log(`${icon} [${c.id}] ${c.title}: ${c.detail}`);
    }
    return doctorVerdict(checks) === "pass" ? 0 : 2;
  }

  if (cmd === "run" || cmd === undefined) {
    let configPath: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--config" && rest[i + 1]) configPath = rest[i + 1];
    }
    const result = await run({ configPath });
    return result.exitCode;
  }

  console.error(`unknown command "${cmd ?? ""}" — use: run | doctor`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`::error::${String(err)}`);
    process.exit(1);
  },
);
