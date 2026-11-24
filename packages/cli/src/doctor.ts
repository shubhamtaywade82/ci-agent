/**
 * Doctor: pre-flight checks for adoption (the V-checklist, automated).
 *
 * Each check is local and hermetic (no network calls in v1 apart from an
 * optional reachability probe when a key is present) — designed to run in
 * `workflow_dispatch` before the first review/fix run.
 */

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { parse as parseYaml } from "yaml";
import { parseManifest, DEFAULT_MANIFEST } from "@nemesis-oss/ci-agent-core";
import { readFile } from "node:fs/promises";

export interface DoctorCheck {
  id: string;
  title: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export async function doctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // D1: manifest present & valid
  try {
    const manifestText = await readFile(".nemesis/ci-agent.yml", "utf8");
    parseManifest(parseYaml(manifestText));
    checks.push({ id: "manifest", title: "Policy manifest", status: "pass", detail: ".nemesis/ci-agent.yml parses" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      checks.push({ id: "manifest", title: "Policy manifest", status: "warn", detail: "absent — built-in conservative defaults will apply" });
    } else {
      checks.push({ id: "manifest", title: "Policy manifest", status: "fail", detail: String(err) });
    }
  }

  // D2: required secrets/vars
  const apiKey = env.OLLAMA_API_KEY;
  checks.push({
    id: "ollama-key",
    title: "OLLAMA_API_KEY",
    status: apiKey ? "pass" : "fail",
    detail: apiKey ? "set" : "missing — LLM port cannot be constructed (fail-closed)",
  });

  const host = env.OLLAMA_HOST ?? "https://ollama.com";
  checks.push({
    id: "ollama-host",
    title: "OLLAMA_HOST",
    status: host === "https://ollama.com" ? "pass" : "warn",
    detail: host === "https://ollama.com" ? "default cloud endpoint" : `custom endpoint ${host} — verify it is a cloud endpoint, not a local daemon`,
  });

  const model = env.OLLAMA_MODEL;
  checks.push({
    id: "ollama-model",
    title: "OLLAMA_MODEL",
    status: model ? "pass" : "fail",
    detail: model ? `"${model}" (pin via repository Variables, not in code)` : "missing — pin the model tag via vars.OLLAMA_MODEL",
  });

  // D3: GitHub auth
  const ghToken = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  checks.push({
    id: "gh-token",
    title: "GitHub token",
    status: ghToken ? "pass" : "fail",
    detail: ghToken
      ? "GH_TOKEN/GITHUB_TOKEN set (for fix: must be a GitHub App installation token so CI triggers on the draft PR)"
      : "missing",
  });

  // D4: CI workflow name(s) for workflow_run coupling — advisory only
  const workflowName = env.CI_WORKFLOW_NAME;
  checks.push({
    id: "ci-workflow-name",
    title: "CI workflow name (workflow_run coupling)",
    status: workflowName ? "pass" : "warn",
    detail: workflowName
      ? `"${workflowName}" (workflow_run filters on the workflow name, not the filename)`
      : "not set — fix mode needs the exact workflow name of your verify pipeline (V4)",
  });

  return checks;
}

export function doctorVerdict(checks: DoctorCheck[]): "pass" | "fail" {
  return checks.some((c) => c.status === "fail") ? "fail" : "pass";
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export { DEFAULT_MANIFEST };
