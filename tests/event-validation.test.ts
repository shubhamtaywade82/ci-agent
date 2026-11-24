import { describe, it, expect, vi } from "vitest";
import { assertCommenterCanReview, validateExpectedHeadSha } from "../src/event-validation.js";
describe("review dispatch SHA validation", () => {
  it("requires a valid expected SHA for repository_dispatch", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(validateExpectedHeadSha("repository_dispatch", sha)).toBe(sha);
  });
  it("rejects missing or malformed repository_dispatch SHAs", () => {
    expect(() => validateExpectedHeadSha("repository_dispatch", undefined)).toThrow(/requires a valid/);
    expect(() => validateExpectedHeadSha("repository_dispatch", "stale")).toThrow(/requires a valid/);
  });
  it("allows comment-triggered review without a dispatch SHA", () => {
    expect(validateExpectedHeadSha("issue_comment", undefined)).toBeUndefined();
  });
});
describe("commenter authorization", () => {
  it("allows commenters with write, maintain or admin permission", async () => {
    for (const role of ["write", "maintain", "admin"])
      await expect(assertCommenterCanReview("issue_comment", "alice", async () => role)).resolves.toBeUndefined();
  });
  it("rejects read or triage commenters", async () => {
    for (const role of ["read", "triage", "none"])
      await expect(assertCommenterCanReview("issue_comment", "bob", async () => role)).rejects.toThrow(
        /lacks write access/,
      );
  });
  it("rejects a comment event without a resolvable author", async () => {
    await expect(assertCommenterCanReview("issue_comment", undefined, async () => "admin")).rejects.toThrow(/author/);
  });
  it("does not look up permissions for non-comment events", async () => {
    const lookup = vi.fn();
    await assertCommenterCanReview("repository_dispatch", undefined, lookup);
    expect(lookup).not.toHaveBeenCalled();
  });
});
