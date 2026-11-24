import { readFile } from "node:fs/promises";
import { validateExpectedHeadSha } from "./event-validation.js";
import { Octokit } from "@octokit/rest";
import { loadConfig } from "./config.js";
import { JsonlAuditStore } from "./audit.js";
import { OllamaCloudAdapter } from "./ollama.js";
import { GitHubRepoHost,GitHubActionsCiProvider,repositoryFromEnv } from "./github.js";
import { runReview } from "./review.js";
import { runAutofix } from "./autofix.js";
import { runImprovementScan } from "./scan.js";
import { collectEvidence } from "./workspace.js";
import type { LlmPort,StructuredOutputRequest } from "./types.js";

const mode=process.env.INPUT_MODE??"validate";
const config=await loadConfig(process.env.INPUT_CONFIG??".nemesis/ci-agent.yml");
if(!config.enabled){console.log("Nemesis CI Agent disabled by repository policy.");process.exit(0);}
if(mode==="validate"){console.log("Nemesis CI Agent configuration is valid.");process.exit(0);}
const {owner,repo,fullName}=repositoryFromEnv();
const token=process.env.INPUT_GITHUB_TOKEN||process.env.GITHUB_TOKEN;
if(!token)throw new Error("A scoped GitHub token is required.");
const octokit=new Octokit({auth:token});
const host=new GitHubRepoHost(octokit,owner,repo);
const audit=new JsonlAuditStore(config.audit.path);
let ollama:OllamaCloudAdapter|undefined;
const llm:LlmPort={
 async generateStructured<T>(request:StructuredOutputRequest<T>):Promise<T>{
  ollama??=new OllamaCloudAdapter();
  return ollama.generateStructured(request);
 }
};
function model(envName:string):string{return process.env[envName]??"";}
if(mode==="review"){
 const pr=Number(process.env.INPUT_PR_NUMBER||process.env.PR_NUMBER);
 if(!Number.isInteger(pr)||pr<1)throw new Error("PR_NUMBER is required.");
 let fork=false;
 if(process.env.GITHUB_EVENT_PATH){const payload=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,"utf8")) as {pull_request?:{head?:{repo?:{full_name?:string}}}};fork=(payload.pull_request?.head?.repo?.full_name??fullName)!==fullName;}
 const expectedHeadSha=validateExpectedHeadSha(process.env.GITHUB_EVENT_NAME,process.env.INPUT_EXPECTED_HEAD_SHA?.trim());
 const result=await runReview({pr,repository:fullName,repo:host,llm,audit,config,model:model(config.llm.reviewModelEnv),isFork:fork,...(expectedHeadSha?{expectedHeadSha}:{})});
 console.log("Review posted; actionable findings: "+result.findings.length);
}else if(mode==="fix"){
 const runId=process.env.INPUT_WORKFLOW_RUN_ID;const pr=Number(process.env.INPUT_PR_NUMBER);
 if(!runId||!Number.isInteger(pr)||pr<1)throw new Error("WORKFLOW_RUN_ID and PR_NUMBER are required.");
 const ci=new GitHubActionsCiProvider(octokit,owner,repo,token);
 const result=await runAutofix({runId,pr,repository:fullName,repo:host,ci,llm,audit,config,model:model(config.llm.fixModelEnv)});
 if(!result.applied)console.log("Autofix skipped: "+result.reasons.join("; "));
 else console.log("Draft fix PR created: "+result.pullRequestUrl);
}else if(mode==="scan"){
 const sha=process.env.GITHUB_SHA;if(!sha)throw new Error("GITHUB_SHA is required.");
 const evidence=await collectEvidence({config,repository:fullName,sha});
 const result=await runImprovementScan({evidence,repository:fullName,llm,repo:host,audit,config,model:model(config.llm.scanModelEnv)});
 console.log("Scan complete; priorities: "+result.priorities+"; issue created: "+result.created);
}else throw new Error("Unsupported agent mode: "+mode);
