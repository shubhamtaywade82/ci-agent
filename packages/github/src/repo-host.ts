/**
 * GitHub RepoHost adapter (REST API via Octokit).
 *
 * Security posture:
 *  - PR content is fetched as DATA via the REST API; nothing from the PR
 *    head is ever executed locally.
 *  - putFile uses the Git Data API (blob → tree → commit → ref update) so
 *    pushes happen with the provided token. Callers running in the fix
 *    pipeline must pass a GitHub App installation token — pushes with the
 *    default `GITHUB_TOKEN` do not trigger workflow runs, which would
 *    silently break the CI-gated fix loop.
 *  - Reviews are posted with `event: COMMENT` only; this adapter refuses
 *    to construct APPROVE / REQUEST_CHANGES reviews.
 */

import { Octokit } from "@octokit/rest";
import { createRequire } from "node:module";
import type {
  CreatePullRequestInput,
  IssueInput,
  PullRequestCreated,
  PullRequestRef,
  PullRequestReviewInput,
  RepoHost,
} from "@nemesis-oss/ci-agent-core";

const require_ = createRequire(import.meta.url);

export interface GitHubRepoHostOptions {
  owner: string;
  repo: string;
  /** Auth token; absence means anonymous (read-only public repos). */
  token?: string;
  /** Octokit instance override (for tests). */
  octokit?: Octokit;
  /** API base URL (GHES support / tests). */
  baseUrl?: string;
}

interface PrLabelName {
  name: string;
}

export class GitHubRepoHost implements RepoHost {
  private readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;

