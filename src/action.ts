import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Octokit } from "@octokit/rest";
import { assertCommenterCanReview, validateExpectedHeadSha } from "./event-validation.js";
import { loadConfig, type AgentConfig } from "./config.js";
import { JsonlAuditStore } from "./audit.js";
import { OllamaCloudAdapter } from "./ollama.js";
import { GitHubRepoHost, GitHubActionsCiProvider, repositoryFromEnv } from "./github.js";
import { runReview } from "./review.js";
import { runAutofix } from "./autofix.js";
import { runImprovementScan } from "./scan.js";
import { collectEvidence } from "./workspace.js";
import type { LlmPort, StructuredOutputRequest } from "./types.js";

const AGENT_MODES = ["review", "fix", "scan"];

type Context = {
  env: NodeJS.ProcessEnv;
  config: AgentConfig;
  octokit: Octokit;
  host: GitHubRepoHost;
  llm: LlmPort;
  audit: JsonlAuditStore;
  token: string;
  owner: string;
  repo: string;
  fullName: string;
};

function parsePrNumber(value: string | undefined, message: string): number {
  const pr = Number(value);
  if (!Number.isInteger(pr) || pr < 1) throw new Error(message);
  return pr;
}

function createContext(env: NodeJS.ProcessEnv, config: AgentConfig): Context {
  const { owner, repo, fullName } = repositoryFromEnv(env);
  const token = env.INPUT_GITHUB_TOKEN || env.GITHUB_TOKEN;
  if (!token) throw new Error("A scoped GitHub token is required.");
  const octokit = new Octokit({ auth: token });
  let ollama: OllamaCloudAdapter | undefined;
  // Lazy so modes that never call the model do not require OLLAMA_API_KEY.
  const llm: LlmPort = {
    async generateStructured<T>(request: StructuredOutputRequest<T>): Promise<T> {
      ollama ??= new OllamaCloudAdapter();
      return ollama.generateStructured(request);
    },
  };
  const host = new GitHubRepoHost(octokit, owner, repo);
  return {
    env,
    config,
    octokit,
    host,
    llm,
    audit: new JsonlAuditStore(config.audit.path),
    token,
    owner,
    repo,
    fullName,
  };
}

async function readCommenterLogin(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!env.GITHUB_EVENT_PATH) return undefined;
  const payload = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as {
    comment?: { user?: { login?: string } };
  };
  return payload.comment?.user?.login;
}

async function reviewMode(ctx: Context): Promise<void> {
  const { env, config, host } = ctx;
  const pr = parsePrNumber(env.INPUT_PR_NUMBER || env.PR_NUMBER, "PR_NUMBER is required.");
  await assertCommenterCanReview(env.GITHUB_EVENT_NAME, await readCommenterLogin(env), (login) =>
    host.getCollaboratorPermission(login),
  );
  const expectedHeadSha = validateExpectedHeadSha(env.GITHUB_EVENT_NAME, env.INPUT_EXPECTED_HEAD_SHA?.trim());
  const result = await runReview({
    pr,
    repository: ctx.fullName,
    repo: host,
    llm: ctx.llm,
    audit: ctx.audit,
    config,
    model: env[config.llm.reviewModelEnv] ?? "",
    ...(expectedHeadSha ? { expectedHeadSha } : {}),
  });
  console.log("Review posted; actionable findings: " + result.findings.length);
}

async function fixMode(ctx: Context): Promise<void> {
  const { env, config } = ctx;
  const runId = env.INPUT_WORKFLOW_RUN_ID;
  if (!runId) throw new Error("WORKFLOW_RUN_ID and PR_NUMBER are required.");
  const pr = parsePrNumber(env.INPUT_PR_NUMBER, "WORKFLOW_RUN_ID and PR_NUMBER are required.");
  const result = await runAutofix({
    runId,
    pr,
    repository: ctx.fullName,
    repo: ctx.host,
    ci: new GitHubActionsCiProvider(ctx.octokit, ctx.owner, ctx.repo, ctx.token),
    llm: ctx.llm,
    audit: ctx.audit,
    config,
    model: env[config.llm.fixModelEnv] ?? "",
  });
  console.log(
    result.applied ? "Draft fix PR created: " + result.pullRequestUrl : "Autofix skipped: " + result.reasons.join("; "),
  );
}

async function scanMode(ctx: Context): Promise<void> {
  const { env, config } = ctx;
  const sha = env.GITHUB_SHA;
  if (!sha) throw new Error("GITHUB_SHA is required.");
  const evidence = await collectEvidence({ config, repository: ctx.fullName, sha });
  const result = await runImprovementScan({
    evidence,
    repository: ctx.fullName,
    llm: ctx.llm,
    repo: ctx.host,
    audit: ctx.audit,
    config,
    model: env[config.llm.scanModelEnv] ?? "",
  });
  console.log("Scan complete; priorities: " + result.priorities + "; issue created: " + result.created);
}

const HANDLERS: Record<string, (ctx: Context) => Promise<void>> = { review: reviewMode, fix: fixMode, scan: scanMode };

/** Entry point for the composite action; reads all inputs from env so tests can drive it. */
export async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const mode = env.INPUT_MODE ?? "validate";
  const config = await loadConfig(env.INPUT_CONFIG ?? ".nemesis/ci-agent.yml");
  if (!config.enabled) return console.log("Nemesis CI Agent disabled by repository policy.");
  if (mode === "validate") return console.log("Nemesis CI Agent configuration is valid.");
  if (!AGENT_MODES.includes(mode)) throw new Error("Unsupported agent mode: " + mode);
  await HANDLERS[mode]!(createContext(env, config));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
