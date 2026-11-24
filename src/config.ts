import { readFile } from "node:fs/promises";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";

const strings = z.array(z.string().min(1));
export const AgentConfigSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean().default(true),
  project: z.object({ name: z.string().default("auto"), type: z.string().default("auto") }).strict().default({}),
  toolchain: z.object({ adapter: z.string().default("auto"), commands: z.record(z.string(), z.array(z.string().min(1)).min(1)).default({}) }).strict().default({}),
  modes: z.object({
    review: z.object({ enabled: z.boolean().default(true), autonomy: z.enum(["disabled","comment"]).default("comment"), maxChunks: z.number().int().min(1).max(20).default(6), maxInputChars: z.number().int().min(1000).max(200000).default(90000) }).strict().default({}),
    fix: z.object({ enabled: z.boolean().default(false), autonomy: z.enum(["disabled","draft-pr"]).default("disabled"), optInLabel: z.string().min(1).default("nemesis:autofix"), maxAttempts: z.number().int().min(1).max(3).default(1), maxFiles: z.number().int().min(1).max(10).default(5), maxFileBytes: z.number().int().min(1).max(100000).default(60000) }).strict().default({}),
    scan: z.object({ enabled: z.boolean().default(true), autonomy: z.enum(["disabled","issue"]).default("issue"), maxFindings: z.number().int().min(1).max(50).default(20) }).strict().default({})
  }).strict().default({}),
  policy: z.object({ autoMerge: z.literal(false).default(false), requireHumanApproval: z.literal(true).default(true), allowPaths: strings.default(["src/**","test/**","tests/**","docs/**"]), denyPaths: strings.default([".github/**","**/*.lock","**/package-lock.json","**/pnpm-lock.yaml","**/yarn.lock","**/.env*","**/*secret*","**/credentials*","**/migrations/**","**/vendor/**"]) }).strict().default({}),
  dataPolicy: z.object({ classification: z.enum(["public","internal","proprietary"]).default("internal"), sendSourceToCloud: z.boolean().default(false), redactPaths: strings.default(["**/.env*","**/*secret*","**/credentials*"]) }).strict().default({}),
  llm: z.object({ provider: z.literal("ollama-cloud").default("ollama-cloud"), reviewModelEnv: z.string().min(1).default("OLLAMA_MODEL_REVIEW"), fixModelEnv: z.string().min(1).default("OLLAMA_MODEL_FIX"), scanModelEnv: z.string().min(1).default("OLLAMA_MODEL_SCAN"), timeoutMs: z.number().int().min(1000).max(300000).default(90000) }).strict().default({}),
  audit: z.object({ path: z.string().min(1).default(".nemesis/audit.jsonl"), uploadArtifact: z.boolean().default(true) }).strict().default({})
}).strict();
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export function parseConfig(value: unknown): AgentConfig { return AgentConfigSchema.parse(value); }
export async function loadConfig(path = ".nemesis/ci-agent.yml"): Promise<AgentConfig> { return parseConfig(parseYaml(await readFile(path,"utf8"),{json:false})); }
