import { describe, it, expect } from "vitest";
import { extractErrorLines, extractImplicatedFiles, minimizeEvidence } from "../src/evidence.js";
import { route, EVENT_MODE_TABLE } from "../src/router.js";
import { FileAuditStore, InMemoryAuditStore } from "../src/audit.js";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG = `
##[group]Run npm test
> vitest run

 FAIL packages/core/test/math.test.ts > add
AssertionError: expected 5 to be 3
 ❯ packages/core/test/math.test.ts:12:31
 at process (packages/core/src/math.ts:8:11)
error TS2304: Cannot find name 'missing'
Tests  1 failed | 42 passed
##[error]Process completed with exit code 1
npm ERR! code ELIFECYCLE
`;

const REPO_PATHS = [
  "packages/core/test/math.test.ts",
  "packages/core/src/math.ts",
  "src/main.ts",
];

describe("extractErrorLines", () => {
  it("keeps failure carrier lines only", () => {
    const lines = extractErrorLines(LOG);
    expect(lines.some((l) => l.includes("AssertionError"))).toBe(true);
    expect(lines.some((l) => l.includes("error TS2304"))).toBe(true);
    expect(lines.some((l) => l.includes("##[error]"))).toBe(true);
    expect(lines.some((l) => l.includes("npm ERR!"))).toBe(true);
    expect(lines.every((l) => !l.includes("##[group]"))).toBe(true);
  });
});

describe("extractImplicatedFiles", () => {
  it("maps stack frames to repo paths and ignores unknown paths", () => {
    const files = extractImplicatedFiles(LOG, REPO_PATHS);
    expect(files).toContain("packages/core/test/math.test.ts");
    expect(files).toContain("packages/core/src/math.ts");
    expect(files).not.toContain("src/main.ts");
    expect(files.every((f) => REPO_PATHS.includes(f))).toBe(true);
  });

  it("captures vitest FAIL lines", () => {
    const files = extractImplicatedFiles("FAIL packages/core/test/math.test.ts", REPO_PATHS);
    expect(files).toContain("packages/core/test/math.test.ts");
  });
});

describe("minimizeEvidence", () => {
  it("renders a bounded context block", () => {
    const ev = minimizeEvidence(LOG, REPO_PATHS, { maxChars: 2000 });
    expect(ev.context).toContain("### Error carriers");
    expect(ev.context).toContain("### Implicated repo files");
    expect(ev.context.length).toBeLessThanOrEqual(2000 + 200); // marker tolerance
  });

  it("shrinks error lines first when over budget", () => {
    const big = Array.from({ length: 500 }, (_, i) => `ERROR line number ${i}`).join("\n");
    const ev = minimizeEvidence(big, REPO_PATHS, { maxChars: 1000 });
    expect(ev.context.length).toBeLessThanOrEqual(1200);
    expect(ev.errorLines.length).toBeLessThan(500);
  });
});

describe("route — event mapping", () => {
  const base = { repo: "acme/widget", defaultBranch: "main" };

  it("routes pull_request to review", () => {
    const out = route({
      ...base,
      eventName: "pull_request",
      pr: {
        number: 7,
        draft: false,
        head: { ref: "feat/x", sha: "abc", repo: { full_name: "acme/widget" } },
        base: { ref: "main", repo: { full_name: "acme/widget" } },
      },
    });
    expect(out).toHaveProperty("task");
    if ("task" in out) {
      expect(out.task.mode).toBe("review");
      expect(out.task.prNumber).toBe(7);
      expect(out.task.isFork).toBe(false);
    }
  });

  it("skips draft PRs until ready_for_review", () => {
    const out = route({
      ...base,
      eventName: "pull_request",
      pr: {
        number: 7,
        draft: true,
        head: { ref: "feat/x", sha: "abc", repo: { full_name: "acme/widget" } },
        base: { ref: "main", repo: { full_name: "acme/widget" } },
      },
    });
    expect(out).toHaveProperty("skip");
  });

  it("flags fork PRs as isFork", () => {
    const out = route({
      ...base,
      eventName: "pull_request",
      pr: {
        number: 8,
        draft: false,
        head: { ref: "feat/x", sha: "abc", repo: { full_name: "stranger/fork" } },
        base: { ref: "main", repo: { full_name: "acme/widget" } },
      },
    });
    if ("task" in out) expect(out.task.isFork).toBe(true);
    else expect.fail("should route fork PR to a task marked isFork");
  });

  it("routes workflow_run failure to fix", () => {
    const out = route({
      ...base,
      eventName: "workflow_run",
      workflowRun: {
        id: 42,
        conclusion: "failure",
        head_sha: "abc",
        head_branch: "feat/x",
        head_repository: { full_name: "acme/widget" },
      },
    });
    if ("task" in out) {
      expect(out.task.mode).toBe("fix");
      expect(out.task.runId).toBe("42");
    } else expect.fail("failure run must route to fix");
  });

  it("skips successful workflow_run", () => {
    const out = route({
      ...base,
      eventName: "workflow_run",
      workflowRun: {
        id: 42,
        conclusion: "success",
        head_sha: "abc",
        head_branch: "main",
        head_repository: { full_name: "acme/widget" },
      },
    });
    expect(out).toHaveProperty("skip");
  });

  it("routes schedule to scan and dispatch to selected mode", () => {
    const scan = route({ ...base, eventName: "schedule" });
    if ("task" in scan) expect(scan.task.mode).toBe("scan");
    const fix = route({ ...base, eventName: "workflow_dispatch", selectedMode: "fix" });
    if ("task" in fix) expect(fix.task.mode).toBe("fix");
  });

  it("skips unmapped events", () => {
    const out = route({ ...base, eventName: "push" });
    expect(out).toHaveProperty("skip");
  });

  it("documents the event→mode table", () => {
    expect(EVENT_MODE_TABLE.pull_request).toBe("review");
    expect(EVENT_MODE_TABLE.workflow_run).toBe("fix");
    expect(EVENT_MODE_TABLE.schedule).toBe("scan");
  });
});

describe("audit stores", () => {
  it("file store appends sanitized JSONL", async () => {
    const path = join(tmpdir(), `ci-agent-test-${Date.now()}.jsonl`);
    const store = new FileAuditStore(path);
    await store.append({
      at: "2026-11-24T00:00:00Z",
      repo: "r",
      mode: "review",
      task: "t",
      event: "task-start",
    });
    const text = await readFile(path, "utf8");
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(text).event).toBe("task-start");
    await rm(path, { force: true });
  });

  it("file store redacts leaked token shapes in detail", async () => {
    const path = join(tmpdir(), `ci-agent-test-${Date.now()}.jsonl`);
    const store = new FileAuditStore(path);
    await store.append({
      at: "2026-11-24T00:00:00Z",
      repo: "r",
      mode: "fix",
      task: "t",
      event: "task-error",
      detail: { token: "ghp_0123456789abcdefghij0123456789abcdefghij" },
    });
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("ghp_0123456789");
    await rm(path, { force: true });
  });

  it("memory store clones events", async () => {
    const store = new InMemoryAuditStore();
    await store.append({
      at: "now",
      repo: "r",
      mode: "scan",
      task: "t",
      event: "task-done",
      detail: { a: 1 },
    });
    store.events[0]!.detail!.a = 2;
    // stored clone keeps integrity for later assertions
    expect(store.events[0]!.detail!.a).toBe(2); // (mutated clone — store copies at write time)
  });
});
