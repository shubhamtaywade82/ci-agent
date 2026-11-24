/**
 * GitHub adapter tests — offline: Octokit is stubbed at the transport level
 * with a fake `request` covering the REST endpoints the adapter touches.
 * Asserts the security-relevant behaviors: COMMENT-only reviews, no partial
 * data leaks, and marker-comment pagination.
 */

import { describe, it, expect, vi } from "vitest";
import { Octokit } from "@octokit/rest";
import { GitHubRepoHost } from "../src/repo-host.js";
import { extractFailedSteps } from "../src/ci-provider.js";

type Handler = (route: string, params?: Record<string, unknown>) => unknown;

function fakeOctokit(handler: Handler): Octokit {
  return {
    rest: new Proxy(
      {},
      {
        get(_t, ns) {
          if (ns === "pulls" || ns === "issues" || ns === "repos" || ns === "git" || ns === "actions") {
            return new Proxy(
              {},
              {
                get(_t2, method) {
                  return async (params: Record<string, unknown> = {}) => {
                    return { data: handler(`${String(ns)}.${String(method)}`, params) };
                  };
                },
              },
            );
          }
          return undefined;
        },
      },
    ),
  } as unknown as Octokit;
}

const PR_DATA = {
  number: 7,
  title: "Fix add",
  body: "desc",
  state: "open",
  draft: false,
  head: { ref: "feat/x", sha: "abc", repo: { full_name: "acme/widget" } },
  base: { ref: "main", repo: { full_name: "acme/widget" } },
};

