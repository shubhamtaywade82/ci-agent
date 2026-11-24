import { readdir,readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { redactText } from "./text.js";
import type { AgentConfig } from "./config.js";
import type { EvidenceBundle,Finding,ProjectProfile } from "./types.js";

export async function discoverProject(root=process.cwd()):Promise<ProjectProfile>{
 const names=await readdir(root);
 const rootFiles=names.filter(n=>["package.json","pnpm-lock.yaml","yarn.lock","package-lock.json","bun.lock","bun.lockb","pyproject.toml","requirements.txt","Pipfile","go.mod","Cargo.toml","pom.xml","build.gradle","build.gradle.kts","Dockerfile","Makefile","turbo.json","nx.json","pnpm-workspace.yaml"].includes(n)||n.endsWith(".sln")||n.endsWith(".csproj"));
 const languages=new Set<string>(),frameworks=new Set<string>(),packageManagers=new Set<string>();
 if(names.includes("package.json")){
  languages.add("javascript");languages.add("typescript");
  try{const pkg=JSON.parse(await readFile(join(root,"package.json"),"utf8")) as {dependencies?:Record<string,string>;devDependencies?:Record<string,string>};const deps={...pkg.dependencies,...pkg.devDependencies};for(const key of ["react","next","vite","express","fastify","@nestjs/core","vue","svelte"])if(deps[key])frameworks.add(key);}catch{/* malformed manifest stays a verify-job concern */}
 }
 if(names.includes("pnpm-lock.yaml"))packageManagers.add("pnpm");
 else if(names.includes("yarn.lock"))packageManagers.add("yarn");
 else if(names.includes("bun.lock")||names.includes("bun.lockb"))packageManagers.add("bun");
 else if(names.includes("package-lock.json")||names.includes("package.json"))packageManagers.add("npm");
 if(names.includes("pyproject.toml")||names.includes("requirements.txt")||names.includes("Pipfile"))languages.add("python");
 if(names.includes("go.mod"))languages.add("go");
 if(names.includes("Cargo.toml"))languages.add("rust");
 if(names.includes("pom.xml")||names.includes("build.gradle")||names.includes("build.gradle.kts"))languages.add("jvm");
 if(names.some(n=>n.endsWith(".sln")||n.endsWith(".csproj")))languages.add("dotnet");
 if(names.includes("Dockerfile"))frameworks.add("docker");
 return {languages:[...languages],packageManagers:[...packageManagers],frameworks:[...frameworks],rootFiles,monorepo:names.some(n=>["pnpm-workspace.yaml","turbo.json","nx.json","lerna.json"].includes(n))};
}
export function redactCommandOutput(value:string,passEnv:string[]=[]):string{
 let result=redactText(value);
 for(const key of passEnv){
  const secret=process.env[key];
  if(secret&&secret.length>=4)result=result.split(secret).join("[REDACTED_ENV:"+key+"]");
 }
 return result;
}
export async function collectEvidence(input:{config:AgentConfig;repository:string;sha:string;root?:string}):Promise<EvidenceBundle>{
 const root=input.root??process.cwd();const profile=await discoverProject(root);const findings:Finding[]=[];const metrics:Record<string,number>={configuredCommands:Object.keys(input.config.toolchain.commands).length};
 for(const [name,argv] of Object.entries(input.config.toolchain.commands)){
  const result=await runCommand(argv,root,input.config.toolchain.commandTimeoutMs,input.config.toolchain.passEnv);metrics["command."+name+".exitCode"]=result.code;
  const excerpt=redactCommandOutput(result.output,input.config.toolchain.passEnv).slice(0,1500);
  if(result.code!==0)findings.push({id:"tool-"+name+"-"+input.sha.slice(0,8),source:name==="verify"?"ci":"test",severity:"high",fingerprint:createHash("sha256").update(name+result.output).digest("hex"),message:"Configured command "+name+" failed with exit code "+result.code+". Evidence: "+excerpt,evidenceRefs:["command:"+name],recommendation:"Inspect the failing command and add a regression test for the root cause."});
 }
 return {repository:input.repository,sha:input.sha,profile,findings,metrics};
}
export function runCommand(argv:string[],cwd:string,timeoutMs=120000,passEnv:string[]=[]):Promise<{code:number;output:string}>{
 return new Promise((resolve,reject)=>{
  const [executable,...args]=argv;if(!executable)return resolve({code:1,output:"Missing executable"});
  const commandEnv:NodeJS.ProcessEnv={};
  for(const key of ["PATH","HOME","TMPDIR","TEMP","TMP","SYSTEMROOT","WINDIR","PATHEXT","COMSPEC","LANG","LC_ALL"]){
   const value=process.env[key];if(value!==undefined)commandEnv[key]=value;
  }
  for(const key of passEnv){const value=process.env[key];if(value!==undefined)commandEnv[key]=value;}
  commandEnv.CI="true";
  const child=spawn(executable,args,{cwd,env:commandEnv,shell:false,windowsHide:true});
  let output="";let timedOut=false;let killTimer:NodeJS.Timeout|undefined;
  const timeout=setTimeout(()=>{timedOut=true;child.kill("SIGTERM");killTimer=setTimeout(()=>child.kill("SIGKILL"),5000);},timeoutMs);
  const cleanup=()=>{clearTimeout(timeout);if(killTimer)clearTimeout(killTimer);};
  const append=(chunk:Buffer)=>{output+=chunk.toString("utf8");if(output.length>20000)output=output.slice(-20000);};
  child.stdout.on("data",append);child.stderr.on("data",append);
  child.on("error",error=>{cleanup();reject(error);});
  child.on("close",code=>{cleanup();resolve({code:timedOut?124:code??1,output:timedOut?output+"\n[CI Agent] Command timed out after "+timeoutMs+"ms.":output});});
 });
}
