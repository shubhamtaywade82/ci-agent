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
 it("requires an explicit opt-in label",async()=>{
  const f=fixture(false);await expect(runAutofix({runId:"123",pr:3,repository:"org/repo",...f,config,model:"test"})).rejects.toThrow(/opt-in/);
 });
 it("rejects a stale PR head SHA",async()=>{
  const f=fixture(true,"moved");await expect(runAutofix({runId:"123",pr:3,repository:"org/repo",...f,config,model:"test"})).rejects.toThrow(/SHA changed/);
 });
});
