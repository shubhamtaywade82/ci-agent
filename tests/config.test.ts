import { describe, it, expect } from "vitest";
import { parseConfig } from "../src/config.js";
describe("configuration contract", () => {
  it("defaults source transmission to disabled", () => {
    expect(parseConfig({ version: 1 }).dataPolicy.sendSourceToCloud).toBe(false);
  });
  it("cannot enable automatic merge", () => {
    expect(() => parseConfig({ version: 1, policy: { autoMerge: true } })).toThrow();
  });
  it("rejects unknown properties", () => {
    expect(() => parseConfig({ version: 1, unexpected: true })).toThrow();
  });
  it("rejects unsupported schema versions", () => {
    expect(() => parseConfig({ version: 2 })).toThrow();
  });
});
