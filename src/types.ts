import type { ZodType } from "zod";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type FindingSource = "ci" | "test" | "lint" | "typecheck" | "security" | "dependency" | "coverage" | "performance" | "docs" | "architecture";
export interface Finding { id:string; source:FindingSource; severity:Severity; fingerprint:string; message:string; evidenceRefs:string[]; path?:string; line?:number; recommendation?:string }
export interface PatchFile { path:string; content:string }
export interface PatchProposal { diagnosis:string; confidence:"high"|"medium"|"low"; risk:"low"|"medium"|"high"; rationale:string; expectedValidation:string[]; files:PatchFile[] }
export interface PullRequestSnapshot { number:number; title:string; body:string|null; headSha:string; headBranch:string; headRepoFullName:string|null; baseBranch:string; draft:boolean; labels:string[] }
export interface PullRequestFileDiff { path:string; patch:string|null }
export interface DraftPullRequestInput { baseBranch:string; baseSha:string; branchName:string; title:string; body:string; files:PatchFile[] }
export interface RepoHost {
  getPullRequest(number:number):Promise<PullRequestSnapshot>;
  getDiff(number:number):Promise<PullRequestFileDiff[]>;
  getFileContent(path:string,ref:string):Promise<string|null>;
  upsertComment(number:number,marker:string,body:string):Promise<void>;
  findOpenIssueByMarker(marker:string):Promise<boolean>;
  createIssue(input:{title:string;body:string;labels?:string[]}):Promise<void>;
  findExistingAgentFix(branchName:string):Promise<{pullRequestUrl:string|null;branchExists:boolean}>;
  createDraftPullRequest(input:DraftPullRequestInput):Promise<{url:string}>;
}
export interface WorkflowRunSnapshot { id:string; repository:string; conclusion:string|null; sha:string; branch:string; attempt:number; pullRequest:number|null; headRepoFullName:string|null }
export interface CiProvider { getWorkflowRun(runId:string):Promise<WorkflowRunSnapshot>; getFailedLogs(runId:string):Promise<string> }
export interface StructuredOutputRequest<T> { model:string; system:string; prompt:string; schema:ZodType<T>; timeoutMs:number; maxOutputTokens:number }
export interface LlmPort { generateStructured<T>(request:StructuredOutputRequest<T>):Promise<T> }
export interface AuditEvent { schemaVersion:1; timestamp:string; event:string; repository:string; decision:"allowed"|"rejected"|"completed"|"failed"; taskId?:string; model?:string; inputHash?:string; outputHash?:string; reason?:string; metadata?:Record<string,string|number|boolean> }
export interface AuditStore { append(event:AuditEvent):Promise<void> }
export interface ProjectProfile { languages:string[]; packageManagers:string[]; frameworks:string[]; rootFiles:string[]; monorepo:boolean }
export interface EvidenceBundle { repository:string; sha:string; profile:ProjectProfile; findings:Finding[]; metrics:Record<string,number> }
