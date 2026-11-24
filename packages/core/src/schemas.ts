/**
 * JSON Schemas for LLM structured outputs.
 *
 * Every LLM response must validate against one of these before the agent
 * acts on it; parse or validation failure is fail-closed (abort + audit).
 * The schemas are kept intentionally narrow: enums over free text,
 * bounded arrays, required fields, no additional properties.
 */

import type { Finding, PatchProposal, ReviewResult } from "./types.js";

export const REVIEW_RESULT_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, maxLength: 512 },
          line: { type: "integer", minimum: 1 },
          severity: { enum: ["blocker", "major", "minor", "nit", "info"] },
          message: { type: "string", minLength: 1, maxLength: 2000 },
        },
        required: ["path", "line", "severity", "message"],
        additionalProperties: false,
      },
    },
    summary: { type: "string", maxLength: 4000 },
  },
  required: ["findings", "summary"],
  additionalProperties: false,
} as const;

export const PATCH_PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    diagnosis: { type: "string", minLength: 1, maxLength: 4000 },
    confidence: { enum: ["high", "medium", "low"] },
    risk: { enum: ["low", "medium", "high"] },
    files: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, maxLength: 512 },
          content: { type: "string", maxLength: 120_000 },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    expectedValidation: { type: "array", maxItems: 10, items: { type: "string", maxLength: 500 } },
    rationale: { type: "string", maxLength: 4000 },
  },
  required: ["diagnosis", "confidence", "risk", "files", "expectedValidation", "rationale"],
  additionalProperties: false,
} as const;

export const SCAN_RESULT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", maxLength: 4000 },
    issues: {
      type: "array",
      maxItems: 15,
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 300 },
          severity: { enum: ["blocker", "major", "minor", "nit", "info"] },
          description: { type: "string", maxLength: 4000 },
          category: { enum: ["ci-failure", "static-analysis", "dependency-vulnerabilities", "coverage-gaps", "dead-code", "docs-drift", "performance-regression"] },
          recommendation: { type: "string", maxLength: 2000 },
        },
        required: ["title", "severity", "description", "category", "recommendation"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "issues"],
  additionalProperties: false,
} as const;

export const FIX_PROPOSAL_REJECT_SCHEMA = {
  type: "object",
  properties: {
    reject: { const: true },
    reason: { type: "string", maxLength: 4000 },
  },
  required: ["reject", "reason"],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Runtime type guards (post-Ajv narrowing for orchestrator use)
// ---------------------------------------------------------------------------

export function isReviewResult(v: unknown): v is ReviewResult {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as ReviewResult).findings) &&
    typeof (v as ReviewResult).summary === "string"
  );
}

export function isPatchProposal(v: unknown): v is PatchProposal {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as PatchProposal).diagnosis === "string" &&
    typeof (v as PatchProposal).confidence === "string" &&
    typeof (v as PatchProposal).risk === "string" &&
    Array.isArray((v as PatchProposal).files) &&
    Array.isArray((v as PatchProposal).expectedValidation) &&
    typeof (v as PatchProposal).rationale === "string"
  );
}
