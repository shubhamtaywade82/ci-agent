/**
 * OllamaCloudLlm tests — fully offline: the SDK client is injected via the
 * fetch implementation (the SDK constructor accepts `fetch`), so no real
 * HTTP happens. Asserts the fail-closed contract and the verified binding
 * surface (Bearer auth, temperature/seed determinism knobs, JSON-in-prompt).
 */

import { describe, it, expect, vi } from "vitest";
import { OllamaCloudLlm, parseJsonLoose } from "../src/index.js";

const SCHEMA = {
  type: "object",
  properties: { verdict: { enum: ["approve", "veto"] }, reason: { type: "string" } },
  required: ["verdict", "reason"],
  additionalProperties: false,
};

function chatResponse(content: string) {
  return {
    model: "beam",
    created_at: "2026-11-24T00:00:00Z",
    message: { role: "assistant", content },
    done: true,
    prompt_eval_count: 120,
    eval_count: 8,
  };
}

function makeLlm(over: Record<string, unknown> = {}) {
  const chat = vi.fn(async (req: Record<string, unknown>) => chatResponse(JSON.stringify({ verdict: "approve", reason: "ci-smoke" })));
  // The SDK client takes a `fetch` implementation; we stub the transport by
  // monkey-patching the client's chat method via a fake fetch that returns
  // the canned JSON body. Simplest reliable seam: fake fetch.
  const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    chat(init);
    const body = JSON.stringify(chatResponse(JSON.stringify({ verdict: "approve", reason: "ci-smoke" })));
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  });
  const llm = new OllamaCloudLlm({
    host: "https://ollama.example.invalid",
    apiKey: "test-key",
    model: "beam",
    fetch: fakeFetch,
    ...over,
  } as never);
  return { llm, fakeFetch, chat };
}

describe("OllamaCloudLlm", () => {
  it("fails closed without an api key", () => {
    expect(() => new OllamaCloudLlm({ model: "beam" as string })).toThrow(/apiKey|api key/i);
  });

  it("fails closed without a model", () => {
    expect(
      () => new OllamaCloudLlm({ apiKey: "k", model: "" }),
    ).toThrow(/model/i);
  });

  it("sends Bearer auth and JSON-schema directive in the prompt", async () => {
    const { llm, fakeFetch } = makeLlm();
    await llm.structured({
      schema: SCHEMA,
      system: "be terse",
      user: "say approve",
      maxInputTokens: 500,
      maxOutputTokens: 100,
    });
    expect(fakeFetch).toHaveBeenCalled();
    const init = fakeFetch.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(init.body as string) as {
      model: string;
      stream: boolean;
      messages: { role: string; content: string }[];
      options: { temperature: number; seed: number };
    };
    expect(body.model).toBe("beam");
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(0);
    expect(body.options.seed).toBe(42);
    expect(body.messages[0]!.content).toContain("JSON Schema");
    expect(body.messages[1]!.content).toBe("say approve");
  });

  it("validates output against the schema and returns usage", async () => {
    const { llm } = makeLlm();
    const out = await llm.structured<{ verdict: string; reason: string }>({
      schema: SCHEMA,
      system: "s",
      user: "u",
      maxInputTokens: 500,
      maxOutputTokens: 100,
    });
    expect(out.verdict).toBe("approve");
    expect(out.__usage?.model).toBe("beam");
    expect(out.__usage?.promptTokens).toBe(120);
    expect(out.__usage?.totalTokens).toBe(128);
  });

  it("fails closed on schema-violating output", async () => {
    const fakeFetch = vi.fn(async () => {
      const body = JSON.stringify(chatResponse(JSON.stringify({ verdict: "maybe" })));
      return new Response(body, { status: 200 });
    });
    const llm = new OllamaCloudLlm({
      host: "https://ollama.example.invalid",
      apiKey: "k",
      model: "beam",
      fetch: fakeFetch,
    } as never);
    await expect(
      llm.structured({
        schema: SCHEMA,
        system: "s",
        user: "u",
        maxInputTokens: 500,
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow(/schema violation/);
  });

  it("fails closed on unparseable output", async () => {
    const fakeFetch = vi.fn(async () => {
      const body = JSON.stringify(chatResponse("<not json at all>"));
      return new Response(body, { status: 200 });
    });
    const llm = new OllamaCloudLlm({
      host: "https://ollama.example.invalid",
      apiKey: "k",
      model: "beam",
      fetch: fakeFetch,
    } as never);
    await expect(
      llm.structured({
        schema: SCHEMA,
        system: "s",
        user: "u",
        maxInputTokens: 500,
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow(/unparseable/);
  });

  it("fails closed on empty completion", async () => {
    const fakeFetch = vi.fn(async () => {
      const body = JSON.stringify(chatResponse("   "));
      return new Response(body, { status: 200 });
    });
    const llm = new OllamaCloudLlm({
      host: "https://ollama.example.invalid",
      apiKey: "k",
      model: "beam",
      fetch: fakeFetch,
    } as never);
    await expect(
      llm.structured({
        schema: SCHEMA,
        system: "s",
        user: "u",
        maxInputTokens: 500,
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow(/empty completion/);
  });

  it("enforces the input token budget before the wire", async () => {
    const { llm } = makeLlm();
    await expect(
      llm.structured({
        schema: SCHEMA,
        system: "s",
        user: "x".repeat(4 * 600),
        maxInputTokens: 500,
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow(/exceeds budget/);
  });

  it("redacts secrets before sending", async () => {
    const fakeFetch = vi.fn(async () => {
      const body = JSON.stringify(chatResponse(JSON.stringify({ verdict: "approve", reason: "ok" })));
      return new Response(body, { status: 200 });
    });
    const llm = new OllamaCloudLlm({
      host: "https://ollama.example.invalid",
      apiKey: "k",
      model: "beam",
      fetch: fakeFetch,
    } as never);
    await llm.structured({
      schema: SCHEMA,
      system: "s",
      user: "log line: Bearer abcdef12345678901234 then failure",
      maxInputTokens: 500,
      maxOutputTokens: 100,
    });
    const init = fakeFetch.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
    expect(body.messages[1]!.content).toContain("[REDACTED]");
  });
});

describe("parseJsonLoose", () => {
  it("parses plain JSON objects", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses fenced JSON", () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("parses JSON with leading prose", () => {
    expect(parseJsonLoose('Sure! {"a":1} hope that helps')).toEqual({ a: 1 });
  });
  it("returns undefined for garbage", () => {
    expect(parseJsonLoose("no json here")).toBeUndefined();
    expect(parseJsonLoose("")).toBeUndefined();
  });
});
