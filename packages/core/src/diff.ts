/**
 * Minimal unified-diff parser for the review pipeline.
 *
 * Supports: file headers with old/new paths, hunks with line numbers,
 * context/+/- lines, `\ No newline at end of file`. Binary and mode-change
 * headers are recognized and skipped. No-mergespace or combined diffs are
 * out of scope; GitHub PR diffs are always plain unified diffs.
 */

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffFile {
  /** New path (after rename) or the single path when unchanged. */
  path: string;
  /** Old path when the file was renamed. */
  oldPath?: string;
  isBinary: boolean;
  isDeleted: boolean;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      current = {
        path: "",
        isBinary: false,
        isDeleted: false,
        hunks: [],
      };
      hunk = null;
      continue;
    }

    if (!current) continue;

    if (line.startsWith("--- ")) {
      current.oldPath = stripAbPrefix(stripTimestamp(line.slice(4)).trim());
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.path = stripAbPrefix(stripTimestamp(line.slice(4)).trim());
      continue;
    }
    if (line.startsWith("new file mode")) {
      // path already set from +++ line
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.isDeleted = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.oldPath = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.isBinary = true;
      continue;
    }
    if (line.startsWith("index ")) continue;

    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        hunk = {
          oldStart: Number(m[1]),
          oldLines: m[2] ? Number(m[2]) : 1,
          newStart: Number(m[3]),
          newLines: m[4] ? Number(m[4]) : 1,
          lines: [],
        };
        current.hunks.push(hunk);
      }
      continue;
    }

    if (hunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "\\")) {
      hunk.lines.push(line);
    }
  }
  if (current) files.push(current);

  return { files: files.filter((f) => f.path !== "" || f.oldPath !== "") };
}

function stripTimestamp(s: string): string {
  // `a/src/foo.ts` 2026-11-24 10:00:00.000000000 +0100
  const tab = s.indexOf("\t");
  return tab === -1 ? s : s.slice(0, tab);
}

/** Drop the `a/` / `b/` prefix used in unified-diff file headers. */
function stripAbPrefix(s: string): string {
  if (s === "/dev/null") return s;
  if (s.startsWith("a/") || s.startsWith("b/")) return s.slice(2);
  return s;
}

/**
 * Right-side line numbers for a hunk: the set of NEW file line numbers
 * touched by `+` lines, including context lines (reviewable positions).
 */
export function hunkRightLines(hunk: DiffHunk): Map<number, string> {
  const map = new Map<number, string>();
  let newLine = hunk.newStart;
  for (const line of hunk.lines) {
    if (line.startsWith("+")) {
      map.set(newLine, line.slice(1));
      newLine++;
    } else if (line.startsWith(" ")) {
      newLine++;
    }
  }
  return map;
}

/**
 * Left-side line numbers for a hunk (context + removed lines).
 * Used for anchor fallback when a finding cites a context line.
 */
export function hunkLeftLines(hunk: DiffHunk): Map<number, string> {
  const map = new Map<number, string>();
  let oldLine = hunk.oldStart;
  for (const line of hunk.lines) {
    if (line.startsWith("-")) {
      map.set(oldLine, line.slice(1));
      oldLine++;
    } else if (line.startsWith(" ")) {
      oldLine++;
    }
  }
  return map;
}
