import { describe,it,expect,vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { runImprovementScan } from "../src/scan.js";
import type { AuditStore,LlmPort,RepoHost } from "../src/types.js";
describe("improvement scan",()=>{
 it("keeps only evidence-backed recommendations and creates an issue",async()=>{
  const repo:RepoHost={getPullRequest:vi.fn(),getDiff:vi.fn(),postComment:vi.fn(),findOpenIssueByMarker:vi.fn().mockResolvedValue(false),createIssue:vi.fn(),findExistingAgentFix:vi.fn().mockResolvedValue({pullRequestUrl:null,branchExists:false}),createDraftPullRequest:vi.fn()};
  const llm:LlmPort={generateStructured:vi.fn().mockResolvedValue({summary:"improve",priorities:[
   {title:"real",severity:"medium",evidenceRefs:["e1"],recommendation:"add coverage"},
   {title:"invented",severity:"high",evidenceRefs:["missing"],recommendation:"unknown"}
  ]})};
  const evidence={repository:"org/repo",sha:"abc",profile:{languages:["typescript"],packageManagers:["npm"],frameworks:[],rootFiles:[],monorepo:false},findings:[{id:"e1",source:"test" as const,severity:"medium" as const,fingerprint:"fingerprint-1",message:"coverage gap",evidenceRefs:[]}],metrics:{}};
  const result=await runImprovementScan({evidence,repository:"org/repo",llm,repo,audit:{append:vi.fn()},config:parseConfig({version:1,dataPolicy:{classification:"public"}}),model:"test"});
  expect(result.priorities).toBe(1);expect(repo.createIssue).toHaveBeenCalledOnce();
 });
 it("does not call the model for empty evidence even when no model is configured",async()=>{
  const llm:LlmPort={generateStructured:vi.fn()};
  const repo:RepoHost={getPullRequest:vi.fn(),getDiff:vi.fn(),postComment:vi.fn(),findOpenIssueByMarker:vi.fn(),createIssue:vi.fn(),findExistingAgentFix:vi.fn().mockResolvedValue({pullRequestUrl:null,branchExists:false}),createDraftPullRequest:vi.fn()};
  const evidence={repository:"org/repo",sha:"abc",profile:{languages:[],packageManagers:[],frameworks:[],rootFiles:[],monorepo:false},findings:[],metrics:{}};
  const result=await runImprovementScan({evidence,repository:"org/repo",llm,repo,audit:{append:vi.fn()},config:parseConfig({version:1}),model:""});
  expect(result.priorities).toBe(0);expect(llm.generateStructured).not.toHaveBeenCalled();
 });
 it("blocks non-public source evidence when cloud sharing is not approved",async()=>{
  const llm:LlmPort={generateStructured:vi.fn()};
  const repo:RepoHost={getPullRequest:vi.fn(),getDiff:vi.fn(),postComment:vi.fn(),findOpenIssueByMarker:vi.fn(),createIssue:vi.fn(),findExistingAgentFix:vi.fn().mockResolvedValue({pullRequestUrl:null,branchExists:false}),createDraftPullRequest:vi.fn()};
  const evidence={repository:"org/repo",sha:"abc",profile:{languages:[],packageManagers:[],frameworks:[],rootFiles:[],monorepo:false},findings:[{id:"e1",source:"test" as const,severity:"medium" as const,fingerprint:"fingerprint-1",message:"source evidence",path:"src/a.ts",evidenceRefs:[]}],metrics:{}};
  await expect(runImprovementScan({evidence,repository:"org/repo",llm,repo,audit:{append:vi.fn()},config:parseConfig({version:1}),model:"test"})).rejects.toThrow(/dataPolicy/);
  expect(llm.generateStructured).not.toHaveBeenCalled();
 });
});
