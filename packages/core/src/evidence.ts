/**
 * Evidence minimization: turn raw CI failure logs into a bounded,
 * reviewable context block for the fix pipeline.
 *
 * Deterministic steps only — no LLM in this file:
 *   1. keep only lines that look like failure carriers (error frames,
 *      failing test names, assertion messages, compiler diagnostics);
 *   2. map stack frames to file paths present in the repo snapshot;
 *   3. cap the total character budget.
 */

import { truncate } from "./fingerprint.js";

export interface MinimizedEvidence {
  /** Deterministically extracted failure carriers. */
  errorLines: string[];
  /** Repo files implicated by stack frames / diagnostics. */
  implicatedFiles: string[];
  /** The rendered context block (already capped). */
  context: string;
}

const FAILURE_PATTERNS: readonly RegExp[] = [
  /^exit code/i,
  /\bERROR\b/,
  /\bFAIL\b/,
  /\bError:/,
  /\berror TS\d+\b/, // TypeScript compiler
  /\bAssertionError\b/,
  /\bExpected\b.*\bReceived\b/i,
  /##\[error\]/, // GitHub Actions annotation
  /Tests:\s+\d+ failed/,
  /Non-zero exit/,
  /Lint.*problems?\b/i,
  /npm ERR!/,
  /failed to (?:compile|build|lint|typecheck)/i,
];

export function extractErrorLines(log: string, maxLines = 60): string[] {
  const lines = log.split("\n");
  const hits: string[] = [];
  for (const line of lines) {
    const t = line.trimEnd();
    if (t.length === 0) continue;
    if (FAILURE_PATTERNS.some((re) => re.test(t))) hits.push(truncate(t, 400));
    if (hits.length >= maxLines) break;
  }
  return hits;
}

/** Extract `at ... (file.js:line:col)` / pytest / go test file references. */
export function extractImplicatedFiles(log: string, repoPaths: readonly string[]): string[] {
  const mentions = new Map<string, number>();
  for (const rawLine of log.split("\n")) {
    const line = rawLine.trimEnd();
    for (const m of line.matchAll(/\(?(([\w./\\-]+)\/([\w.-]+)):(\d+):?(\d+)?\)?/g)) {
      const candidate = m[1] as string;
      if (!repoPaths.includes(candidate)) continue;
      mentions.set(candidate, (mentions.get(candidate) ?? 0) + 1);
    }
    // vitest/jest style: FAIL packages/core/test/x.test.ts
    const failMatch = /^FAIL\s+(\S+)/.exec(line);
    if (failMatch && repoPaths.includes(failMatch[1] as string)) {
      const p = failMatch[1] as string;
      mentions.set(p, (mentions.get(p) ?? 0) + 1);
    }
  }
  return [...mentions.keys()].sort();
}

export function minimizeEvidence(
  log: string,
  repoPaths: readonly string[],
  opts: { maxChars?: number } = {},
): MinimizedEvidence {
  const maxChars = opts.maxChars ?? 24_000;
  const errorLines = extractErrorLines(log);
  const implicatedFiles = extractImplicatedFiles(log, repoPaths);

  const sections: string[] = [];
  sections.push("## Failed-run evidence (minimized)\n");
  sections.push("### Error carriers\n" + (errorLines.join("\n") || "(none extracted)"));
  sections.push("### Implicated repo files\n" + (implicatedFiles.join("\n") || "(none matched)"));

  let context = sections.join("\n\n");
  if (context.length > maxChars) {
    // Drop error lines from the tail first; files list is small and vital.
    while (context.length > maxChars && errorLines.length > 1) {
      errorLines.pop();
      context = [
        "## Failed-run evidence (minimized)\n",
        "### Error carriers\n" + errorLines.join("\n"),
        "### Implicated repo files\n" + implicatedFiles.join("\n"),
      ].join("\n\n");
    }
    if (context.length > maxChars) context = truncate(context, maxChars);
  }
  return { errorLines, implicatedFiles, context };
}
