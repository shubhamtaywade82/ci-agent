import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const chatText = vi.fn();
vi.mock("@nemesis-oss/ollama-sdk", () => ({
  OllamaClient: class {
    chatText = chatText;
  },
  OLLAMA_CLOUD_BASE_URL: "https://example.test",
  zodToJsonSchema: () => ({ type: "object" }),
  parseStructuredOutput: (text: string, schema: z.ZodType) => schema.parse(JSON.parse(text)),
}));
const { OllamaCloudAdapter } = await import("../src/ollama.js");
const request = {
  model: "m",
  system: "s",
  prompt: "p",
  schema: z.object({ ok: z.boolean() }),
  timeoutMs: 1000,
  maxOutputTokens: 10,
};

// Braces matter: a returned mock would be invoked by vitest as a teardown hook.
beforeEach(() => {
  chatText.mockReset();
});
describe("OllamaCloudAdapter", () => {
  it("requires an API key", () => {
    expect(() => new OllamaCloudAdapter("")).toThrow(/OLLAMA_API_KEY/);
  });
  it("returns parsed output on the first attempt", async () => {
    chatText.mockResolvedValueOnce('{"ok":true}');
    await expect(new OllamaCloudAdapter("k").generateStructured(request)).resolves.toEqual({ ok: true });
    expect(chatText).toHaveBeenCalledOnce();
  });
  it("retries once after malformed output", async () => {
    chatText.mockResolvedValueOnce("not json").mockResolvedValueOnce('{"ok":true}');
    await expect(new OllamaCloudAdapter("k").generateStructured(request)).resolves.toEqual({ ok: true });
    expect(chatText).toHaveBeenCalledTimes(2);
  });
  it("fails with context after exhausting attempts", async () => {
    chatText.mockRejectedValue(new Error("timeout"));
    await expect(new OllamaCloudAdapter("k").generateStructured(request)).rejects.toThrow(/after 2 attempts: timeout/);
    expect(chatText).toHaveBeenCalledTimes(2);
  });
});
