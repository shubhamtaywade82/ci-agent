/**
 * Shared test fakes: in-memory ports for every seam the orchestrators use.
 * These make the core test suite fully offline and hermetic.
 */

import type {
  AgentManifest,
  AuditStore,
  AgentAuditEvent,
  CiProvider,
  LlmPort,
  PullRequestRef,
  PullRequestReviewInput,
  RepoHost,
} from "../src/index.js";
import { DEFAULT_MANIFEST, parseManifest } from "../src/index.js";
import { parse as parseYaml } from "yaml";

export class InMemoryAudit implements AuditStore {
  events: AgentAuditEvent[] = [];
  async append(e: AgentAuditEvent): Promise<void> {
    this.events.push(e);
  }
  eventsOf(kind: AgentAuditEvent["event"]): AgentAuditEvent[] {
    return this.events.filter((e) => e.event === kind);
  }
}

/** LLM port fake: returns a queued JSON payload per call, records prompts. */
export class FakeLlm implements LlmPort {
  calls: { system: string; user: string; schema: object }[] = [];
  queue: unknown[] = [];
  error: Error | null = null;
  private lastPayload: unknown = null;

  async structured<T>(input: {
    schema: object;
    system: string;
    user: string;
  }): Promise<T> {
    this.calls.push({ system: input.system, user: input.user, schema: input.schema });
    if (this.error) throw this.error;
    if (this.queue.length === 0 && this.lastPayload === null) {
      throw new Error("FakeLlm: queue empty");
    }
    const head = this.queue.shift();
    if (head !== undefined) this.lastPayload = head;
    // Multi-chunk reviews consult once per chunk; when the queue runs out,
    // repeat the last payload so tests can set a single canned response.
    return (head !== undefined ? head : this.lastPayload) as T;
  }
}

export const SAMPLE_DIFF = `diff --git a/src/math.ts b/src/math.ts
index 111..222 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,4 +1,6 @@
 export function add(a: number, b: number): number {
-  return a - b;
+  return a + b;
 }
+
+export const ANSWER = 42;
diff --git a/README.md b/README.md
index 333..444 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
-# old title
+# new title
+some docs
`;

export const PR: PullRequestRef = {
  number: 7,
  title: "Fix add",
  body: "Fixes the add function",
  state: "open",
  draft: false,
  headRefName: "feat/add-fix",
  headSha: "abc123def456",
  headRepoFullName: "acme/widget",
  baseRefName: "main",
};

export class FakeRepoHost implements RepoHost {
  diffs = new Map<number, string>();
  files = new Map<string, string>();
  prs = new Map<number, PullRequestRef>();
  prForSha = new Map<string, number[]>();
  branches: string[] = [];
  commits: { branch: string; path: string; content: string }[] = [];
  reviews: { pr: number; review: PullRequestReviewInput }[] = [];
  issues: { title: string; body: string }[] = [];
  markerComments = new Map<number, { id: number; body: string }>();
  labels = new Map<number, string[]>();
  nextCommentId = 1;

