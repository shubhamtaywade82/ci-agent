import { describe,it,expect,vi,afterEach } from "vitest";
import { redactCommandOutput,runCommand } from "../src/workspace.js";

afterEach(()=>vi.unstubAllEnvs());

describe("deterministic command execution",()=>{
 it("does not pass Actions or Ollama secrets to project commands by default",async()=>{
  vi.stubEnv("OLLAMA_API_KEY","test-ollama-secret");
  vi.stubEnv("GITHUB_TOKEN","test-github-secret");
  const result=await runCommand([process.execPath,"-e","process.stdout.write(JSON.stringify({ollama:process.env.OLLAMA_API_KEY,github:process.env.GITHUB_TOKEN}))"],process.cwd(),5000);
  expect(JSON.parse(result.output)).toEqual({});
 });
 it("forwards only explicitly allowlisted environment variables",async()=>{
  vi.stubEnv("CI_AGENT_TEST_VALUE","safe-to-forward");
  vi.stubEnv("OLLAMA_API_KEY","must-not-forward");
  const result=await runCommand([process.execPath,"-e","process.stdout.write(JSON.stringify({allowed:process.env.CI_AGENT_TEST_VALUE,ollama:process.env.OLLAMA_API_KEY}))"],process.cwd(),5000,["CI_AGENT_TEST_VALUE"]);
  expect(JSON.parse(result.output)).toEqual({allowed:"safe-to-forward"});
 });
 it("redacts explicitly forwarded secret values from evidence",()=>{
  vi.stubEnv("CI_AGENT_TEST_VALUE","sensitive-value");
  expect(redactCommandOutput("command emitted sensitive-value",["CI_AGENT_TEST_VALUE"])).toBe("command emitted [REDACTED_ENV:CI_AGENT_TEST_VALUE]");
 });
 it("terminates configured commands that exceed their deadline",async()=>{
  const result=await runCommand([process.execPath,"-e","setInterval(()=>{},1000)"],process.cwd(),100);
  expect(result.code).toBe(124);
  expect(result.output).toContain("Command timed out");
 });
});
