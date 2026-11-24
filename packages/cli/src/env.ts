/**
 * GitHub Actions environment wiring: reads the event payload and runner
 * context, exposes a typed view, and extracts the composition inputs.
 *
 * The payload file is UNTRUSTED DATA: it is only read and surfaced as
 * structured fields; nothing in it is ever executed.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface GithubEnv {
  eventName: string;
  repository: string;
  defaultBranch: string;
  /** Absolute payload path (GITHUB_EVENT_PATH). */
  payloadPath: string | null;
  runId: string | null;
  token: string | null;
  /** Repo path on the runner (GITHUB_WORKSPACE). */
  workspace: string | null;
}

export function readGithubEnv(env: NodeJS.ProcessEnv = process.env): GithubEnv {
  return {
    eventName: env.GITHUB_EVENT_NAME ?? "",
    repository: env.GITHUB_REPOSITORY ?? "",
    defaultBranch: "",
    payloadPath: env.GITHUB_EVENT_PATH ?? null,
    runId: env.GITHUB_RUN_ID ?? null,
    token: env.GH_TOKEN ?? env.GITHUB_TOKEN ?? null,
    workspace: env.GITHUB_WORKSPACE ?? null,
  };
}

export interface GithubPayload {
  pull_request?: {
    number: number;
    draft: boolean;
    head: { ref: string; sha: string; repo: { full_name: string } };
    base: { ref: string; repo: { full_name: string } };
  };
  workflow_run?: {
    id: number;
    conclusion: string | null;
    head_sha: string;
    head_branch: string | null;
    head_repository: { full_name: string };
  };
  repository?: { default_branch?: string; full_name?: string };
  inputs?: { mode?: string };
  /** issue_comment payload: the comment author (permission-checked). */
  comment?: { user?: { login?: string } };
  /** repository_dispatch payload */
  client_payload?: { mode?: string; run_id?: string; pr_number?: number; sha?: string };
}

export async function loadPayload(path: string | null): Promise<GithubPayload> {
  if (!path) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as GithubPayload;
  } catch {
    return {};
  }
}

/** Compose the router input from env + payload (typed, total). */
export interface ComposedEvent {
  eventName: string;
  repository: string;
  defaultBranch: string;
  pr?: NonNullable<GithubPayload["pull_request"]>;
  workflowRun?: NonNullable<GithubPayload["workflow_run"]>;
  selectedMode?: string;
  runId?: string;
  prNumber?: number;
  /** Comment author login for issue_comment-triggered runs. */
  commentLogin?: string;
}

export function composeEvent(env: GithubEnv, payload: GithubPayload): ComposedEvent {
  const selectedMode =
    payload.inputs?.mode ?? payload.client_payload?.mode ?? undefined;
  return {
    eventName: env.eventName,
    repository: env.repository || (payload.repository?.full_name ?? ""),
    defaultBranch: payload.repository?.default_branch ?? "main",
    pr: payload.pull_request,
    workflowRun: payload.workflow_run,
    selectedMode,
    runId: payload.client_payload?.run_id ?? (env.runId ?? undefined),
    prNumber: payload.client_payload?.pr_number,
    commentLogin: payload.comment?.user?.login,
  };
}

/** Parse owner/repo from a full name or URL. */
export function parseRepo(fullName: string): { owner: string; repo: string } | null {
  const m = /(?:^|\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(fullName.replace(/\/+$/, ""));
  if (!m?.[1]) return null;
  const [owner, repo] = m[1].split("/");
  if (!owner || !repo) return null;
  return { owner, repo: basename(repo) };
}
