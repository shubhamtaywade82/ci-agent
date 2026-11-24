import { describe,it,expect,vi } from "vitest";
import { GitHubRepoHost } from "../src/github.js";
import type { Octokit } from "@octokit/rest";

function fakeOctokit(headSequence:string[]){
 const getRef=vi.fn();for(const sha of headSequence)getRef.mockResolvedValueOnce({data:{object:{sha}}});
 const createTree=vi.fn().mockResolvedValue({data:{sha:"tree2"}});
 const octokit={git:{
  getRef,getCommit:vi.fn().mockResolvedValue({data:{tree:{sha:"tree1"}}}),
  getTree:vi.fn().mockResolvedValue({data:{tree:[{path:"src/run.sh",mode:"100755"}]}}),
  createTree,createCommit:vi.fn().mockResolvedValue({data:{sha:"commit2"}}),createRef:vi.fn()
 },pulls:{create:vi.fn().mockResolvedValue({data:{html_url:"https://example.test/pr/9"}})}};
 return {octokit,createTree};
}
const input={baseBranch:"feature",baseSha:"base",branchName:"nemesis-agent/fix-1-abc",title:"t",body:"b",files:[{path:"src/run.sh",content:"x"},{path:"src/new.ts",content:"y"}]};

describe("GitHubRepoHost.createDraftPullRequest",()=>{
 it("preserves the executable bit of existing files and defaults new files to 100644",async()=>{
  const {octokit,createTree}=fakeOctokit(["base","base"]);
  const result=await new GitHubRepoHost(octokit as unknown as Octokit,"o","r").createDraftPullRequest(input);
  expect(result.url).toBe("https://example.test/pr/9");
  expect(createTree.mock.calls[0]?.[0].tree.map((e:{mode:string})=>e.mode)).toEqual(["100755","100644"]);
 });
 it("refuses policy files such as .nemesis/ci-agent.yml",async()=>{
  const {octokit}=fakeOctokit(["base"]);
  await expect(new GitHubRepoHost(octokit as unknown as Octokit,"o","r").createDraftPullRequest({...input,files:[{path:".nemesis/ci-agent.yml",content:"x"}]})).rejects.toThrow(/Protected/);
 });
 it("publishes nothing when the PR head moves during patch creation",async()=>{
  const {octokit}=fakeOctokit(["base","moved"]);
  await expect(new GitHubRepoHost(octokit as unknown as Octokit,"o","r").createDraftPullRequest(input)).rejects.toThrow(/moved/);
  expect(octokit.git.createRef).not.toHaveBeenCalled();
 });
});
