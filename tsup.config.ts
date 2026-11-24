import { defineConfig } from "tsup";
export default defineConfig({ entry: ["src/index.ts", "src/cli.ts", "src/action.ts"], format: ["esm"], platform: "node", target: "node24", outDir: "dist", clean: true, splitting: false, sourcemap: true, dts: true, treeshake: true });
