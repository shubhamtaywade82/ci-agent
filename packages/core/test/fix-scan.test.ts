import { describe, it, expect } from "vitest";
import { runFix, parseFixAttempt, FIX_BRANCH_PREFIX } from "../src/fix.js";
import { runScan } from "../src/scan.js";
import {
  FakeLlm,
  FakeRepoHost,
  FakeCiProvider,
  InMemoryAudit,
  PR,
  testManifest,
} from "./fakes.js";

function setup() {
  const host = new FakeRepoHost();
  const ci = new FakeCiProvider();
  const audit = new InMemoryAudit();
  const llm = new FakeLlm();
  host.prs.set(PR.number, { ...PR, body: "some description label:nemesis:autofix" });
  host.prForSha.set(ci.run.headSha, [PR.number]);
  host.files.set("packages/core/src/math.ts", "export function add(a, b) { return a - b; }");
  return { host, ci, audit, llm };
}

const PROPOSAL = {
  diagnosis: "typo: minus instead of plus",
  confidence: "high",
  risk: "low",
  files: [
    {
      path: "packages/core/src/math.ts",
      content: "export function add(a, b) { return a + b; }",
    },
  ],
  expectedValidation: ["npm test"],
  rationale: "diff shows the sign flip",
};

describe("runFix", () => {
  it("creates a branch, commits the patch, opens a draft PR", async () => {
    const { host, ci, audit, llm } = setup();
    llm.queue.push(PROPOSAL);
    const out = await runFix(
      { runId: "42", repo: "acme/widget", isFork: false },
      { host, ci, llm, audit, manifest: testManifest(), repoPaths: ["packages/core/src/math.ts"] },
    );
    expect(out.outcome).toBe("fix-pr");
    expect(out.attempt).toBe(1);
    expect(out.prUrl).toMatch(/example\.invalid/);
    expect(host.branches).toEqual([`nemesis-agent/fix/42/a1@${ci.run.headSha}`]);
    expect(host.commits).toHaveLength(1);
    expect(host.commits[0]!.path).toBe("packages/core/src/math.ts");
    expect(host.commits[0]!.content).toContain("a + b");
    // The PR created for the fix is a draft targeting the original base.
    const fixPr = host.prs.get(101);
    expect(fixPr?.draft).toBe(true);
    expect(fixPr?.baseRefName).toBe("main");
  });

  it("skips when no PR is associated with the failed run", async () => {
    const { host, ci, audit, llm } = setup();
    host.prForSha.set(ci.run.headSha, []);
    const out = await runFix(
      { runId: "42", repo: "acme/widget", isFork: false },
      { host, ci, llm, audit, manifest: testManifest(), repoPaths: [] },
    );
    expect(out.outcome).toBe("skipped");
  });

  it("skips PRs without the opt-in label", async () => {
    const { host, ci, audit, llm } = setup();
    host.prs.set(PR.number, { ...PR, body: "no label here" });
    const out = await runFix(
      { runId: "42", repo: "acme/widget", isFork: false },
      { host, ci, llm, audit, manifest: testManifest(), repoPaths: [] },
    );
    expect(out.outcome).toBe("skipped");
    expect(out.reason).toContain("opt-in");
  });

  it("skips fork PRs even with the label", async () => {
    const { host, ci, audit, llm } = setup();
    host.prs.set(PR.number, { ...PR, body: "label:nemesis:autofix", headRepoFullName: "stranger/fork" });
    const out = await runFix(
      { runId: "42", repo: "acme/widget", isFork: false },
      { host, ci, llm, audit, manifest: testManifest(), repoPaths: [] },
    );
    expect(out.outcome).toBe("skipped");
    expect(out.reason).toContain("fork");
  });

  it("enforces the attempt cap on fix branches (recursion guard)", async () => {
    const { host, ci, audit, llm } = setup();
    // PR head is already a second attempt branch → attempt 3 > max 2.
    host.prs.set(PR.number, {
      ...PR,
      headRefName: "nemesis-agent/fix/41/a2",
      body: "label:nemesis:autofix",
    });
    const out = await runFix(
      { runId: "42", repo: "acme/widget", isFork: false },
      { host, ci, llm, audit, manifest: testManifest(), repoPaths: [] },
    );
    expect(out.outcome).toBe("skipped");
    expect(out.reason).toContain("attempt");
    expect(host.branches).toHaveLength(0);
  });

  it("increments attempt numbers for fix-branch PRs", async () => {
    const { host, ci, audit, llm } = setup();
    host.prs.set(PR.number, {
      ...PR,
      headRefName: "nemesis-agent/fix/41/a1",
      body: "label:nemesis:autofix",
    });
    llm.queue.push(PROPOSAL);
    const out = await runFix(
      { runId: "42", repo: "acme/widget", isFork: false },
      { host, ci, llm, audit, manifest: testManifest(), repoPaths: [] },
    );
    expect(out.outcome).toBe("fix-pr");
    expect(out.attempt).toBe(2);
    expect(host.branches[0]).toContain("a2@");
  });

  it("aborts fail-closed on schema violation without touching the repo", async () => {
    const { host, ci, audit, llm } = setup();
    llm.queue.push({ garbage: "not a proposal" });
    const out = await runFix(
      { runId: "42", repo: "acme/widget", isFork: false },
      { host, ci, llm, audit, manifest: testManifest(), repoPaths: ["packages/core/src/math.ts"] },
    );
    expect(out.outcome).toBe("aborted");
    expect(host.branches).toHaveLength(0);
    expect(host.commits).toHaveLength(0);
    expect(audit.eventsOf("llm-reject")).toHaveLength(1);
  });

  it("returns comment-only when policy rejects the proposal paths", async () => {
    const { host, ci, audit, llm } = setup();
    llm.queue.push({
      ...PROPOSAL,
      files: [{ path: ".github/workflows/ci.yml", content: "on: push" }],
    });
    const out = await runFix(
      { runId: "42", repo: "acme/widget", isFork: false },
      { host, ci, llm, audit, manifest: testManifest(), repoPaths: [] },
    );
    expect(out.outcome).toBe("comment-only");
    expect(out.reason).toContain("denyPaths");
    expect(host.branches).toHaveLength(0);
    expect(audit.eventsOf("proposal-reject")).toHaveLength(1);
  });

  it("rejects cloud consultation under a no-cloud data policy", async () => {
    const { host, ci, audit, llm } = setup();
    const manifest = testManifest({
      dataPolicy: { classification: "proprietary", sendSourceToCloud: false },
    });
    const out = await runFix(
      { runId: "42", repo: "acme/widget", isFork: false },
      { host, ci, llm, audit, manifest, repoPaths: ["packages/core/src/math.ts"] },
    );
    expect(out.outcome).toBe("aborted");
    expect(llm.calls).toHaveLength(0); // never consulted
    expect(audit.eventsOf("policy-reject")).toHaveLength(1);
  });

  it("records full audit trail: request, response, applied", async () => {
    const { host, ci, audit, llm } = setup();
    llm.queue.push(PROPOSAL);
    await runFix(
      { runId: "42", repo: "acme/widget", isFork: false },
      { host, ci, llm, audit, manifest: testManifest(), repoPaths: ["packages/core/src/math.ts"] },
    );
    expect(audit.eventsOf("llm-request")).toHaveLength(1);
    expect(audit.eventsOf("llm-response")).toHaveLength(1);
    expect(audit.eventsOf("action-applied")).toHaveLength(1);
    const applied = audit.eventsOf("action-applied")[0]!;
    expect(applied.detail?.["files"]).toEqual(["packages/core/src/math.ts"]);
  });
});

