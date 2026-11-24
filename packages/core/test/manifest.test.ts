import { describe, it, expect } from "vitest";
import { parseManifest, DEFAULT_MANIFEST } from "../src/manifest.js";
import { parse as parseYaml } from "yaml";

const BASE = `
version: 1
enabled: true
modes:
  review:
    enabled: true
    autonomy: comment
    maxChunks: 4
  fix:
    enabled: true
    autonomy: draft-pr
    optInLabel: team:autofix
    maxAttempts: 3
    maxFiles: 2
    maxFileBytes: 40000
    minConfidence: high
`;

function parse(text: string) {
  return parseManifest(parseYaml(text));
}

describe("parseManifest", () => {
  it("parses a full manifest with overrides", () => {
    const m = parse(BASE);
    expect(m.version).toBe(1);
    expect(m.enabled).toBe(true);
    expect(m.modes.review.maxChunks).toBe(4);
    expect(m.modes.fix.optInLabel).toBe("team:autofix");
    expect(m.modes.fix.maxAttempts).toBe(3);
    expect(m.modes.fix.minConfidence).toBe("high");
    expect(m.modes.fix.autonomy).toBe("draft-pr");
  });

  it("fills defaults for omitted sections", () => {
    const m = parse("version: 1\n");
    expect(m.modes.review.maxChunks).toBe(DEFAULT_MANIFEST.modes.review.maxChunks);
    expect(m.modes.fix.maxAttempts).toBe(DEFAULT_MANIFEST.modes.fix.maxAttempts);
    expect(m.modes.scan.schedule).toBe("weekly");
    expect(m.policy.autoMerge).toBe(false);
    expect(m.audit.format).toBe("jsonl");
  });

  it("rejects unsupported versions", () => {
    expect(() => parse("version: 2\n")).toThrow(/unsupported version/);
  });

  it("rejects autoMerge=true — the agent never merges", () => {
    expect(() => parse(BASE + "policy:\n  autoMerge: true\n")).toThrow(/autoMerge/);
  });

  it("rejects proprietary data classification with cloud source sending", () => {
    expect(() =>
      parse(BASE + "dataPolicy:\n  classification: proprietary\n  sendSourceToCloud: true\n"),
    ).toThrow(/proprietary/);
  });

  it("accepts proprietary with sendSourceToCloud=false", () => {
    const m = parse(BASE + "dataPolicy:\n  classification: proprietary\n  sendSourceToCloud: false\n");
    expect(m.dataPolicy.classification).toBe("proprietary");
    expect(m.dataPolicy.sendSourceToCloud).toBe(false);
  });

  it("rejects invalid autonomy values", () => {
    expect(() => parse("version: 1\nmodes:\n  review:\n    autonomy: merge\n")).toThrow(/autonomy/);
  });

  it("rejects non-positive numeric budgets", () => {
    expect(() => parse("version: 1\nmodes:\n  review:\n    maxChunks: 0\n")).toThrow(/positive integer/);
    expect(() => parse("version: 1\nmodes:\n  review:\n    maxChunks: -2\n")).toThrow(/positive integer/);
  });

  it("rejects malformed verify commands", () => {
    expect(() => parse("version: 1\ntoolchain:\n  commands:\n    verify: npm test\n")).toThrow();
  });

  it("accepts explicit verify command arrays", () => {
    const m = parse("version: 1\ntoolchain:\n  commands:\n    verify:\n      - npm run typecheck\n      - npm test\n");
    expect(m.toolchain.commands.verify).toEqual(["npm run typecheck", "npm test"]);
  });

  it("rejects boolean fields set to strings", () => {
    expect(() => parse("version: 1\nmodes:\n  review:\n    enabled: 'yes'\n")).toThrow();
  });

  it("rejects a non-object root", () => {
    expect(() => parseManifest("just a string")).toThrow(/object/);
  });
});
