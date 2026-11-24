import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../src/policy.js";
import { testManifest, FakeLlm } from "./fakes.js";
import type { PatchProposal } from "../src/types.js";

const manifest = testManifest();

function proposal(over: Partial<PatchProposal> = {}): PatchProposal {
  return {
    diagnosis: "off-by-one in add",
    confidence: "high",
    risk: "low",
    files: [{ path: "src/math.ts", content: "export function add(a,b){return a+b}" }],
    expectedValidation: ["npm test"],
    rationale: "the minus was a typo",
    ...over,
  };
}

function task(over: Record<string, unknown> = {}) {
  return {
    mode: "fix" as const,
    repo: "acme/widget",
    runId: "42",
    sha: "abc",
    isFork: false,
    ...over,
  };
}

describe("evaluatePolicy — structural gates", () => {
  it("rejects when the whole manifest is disabled", () => {
    const m = testManifest({ enabled: false });
    const d = evaluatePolicy(m, { action: "llm-consult", task: task() });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("enabled=false");
  });

  it("rejects when the mode is disabled", () => {
    const m = testManifest({ modes: { fix: { enabled: false } } });
    const d = evaluatePolicy(m, { action: "draft-fix-pr", task: task(), proposal: proposal() });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("modes.fix.enabled");
  });

  it("rejects fork tasks before any cloud consultation", () => {
    const d = evaluatePolicy(manifest, {
      action: "llm-consult",
      task: task({ isFork: true, headRepoFullName: "stranger/fork" }),
    });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("fork");
  });

  it("rejects when data policy forbids cloud source exposure", () => {
    const m = testManifest({ dataPolicy: { classification: "proprietary", sendSourceToCloud: false } });
    const d = evaluatePolicy(m, { action: "llm-consult", task: task(), cloudPaths: ["src/a.ts"] });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("sendSourceToCloud");
  });

  it("rejects cloud consultation of redacted paths", () => {
    const d = evaluatePolicy(manifest, {
      action: "llm-consult",
      task: task(),
      cloudPaths: ["config/.env.production"],
    });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("redactPaths");
  });
});

describe("evaluatePolicy — proposal gates", () => {
  it("allows a compliant proposal", () => {
    const d = evaluatePolicy(manifest, { action: "draft-fix-pr", task: task(), proposal: proposal() });
    expect(d.action).toBe("allow");
  });

  it("rejects proposals exceeding maxFiles", () => {
    const p = proposal({
      files: [
        { path: "src/a.ts", content: "x" },
        { path: "src/b.ts", content: "x" },
        { path: "src/c.ts", content: "x" },
      ],
    });
    // default maxFiles=5; force a lower ceiling
    const m = testManifest({ modes: { fix: { maxFiles: 2 } } });
    const d = evaluatePolicy(m, { action: "draft-fix-pr", task: task(), proposal: p });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("maxFiles");
  });

  it("rejects low-confidence proposals below the threshold", () => {
    const d = evaluatePolicy(manifest, {
      action: "draft-fix-pr",
      task: task(),
      proposal: proposal({ confidence: "low" }),
    });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("minConfidence");
  });

  it("rejects files on the denylist", () => {
    const p = proposal({ files: [{ path: ".github/workflows/ci.yml", content: "on: push" }] });
    const d = evaluatePolicy(manifest, { action: "draft-fix-pr", task: task(), proposal: p });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("denyPaths");
  });

  it("rejects lockfile edits", () => {
    const p = proposal({ files: [{ path: "package-lock.json", content: "{}" }] });
    const d = evaluatePolicy(manifest, { action: "draft-fix-pr", task: task(), proposal: p });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("denyPaths");
  });

  it("rejects files outside the allowlist", () => {
    const p = proposal({ files: [{ path: "infra/deploy.sh", content: "x" }] });
    const d = evaluatePolicy(manifest, { action: "draft-fix-pr", task: task(), proposal: p });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("allowPaths");
  });

  it("rejects empty file contents", () => {
    const p = proposal({ files: [{ path: "src/math.ts", content: "" }] });
    const d = evaluatePolicy(manifest, { action: "draft-fix-pr", task: task(), proposal: p });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("empty");
  });

  it("rejects oversized files", () => {
    const m = testManifest({ modes: { fix: { maxFileBytes: 10 } } });
    const p = proposal({ files: [{ path: "src/math.ts", content: "x".repeat(50) }] });
    const d = evaluatePolicy(m, { action: "draft-fix-pr", task: task(), proposal: p });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("maxFileBytes");
  });

  it("rejects empty proposals", () => {
    const d = evaluatePolicy(manifest, {
      action: "draft-fix-pr",
      task: task(),
      proposal: proposal({ files: [] }),
    });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("no files");
  });
});

describe("evaluatePolicy — budgets", () => {
  it("rejects chunk counts above maxChunks", () => {
    const d = evaluatePolicy(manifest, {
      action: "review-comment",
      task: { mode: "review", repo: "acme/widget", sha: "x", isFork: false, prNumber: 1 },
      chunks: 99,
    });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("maxChunks");
  });

  it("rejects input tokens above budget", () => {
    const d = evaluatePolicy(manifest, {
      action: "review-comment",
      task: { mode: "review", repo: "acme/widget", sha: "x", isFork: false, prNumber: 1 },
      inputTokens: 1_000_000,
    });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("maxInputTokens");
  });

  it("allows review-comment at comment autonomy", () => {
    const d = evaluatePolicy(manifest, {
      action: "review-comment",
      task: { mode: "review", repo: "acme/widget", sha: "x", isFork: false, prNumber: 1 },
    });
    expect(d.action).toBe("allow");
  });

  it("rejects create-issue when autonomy is comment-only", () => {
    const m = testManifest({ modes: { scan: { autonomy: "comment" } } });
    const d = evaluatePolicy(m, {
      action: "create-issue",
      task: { mode: "scan", repo: "acme/widget", sha: "x", isFork: false },
    });
    expect(d.action).toBe("reject");
    expect(d.reasons.join()).toContain("autonomy");
  });
});

describe("autonomy ceiling table", () => {
  it("comment < issue < draft-pr", () => {
    const m = testManifest({ modes: { scan: { autonomy: "issue" } } });
    const issue = evaluatePolicy(m, {
      action: "create-issue",
      task: { mode: "scan", repo: "r", sha: "s", isFork: false },
    });
    expect(issue.action).toBe("allow");
  });
});

describe("FakeLlm sanity (test infrastructure itself)", () => {
  it("returns queued payloads and records calls", async () => {
    const llm = new FakeLlm();
    llm.queue.push({ verdict: "ok" });
    const out = await llm.structured<{ verdict: string }>({
      schema: {},
      system: "s",
      user: "u",
      maxInputTokens: 100,
      maxOutputTokens: 10,
    });
    expect(out.verdict).toBe("ok");
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.system).toBe("s");
  });
});