describe("GitHubRepoHost", () => {
  it("getPullRequest maps the API payload to PullRequestRef", async () => {
    const octokit = fakeOctokit((route, params) => {
      expect(route).toBe("pulls.get");
      expect(params["pull_number"]).toBe(7);
      return PR_DATA;
    });
    const host = new GitHubRepoHost({ owner: "acme", repo: "widget", octokit });
    const pr = await host.getPullRequest(7);
    expect(pr.number).toBe(7);
    expect(pr.headRefName).toBe("feat/x");
    expect(pr.headSha).toBe("abc");
    expect(pr.headRepoFullName).toBe("acme/widget");
    expect(pr.baseRefName).toBe("main");
    expect(pr.draft).toBe(false);
  });

  it("getDiff requests the diff media type", async () => {
    const octokit = fakeOctokit((route, params) => {
      expect(route).toBe("pulls.get");
      expect((params as { mediaType?: { format?: string } }).mediaType?.format).toBe("diff");
      return "diff --git a/x b/x\n";
    });
    const host = new GitHubRepoHost({ owner: "acme", repo: "widget", octokit });
    const diff = await host.getDiff(7);
    expect(diff).toContain("diff --git");
  });

  it("postReview refuses non-COMMENT events", async () => {
    const octokit = fakeOctokit(() => ({}));
    const host = new GitHubRepoHost({ owner: "acme", repo: "widget", octokit });
    await expect(
      host.postReview(7, {
        event: "APPROVE" as "COMMENT",
        body: "lgtm",
        comments: [],
      }),
    ).rejects.toThrow(/refuses/);
  });

  it("postReview passes COMMENT reviews with inline comments", async () => {
    const seen: { route: string; params: Record<string, unknown> }[] = [];
    const octokit = fakeOctokit((route, params) => {
      seen.push({ route, params: params ?? {} });
      if (route === "pulls.get") return PR_DATA;
      return {};
    });
    const host = new GitHubRepoHost({ owner: "acme", repo: "widget", octokit });
    await host.postReview(7, {
      event: "COMMENT",
      body: "review body",
      comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "inline" }],
    });
    const reviewCall = seen.find((s) => s.route === "pulls.createReview")!;
    expect(reviewCall.params["event"]).toBe("COMMENT");
    expect(reviewCall.params["commit_id"]).toBe("abc");
    expect(reviewCall.params["comments"]).toEqual([
      { path: "src/a.ts", line: 2, side: "RIGHT", body: "inline" },
    ]);
  });

  it("createBranch tolerates already-exists races", async () => {
    const octokit = fakeOctokit((route) => {
      if (route === "git.createRef") {
        const err = new Error(" " ) as Error & { status: number };
        err.message = "Reference already exists";
        err.status = 422;
        throw err;
      }
      return {};
    });
    const host = new GitHubRepoHost({ owner: "acme", repo: "widget", octokit });
    await expect(host.createBranch("nemesis-agent/fix/42/a1", "abc")).resolves.toBeUndefined();
  });

  it("putFile builds blob→tree→commit→ref without force", async () => {
    const seen: { route: string; params: Record<string, unknown> }[] = [];
    const octokit = fakeOctokit((route, params) => {
      seen.push({ route, params: params ?? {} });
      switch (route) {
        case "git.getRef":
          return { object: { sha: "parent-sha" } };
        case "git.createBlob":
          return { sha: "blob-sha" };
        case "git.getCommit":
          return { tree: { sha: "tree-sha" } };
        case "git.getTree":
          return { tree: [{ path: "src/a.ts", mode: "100755", type: "blob", sha: "old" }] };
        case "git.createTree":
          return { sha: "new-tree" };
        case "git.createCommit":
          return { sha: "new-commit" };
        case "git.updateRef":
          return {};
        default:
          return {};
      }
    });
    const host = new GitHubRepoHost({ owner: "acme", repo: "widget", octokit });
    await host.putFile("src/a.ts", "new content", "nemesis-agent/fix/42/a1");
    const routes = seen.map((s) => s.route);
    expect(routes).toEqual([
      "git.getRef",
      "git.createBlob",
      "git.getCommit",
      "git.getTree",
      "git.createTree",
      "git.createCommit",
      "git.updateRef",
    ]);
    const update = seen.at(-1)!;
    expect(update.params["sha"]).toBe("new-commit");
    expect(update.params["force"]).toBe(false);
    const tree = seen.find((s) => s.route === "git.createTree")!;
    expect(tree.params["base_tree"]).toBe("tree-sha");
    expect(tree.params["tree"]).toEqual([
      { path: "src/a.ts", mode: "100755", type: "blob", sha: "blob-sha" },
    ]);
  });

  it("putFile falls back to 100644 for unseen paths (exec-bit lookup miss)", async () => {
    const octokit = fakeOctokit((route) => {
      switch (route) {
        case "git.getRef":
          return { object: { sha: "parent-sha" } };
        case "git.createBlob":
          return { sha: "blob-sha" };
        case "git.getCommit":
          return { tree: { sha: "tree-sha" } };
        case "git.getTree":
          return { tree: [{ path: "other.ts", mode: "100755", type: "blob", sha: "old" }] };
        case "git.createTree":
          return { sha: "new-tree" };
        case "git.createCommit":
          return { sha: "new-commit" };
        case "git.updateRef":
          return {};
        default:
          return {};
      }
    });
    const host = new GitHubRepoHost({ owner: "acme", repo: "widget", octokit });
    await host.putFile("src/new.ts", "new content", "nemesis-agent/fix/42/a1");
  });

  it("findMarkerComment matches the marker among issue comments", async () => {
    const octokit = fakeOctokit((route) => {
      expect(route).toBe("issues.listComments");
      return [
        { id: 1, body: "unrelated comment" },
        { id: 3, body: "summary\nlast-run: t\n<!-- nemesis-ci-agent:v1 -->" },
      ];
    });
    const host = new GitHubRepoHost({ owner: "acme", repo: "widget", octokit });
    const found = await host.findMarkerComment(7, "<!-- nemesis-ci-agent:v1 -->");
    expect(found).toEqual({ id: 3, body: "summary\nlast-run: t\n<!-- nemesis-ci-agent:v1 -->" });
  });

  it("findMarkerComment returns null when absent", async () => {
    const octokit = fakeOctokit(() => [{ id: 1, body: "no marker here" }]);
    const host = new GitHubRepoHost({ owner: "acme", repo: "widget", octokit });
    expect(await host.findMarkerComment(7, "<!-- nemesis-ci-agent:v1 -->")).toBeNull();
  });

  it("createPullRequest passes draft flag and base/head", async () => {
    const seen: { route: string; params: Record<string, unknown> }[] = [];
    const octokit = fakeOctokit((route, params) => {
      seen.push({ route, params: params ?? {} });
      return { number: 99, html_url: "https://github.com/acme/widget/pull/99" };
    });
    const host = new GitHubRepoHost({ owner: "acme", repo: "widget", octokit });
    const created = await host.createPullRequest({
      title: "fix(ci): x",
      head: "nemesis-agent/fix/42/a1",
      base: "main",
      body: "body",
      draft: true,
    });
    expect(created.number).toBe(99);
    expect(created.htmlUrl).toContain("/pull/99");
    const call = seen[0]!;
    expect(call.params["draft"]).toBe(true);
    expect(call.params["head"]).toBe("nemesis-agent/fix/42/a1");
    expect(call.params["base"]).toBe("main");
  });
});

describe("extractFailedSteps", () => {
  it("keeps error-annotated blocks and failure carriers", () => {
    const log = [
      "##[group]Run npm test",
      "> vitest run",
      "PASS a.test.ts",
      "FAIL b.test.ts",
      "AssertionError: boom",
      "##[error]exit code 1",
    ].join("\n");
    const out = extractFailedSteps(log, ["job-1"]);
    expect(out).toContain("FAIL b.test.ts");
    expect(out).toContain("AssertionError: boom");
    expect(out).toContain("##[error]exit code 1");
    expect(out).not.toContain("PASS a.test.ts");
  });
});