  async getPullRequest(pr: number): Promise<PullRequestRef> {
    const found = this.prs.get(pr);
    if (!found) throw new Error(`no PR #${pr}`);
    return found;
  }
  async getDiff(pr: number): Promise<string> {
    return this.diffs.get(pr) ?? "";
  }
  async getFile(path: string, _ref: string): Promise<string> {
    const f = this.files.get(path);
    if (f === undefined) throw new Error(`no file ${path}`);
    return f;
  }
  async listPullRequestsForSha(sha: string): Promise<number[]> {
    return this.prForSha.get(sha) ?? [];
  }
  async createBranch(name: string, sha: string): Promise<void> {
    this.branches.push(`${name}@${sha}`);
  }
  async putFile(path: string, content: string, branch: string): Promise<void> {
    this.commits.push({ branch, path, content });
  }
  async createPullRequest(input: { title: string; head: string; base: string; body: string; draft: boolean }) {
    const number = 100 + this.prs.size;
    this.prs.set(number, {
      ...PR,
      number,
      title: input.title,
      headRefName: input.head,
      baseRefName: input.base,
      body: input.body,
      draft: input.draft,
    });
    return { number, htmlUrl: `https://example.invalid/pr/${number}` };
  }
  async postReview(pr: number, review: PullRequestReviewInput): Promise<void> {
    if (review.event !== "COMMENT") throw new Error(`refused event ${review.event}`);
    this.reviews.push({ pr, review });
  }
  async createIssue(input: { title: string; body: string }): Promise<void> {
    this.issues.push(input);
  }
  async findMarkerComment(pr: number, marker: string) {
    const c = this.markerComments.get(pr);
    if (c && c.body.includes(marker)) return c;
    return null;
  }
  async updateComment(pr: number, commentId: number, body: string): Promise<void> {
    this.markerComments.set(pr, { id: commentId, body });
  }
  async createComment(pr: number, body: string): Promise<number> {
    const id = this.nextCommentId++;
    this.markerComments.set(pr, { id, body });
    return id;
  }
}

export class FakeCiProvider implements CiProvider {
  run = {
    id: 42,
    name: "verify",
    conclusion: "failure",
    headSha: "abc123def456",
    headBranch: "feat/add-fix",
    htmlUrl: "https://ci.example/42",
  };
  logs = `##[group]Run npm test
> packages/core@0.1.0 test
> vitest run

FAIL packages/core/test/math.test.ts > add
AssertionError: expected 5 to be 3
 ❯ packages/core/test/math.test.ts:12:31
    at Object.<anonymous> (packages/core/test/math.test.ts:12:31)
Tests 1 failed
##[error]Process completed with exit code 1`;

  async getRun(_runId: string) {
    return this.run;
  }
  async getFailedLogs(_runId: string): Promise<string> {
    return this.logs;
  }
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Deep-merge a partial override over an object (arrays replaced wholesale). */
function deepMerge<T>(base: T, over: DeepPartial<T> | Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = out[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v) && b !== null && typeof b === "object" && !Array.isArray(b)) {
      out[k] = deepMerge(b, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function testManifest(
  overrides: DeepPartial<AgentManifest> | Record<string, unknown> = {},
): ReturnType<typeof parseManifest> {
  const base = {
    version: 1,
    enabled: true,
    project: { name: "auto", type: "auto", monorepo: "auto" },
    toolchain: { adapter: "auto", commands: {} },
    modes: {
      review: { enabled: true, autonomy: "comment", maxChunks: 6, maxInputTokens: 30000 },
      fix: {
        enabled: true,
        autonomy: "draft-pr",
        optInLabel: "nemesis:autofix",
        maxAttempts: 2,
        maxFiles: 5,
        maxFileBytes: 60000,
        minConfidence: "medium",
      },
      scan: {
        enabled: true,
        schedule: "weekly",
        autonomy: "issue",
        signals: ["ci-failure", "static-analysis"],
      },
      triage: { enabled: false },
    },
    policy: {
      autoMerge: false,
      requireHumanApproval: true,
      allowPaths: ["src/**", "tests/**", "docs/**", "packages/**"],
      denyPaths: [".github/**", "**/package-lock.json", "**/.env*"],
    },
    dataPolicy: {
      classification: "internal",
      sendSourceToCloud: true,
      redactPaths: ["**/.env*", "**/*secret*", "**/credentials*"],
    },
    llm: { provider: "ollama-cloud", hostEnv: "OLLAMA_HOST", apiKeyEnv: "OLLAMA_API_KEY", modelEnv: "OLLAMA_MODEL" },
    audit: { format: "jsonl", uploadArtifact: true },
  };
  return parseManifest(deepMerge(base, overrides));
}

export { DEFAULT_MANIFEST };
