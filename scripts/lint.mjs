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

for (const pkg of ["core", "ollama-cloud", "github", "toolchains", "cli"]) {
  const pkgJson = JSON.parse(await readFile(join(root, "packages", pkg, "package.json"), "utf8"));
  for (const field of ["name", "license", "engines"]) {
    if (pkgJson[field] === undefined) failures.push(`packages/${pkg}: package.json missing ${field}`);
  }

  for await (const file of walk(join(root, "packages", pkg, "src"))) {
    const rel = file.slice(root.length + 1);
    const text = await readFile(file, "utf8");

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
  if (/TODO|FIXME/.test(text)) failures.push(`${rel}: TODO marker`);
}

if (failures.length > 0) {
  console.error("lint failures:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("lint ok");
