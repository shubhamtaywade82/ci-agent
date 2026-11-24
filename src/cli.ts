#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { evaluatePaths } from "./policy.js";
import { collectEvidence } from "./workspace.js";
const cli=new Command();
cli.name("nemesis-ci").description("Policy-gated CI agent utilities").version("0.1.0");
cli.command("validate").option("-c, --config <path>","Configuration path",".nemesis/ci-agent.yml").action(async({config})=>{
 try{const parsed=await loadConfig(config);console.log(JSON.stringify({valid:true,version:parsed.version,enabled:parsed.enabled},null,2));}
 catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
});
cli.command("policy-check").requiredOption("-p, --paths <paths>").option("-c, --config <path>","Configuration path",".nemesis/ci-agent.yml").action(async({config,paths})=>{
 try{const parsed=await loadConfig(config);const result=evaluatePaths(paths.split(",").map((p:string)=>p.trim()).filter(Boolean),parsed);console.log(JSON.stringify(result,null,2));if(!result.allowed)process.exitCode=1;}
 catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
});
cli.command("evidence").option("-c, --config <path>","Configuration path",".nemesis/ci-agent.yml").action(async({config})=>{
 try{const parsed=await loadConfig(config);const result=await collectEvidence({config:parsed,repository:process.env.GITHUB_REPOSITORY??"local",sha:process.env.GITHUB_SHA??"local"});console.log(JSON.stringify(result,null,2));}
 catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
});
await cli.parseAsync(process.argv);
