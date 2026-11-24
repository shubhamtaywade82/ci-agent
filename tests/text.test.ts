import { describe,it,expect } from "vitest";
import { redactText,sanitizeMarkdown } from "../src/text.js";
describe("redactText",()=>{
 it("masks credential assignments and tokens",()=>{
  expect(redactText("API_KEY=abcdef1234567890abcd")).toContain("[REDACTED]");
  expect(redactText('password: "hunter2hunter2"')).toContain("[REDACTED]");
  expect(redactText("Authorization: Bearer abc.def.ghi")).toContain("Bearer [REDACTED]");
 });
 it("leaves ordinary code that merely mentions token or secret alone",()=>{
  for(const code of ["const token = getToken();","secret: z.string(),","if (!token) return;"])expect(redactText(code)).toBe(code);
 });
});
describe("sanitizeMarkdown",()=>{
 it("breaks mentions, html and images",()=>{
  const out=sanitizeMarkdown("@bob <!-- c --> ![x](u)");
  expect(out).not.toContain("@bob");expect(out).not.toContain("<!--");expect(out).not.toContain("![");
 });
});
