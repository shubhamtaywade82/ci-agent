import { describe, it, expect } from "vitest";
import { runReview, MARKER, parseLedger, chunkDiff, buildAnchors, filterReviewableFiles } from "../src/review.js";
import { FakeLlm, FakeRepoHost, InMemoryAudit, PR, SAMPLE_DIFF, testManifest } from "./fakes.js";

function setup() {
  const host = new FakeRepoHost();
  const audit = new InMemoryAudit();
  const llm = new FakeLlm();
  host.diffs.set(PR.number, SAMPLE_DIFF);
  host.prs.set(PR.number, PR);
  return { host, audit, llm };
}

const GOOD = {
  findings: [
    { path: "src/math.ts", line: 2, severity: "major", message: "return value changed silently" },
  ],
  summary: "one finding",
};

describe("runReview", () => {
  it("posts one COMMENT review with in-diff inline comments", async () => {
    const { host, audit, llm } = setup();
    llm.queue.push(GOOD);
    llm.queue.push({ findings: [], summary: "clean" }); // README.md chunk
    const r = await runReview(PR, { host, llm, audit, manifest: testManifest() });
    expect(r.posted).toBe(true);
    expect(r.findings).toBe(1);
    expect(host.reviews).toHaveLength(1);
    const review = host.reviews[0]!.review;
    expect(review.event).toBe("COMMENT");
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]!.path).toBe("src/math.ts");
    expect(review.comments[0]!.line).toBe(2);
    expect(review.comments[0]!.side).toBe("RIGHT");
  });

  it("drops findings anchored outside the diff's right side", async () => {
    const { host, audit, llm } = setup();
    llm.queue.push({
      findings: [
        { path: "src/math.ts", line: 2, severity: "minor", message: "in diff" },
        { path: "src/math.ts", line: 99, severity: "major", message: "out of diff" },
        { path: "other/file.ts", line: 1, severity: "info", message: "wrong file" },
      ],
      summary: "mixed",
    });
    llm.queue.push({ findings: [], summary: "clean" }); // README.md chunk
    const r = await runReview(PR, { host, llm, audit, manifest: testManifest() });
    expect(r.findings).toBe(1);
    expect(host.reviews[0]!.review.comments).toHaveLength(1);
    expect(host.reviews[0]!.review.comments[0]!.line).toBe(2);
  });

  it("fails closed when the LLM payload violates the schema", async () => {
    const { host, audit, llm } = setup();
    llm.queue.push({ nonsense: true });
    await expect(runReview(PR, { host, llm, audit, manifest: testManifest() })).rejects.toThrow(/fail-closed/);
    expect(host.reviews).toHaveLength(0); // nothing posted
    expect(audit.eventsOf("llm-reject").length).toBeGreaterThanOrEqual(1);
  });

  it("fails closed when the LLM port throws", async () => {
    const { host, audit, llm } = setup();
    llm.error = new Error("boom");
    await expect(runReview(PR, { host, llm, audit, manifest: testManifest() })).rejects.toThrow(/fail-closed/);
    expect(audit.eventsOf("llm-reject").length).toBeGreaterThanOrEqual(1);
  });

  it("skips cleanly when there are no reviewable chunks", async () => {
    const { host, audit, llm } = setup();
    host.diffs.set(PR.number, "");
    const r = await runReview(PR, { host, llm, audit, manifest: testManifest() });
    expect(r.posted).toBe(false);
    expect(llm.calls).toHaveLength(0); // no consultation at all
  });

  it("writes the marker ledger comment with fingerprints", async () => {
    const { host, audit, llm } = setup();
    llm.queue.push(GOOD);
    await runReview(PR, { host, llm, audit, manifest: testManifest() });
    const marker = host.markerComments.get(PR.number);
    expect(marker).toBeDefined();
    expect(marker!.body).toContain(MARKER);
    const ledger = parseLedger(marker!.body);
    expect(ledger.fingerprints.size).toBe(1);
  });

  it("dedupes findings already recorded in the ledger", async () => {
    const { host, audit, llm } = setup();
    llm.queue.push(GOOD);
    llm.queue.push({ findings: [], summary: "clean" });
    await runReview(PR, { host, llm, audit, manifest: testManifest() });
    llm.queue.push(GOOD); // same finding again on re-run
    llm.queue.push({ findings: [], summary: "clean" });
    const r2 = await runReview(PR, { host, llm, audit, manifest: testManifest() });
    expect(r2.findings).toBe(0);
    expect(host.reviews).toHaveLength(1); // second run posts nothing
  });

  it("never approves or requests changes", async () => {
    const { host, audit, llm } = setup();
    llm.queue.push(GOOD);
    await runReview(PR, { host, llm, audit, manifest: testManifest() });
    expect(host.reviews.every((r) => r.review.event === "COMMENT")).toBe(true);
  });

  it("marks the untrusted-data rule in the system prompt", async () => {
    const { host, audit, llm } = setup();
    llm.queue.push(GOOD);
    await runReview(PR, { host, llm, audit, manifest: testManifest() });
    expect(llm.calls[0]!.system).toContain("UNTRUSTED DATA");
  });
});

