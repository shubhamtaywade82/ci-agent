import { describe,it,expect,vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { runAutofix } from "../src/autofix.js";
import type { AuditStore,CiProvider,LlmPort,RepoHost } from "../src/types.js";
function fixture(label=true,headSha="abc"):{repo:RepoHost;ci:CiProvider;llm:LlmPort;audit:AuditStore}{
 const repo:RepoHost={getPullRequest:vi.fn().mockResolvedValue({number:3,title:"fail",body:null,headSha,headBranch:"feature",headRepoFullName:"org/repo",baseBranch:"main",draft:false,labels:label?["nemesis:autofix"]:[]}),getDiff:vi.fn(),postComment:vi.fn(),findOpenIssueByMarker:vi.fn(),createIssue:vi.fn(),createDraftPullRequest:vi.fn().mockResolvedValue({url:"https://example.test/pr/4"})};
 const ci:CiProvider={getWorkflowRun:vi.fn().mockResolvedValue({id:"123",repository:"org/repo",conclusion:"failure",sha:"abc",branch:"feature",attempt:1,pullRequest:3,headRepoFullName:"org/repo"}),getFailedLogs:vi.fn().mockResolvedValue("test failed")};
 const llm:LlmPort={generateStructured:vi.fn().mockResolvedValue({diagnosis:"repair",confidence:"high",risk:"low",rationale:"small",expectedValidation:["npm test"],files:[{path:"src/a.ts",content:"fixed"}]})};
 return {repo,ci,llm,audit:{append:vi.fn()}};
}
describe("autofix guardrails",()=>{
 const config=parseConfig({version:1,modes:{fix:{enabled:true,autonomy:"draft-pr"}},dataPolicy:{classification:"public"}});
 it("creates a draft PR only when all guards pass",async()=>{
  const f=fixture();const result=await runAutofix({runId:"123",pr:3,repository:"org/repo",...f,config,model:"test"});
  expect(result.applied).toBe(true);expect(f.repo.createDraftPullRequest).toHaveBeenCalledOnce();
 });
 it("skips without calling the model when explicit opt-in label is missing",async()=>{
  const f=fixture(false);const result=await runAutofix({runId:"123",pr:3,repository:"org/repo",...f,config,model:""});
  expect(result.applied).toBe(false);expect(result.reasons.join(" ")).toMatch(/opt-in/);
  expect(f.llm.generateStructured).not.toHaveBeenCalled();expect(f.repo.createDraftPullRequest).not.toHaveBeenCalled();
 });
 it("skips stale PR head SHA without calling the model",async()=>{
  const f=fixture(true,"moved");const result=await runAutofix({runId:"123",pr:3,repository:"org/repo",...f,config,model:"test"});
  expect(result.applied).toBe(false);expect(result.reasons.join(" ")).toMatch(/SHA changed/);
  expect(f.llm.generateStructured).not.toHaveBeenCalled();
 });
 it("skips source transmission when repository policy has not approved cloud sharing",async()=>{
  const f=fixture();const result=await runAutofix({runId:"123",pr:3,repository:"org/repo",...f,config:parseConfig({version:1,modes:{fix:{enabled:true,autonomy:"draft-pr"}}}),model:""});
  expect(result.applied).toBe(false);expect(result.reasons.join(" ")).toMatch(/dataPolicy/);
  expect(f.llm.generateStructured).not.toHaveBeenCalled();
 });
});
