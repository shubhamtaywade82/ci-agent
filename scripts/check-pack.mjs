#!/usr/bin/env node
/**
 * Release gate: every workspace tarball must contain its built output and
 * docs, and must not ship sources, tests, tsconfig or build-info files.
 * Runs `npm pack --dry-run`, so nothing is written or published.
 */

import { execFileSync } from "node:child_process";

const REQUIRED = ["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE", "package.json"];
const FORBIDDEN = [/^src\//, /^test\//, /tsconfig/, /\.tsbuildinfo$/];

const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--workspaces"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});

const failures = [];
for (const pkg of JSON.parse(raw)) {
  const paths = pkg.files.map((f) => f.path);
  for (const required of REQUIRED) {
    if (!paths.includes(required)) failures.push(`${pkg.name}: missing ${required}`);
  }
  for (const path of paths) {
    if (FORBIDDEN.some((re) => re.test(path))) failures.push(`${pkg.name}: must not ship ${path}`);
  }
  console.log(`${pkg.name}@${pkg.version}: ${paths.length} files, ${pkg.size} bytes`);
}

if (failures.length > 0) {
  for (const f of failures) console.error(`pack check failed: ${f}`);
  process.exit(1);
}
console.log("pack check ok");
