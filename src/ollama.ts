import { OllamaClient, OLLAMA_CLOUD_BASE_URL, parseStructuredOutput, zodToJsonSchema } from "@nemesis-oss/ollama-sdk";
import type { ZodType } from "zod";
import type { LlmPort, StructuredOutputRequest } from "./types.js";

const MAX_ATTEMPTS = 2;

export class OllamaCloudAdapter implements LlmPort {
  private readonly client: OllamaClient;
  constructor(
    apiKey = process.env.OLLAMA_API_KEY,
    private readonly defaultTimeoutMs = 90000,
  ) {
    if (!apiKey) throw new Error("OLLAMA_API_KEY is required for Ollama Cloud.");
    this.client = new OllamaClient({ baseUrl: OLLAMA_CLOUD_BASE_URL, apiKey, timeoutMs: defaultTimeoutMs });
  }

  // Hosted models intermittently return malformed JSON or time out; one retry is cheaper than a failed CI run.
  async generateStructured<T>(request: StructuredOutputRequest<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.attempt(request);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      "Ollama structured output failed after " +
        MAX_ATTEMPTS +
        " attempts: " +
        (lastError instanceof Error ? lastError.message : String(lastError)),
      { cause: lastError },
    );
  }

  private async attempt<T>(request: StructuredOutputRequest<T>): Promise<T> {
    const schema = zodToJsonSchema(request.schema as ZodType<T>);
    const output = await this.client.chatText({
      model: request.model,
      timeoutMs: request.timeoutMs || this.defaultTimeoutMs,
      messages: [
        { role: "system", content: request.system },
        {
          role: "user",
          content:
            request.prompt +
            "\n\nReturn one JSON object matching this JSON Schema. Do not include markdown fences.\n" +
            JSON.stringify(schema),
        },
      ],
      options: { num_predict: request.maxOutputTokens },
    });
    return parseStructuredOutput(output, request.schema);
  }
}
