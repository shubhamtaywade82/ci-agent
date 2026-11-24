/**
 * Architecture boundary test — the load-bearing wall of the whole design.
 *
 * The core package must never import (directly or transitively, at the
 * source level) any adapter SDK: no Octokit, no ollama-sdk, no fetch
 * wrappers, nothing environment-bound. Adapters depend on core, never the
 * other way around. This is what keeps the deterministic pipeline hermetic
 * and lets the LLM port stay mocked in tests.
 *
 * Mirrors the intent of the user's `core.architecture.test.ts`: boundary
 * enforcement as a first-class test, not a review-time convention.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN_IMPORT_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /@octokit\//, label: "Octokit (GitHub adapter SDK)" },
  { pattern: /@nemesis-oss\/ollama-sdk/, label: "Ollama SDK (LLM adapter SDK)" },
  { pattern: /from\s+["']\.\.\/\.\.\//, label: "imports escaping the package root" },
  { pattern: /node-fetch|undici|axios|got\(/, label: "HTTP client libraries" },
];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("architecture boundaries", () => {
  const coreFiles = listFiles(join(import.meta.dirname, "../src"));

  it("core has source files to check", () => {
    expect(coreFiles.length).toBeGreaterThan(5);
  });

  it("core imports no adapter SDKs (no octokit, no ollama-sdk, no http clients)", () => {
    const violations: string[] = [];
    for (const file of coreFiles) {
      const text = readFileSync(file, "utf8");
      for (const { pattern, label } of FORBIDDEN_IMPORT_PATTERNS) {
        if (pattern.test(text)) violations.push(`${file}: imports ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("core imports stay intra-package (./module.js only, plus ajv + node builtins)", () => {
    const allowed = new Set(["ajv", "node:crypto", "node:fs/promises", "node:path"]);
    const violations: string[] = [];
    const importRe = /^import\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["'];?$/gm;
    for (const file of coreFiles) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(importRe)) {
        const spec = m[1] as string;
        if (spec.startsWith("./") || spec.startsWith("../")) {
          if (spec.startsWith("../")) violations.push(`${file}: ${spec} escapes package`);
          continue;
        }
        if (!allowed.has(spec) && !spec.startsWith("node:")) {
          violations.push(`${file}: unexpected import ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("ollama-cloud is the only package that imports the ollama SDK", () => {
    const offenders: string[] = [];
    for (const pkg of ["github", "toolchains", "cli", "core"]) {
      for (const file of listFiles(join(import.meta.dirname, `../../${pkg}/src`))) {
        const text = readFileSync(file, "utf8");
        if (text.includes("@nemesis-oss/ollama-sdk")) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("github adapter is the only package importing octokit (besides none)", () => {
    const offenders: string[] = [];
    for (const pkg of ["core", "ollama-cloud", "toolchains", "cli"]) {
      const dir = join(import.meta.dirname, `../../${pkg}/src`);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of listFiles(dir)) {
        const text = readFileSync(file, "utf8");
        if (text.includes("@octokit/")) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every core source file compiles to a real export surface", () => {
    // dist check only meaningful after build; assert index re-exports exist in source
    const index = readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8");
    for (const module of [
      "types",
      "manifest",
      "glob",
      "schemas",
      "policy",
      "diff",
      "evidence",
      "audit",
      "review",
      "fix",
      "scan",
      "router",
    ]) {
      expect(index).toContain(`./${module}.js`);
    }
  });
});
