import {describe,it,expect} from "vitest";
import {validateExpectedHeadSha} from "../src/event-validation.js";
describe("review dispatch SHA validation",()=>{
 it("requires a valid expected SHA for repository_dispatch",()=>{
  const sha="0123456789abcdef0123456789abcdef01234567";
  expect(validateExpectedHeadSha("repository_dispatch",sha)).toBe(sha);
 });
 it("rejects missing or malformed repository_dispatch SHAs",()=>{
  expect(()=>validateExpectedHeadSha("repository_dispatch",undefined)).toThrow(/requires a valid/);
  expect(()=>validateExpectedHeadSha("repository_dispatch","stale")).toThrow(/requires a valid/);
 });
 it("allows comment-triggered review without a dispatch SHA",()=>{
  expect(validateExpectedHeadSha("issue_comment",undefined)).toBeUndefined();
 });
});