describe("chunkDiff", () => {
  it("chunks one file per diff, skipping non-reviewable paths", () => {
    const { chunks, skipped } = chunkDiff(SAMPLE_DIFF, 6);
    expect(chunks.map((c) => c.path)).toEqual(["src/math.ts", "README.md"]);
    expect(skipped).toHaveLength(0);
  });

  it("skips lockfiles and generated files", () => {
    const diff = SAMPLE_DIFF.replaceAll("src/math.ts", "package-lock.json");
    const { chunks } = chunkDiff(diff, 6);
    expect(chunks.map((c) => c.path)).toEqual(["README.md"]);
  });

  it("honors the maxChunks cap", () => {
    const { chunks } = chunkDiff(SAMPLE_DIFF, 1);
    expect(chunks).toHaveLength(1);
  });
});

describe("buildAnchors", () => {
  it("anchors right-side lines per file", () => {
    const anchors = buildAnchors(SAMPLE_DIFF);
    const math = anchors.get("src/math.ts")!;
    expect(math.has(2)).toBe(true); // +return a + b;
    expect(math.has(5)).toBe(true); // +blank
    expect(math.has(1)).toBe(false); // context-only
    expect(anchors.get("README.md")!.has(1)).toBe(true);
  });
});

describe("filterReviewableFiles", () => {
  it("filters lockfiles, dist, node_modules, vendored, binaries", () => {
    const paths = [
      "src/a.ts",
      "package-lock.json",
      "packages/cli/pnpm-lock.yaml",
      "dist/index.js",
      "node_modules/x/index.js",
      "vendor/lib/a.js",
      "logo.png",
      "font.woff2",
      "src/a.js.map",
    ];
    const kept = filterReviewableFiles(paths);
    expect(kept).toEqual(["src/a.ts"]);
  });
});

describe("parseLedger", () => {
  it("parses fingerprints and last-run from a marker body", () => {
    const body = [
      "summary line",
      "",
      "last-run: 2026-11-24T01:00:00Z",
      "fingerprints: aaa,bbb",
      MARKER,
    ].join("\n");
    const ledger = parseLedger(body);
    expect(ledger.fingerprints.has("aaa")).toBe(true);
    expect(ledger.fingerprints.has("bbb")).toBe(true);
    expect(ledger.lastRunAt).toBe("2026-11-24T01:00:00Z");
  });
});

describe("sanitization of posted review bodies (ported hardening)", () => {
  it("neutralizes mentions and raw HTML in model findings", async () => {
    const host = new FakeRepoHost();
    host.diffs.set(PR.number, "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n context\n-old\n+new\n context\n");
    const audit = new InMemoryAudit();
    const llm = new FakeLlm();
    llm.queue.push({
      findings: [
        { path: "src/a.ts", line: 2, severity: "major", message: "pings @owner and <script>alert(1)</script>" },
      ],
      summary: "injected <b>markup</b> @someone",
    });
    const out = await runReview(PR, { host, llm, audit, manifest: testManifest() });
    expect(out.posted).toBe(true);
    const review = host.reviews[0]!.review;
    // `<` is escaped so nothing renders as raw HTML; the closing bracket is inert.
    expect(review.body).toContain("&lt;script>");
    expect(review.body).not.toContain("<script>");
    // Mention is broken up by a zero-width space after @.
    expect(review.body).not.toContain("@owner");
    for (const c of review.comments) {
      expect(c.body).not.toContain("<script>");
    }
  });
});
