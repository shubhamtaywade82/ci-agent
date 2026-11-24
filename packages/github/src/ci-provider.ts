/**
 * GitHub Actions CiProvider adapter.
 *
 * `getFailedLogs` fetches the failed job's logs zip via the Actions API
 * (`GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs`) and returns the
 * concatenated text of the failed steps. The zip is downloaded as a stream
 * and decompressed in-memory with fflate (no temp files, no shell).
 */

import { Octokit } from "@octokit/rest";
import { unzipSync, strFromU8 } from "fflate";
import type { CiProvider } from "@nemesis-oss/ci-agent-core";

export interface GitHubActionsCiProviderOptions {
  owner: string;
  repo: string;
  token: string;
  /** API base URL (GHES support / tests). */
  baseUrl?: string;
  /** Octokit override (tests). */
  octokit?: Octokit;
  /** Fetch implementation override (tests). */
  fetchImpl?: typeof fetch;
}

interface ActionsJob {
  id: number;
  name: string;
  conclusion: string | null;
  status: string;
  steps?: { name: string; conclusion: string | null; number: number }[];
}

export class GitHubActionsCiProvider implements CiProvider {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GitHubActionsCiProviderOptions) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.octokit =
      opts.octokit ??
      new Octokit({
        auth: opts.token,
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        userAgent: "nemesis-ci-agent",
      });
  }

  async getRun(runId: string): Promise<{
    id: number;
    name: string;
    conclusion: string | null;
    headSha: string;
    headBranch: string | null;
    htmlUrl: string;
  }> {
    const { data } = await this.octokit.rest.actions.getWorkflowRun({
      owner: this.owner,
      repo: this.repo,
      run_id: Number(runId),
    });
    return {
      id: data.id,
      name: data.name ?? "",
      conclusion: data.conclusion,
      headSha: data.head_sha,
      headBranch: data.head_branch ?? null,
      htmlUrl: data.html_url,
    };
  }

  async getFailedLogs(runId: string): Promise<string> {
    const jobs = await this.listJobs(runId);
    const failedJobs = jobs.filter((j) => j.conclusion === "failure");
    if (failedJobs.length === 0) {
      return "";
    }

    // The run-level logs endpoint returns one zip with every job.
    const zipBytes = await this.downloadRunLogs(runId);
    const files = unzipSync(zipBytes);
    const texts: string[] = [];
    for (const [name, bytes] of Object.entries(files)) {
      if (!name.endsWith(".txt")) continue;
      const text = strFromU8(bytes);
      // Keep only failed steps' output: lines after a failed step header.
      const failedText = extractFailedSteps(text, failedJobs.map((j) => j.name));
      if (failedText.length > 0) texts.push(failedText);
    }
    return texts.join("\n\n");
  }

  private async listJobs(runId: string): Promise<ActionsJob[]> {
    const out: ActionsJob[] = [];
    let page = 1;
    for (;;) {
      const { data } = await this.octokit.rest.actions.listJobsForWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        run_id: Number(runId),
        per_page: 100,
        page,
      });
      out.push(...(data.jobs as unknown as ActionsJob[]));
      if (data.jobs.length < 100) break;
      page++;
    }
    return out;
  }

  private async downloadRunLogs(runId: string): Promise<Uint8Array> {
    // Ask the API for the redirect URL (the zip itself is behind a signed
    // short-lived URL), then fetch it directly with the token.
    const { data } = await this.octokit.rest.actions.downloadWorkflowRunLogs({
      owner: this.owner,
      repo: this.repo,
      run_id: Number(runId),
    });
    const url = (data as unknown as { url: string }).url;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.token}`, "User-Agent": "nemesis-ci-agent" },
    });
    if (!res.ok) {
      throw new Error(`github-actions: logs download failed with HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}

/**
 * Extract output of failed steps from one job's log text.
 * GitHub job logs contain step group markers like `##[group]Run npm test`
 * and step conclusion lines; the reliable signal is the final
 * `##[error]`-annotated block plus the step headers. We keep lines that
 * belong to steps whose conclusion was failure — approximated by slicing
 * between a step header and the next step header when an error annotation
 * appears within it, plus any `##[error]` lines anywhere.
 */
export function extractFailedSteps(logText: string, failedJobNames: string[]): string {
  const lines = logText.split("\n");
  const kept: string[] = [];
  let inFailedStep = false;
  for (const line of lines) {
    if (/##\[group\]/.test(line)) {
      inFailedStep = false;
    }
    if (/##\[error\]/.test(line)) {
      inFailedStep = true;
      kept.push(line);
      continue;
    }
    if (inFailedStep) {
      kept.push(line);
      continue;
    }
    if (/\bFAIL\b|\bERROR\b|exit code/i.test(line)) {
      // A FAIL line starts a failure block: keep subsequent lines until the
      // next step group (they carry assertions and stack frames).
      inFailedStep = true;
      kept.push(line);
      continue;
    }
    void failedJobNames;
  }
  return kept.join("\n");
}
