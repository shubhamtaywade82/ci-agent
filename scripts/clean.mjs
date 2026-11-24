#!/usr/bin/env node
/** Remove all build outputs. */

import { rm } from "node:fs/promises";

const targets = [
  "packages/core/dist",
  "packages/ollama-cloud/dist",
  "packages/github/dist",
  "packages/toolchains/dist",
  "packages/cli/dist",
  "packages/cli/dist-action",
  "action/dist",
];

for (const t of targets) {
  await rm(t, { recursive: true, force: true });
}
console.log("clean done");
