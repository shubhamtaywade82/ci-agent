/**
 * Task router: GitHub event context → AgentTask.
 *
 * Event mapping (the adoption contract):
 *   pull_request          → review
 *   workflow_run failure  → fix
 *   schedule              → scan
 *   workflow_dispatch     → selected mode
 *   repository_dispatch   → payload-selected mode
 */

import type { AgentMode, AgentTask } from "./types.js";

export interface RouterInput {
  eventName: string;
  /** pull_request event payload (minimal shape). */
  pr?: {
    number: number;
    draft: boolean;
    head: { ref: string; sha: string; repo: { full_name: string } };
    base: { ref: string; repo: { full_name: string } };
  };
  /** workflow_run payload (minimal shape). */
  workflowRun?: {
    id: number;
    conclusion: string | null;
    head_sha: string;
    head_branch: string | null;
    head_repository: { full_name: string };
  };
  /** workflow_dispatch / repository_dispatch mode selection. */
  selectedMode?: string;
  repo: string;
  defaultBranch: string;
}

export interface RoutingDecision {
  task: AgentTask;
  /** Human-readable provenance for the audit record. */
  via: string;
}

export function route(input: RouterInput): RoutingDecision | { skip: "reason"; reason: string } {
  const { eventName } = input;

  if (eventName === "pull_request") {
    if (!input.pr) return { skip: "reason", reason: "pull_request event without PR payload" };
    if (input.pr.draft) return { skip: "reason", reason: "PR is a draft (waiting for ready_for_review)" };
    const isFork = input.pr.head.repo.full_name !== input.repo;
    return {
      task: {
        mode: "review",
        repo: input.repo,
        prNumber: input.pr.number,
        sha: input.pr.head.sha,
        isFork,
        headRepoFullName: input.pr.head.repo.full_name,
        headBranch: input.pr.head.ref,
      },
      via: "pull_request → review",
    };
  }

  if (eventName === "workflow_run") {
    if (!input.workflowRun) return { skip: "reason", reason: "workflow_run event without run payload" };
    const wr = input.workflowRun;
    if (wr.conclusion !== "failure") return { skip: "reason", reason: `workflow_run conclusion=${wr.conclusion}` };
    const isFork = wr.head_repository.full_name !== input.repo;
    return {
      task: {
        mode: "fix",
        repo: input.repo,
        runId: String(wr.id),
        sha: wr.head_sha,
        isFork,
        headRepoFullName: wr.head_repository.full_name,
        headBranch: wr.head_branch ?? undefined,
      },
      via: "workflow_run failure → fix",
    };
  }

  if (eventName === "schedule") {
    return {
      task: { mode: "scan", repo: input.repo, sha: input.defaultBranch, isFork: false },
      via: "schedule → scan",
    };
  }

  if (eventName === "workflow_dispatch" || eventName === "repository_dispatch") {
    const mode = input.selectedMode === "fix" || input.selectedMode === "scan" || input.selectedMode === "review" || input.selectedMode === "triage"
      ? (input.selectedMode as AgentMode)
      : undefined;
    if (!mode) return { skip: "reason", reason: `no valid mode selected for ${eventName}` };
    return {
      task: { mode, repo: input.repo, sha: input.defaultBranch, isFork: false },
      via: `${eventName} → ${mode}`,
    };
  }

  return { skip: "reason", reason: `unmapped event ${eventName}` };
}

export const EVENT_MODE_TABLE: Record<string, AgentMode | "skip"> = {
  pull_request: "review",
  workflow_run: "fix",
  schedule: "scan",
  workflow_dispatch: "review",
  repository_dispatch: "review",
};
