import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import { isAlwaysDeniedPath } from "./policy.js";
import type { CiProvider, DraftPullRequestInput, PullRequestSnapshot, RepoHost, WorkflowRunSnapshot } from "./types.js";
const execFileAsync = promisify(execFile);
export class GitHubRepoHost implements RepoHost {
  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
  ) {}
  async getPullRequest(number: number): Promise<PullRequestSnapshot> {
    const { data } = await this.octokit.pulls.get({ owner: this.owner, repo: this.repo, pull_number: number });
    return {
      number: data.number,
      title: data.title,
      body: data.body,
      headSha: data.head.sha,
      headBranch: data.head.ref,
      headRepoFullName: data.head.repo?.full_name ?? null,
      baseBranch: data.base.ref,
      draft: data.draft ?? false,
      labels: data.labels.flatMap((label) => (typeof label === "string" ? [label] : label.name ? [label.name] : [])),
    };
  }
  async getDiff(number: number) {
    const files = await this.octokit.paginate(this.octokit.pulls.listFiles, {
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      per_page: 100,
    });
    return files.map((file) => ({ path: file.filename, patch: file.patch ?? null }));
  }
  // Bot-only match: a human pasting the marker must not redirect the update onto their own comment.
  async upsertComment(number: number, marker: string, body: string): Promise<void> {
    const target = { owner: this.owner, repo: this.repo };
    const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
      ...target,
      issue_number: number,
      per_page: 100,
    });
    const previous = comments.find((comment) => comment.body?.includes(marker) && comment.user?.type === "Bot");
    if (previous) await this.octokit.issues.updateComment({ ...target, comment_id: previous.id, body });
    else await this.octokit.issues.createComment({ ...target, issue_number: number, body });
  }
  async findOpenIssueByMarker(marker: string): Promise<boolean> {
    const issues = await this.octokit.paginate(this.octokit.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      per_page: 100,
    });
    return issues.some((issue) => issue.body?.includes(marker) ?? false);
  }
  async createIssue(input: { title: string; body: string; labels?: string[] }): Promise<void> {
    await this.octokit.issues.create({ owner: this.owner, repo: this.repo, ...input });
  }
  async getCollaboratorPermission(login: string): Promise<string> {
    const { data } = await this.octokit.repos.getCollaboratorPermissionLevel({
      owner: this.owner,
      repo: this.repo,
      username: login,
    });
    return data.permission;
  }
  async getFileContent(path: string, ref: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({ owner: this.owner, repo: this.repo, path, ref });
      if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string" || !data.content) return null;
      return Buffer.from(data.content, "base64").toString("utf8");
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }
  async findExistingAgentFix(branchName: string): Promise<{ pullRequestUrl: string | null; branchExists: boolean }> {
    const pulls = await this.octokit.paginate(this.octokit.pulls.list, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      head: this.owner + ":" + branchName,
      per_page: 100,
    });
    const existing = pulls.find((pull) => pull.head.ref === branchName && pull.draft);
    let branchExists = false;
    try {
      await this.octokit.git.getRef({ owner: this.owner, repo: this.repo, ref: "heads/" + branchName });
      branchExists = true;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    return { pullRequestUrl: existing?.html_url ?? null, branchExists };
  }
  // Rewriting a file must not silently drop its executable bit.
  private async existingModes(treeSha: string): Promise<Map<string, string>> {
    const { data } = await this.octokit.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: treeSha,
      recursive: "1",
    });
    // ponytail: a truncated tree (huge repos) falls back to 100644 for unseen paths.
    return new Map(
      data.tree.flatMap((entry) => (entry.path && entry.mode ? [[entry.path, entry.mode] as [string, string]] : [])),
    );
  }
  private async headSha(branch: string): Promise<string> {
    const ref = await this.octokit.git.getRef({ owner: this.owner, repo: this.repo, ref: "heads/" + branch });
    return ref.data.object.sha;
  }
  private async createPatchCommit(input: DraftPullRequestInput): Promise<string> {
    const target = { owner: this.owner, repo: this.repo };
    const baseCommit = await this.octokit.git.getCommit({ ...target, commit_sha: input.baseSha });
    const baseTree = baseCommit.data.tree.sha;
    const modes = await this.existingModes(baseTree);
    const tree = await this.octokit.git.createTree({
      ...target,
      base_tree: baseTree,
      tree: input.files.map((file) => ({
        path: file.path,
        mode: (modes.get(file.path) ?? "100644") as "100644" | "100755",
        type: "blob" as const,
        content: file.content,
      })),
    });
    const commit = await this.octokit.git.createCommit({
      ...target,
      message: "fix: propose bounded CI agent patch",
      tree: tree.data.sha,
      parents: [input.baseSha],
    });
    return commit.data.sha;
  }
  async createDraftPullRequest(input: DraftPullRequestInput): Promise<{ url: string }> {
    if (!input.branchName.startsWith("nemesis-agent/fix-")) throw new Error("Refusing non-agent branch prefix.");
    const protectedFile = input.files.find((file) => isAlwaysDeniedPath(file.path));
    if (protectedFile) throw new Error("Protected file write refused: " + protectedFile.path);
    if ((await this.headSha(input.baseBranch)) !== input.baseSha)
      throw new Error("PR head branch changed; stale patch was not applied.");
    const commitSha = await this.createPatchCommit(input);
    if ((await this.headSha(input.baseBranch)) !== input.baseSha)
      throw new Error("PR head branch moved during patch creation; no branch or PR was published.");
    const target = { owner: this.owner, repo: this.repo };
    await this.octokit.git.createRef({ ...target, ref: "refs/heads/" + input.branchName, sha: commitSha });
    const pr = await this.octokit.pulls.create({
      ...target,
      title: input.title,
      body: input.body,
      head: input.branchName,
      base: input.baseBranch,
      draft: true,
      maintainer_can_modify: false,
    });
    return { url: pr.data.html_url };
  }
}
function pullRequestLinks(data: {
  pull_requests?: { number: number }[] | null;
  head_repository?: { full_name: string } | null;
}): { pullRequest: number | null; headRepoFullName: string | null } {
  return {
    pullRequest: data.pull_requests?.[0]?.number ?? null,
    headRepoFullName: data.head_repository?.full_name ?? null,
  };
}

