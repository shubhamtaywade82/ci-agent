#!/usr/bin/env node
/**
 * Bundle the GitHub Action entrypoint into action/dist/index.js.
 *
 * The bundle is intentionally self-contained (esbuild, ESM, Node platform):
 * the Action must run on a clean runner with only the repo's
 * .github/workflows file referencing it — no npm install step in the
 * consumer's pipeline.
 */

import { build } from "esbuild";

const result = await build({
  entryPoints: ["action/src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: "action/dist/index.js",
  sourcemap: false,
  minify: true,
  legalComments: "none",
  packages: "bundle",
  banner: {
    js: [
      "import { createRequire } from 'node:module';",
      "const require = createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

if (result.errors.length > 0) {
  process.exit(1);
}
console.log("action bundled → action/dist/index.js");
