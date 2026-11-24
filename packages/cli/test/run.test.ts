/**
 * CLI composition tests — offline, using port overrides and a temp manifest.
 * Asserts the exit-code contract and the routing → orchestration wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { run } from "../src/run.js";
import { parseRepo, composeEvent, readGithubEnv } from "../src/env.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MANIFEST, InMemoryAuditStore, parseManifest } from "@nemesis-oss/ci-agent-core";
import type { AgentManifest, AuditStore, LlmPort, RepoHost, CiProvider } from "@nemesis-oss/ci-agent-core";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ci-agent-cli-"));
  await mkdir(join(cwd, ".nemesis"), { recursive: true });
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function writeManifest(text: string): Promise<string> {
  const path = join(cwd, ".nemesis/ci-agent.yml");
  await writeFile(path, text, "utf8");
  return path;
}

function overrides(ports: { llm: LlmPort; host: RepoHost; ci: CiProvider; audit: AuditStore }) {
  return {
    llm: ports.llm,
    host: ports.host,
    ci: ports.ci,
    audit: ports.audit,
  };
}

const MANIFEST = `version: 1
enabled: true
modes:
  review:
    enabled: true
    autonomy: comment
  fix:
    enabled: true
    autonomy: draft-pr
    optInLabel: nemesis:autofix
  scan:
    enabled: true
    autonomy: issue
policy:
  allowPaths:
    - src/**
  denyPaths:
    - .github/**
dataPolicy:
  classification: internal
  sendSourceToCloud: true
`;

describe("parseRepo", () => {
  it("parses owner/repo", () => {
    expect(parseRepo("acme/widget")).toEqual({ owner: "acme", repo: "widget" });
  });
  it("parses URLs and .git suffixes", () => {
    expect(parseRepo("https://github.com/acme/widget.git")).toEqual({ owner: "acme", repo: "widget" });
  });
  it("rejects garbage", () => {
    expect(parseRepo("not-a-repo")).toBeNull();
    expect(parseRepo("")).toBeNull();
  });
});

describe("readGithubEnv / composeEvent", () => {
  it("reads the GitHub event env and composes a routing input", () => {
    const env: Record<string, string> = {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "acme/widget",
      GITHUB_EVENT_PATH: join(cwd, "event.json"),
      GH_TOKEN: "t",
    };
    const ghEnv = readGithubEnv(env);
    expect(ghEnv.eventName).toBe("pull_request");
    expect(ghEnv.repository).toBe("acme/widget");
  });
});

describe("run — exit-code contract", () => {
  it("exit 2 on invalid manifest (never silently ignored)", async () => {
    const configPath = await writeManifest("version: 1\nmodes: [not-an-object\n");
    // make it a YAML type error
    await writeFile(configPath, "modes:\n  - just\n  - a\n  - list\nversion: 1\n", "utf8");
    const r = await run({ env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "acme/widget" }, configPath });
    expect(r.exitCode).toBe(2);
    expect(r.outcome).toBe("config-error");
  });

  it("exit 0 disabled when manifest.enabled=false", async () => {
    const configPath = await writeManifest("version: 1\nenabled: false\n");
    const r = await run({ env: { GITHUB_EVENT_NAME: "pull_request" }, configPath });
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("disabled");
  });

  it("exit 0 skip for unmapped events", async () => {
    const configPath = await writeManifest(MANIFEST);
    const r = await run({ env: { GITHUB_EVENT_NAME: "push" }, configPath });
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("skipped");
  });

  it("exit 2 when the repository slug cannot be parsed", async () => {
    const configPath = await writeManifest(MANIFEST);
    const r = await run({
      env: { GITHUB_EVENT_NAME: "schedule", GITHUB_REPOSITORY: "" },
      configPath,
      overrides: {
        payload: JSON.stringify({ repository: { full_name: "" } }),
      },
    });
    expect(r.exitCode).toBe(2);
  });
});

describe("run — review mode wiring", () => {
  it("routes pull_request payloads to runReview through the ports", async () => {
    const configPath = await writeManifest(MANIFEST);
    const audit = new InMemoryAuditStore();
    const reviews: unknown[] = [];
    const host: RepoHost = {
      async getPullRequest() {
        return {
          number: 7,
          title: "t",
          body: "b",
          state: "open",
          draft: false,
          headRefName: "feat/x",
          headSha: "abc",
          headRepoFullName: "acme/widget",
          baseRefName: "main",
        };
      },
      async getDiff() {
        return "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
      },
      async getFile() { return ""; },
      async listPullRequestsForSha() { return []; },
      async createBranch() {},
      async putFile() {},
      async createPullRequest() { return { number: 1, htmlUrl: "u" }; },
      async postReview(_pr, review) { reviews.push(review); },
      async createIssue() {},
      async findMarkerComment() { return null; },
      async updateComment() {},
      async createComment() { return 1; },
    };
    const llm: LlmPort = {
      async structured() {
        return { findings: [], summary: "clean" } as never;
      },
    };
    const ci: CiProvider = {
      async getRun() { return { id: 1, name: "ci", conclusion: "success", headSha: "a", headBranch: "m", htmlUrl: "u" }; },
      async getFailedLogs() { return ""; },
    };
    const r = await run({
      env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "acme/widget", GH_TOKEN: "t" },
      configPath,
      overrides: { ...overrides({ llm, host, ci, audit }), payload: JSON.stringify({
        pull_request: {
          number: 7,
          draft: false,
          head: { ref: "feat/x", sha: "abc", repo: { full_name: "acme/widget" } },
          base: { ref: "main", repo: { full_name: "acme/widget" } },
        },
        repository: { default_branch: "main", full_name: "acme/widget" },
      }) },
      stdout: () => {},
    });
    expect(r.exitCode).toBe(0);
    expect(r.mode).toBe("review");
  });
});

describe("run — defaults fall-open only for absent manifests", () => {
  it("uses built-in defaults when the file is missing", async () => {
    const r = await run({
      env: { GITHUB_EVENT_NAME: "push" },
      configPath: join(cwd, ".nemesis/absent.yml"),
    });
    expect(r.exitCode).toBe(0); // push → skipped
    expect(r.outcome).toBe("skipped");
  });
});

describe("manifest defaults re-exported through CLI", () => {
  it("DEFAULT_MANIFEST is parseable and conservative", () => {
    expect(DEFAULT_MANIFEST.policy.autoMerge).toBe(false);
    expect(DEFAULT_MANIFEST.modes.fix.maxAttempts).toBe(2);
    expect(parseManifest(DEFAULT_MANIFEST)).toEqual(DEFAULT_MANIFEST);
  });
});