export class GitHubActionsCiProvider implements CiProvider {
  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
    private readonly token: string,
  ) {}
  async getWorkflowRun(runId: string): Promise<WorkflowRunSnapshot> {
    if (!/^\d+$/.test(runId)) throw new Error("Invalid workflow run id.");
    const { data } = await this.octokit.actions.getWorkflowRun({
      owner: this.owner,
      repo: this.repo,
      run_id: Number(runId),
    });
    return {
      id: String(data.id),
      repository: this.owner + "/" + this.repo,
      conclusion: data.conclusion ?? null,
      sha: data.head_sha ?? "",
      branch: data.head_branch ?? "",
      attempt: data.run_attempt ?? 1,
      ...pullRequestLinks(data),
    };
  }
  async getFailedLogs(runId: string): Promise<string> {
    if (!/^\d+$/.test(runId)) throw new Error("Invalid workflow run id.");
    const { stdout } = await execFileAsync(
      "gh",
      ["run", "view", runId, "--repo", this.owner + "/" + this.repo, "--log-failed"],
      { env: { ...process.env, GH_TOKEN: this.token }, maxBuffer: 5 * 1024 * 1024, timeout: 30000 },
    );
    // Failures surface at the end of a log; keep the tail, not the setup noise.
    return stdout.slice(-100000);
  }
}
export function repositoryFromEnv(env: NodeJS.ProcessEnv = process.env): {
  owner: string;
  repo: string;
  fullName: string;
} {
  const fullName = env.GITHUB_REPOSITORY ?? "";
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must be owner/name.");
  return { owner, repo, fullName };
}
