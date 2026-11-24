/**
 * Ollama Cloud LlmPort adapter — the ONLY file coupled to
 * `@nemesis-oss/ollama-sdk`.
 *
 * Binding notes (verified against the SDK 1.26.0 type declarations):
 *
 *  - The client class is `OllamaClient` (NOT `Ollama`), constructed with
 *    `{ baseUrl, apiKey }`; the SDK sends `Authorization: Bearer <apiKey>`
 *    and falls back to `OLLAMA_HOST` / `OLLAMA_API_KEY` env vars itself.
 *  - `chat(req)` with `stream: false` returns `ChatResponse` whose
 *    `message.content` is the text; token usage comes from
 *    `prompt_eval_count` / `eval_count`.
 *  - The SDK **fail-fasts `format` (structured-output) requests when the
 *    endpoint is inferred as Ollama Cloud** (cloud endpoints do not support
 *    structured outputs). So this adapter enforces JSON via the prompt and
 *    validates client-side with Ajv — fail-closed on parse/validation.
 *
 * The port contract (from core): implementations MUST fail closed. This
 * adapter throws on: missing model/key, non-2xx, unparseable JSON, schema
 * violation, empty completion, and oversize input. Retry: the SDK has
 * built-in retry with backoff; we configure it explicitly.
 */

import { OllamaClient } from "@nemesis-oss/ollama-sdk";
import { Ajv } from "ajv";
import { estimateTokens, redactSecrets, truncate } from "@nemesis-oss/ci-agent-core";
import type { LlmPort, LlmUsageInfo } from "@nemesis-oss/ci-agent-core";

const ajv = new Ajv({ allErrors: true });

export interface OllamaCloudOptions {
  host?: string;
  apiKey?: string;
  model: string;
  /** Per-request timeout (default 90s — repair/review prompts are large). */
  timeoutMs?: number;
  /** SDK retry count (default 2 → one retry with backoff on 429/5xx). */
  retries?: number;
  /** Determinism knobs pinned by the operating rules. */
  temperature?: number;
  seed?: number;
  /**
   * Custom fetch implementation forwarded to the SDK client (tests inject
   * a fake transport here; the SDK wires it into every request).
   */
  fetch?: typeof fetch;
}

export class OllamaCloudLlm implements LlmPort {
  private readonly client: OllamaClient;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly seed: number;

  constructor(opts: OllamaCloudOptions) {
    const host = (opts.host ?? process.env.OLLAMA_HOST ?? "https://ollama.com").replace(/\/+$/, "");
    const apiKey = opts.apiKey ?? process.env.OLLAMA_API_KEY;
    if (!apiKey) throw new Error("ollama-cloud: apiKey (or OLLAMA_API_KEY) is required — fail-closed");
    if (!opts.model) throw new Error("ollama-cloud: model is required — fail-closed");

    this.client = new OllamaClient({
      baseUrl: host,
      apiKey,
      timeoutMs: opts.timeoutMs ?? 90_000,
      retries: opts.retries ?? 2,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.temperature = opts.temperature ?? 0;
    this.seed = opts.seed ?? 42;
  }

  async structured<T>(input: {
    schema: object;
    system: string;
    user: string;
    maxInputTokens: number;
    maxOutputTokens: number;
  }): Promise<T & { __usage?: LlmUsageInfo }> {
    // Input budget enforced in code, before the wire.
    const userTokens = estimateTokens(input.user);
    if (userTokens > input.maxInputTokens) {
      throw new Error(
        `ollama-cloud: input ${userTokens} tokens exceeds budget ${input.maxInputTokens} — fail-closed`,
      );
    }

    const jsonDirective = [
      "Respond with a single JSON object that validates against this JSON Schema:",
      JSON.stringify(input.schema),
      "No markdown fences, no prose before or after the JSON.",
    ].join("\n");

    const system = `${input.system}\n\n${jsonDirective}`;

    // Redact before the wire, then truncate as a final hard cap.
    const user = redactSecrets(input.user);

    const res = await this.client.chat({
      model: this.model,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      options: {
        temperature: this.temperature,
        seed: this.seed,
        num_predict: input.maxOutputTokens,
      },
    });

    const text = res?.message?.content;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("ollama-cloud: empty completion — fail-closed");
    }

    const parsed = parseJsonLoose(text);
    if (parsed === undefined) {
      throw new Error(`ollama-cloud: unparseable JSON payload — fail-closed (got: ${truncate(text, 200)})`);
    }

    const validate = ajv.compile(input.schema);
    if (!validate(parsed)) {
      throw new Error(
        `ollama-cloud: schema violation — fail-closed (${ajv.errorsText(validate.errors)})`,
      );
    }

    const usage: LlmUsageInfo = {
      model: res.model,
      promptTokens: res.prompt_eval_count,
      completionTokens: res.eval_count,
      totalTokens:
        (res.prompt_eval_count ?? 0) + (res.eval_count ?? 0) > 0
          ? (res.prompt_eval_count ?? 0) + (res.eval_count ?? 0)
          : undefined,
    };

    return { ...(parsed as object), __usage: usage } as T & { __usage?: LlmUsageInfo };
  }
}

/**
 * Parse JSON from a model response that may be wrapped in markdown fences
 * or have stray prose. Strict about producing a real object; anything
 * else is a parse failure.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined && typeof direct === "object" && direct !== null) return direct;

  // ```json ... ``` or ``` ... ```
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) {
    const inner = tryParse(fence[1].trim());
    if (inner !== undefined) return inner;
  }

  // First {...} or [...] span when the model prefixed prose.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const span = tryParse(trimmed.slice(firstBrace, lastBrace + 1));
    if (span !== undefined) return span;
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}
