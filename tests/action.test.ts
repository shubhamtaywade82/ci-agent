import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/action.js";

async function configFile(yaml: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "action-")), "ci-agent.yml");
  await writeFile(path, yaml);
  return path;
}

afterEach(() => vi.restoreAllMocks());

describe("action entry point", () => {
  it("validates configuration without touching GitHub", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main({ INPUT_MODE: "validate", INPUT_CONFIG: await configFile("version: 1\n") });
    expect(log).toHaveBeenCalledWith("Nemesis CI Agent configuration is valid.");
  });

  it("exits quietly when disabled by repository policy", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main({ INPUT_MODE: "review", INPUT_CONFIG: await configFile("version: 1\nenabled: false\n") });
    expect(log).toHaveBeenCalledWith("Nemesis CI Agent disabled by repository policy.");
  });

  it("rejects unsupported modes before requiring credentials", async () => {
    const INPUT_CONFIG = await configFile("version: 1\n");
    await expect(main({ INPUT_MODE: "deploy", INPUT_CONFIG })).rejects.toThrow(/Unsupported agent mode: deploy/);
  });

  it("requires a scoped token for agent modes", async () => {
    const INPUT_CONFIG = await configFile("version: 1\n");
    await expect(main({ INPUT_MODE: "review", INPUT_CONFIG, GITHUB_REPOSITORY: "o/r" })).rejects.toThrow(/token/);
  });

  it("requires a PR number for review and a run id for fix before any network call", async () => {
    const INPUT_CONFIG = await configFile("version: 1\n");
    const base = { INPUT_CONFIG, GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t" };
    await expect(main({ ...base, INPUT_MODE: "review" })).rejects.toThrow(/PR_NUMBER/);
    await expect(main({ ...base, INPUT_MODE: "fix" })).rejects.toThrow(/WORKFLOW_RUN_ID/);
    await expect(main({ ...base, INPUT_MODE: "scan" })).rejects.toThrow(/GITHUB_SHA/);
  });
});
