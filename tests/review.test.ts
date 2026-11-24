import { describe,it,expect,vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { runReview,buildChunks,fitLines } from "../src/review.js";
import type { AuditStore,LlmPort,RepoHost } from "../src/types.js";
function fixture(draft=false):RepoHost{return {
 getPullRequest:vi.fn().mockResolvedValue({number:2,title:"change",body:null,headSha:"abc",headBranch:"feature",headRepoFullName:"org/repo",baseBranch:"main",draft,labels:[]}),
 getDiff:vi.fn().mockResolvedValue([{path:"src/a.ts",patch:"@@ -1 +1 @@\n-old\n+new"},{path:".github/workflows/ci.yml",patch:"secret"}]),
 getFileContent:vi.fn(),postComment:vi.fn(),findOpenIssueByMarker:vi.fn(),createIssue:vi.fn(),findExistingAgentFix:vi.fn().mockResolvedValue({pullRequestUrl:null,branchExists:false}),createDraftPullRequest:vi.fn()
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
  expect(String(vi.mocked(llm.generateStructured).mock.calls[0]?.[0].prompt)).not.toContain(".github/workflows/ci.yml");
 });
 it("refuses draft PRs",async()=>{
  await expect(runReview({pr:2,repository:"org/repo",repo:fixture(true),llm:{generateStructured:vi.fn()},audit:{append:vi.fn()},config:parseConfig({version:1,dataPolicy:{classification:"public"}}),model:"test"})).rejects.toThrow(/Draft/);
 });
 it("refuses fork-originated runs before sending source to the model",async()=>{
  const llm:LlmPort={generateStructured:vi.fn()};
  const repo=fixture();
  vi.mocked(repo.getPullRequest).mockResolvedValue({number:2,title:"change",body:null,headSha:"abc",headBranch:"feature",headRepoFullName:"someone/fork",baseBranch:"main",draft:false,labels:[]});
  await expect(runReview({pr:2,repository:"org/repo",repo,llm,audit:{append:vi.fn()},config:parseConfig({version:1,dataPolicy:{classification:"public"}}),model:"test"})).rejects.toThrow(/fork/);
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
 it("states what was not reviewed instead of implying a clean review",async()=>{
  const repo=fixture();
  vi.mocked(repo.getDiff).mockResolvedValue([{path:".github/workflows/ci.yml",patch:"excluded"}]);
  await runReview({pr:2,repository:"org/repo",repo,llm:{generateStructured:vi.fn()},audit:{append:vi.fn()},config:parseConfig({version:1}),model:""});
  const body=String(vi.mocked(repo.postComment).mock.calls[0]?.[1]);
  expect(body).toContain("No files were reviewed.");expect(body).toContain("Not reviewed");expect(body).not.toContain("No actionable findings");
 });
 it("reports oversized diffs and chunks over budget as not reviewed",()=>{
  const config=parseConfig({version:1,modes:{review:{maxChunks:1,maxInputChars:2000}}});
  const big="x".repeat(2500);const mid="y".repeat(1200);
  const {chunks,skipped}=buildChunks([{path:"src/big.ts",patch:big},{path:"src/a.ts",patch:mid},{path:"src/b.ts",patch:mid}],config);
  expect(chunks).toHaveLength(1);
  expect(skipped.join(" ")).toMatch(/src\/big\.ts \(diff too large\)/);
  expect(skipped.join(" ")).toMatch(/src\/b\.ts \(over maxChunks budget\)/);
 });
 it("neutralizes mentions and html in model output",async()=>{
  const repo=fixture();
  const llm:LlmPort={generateStructured:vi.fn().mockResolvedValue({summary:"ping @everyone",findings:[{id:"1",source:"test",severity:"high",fingerprint:"fingerprint-1",message:"<!-- x --> ![i](http://e)",evidenceRefs:[],path:"src/a.ts",line:1}]})};
  await runReview({pr:2,repository:"org/repo",repo,llm,audit:{append:vi.fn()},config:parseConfig({version:1,dataPolicy:{classification:"public"}}),model:"test"});
  const body=String(vi.mocked(repo.postComment).mock.calls[0]?.[1]);
  expect(body).not.toContain("@everyone");expect(body).not.toContain("<!-- x");expect(body).not.toContain("![i]");
 });
 it("truncates oversized sections and says how many entries were omitted",()=>{
  const lines=Array.from({length:10},(_,i)=>"- finding "+i+" "+"x".repeat(90));
  const fitted=fitLines(lines,300);
  expect(fitted.length).toBeLessThan(lines.length);expect(fitted.at(-1)).toMatch(/more omitted/);
  expect(fitLines(lines,100000)).toEqual(lines);
 });
});
