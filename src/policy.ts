import { minimatch } from "minimatch";
import { posix } from "node:path";
import type { AgentConfig } from "./config.js";
import type { PatchProposal } from "./types.js";
export interface PolicyDecision { allowed:boolean; reasons:string[] }
const ALWAYS_DENY=[/^\.github\//i,/(^|\/)\.env(?:\.|$)/i,/(^|\/)(?:secrets?|credentials?)(?:\/|\.|$)/i,/(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/i,/(^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|.*\.csproj)$/i,/(^|\/)migrations?\//i,/\.lock$/i];
export function normalizeRepoPath(input:string):string|null {
 if(!input||input.includes("\0")||input.startsWith("/")||/^[A-Za-z]:[\\/]/.test(input))return null;
 const slashed=input.replaceAll("\\","/");
 if(slashed.split("/").some(part=>part===".."))return null;
 const normalized=posix.normalize(slashed).replace(/^\.\//,"");
 if(!normalized||normalized==="."||normalized.startsWith("../"))return null;
 return normalized;
}
export function isDeniedPath(path:string,config:AgentConfig):boolean {
 return ALWAYS_DENY.some(rule=>rule.test(path))||config.policy.denyPaths.some(pattern=>minimatch(path,pattern,{dot:true}));
}
export function evaluatePaths(paths:string[],config:AgentConfig):PolicyDecision {
 const reasons:string[]=[];
 for(const raw of paths){
  const path=normalizeRepoPath(raw);
  if(!path){reasons.push("Unsafe path: "+raw);continue;}
  if(isDeniedPath(path,config)){reasons.push("Denied path: "+path);continue;}
  if(config.policy.allowPaths.length&&!config.policy.allowPaths.some(pattern=>minimatch(path,pattern,{dot:true})))reasons.push("Path outside allowlist: "+path);
 }
 return {allowed:reasons.length===0,reasons};
}
export function validatePatchProposal(proposal:PatchProposal,config:AgentConfig):PolicyDecision {
 const reasons:string[]=[];
 if(proposal.confidence!=="high")reasons.push("Only high-confidence proposals may be applied.");
 if(proposal.risk!=="low")reasons.push("Only low-risk proposals may be applied.");
 if(!proposal.files.length)reasons.push("Patch is empty.");
 if(proposal.files.length>config.modes.fix.maxFiles)reasons.push("Patch exceeds maxFiles.");
 const seen=new Set<string>();
 for(const file of proposal.files){
  const path=normalizeRepoPath(file.path);
  if(!path)reasons.push("Unsafe patch path: "+file.path);
  else if(seen.has(path))reasons.push("Duplicate patch path: "+path);
  else seen.add(path);
  if(Buffer.byteLength(file.content,"utf8")>config.modes.fix.maxFileBytes)reasons.push("File exceeds size limit: "+file.path);
  if(file.content.includes("\0"))reasons.push("Binary patch content is not allowed: "+file.path);
 }
 reasons.push(...evaluatePaths(proposal.files.map(f=>f.path),config).reasons);
 return {allowed:reasons.length===0,reasons:[...new Set(reasons)]};
}
