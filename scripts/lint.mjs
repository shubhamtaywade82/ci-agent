#!/usr/bin/env node
/**
 * Zero-dependency structural lint.
 *
 * Checks that would otherwise need ESLint config bikeshedding:
 *   - no console.log in library packages (bin.ts/cli entrypoints exempt);
 *   - no `TODO`/`FIXME` markers left in shipped source;
 *   - no relative imports escaping a package root (`../../`);
 *   - every package.json has name/license/engines.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const failures = [];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith(".ts")) yield p;
  }
}

const CONSOLE_ALLOWED = new Set([
  "packages/cli/src/bin.ts",
  "packages/cli/src/run.ts",
  "action/src/actions-core.ts",
]);

export const LEGACY_LINE_BUDGETS = new Map([
  ["packages/core/src/fix.ts", 370],
  ["packages/core/src/manifest.ts", 390],
  ["packages/core/src/review.ts", 445],
  ["packages/core/src/types.ts", 365],
  ["packages/github/src/repo-host.ts", 370],
]);

export function checkCrlf(text) {
  return /\r\n/.test(text);
}

export function checkLineBudget(file, lineCount) {
  const allowed = LEGACY_LINE_BUDGETS.get(file) ?? 300;
  return lineCount <= allowed;
}

for (const pkg of ["core", "ollama-cloud", "github", "toolchains", "cli"]) {
  const pkgJson = JSON.parse(await readFile(join(root, "packages", pkg, "package.json"), "utf8"));
  for (const field of ["name", "license", "engines"]) {
    if (pkgJson[field] === undefined) failures.push(`packages/${pkg}: package.json missing ${field}`);
  }

  for await (const file of walk(join(root, "packages", pkg, "src"))) {
    const rel = file.slice(root.length + 1);
    const text = await readFile(file, "utf8");

    if (checkCrlf(text)) failures.push(`${rel}: CRLF line ending`);
    const lineCount = text.split("\n").length;
    if (!checkLineBudget(rel, lineCount)) {
      failures.push(`${rel}: line count ${lineCount} exceeds budget`);
    }
    if (/TODO|FIXME/.test(text)) failures.push(`${rel}: TODO/FIXME marker`);
    if (/console\.(log|debug)\(/.test(text) && !CONSOLE_ALLOWED.has(rel)) {
      failures.push(`${rel}: console.log in library code`);
    }
    if (/\.\.\/\.\.\//.test(text)) failures.push(`${rel}: import escapes package root`);
  }
}

// Action sources
for await (const file of walk(join(root, "action/src"))) {
  const rel = file.slice(root.length + 1);
  const text = await readFile(file, "utf8");
  if (checkCrlf(text)) failures.push(`${rel}: CRLF line ending`);
  if (/TODO|FIXME/.test(text)) failures.push(`${rel}: TODO marker`);
}

if (process.argv[1] && process.argv[1].endsWith("lint.mjs")) {
  if (failures.length > 0) {
    console.error("lint failures:\n" + failures.join("\n"));
    process.exit(1);
  }
  console.log("lint ok");
}
