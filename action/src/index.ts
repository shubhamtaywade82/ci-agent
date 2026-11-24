/**
 * GitHub Action entrypoint (bundled to action/dist/index.js by esbuild).
 *
 * Duties:
 *   1. translate Action inputs → env vars (the CLI reads env);
 *   2. run the CLI with the exit-code contract intact;
 *   3. never let an advisory failure redden the workflow by accident —
 *      but DO propagate exit 1/2 faithfully: the caller workflow is the
 *      agent's own (non-blocking) workflow, never `verify`.
 */

import { setFailed, setOutput, info } from "./actions-core.js";
import { run } from "../../packages/cli/src/run.js";
import { doctor, doctorVerdict } from "../../packages/cli/src/doctor.js";

function input(name: string, fallback = ""): string {
  const v = process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`] ?? "";
  return v === "" ? fallback : v;
}

async function main(): Promise<void> {
  const mode = input("mode", "auto");
  const config = input("config", ".nemesis/ci-agent.yml");

  // Wire Action inputs into the env the core reads.
  process.env.OLLAMA_HOST = process.env.OLLAMA_HOST || input("ollama-host", "https://ollama.com");
  if (input("ollama-api-key")) process.env.OLLAMA_API_KEY = input("ollama-api-key");
  if (input("ollama-model")) process.env.OLLAMA_MODEL = input("ollama-model");
  if (input("github-app-id")) process.env.CI_AGENT_APP_ID = input("github-app-id");
  if (input("github-app-private-key")) process.env.CI_AGENT_APP_PRIVATE_KEY = input("github-app-private-key");
  if (mode === "auto" && !process.env.GITHUB_EVENT_NAME) {
    info("no event context; defaulting mode to doctor");
  }

  if (mode === "doctor") {
    const checks = await doctor(process.env);
    for (const c of checks) {
      const line = `[${c.id}] ${c.status}: ${c.detail}`;
      if (c.status === "pass") info(line);
      else if (c.status === "warn") info(`::warning::${line}`);
      else info(`::error::${line}`);
    }
    setOutput("verdict", doctorVerdict(checks));
    if (doctorVerdict(checks) === "fail") setFailed("doctor: pre-flight checks failed (exit 2)");
    return;
  }

  // `auto` (and review/fix/scan) delegate to the CLI run pipeline,
  // which routes on the event.
  const result = await run({ configPath: config });
  setOutput("mode", result.mode);
  setOutput("outcome", result.outcome);
  if (result.reason) setOutput("reason", result.reason);
  if (result.exitCode !== 0) {
    setFailed(`ci-agent ${result.mode}: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""} (exit ${result.exitCode})`);
  }
}

main().catch((err: unknown) => setFailed(String(err)));
