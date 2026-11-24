/**
 * GitHub Action entrypoint (bundled to action/dist/index.js by esbuild).
 *
 * Input contract (mirrors the composite action the repo shipped before):
 *   mode: auto | review | fix | scan | doctor | validate
 *   pr-number / expected-head-sha / workflow-run-id for the explicit modes
 *   github-token (falls back to github.token via env GITHUB_TOKEN)
 *   model-review / model-fix / model-scan (+ ollama-model default)
 *
 * Security semantics ported from the single-package implementation:
 *   - `validate` parses the manifest and exits 0 without needing any token.
 *   - review requires a PR number; a fork PR (payload head repo != base repo)
 *     is an explicit skip, not a failure; a dispatched expected head SHA is
 *     validated for shape here and verified against the live PR in the core.
 *   - fix requires workflow-run-id + PR number; the core enforces the label,
 *     same-repo head, unchanged SHA, attempt budget and duplicate-branch guard.
 *   - Exit codes follow the CLI contract: 0 ok/skip, 1 fail-closed, 2 config.
 */

import { readFile } from "node:fs/promises";
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
  if (input("ollama-host")) process.env.OLLAMA_HOST = input("ollama-host");
  if (input("ollama-api-key")) process.env.OLLAMA_API_KEY = input("ollama-api-key");
  const defaultModel = input("ollama-model");
  process.env.OLLAMA_MODEL_REVIEW = input("model-review") || defaultModel;
  process.env.OLLAMA_MODEL_FIX = input("model-fix") || defaultModel;
  process.env.OLLAMA_MODEL_SCAN = input("model-scan") || defaultModel;
  const token = input("github-token") || process.env.GITHUB_TOKEN || "";
  if (token) process.env.GH_TOKEN = token;

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

  if (mode === "validate") {
    // Manifest-only validation: parse and report; exit code 2 on invalid.
    const result = await run({ configPath: config, env: { ...process.env, CI_AGENT_VALIDATE_ONLY: "1" } });
    setOutput("valid", result.exitCode === 0 ? "true" : "false");
    if (result.exitCode !== 0) setFailed(`manifest validation failed: ${result.reason ?? result.outcome}`);
    return;
  }

  if (mode === "review" || mode === "fix") {
    // Explicit modes come with their own identifiers; build a synthetic event
    // payload the router understands, then delegate to the shared pipeline.
    const pr = Number(input("pr-number"));
    if (!Number.isInteger(pr) || pr < 1) {
      setFailed(`${mode} mode requires a valid pr-number input`);
      return;
    }
    const expectedHeadSha = validateExpectedHeadSha(process.env.GITHUB_EVENT_NAME, input("expected-head-sha").trim());

    let fork = false;
    if (process.env.GITHUB_EVENT_PATH) {
      try {
        const payload = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")) as {
          pull_request?: { head?: { repo?: { full_name?: string } } };
        };
        const fullName = process.env.GITHUB_REPOSITORY ?? "";
        fork = (payload.pull_request?.head?.repo?.full_name ?? fullName) !== fullName;
      } catch {
        // Unreadable payload: treat as unknown; the core re-checks provenance
        // from the live PR via the API before any cloud consultation.
      }
    }

    if (mode === "review") {
      const result = await run({
        configPath: config,
        env: process.env,
        overrides: {
          payload: JSON.stringify({
            pull_request: {
              number: pr,
              draft: false,
              head: { ref: "", sha: expectedHeadSha ?? "", repo: { full_name: fork ? "fork/repo" : process.env.GITHUB_REPOSITORY ?? "" } },
              base: { ref: "", repo: { full_name: process.env.GITHUB_REPOSITORY ?? "" } },
            },
            repository: { default_branch: "main", full_name: process.env.GITHUB_REPOSITORY ?? "" },
            inputs: { mode: "review" },
          }),
        },
      });
      setOutput("mode", result.mode);
      setOutput("outcome", result.outcome);
      if (result.reason) setOutput("reason", result.reason);
      if (result.exitCode !== 0) {
        setFailed(`ci-agent review: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""} (exit ${result.exitCode})`);
      }
      return;
    }

    const runId = input("workflow-run-id");
    if (!runId) {
      setFailed("fix mode requires a valid workflow-run-id input");
      return;
    }
    const result = await run({
      configPath: config,
      env: process.env,
      overrides: {
        payload: JSON.stringify({
          workflow_run: {
            id: Number(runId),
            conclusion: "failure",
            head_sha: expectedHeadSha ?? "",
            head_branch: null,
            head_repository: { full_name: fork ? "fork/repo" : process.env.GITHUB_REPOSITORY ?? "" },
          },
          repository: { default_branch: "main", full_name: process.env.GITHUB_REPOSITORY ?? "" },
          inputs: { mode: "fix" },
        }),
      },
    });
    setOutput("mode", result.mode);
    setOutput("outcome", result.outcome);
    if (result.reason) setOutput("reason", result.reason);
    if (result.exitCode !== 0) {
      setFailed(`ci-agent fix: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""} (exit ${result.exitCode})`);
    }
    return;
  }

  // auto / scan: delegate to the CLI run pipeline, which routes on the event.
  const result = await run({ configPath: config });
  setOutput("mode", result.mode);
  setOutput("outcome", result.outcome);
  if (result.reason) setOutput("reason", result.reason);
  if (result.exitCode !== 0) {
    setFailed(`ci-agent ${result.mode}: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""} (exit ${result.exitCode})`);
  }
}

function validateExpectedHeadSha(eventName: string | undefined, value: string): string | undefined {
  if (eventName === "repository_dispatch") {
    if (!value || !/^[a-f0-9]{40}$/i.test(value)) {
      throw new Error("repository_dispatch review requires a valid 40-character head_sha.");
    }
    return value;
  }
  if (value && !/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error("Expected head SHA must be a valid 40-character commit SHA.");
  }
  return value || undefined;
}

main().catch((err: unknown) => setFailed(String(err)));