describe("parseFixAttempt", () => {
  it("parses attempt numbers from branch names", () => {
    expect(parseFixAttempt("nemesis-agent/fix/42/a1")).toBe(1);
    expect(parseFixAttempt("nemesis-agent/fix/42/a7")).toBe(7);
    expect(parseFixAttempt("feat/other")).toBeNull();
    expect(parseFixAttempt("nemesis-agent/fix/42/nope")).toBeNull();
    expect(parseFixAttempt("nemesis-agent/fix/a1")).toBeNull();
  });

  it("exports the documented branch prefix", () => {
    expect(FIX_BRANCH_PREFIX).toBe("nemesis-agent/fix");
  });
});

describe("runScan", () => {
  function evidence() {
    return {
      repo: "acme/widget",
      sha: "0123456789abcdef",
      profile: { adapter: "node-npm", commands: { verify: ["npm test"] }, packageRoots: ["."] },
      commands: [{ command: "npm test", exitCode: 0 }],
      reports: {},
      metrics: { coverage: 0.42 },
      findings: [
        {
          id: "f1",
          source: "coverage" as const,
          severity: "minor" as const,
          fingerprint: "abc",
          evidenceRefs: ["lcov"],
          message: "src/old.ts has 0% coverage",
        },
      ],
    };
  }

  it("creates issues from a prioritized scan", async () => {
    const audit = new InMemoryAudit();
    const llm = new FakeLlm();
    llm.queue.push({
      summary: "coverage is weak",
      issues: [
        {
          title: "Cover src/old.ts",
          severity: "minor",
          description: "0% coverage on a core module",
          category: "coverage-gaps",
          recommendation: "add tests for src/old.ts",
        },
      ],
    });
    const issues: { title: string; body: string }[] = [];
    const out = await runScan(evidence(), {
      llm,
      audit,
      manifest: testManifest({ modes: { scan: { enabled: true, autonomy: "issue" } } }),
      createIssue: async (input) => {
        issues.push(input);
      },
    });
    expect(out.outcome).toBe("issues-created");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toContain("minor");
    expect(issues[0]!.body).toContain("add tests");
  });

  it("skips with no evidence findings", async () => {
    const audit = new InMemoryAudit();
    const llm = new FakeLlm();
    const out = await runScan({ ...evidence(), findings: [], metrics: {} }, {
      llm,
      audit,
      manifest: testManifest(),
      createIssue: async () => {},
    });
    expect(out.outcome).toBe("skipped");
  });

  it("aborts fail-closed on schema violation", async () => {
    const audit = new InMemoryAudit();
    const llm = new FakeLlm();
    llm.queue.push({ bad: "shape" });
    const out = await runScan(evidence(), {
      llm,
      audit,
      manifest: testManifest({ modes: { scan: { autonomy: "issue" } } }),
      createIssue: async () => {},
    });
    expect(out.outcome).toBe("aborted");
    expect(audit.eventsOf("llm-reject")).toHaveLength(1);
  });
});
