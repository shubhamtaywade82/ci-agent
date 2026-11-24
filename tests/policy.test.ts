import { describe,it,expect } from "vitest";
import { parseConfig } from "../src/config.js";
import { evaluatePaths,normalizeRepoPath,validatePatchProposal } from "../src/policy.js";
const config=parseConfig({version:1,modes:{fix:{maxFiles:2,maxFileBytes:100}}});
const proposal={diagnosis:"repair",confidence:"high" as const,risk:"low" as const,rationale:"minimal",expectedValidation:["npm test"],files:[{path:"src/a.ts",content:"ok"}]};
describe("path policy",()=>{
 it("allows in-scope code and tests",()=>{expect(evaluatePaths(["src/a.ts","tests/a.test.ts"],config).allowed).toBe(true);});
 it("rejects paths outside the default allowlist",()=>{expect(evaluatePaths(["README.md"],config).allowed).toBe(false);});
 it("rejects path traversal and absolute paths",()=>{expect(normalizeRepoPath("../secret")).toBeNull();expect(normalizeRepoPath("/etc/passwd")).toBeNull();});
 it("denies workflow, lockfile and migration paths",()=>{expect(evaluatePaths([".github/workflows/ci.yml"],config).allowed).toBe(false);expect(evaluatePaths(["src/package-lock.json"],config).allowed).toBe(false);expect(evaluatePaths(["src/migrations/1.rb"],config).allowed).toBe(false);});
});
describe("patch policy",()=>{
 it("accepts a bounded low-risk proposal",()=>{expect(validatePatchProposal(proposal,config).allowed).toBe(true);});
 it("rejects a non-high-confidence proposal",()=>{expect(validatePatchProposal({...proposal,confidence:"medium"},config).allowed).toBe(false);});
 it("rejects elevated risk",()=>{expect(validatePatchProposal({...proposal,risk:"high"},config).allowed).toBe(false);});
 it("rejects files over the byte budget",()=>{expect(validatePatchProposal({...proposal,files:[{path:"src/a.ts",content:"x".repeat(101)}]},config).allowed).toBe(false);});
});
