import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, hunkRightLines, hunkLeftLines } from "../src/diff.js";
import { SAMPLE_DIFF } from "./fakes.js";

describe("parseUnifiedDiff", () => {
  const parsed = parseUnifiedDiff(SAMPLE_DIFF);

  it("parses files with new paths", () => {
    expect(parsed.files.map((f) => f.path)).toEqual(["src/math.ts", "README.md"]);
  });

  it("parses hunks with correct headers", () => {
    const f = parsed.files[0]!;
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0]!.oldStart).toBe(1);
    expect(f.hunks[0]!.oldLines).toBe(4);
    expect(f.hunks[0]!.newStart).toBe(1);
    expect(f.hunks[0]!.newLines).toBe(6);
  });

  it("captures +/-/context lines including the removed line", () => {
    const lines = parsed.files[0]!.hunks[0]!.lines;
    expect(lines).toContain("-  return a - b;");
    expect(lines).toContain("+  return a + b;");
    expect(lines).toContain("+");
    expect(lines.some((l) => l.startsWith(" "))).toBe(true);
  });

  it("recognizes binary and deleted file headers", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "index 123..456 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "index 789..000",
      "--- a/old.ts",
      "+++ /dev/null",
    ].join("\n");
    const out = parseUnifiedDiff(diff);
    expect(out.files[0]!.isBinary).toBe(true);
    expect(out.files[1]!.isDeleted).toBe(true);
  });

  it("handles rename headers", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
    ].join("\n");
    const out = parseUnifiedDiff(diff);
    expect(out.files[0]!.oldPath).toBe("src/old.ts");
    expect(out.files[0]!.path).toBe("src/new.ts");
  });
});

describe("hunkRightLines / hunkLeftLines", () => {
  const f = parseUnifiedDiff(SAMPLE_DIFF).files[0]!;
  const hunk = f.hunks[0]!;

  it("right-side map holds added lines at new line numbers", () => {
    const right = hunkRightLines(hunk);
    // new file: line2 = "return a + b", line5 = "" (blank added), line6 = ANSWER
    expect(right.get(2)).toBe("  return a + b;");
    expect(right.has(5)).toBe(true);
    expect(right.has(1)).toBe(false); // context line 1 not a `+` line
  });

  it("left-side map holds removed lines at old numbers", () => {
    const left = hunkLeftLines(hunk);
    expect(left.get(2)).toBe("  return a - b;");
    expect(left.has(5)).toBe(false);
  });
});