  constructor(opts: GitHubRepoHostOptions) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.octokit =
      opts.octokit ??
      new Octokit({
        ...(opts.token ? { auth: opts.token } : {}),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        userAgent: "nemesis-ci-agent",
      });
  }

  async getPullRequest(pr: number): Promise<PullRequestRef> {
    const { data } = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: pr,
    });
    return {
      number: data.number,
      title: data.title,
      body: data.body,
      state: data.state,
      draft: data.draft ?? false,
      headRefName: data.head.ref,
      headSha: data.head.sha,
      headRepoFullName: data.head.repo?.full_name ?? `${this.owner}/${this.repo}`,
      baseRefName: data.base.ref,
    };
  }

  async getDiff(pr: number): Promise<string> {
    const res = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: pr,
      mediaType: { format: "diff" },
    });
    // With mediaType diff, data is the raw diff string.
    return String(res.data);
  }

  async getFile(path: string, ref: string): Promise<string> {
    const { data } = await this.octokit.rest.repos.getContent({
      owner: this.owner,
      repo: this.repo,
      path,
      ref,
      mediaType: { format: "raw" },
    });
    return String(data);
  }

  async listPullRequestsForSha(sha: string): Promise<number[]> {
    const { data } = await this.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner: this.owner,
      repo: this.repo,
      commit_sha: sha,
    });
    return data.map((pr) => pr.number);
  }

  async getLabels(pr: number): Promise<string[]> {
    const { data } = await this.octokit.rest.issues.listLabelsOnIssue({
      owner: this.owner,
      repo: this.repo,
      issue_number: pr,
    });
    return (data as PrLabelName[]).map((l) => l.name);
  }

  async addLabel(pr: number, label: string): Promise<void> {
    await this.octokit.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: pr,
      labels: [label],
    });
  }

  async createBranch(name: string, sha: string): Promise<void> {
    if (!name.startsWith("nemesis-agent/fix")) {
      throw new Error("Refusing non-agent branch prefix.");
    }
    // Idempotent-ish: a race means the branch already exists; we accept 422
    // with "Reference already exists" as success to keep the flow monotonic.
    try {
      await this.octokit.rest.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${name}`,
        sha,
      });
    } catch (err) {
      const message = String((err as { message?: string }).message ?? "");
      if (!message.includes("Reference already exists")) throw err;
    }
  }

  async putFile(path: string, content: string, branch: string): Promise<void> {
    // The GitHub adapter only ever publishes agent branches (ported guard).
    if (!branch.startsWith("nemesis-agent/fix")) {
      throw new Error("Refusing non-agent branch prefix.");
    }
    // Resolve the current head of the branch first.
    const ref = await this.octokit.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${branch}`,
    });
    const parentSha = ref.data.object.sha;

    // Create blobs for the file.
    const blob = await this.octokit.rest.git.createBlob({
      owner: this.owner,
      repo: this.repo,
      content: Buffer.from(content, "utf8").toString("base64"),
      encoding: "base64",
    });

    // Read the current tree to preserve unrelated entries.
    const commit = await this.octokit.rest.git.getCommit({
      owner: this.owner,
      repo: this.repo,
      commit_sha: parentSha,
    });
    const baseTree = commit.data.tree.sha;

    const tree = await this.octokit.rest.git.createTree({
      owner: this.owner,
      repo: this.repo,
      base_tree: baseTree,
      tree: [
        {
          path,
          mode: "100644",
          type: "blob",
          sha: blob.data.sha,
        },
      ],
    });

    const newCommit = await this.octokit.rest.git.createCommit({
      owner: this.owner,
      repo: this.repo,
      message: `nemesis ci-agent: propose ${path}`,
      tree: tree.data.sha,
      parents: [parentSha],
    });

    // Update the branch ref — a force-free fast-forward update.
    await this.octokit.rest.git.updateRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${branch}`,
      sha: newCommit.data.sha,
      force: false,
    });
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestCreated> {
    const { data } = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: input.draft,
    });
    return { number: data.number, htmlUrl: data.html_url };
  }

  async postReview(pr: number, review: PullRequestReviewInput): Promise<void> {
    if (review.event !== "COMMENT") {
      throw new Error(`github adapter refuses review event ${review.event} — COMMENT only`);
    }
    if (review.comments.length > 0) {
      // Inline comments need commit_id; use the PR head.
      const pull = await this.getPullRequest(pr);
      await this.octokit.rest.pulls.createReview({
        owner: this.owner,
        repo: this.repo,
        pull_number: pr,
        event: "COMMENT",
        body: review.body,
        commit_id: pull.headSha,
        comments: review.comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body,
        })),
      });
    } else {
      await this.octokit.rest.pulls.createReview({
        owner: this.owner,
        repo: this.repo,
        pull_number: pr,
        event: "COMMENT",
        body: review.body,
      });
    }
  }

  async createIssue(input: IssueInput): Promise<void> {
    await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title: input.title,
      body: input.body,
      ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
    });
  }

  async findMarkerComment(pr: number, marker: string): Promise<{ id: number; body: string } | null> {
    // Paginate through all issue comments (marker comments can sink deep).
    let page = 1;
    for (;;) {
      const { data } = await this.octokit.rest.issues.listComments({
        owner: this.owner,
        repo: this.repo,
        issue_number: pr,
        per_page: 100,
        page,
      });
      if (data.length === 0) return null;
      for (const c of data) {
        if (typeof c.body === "string" && c.body.includes(marker)) {
          return { id: c.id, body: c.body };
        }
      }
      if (data.length < 100) return null;
      page++;
    }
  }

  async updateComment(pr: number, commentId: number, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: commentId,
      body,
    });
  }

  /**
   * Duplicate-fix guard (ported): one deterministic branch per PR head.
   * Returns the open draft PR URL for the branch when one exists, and
   * whether the branch ref itself exists.
   */
  async findExistingAgentFix(branchName: string): Promise<{ pullRequestUrl: string | null; branchExists: boolean }> {
    const pulls = await this.octokit.paginate(this.octokit.rest.pulls.list, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      head: `${this.owner}:${branchName}`,
      per_page: 100,
    });
    const existing = pulls.find((pull) => pull.head.ref === branchName && pull.draft);
    let branchExists = false;
    try {
      await this.octokit.rest.git.getRef({ owner: this.owner, repo: this.repo, ref: `heads/${branchName}` });
      branchExists = true;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    return { pullRequestUrl: existing?.html_url ?? null, branchExists };
  }

  async createComment(pr: number, body: string): Promise<number> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: pr,
      body,
    });
    return data.id;
  }
}
