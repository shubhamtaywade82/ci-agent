import { OllamaClient,OLLAMA_CLOUD_BASE_URL,parseStructuredOutput,zodToJsonSchema } from "@nemesis-oss/ollama-sdk";
import type { ZodType } from "zod";
import type { LlmPort,StructuredOutputRequest } from "./types.js";
export class OllamaCloudAdapter implements LlmPort {
 private readonly client:OllamaClient;
 constructor(apiKey=process.env.OLLAMA_API_KEY,private readonly defaultTimeoutMs=90000){
  if(!apiKey)throw new Error("OLLAMA_API_KEY is required for Ollama Cloud.");
  this.client=new OllamaClient({baseUrl:OLLAMA_CLOUD_BASE_URL,apiKey,timeoutMs:defaultTimeoutMs});
 }
 async generateStructured<T>(request:StructuredOutputRequest<T>):Promise<T>{
  const schema=zodToJsonSchema(request.schema as ZodType<T>);
  const output=await this.client.chatText({
   model:request.model,
   timeoutMs:request.timeoutMs||this.defaultTimeoutMs,
   messages:[
    {role:"system",content:request.system},
    {role:"user",content:request.prompt+"\n\nReturn one JSON object matching this JSON Schema. Do not include markdown fences.\n"+JSON.stringify(schema)}
   ],
   options:{num_predict:request.maxOutputTokens}
  });
  return parseStructuredOutput(output,request.schema);
 }
}
