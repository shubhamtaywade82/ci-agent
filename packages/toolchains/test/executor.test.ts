import { describe, it, expect } from "vitest";
import { runCommand, redactCommandOutput } from "../src/executor.js";

describe("runCommand (ported)", () => {
  it("executes without a shell and captures output", async () => {
    const out = await runCommand(["node", "-e", "console.log('hello')"], process.cwd(), 10_000);
    expect(out.code).toBe(0);
    expect(out.output).toContain("hello");
  });

  it("reports non-zero exit codes", async () => {
    const out = await runCommand(["node", "-e", "process.exit(3)"], process.cwd(), 10_000);
    expect(out.code).toBe(3);
  });

  it("times out with exit code 124 and a marker", async () => {
    const out = await runCommand(["node", "-e", "setTimeout(()=>{}, 60000)"], process.cwd(), 200);
    expect(out.code).toBe(124);
    expect(out.output).toContain("timed out");
  });

  it("does not inherit credentials into the child environment", async () => {
    process.env.FAKE_SECRET = "super-secret-value";
    try {
      const out = await runCommand(
        ["node", "-e", "console.log(typeof process.env.FAKE_SECRET)"],
        process.cwd(),
        10_000,
      );
      expect(out.output).toContain("undefined");
    } finally {
      delete process.env.FAKE_SECRET;
    }
  });

  it("forwards only explicitly passed env vars", async () => {
    process.env.CI_AGENT_TEST_VAR = "forwarded-value";
    try {
      const out = await runCommand(
        ["node", "-e", "console.log(process.env.CI_AGENT_TEST_VAR ?? 'missing')"],
        process.cwd(),
        10_000,
        ["CI_AGENT_TEST_VAR"],
      );
      expect(out.output).toContain("forwarded-value");
    } finally {
      delete process.env.CI_AGENT_TEST_VAR;
    }
  });

  it("rejects when the executable cannot be spawned", async () => {
    await expect(
      runCommand(["definitely-not-a-real-binary-xyz"], process.cwd(), 5_000),
    ).rejects.toThrow();
  });
});

describe("redactCommandOutput (ported)", () => {
  it("redacts forwarded env values wherever they appear", () => {
    process.env.CI_AGENT_TEST_VAR = "Zx9private-blob-Qq7";
    try {
      const out = redactCommandOutput("used Zx9private-blob-Qq7 in output", ["CI_AGENT_TEST_VAR"]);
      expect(out).toContain("[REDACTED_ENV:CI_AGENT_TEST_VAR]");
      expect(out).not.toContain("Zx9private-blob-Qq7");
    } finally {
      delete process.env.CI_AGENT_TEST_VAR;
    }
  });

  it("redacts key-shaped values with the generic marker", () => {
    const out = redactCommandOutput("token=super-secret-value end");
    expect(out).toBe("token=[REDACTED] end");
  });

  it("redacts github token shapes", () => {
    expect(redactCommandOutput("ghp_0123456789abcdefghij0123456789")).not.toContain("ghp_0123");
  });

  it("redacts bearer headers", () => {
    const out = redactCommandOutput("Authorization: Bearer abcdef1234567890");
    expect(out).toContain("[REDACTED]");
  });
});
