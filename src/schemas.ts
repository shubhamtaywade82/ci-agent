import { z } from "zod";
export const FindingSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum([
      "ci",
      "test",
      "lint",
      "typecheck",
      "security",
      "dependency",
      "coverage",
      "performance",
      "docs",
      "architecture",
    ]),
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    fingerprint: z.string().min(8),
    message: z.string().min(1).max(4000),
    evidenceRefs: z.array(z.string()),
    path: z.string().optional(),
    line: z.number().int().positive().optional(),
    recommendation: z.string().max(4000).optional(),
  })
  .strict();
export const ReviewResultSchema = z
  .object({ summary: z.string().max(8000), findings: z.array(FindingSchema).max(100) })
  .strict();
export const PatchProposalSchema = z
  .object({
    diagnosis: z.string().min(1).max(8000),
    confidence: z.enum(["high", "medium", "low"]),
    risk: z.enum(["low", "medium", "high"]),
    rationale: z.string().min(1).max(8000),
    expectedValidation: z.array(z.string()).max(20),
    files: z.array(z.object({ path: z.string().min(1), content: z.string() }).strict()).max(10),
  })
  .strict();
export const ScanResultSchema = z
  .object({
    summary: z.string().max(8000),
    priorities: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            severity: z.enum(["critical", "high", "medium", "low", "info"]),
            evidenceRefs: z.array(z.string()),
            recommendation: z.string().max(4000),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
