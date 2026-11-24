import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import type { CiProvider,DraftPullRequestInput,PullRequestSnapshot,RepoHost,WorkflowRunSnapshot } from "./types.js";
const execFileAsync=promisify(execFile);
export class GitHubRepoHost implements RepoHost {
 constructor(private readonly octokit:Octokit,private readonly owner:string,private readonly repo:string){}
 async getPullRequest(number:number):Promise<PullRequestSnapshot>{
  const {data}=await this.octokit.pulls.get({owner:this.owner,repo:this.repo,pull_number:number});
  return {number:data.number,title:data.title,body:data.body,headSha:data.head.sha,headBranch:data.head.ref,headRepoFullName:data.head.repo?.full_name??null,baseBranch:data.base.ref,draft:data.draft??false,labels:data.labels.flatMap(label=>typeof label==="string"?[label]:label.name?[label.name]:[])};
 }
 async getDiff(number:number){
  const files=await this.octokit.paginate(this.octokit.pulls.listFiles,{owner:this.owner,repo:this.repo,pull_number:number,per_page:100});
  return files.map(file=>({path:file.filename,patch:file.patch??null}));
 }
 async postComment(number:number,body:string):Promise<void>{await this.octokit.issues.createComment({owner:this.owner,repo:this.repo,issue_number:number,body});}
 async findOpenIssueByMarker(marker:string):Promise<boolean>{
  const issues=await this.octokit.paginate(this.octokit.issues.listForRepo,{owner:this.owner,repo:this.repo,state:"open",per_page:100});
  return issues.some(issue=>issue.body?.includes(marker)??false);
 }
 async createIssue(input:{title:string;body:string;labels?:string[]}):Promise<void>{await this.octokit.issues.create({owner:this.owner,repo:this.repo,...input});}
 async findExistingAgentFix(branchName:string):Promise<{pullRequestUrl:string|null;branchExists:boolean}>{
  const [pulls]=await Promise.all([
   this.octokit.paginate(this.octokit.pulls.list,{owner:this.owner,repo:this.repo,state:"open",head:this.owner+":"+branchName,per_page:100})
  ]);
  const existing=pulls.find(pull=>pull.head.ref===branchName&&pull.draft);
  let branchExists=false;
  try{await this.octokit.git.getRef({owner:this.owner,repo:this.repo,ref:"heads/"+branchName});branchExists=true;}
  catch(error){if((error as {status?:number}).status!==404)throw error;}
  return {pullRequestUrl:existing?.html_url??null,branchExists};
 }
 async createDraftPullRequest(input:DraftPullRequestInput):Promise<{url:string}>{
  if(!input.branchName.startsWith("nemesis-agent/fix-"))throw new Error("Refusing non-agent branch prefix.");
  const protectedFile=input.files.find(file=>file.path.startsWith(".github/")||/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|\.env)/i.test(file.path)||/\.lock$/i.test(file.path)||/(^|\/)migrations?\//i.test(file.path));
  if(protectedFile)throw new Error("Protected file write refused: "+protectedFile.path);
  const baseRef=await this.octokit.git.getRef({owner:this.owner,repo:this.repo,ref:"heads/"+input.baseBranch});
  if(baseRef.data.object.sha!==input.baseSha)throw new Error("PR head branch changed; stale patch was not applied.");
  const baseCommit=await this.octokit.git.getCommit({owner:this.owner,repo:this.repo,commit_sha:input.baseSha});
  const tree=await this.octokit.git.createTree({owner:this.owner,repo:this.repo,base_tree:baseCommit.data.tree.sha,tree:input.files.map(file=>({path:file.path,mode:"100644" as const,type:"blob" as const,content:file.content}))});
  const commit=await this.octokit.git.createCommit({owner:this.owner,repo:this.repo,message:"fix: propose bounded CI agent patch",tree:tree.data.sha,parents:[input.baseSha]});
  const latestRef=await this.octokit.git.getRef({owner:this.owner,repo:this.repo,ref:"heads/"+input.baseBranch});
  if(latestRef.data.object.sha!==input.baseSha)throw new Error("PR head branch moved during patch creation; no branch or PR was published.");
  await this.octokit.git.createRef({owner:this.owner,repo:this.repo,ref:"refs/heads/"+input.branchName,sha:commit.data.sha});
  const pr=await this.octokit.pulls.create({owner:this.owner,repo:this.repo,title:input.title,body:input.body,head:input.branchName,base:input.baseBranch,draft:true,maintainer_can_modify:false});
  return {url:pr.data.html_url};
 }
}
export class GitHubActionsCiProvider implements CiProvider {
 constructor(private readonly octokit:Octokit,private readonly owner:string,private readonly repo:string,private readonly token:string){}
 async getWorkflowRun(runId:string):Promise<WorkflowRunSnapshot>{
  if(!/^\d+$/.test(runId))throw new Error("Invalid workflow run id.");
  const {data}=await this.octokit.actions.getWorkflowRun({owner:this.owner,repo:this.repo,run_id:Number(runId)});
  return {id:String(data.id),repository:this.owner+"/"+this.repo,conclusion:data.conclusion??null,sha:data.head_sha??"",branch:data.head_branch??"",attempt:data.run_attempt??1,pullRequest:data.pull_requests?.[0]?.number??null,headRepoFullName:data.head_repository?.full_name??null};
 }
 async getFailedLogs(runId:string):Promise<string>{
  if(!/^\d+$/.test(runId))throw new Error("Invalid workflow run id.");
  const {stdout}=await execFileAsync("gh",["run","view",runId,"--repo",this.owner+"/"+this.repo,"--log-failed"],{env:{...process.env,GH_TOKEN:this.token},maxBuffer:5*1024*1024,timeout:30000});
  return stdout.slice(0,100000);
 }
}
export function repositoryFromEnv():{owner:string;repo:string;fullName:string}{
 const fullName=process.env.GITHUB_REPOSITORY??"";const [owner,repo]=fullName.split("/");
 if(!owner||!repo)throw new Error("GITHUB_REPOSITORY must be owner/name.");
 return {owner,repo,fullName};
}
