import { describe,it,expect,vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { runReview } from "../src/review.js";
import type { AuditStore,LlmPort,RepoHost } from "../src/types.js";
function fixture(draft=false):RepoHost{return {
 getPullRequest:vi.fn().mockResolvedValue({number:2,title:"change",body:null,headSha:"abc",headBranch:"feature",headRepoFullName:"org/repo",baseBranch:"main",draft,labels:[]}),
 getDiff:vi.fn().mockResolvedValue([{path:"src/a.ts",patch:"@@ -1 +1 @@\n-old\n+new"},{path:".github/workflows/ci.yml",patch:"secret"}]),
 postComment:vi.fn(),findOpenIssueByMarker:vi.fn(),createIssue:vi.fn(),createDraftPullRequest:vi.fn()
};}
describe("review agent",()=>{
 it("posts only changed-file findings and filters protected diff paths",async()=>{
  const repo=fixture();
  const llm:LlmPort={generateStructured:vi.fn().mockResolvedValue({summary:"reviewed",findings:[
   {id:"1",source:"test",severity:"high",fingerprint:"fingerprint-1",message:"bug introduced",evidenceRefs:[],path:"src/a.ts",line:1},
   {id:"2",source:"test",severity:"high",fingerprint:"fingerprint-2",message:"not in diff",evidenceRefs:[],path:"other.ts"}
  ]})};
  const result=await runReview({pr:2,repository:"org/repo",repo,llm,audit:{append:vi.fn()},config:parseConfig({version:1,dataPolicy:{classification:"public"}}),model:"test"});
  expect(result.findings).toHaveLength(1);expect(repo.postComment).toHaveBeenCalledOnce();
  expect(String(vi.mocked(repo.postComment).mock.calls[0]?.[1])).not.toContain(".github/workflows/ci.yml");
 });
 it("refuses draft PRs",async()=>{
  await expect(runReview({pr:2,repository:"org/repo",repo:fixture(true),llm:{generateStructured:vi.fn()},audit:{append:vi.fn()},config:parseConfig({version:1,dataPolicy:{classification:"public"}}),model:"test"})).rejects.toThrow(/Draft/);
 });
 it("refuses fork-originated runs before sending source to the model",async()=>{
  const llm:LlmPort={generateStructured:vi.fn()};
  await expect(runReview({pr:2,repository:"org/repo",repo:fixture(),llm,audit:{append:vi.fn()},config:parseConfig({version:1,dataPolicy:{classification:"public"}}),model:"test",isFork:true})).rejects.toThrow(/fork/);
  expect(llm.generateStructured).not.toHaveBeenCalled();
 });
 it("refuses stale repository-dispatch events before calling the model",async()=>{
  const llm:LlmPort={generateStructured:vi.fn()};
  await expect(runReview({pr:2,repository:"org/repo",repo:fixture(),llm,audit:{append:vi.fn()},config:parseConfig({version:1,dataPolicy:{classification:"public"}}),model:"test",expectedHeadSha:"stale-sha"})).rejects.toThrow(/head SHA changed/);
  expect(llm.generateStructured).not.toHaveBeenCalled();
 });
 it("does not require cloud approval or a model when every changed path is excluded",async()=>{
  const repo=fixture();
  vi.mocked(repo.getDiff).mockResolvedValue([{path:".github/workflows/ci.yml",patch:"excluded"}]);
  const llm:LlmPort={generateStructured:vi.fn()};
  const result=await runReview({pr:2,repository:"org/repo",repo,llm,audit:{append:vi.fn()},config:parseConfig({version:1}),model:""});
  expect(result.findings).toHaveLength(0);expect(repo.postComment).toHaveBeenCalledOnce();expect(llm.generateStructured).not.toHaveBeenCalled();
 });
});
