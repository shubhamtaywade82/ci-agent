/**
 * Policy engine: the single decision point for every agent action.
 *
 * Evaluation is deterministic and total: the engine always returns allow
 * or reject with reasons, never throws on malformed input. If a rule
 * cannot be evaluated because data is missing, the decision is reject.
 *
 * Order of checks (fail-closed, cheapest first):
 *   1. manifest enabled / mode enabled
 *   2. fork provenance (untrusted PRs never reach the LLM)
 *   3. data policy (cloud source exposure)
 *   4. autonomy ceiling for the action
 *   5. budgets (files, bytes, chunks, tokens)
 *   6. path allowlist/denylist
 */

import { posix } from "node:path";
import type { AgentManifest } from "./manifest.js";
import type { AgentTask, PolicyDecision, PatchProposal } from "./types.js";
import type { Autonomy } from "./manifest.js";
import { matchesAny } from "./glob.js";

const AUTONOMY_RANK: Record<Autonomy, number> = {
  comment: 1,
  issue: 2,
  "draft-pr": 3,
};

const CONFIDENCE_RANK = { low: 1, medium: 2, high: 3 } as const;

// Non-negotiable deny rules evaluated before any manifest list: workflow
// files, secrets, lockfiles, dependency manifests and migrations can never
// be patched by the agent even if a manifest allowlist would permit them.
const ALWAYS_DENY: readonly RegExp[] = [
  /^\.github\//i,
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.nemesis\//i,
  /(^|\/)(?:secrets?|credentials?)(?:\/|\.|$)/i,
  /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/i,
  /(^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|.*\.csproj)$/i,
  /(^|\/)migrations?\//i,
  /\.lock$/i,
];

/**
 * Canonicalize a repo-relative path; null when the input can never name a
 * real file safely: absolute paths, Windows drive letters, NUL bytes,
 * `..` traversal, or empty/dot-only results. Ported from the single-package
 * implementation's `normalizeRepoPath`.
 */
export function normalizeRepoPath(input: string): string | null {
  if (!input || input.includes("\0") || input.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input)) return null;
  const slashed = input.replaceAll("\\", "/");
  if (slashed.split("/").some((part) => part === "..")) return null;
  const normalized = posix.normalize(slashed).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) return null;
  return normalized;
}

/** True when the path hits an ALWAYS_DENY rule. */
export function isDeniedPath(path: string): boolean {
  return ALWAYS_DENY.some((rule) => rule.test(path));
}

export interface PolicySubject {
  action: "review-comment" | "create-issue" | "draft-fix-pr" | "llm-consult";
  task: AgentTask;
  proposal?: PatchProposal;
  /** Paths whose content would be sent to the cloud for consultation. */
  cloudPaths?: string[];
  /** Number of chunks (review only). */
  chunks?: number;
  /** Estimated input tokens for the consultation. */
  inputTokens?: number;
}

export function evaluatePolicy(manifest: AgentManifest, subject: PolicySubject): PolicyDecision {
  const reasons: string[] = [];

  if (!manifest.enabled) return reject(`manifest.enabled=false`);
  if (manifest.policy.requireHumanApproval !== true) {
    return reject(`policy.requireHumanApproval must be true (invariant)`);
  }

  const mode = subject.task.mode;
  const modeCfg: { enabled: boolean; autonomy: Autonomy } =
    mode === "review"
      ? manifest.modes.review
      : mode === "fix"
        ? manifest.modes.fix
        : mode === "scan"
          ? manifest.modes.scan
          : { enabled: manifest.modes.triage.enabled, autonomy: "comment" };
  if (!modeCfg.enabled) return reject(`modes.${mode}.enabled=false`);

  // Fork provenance — untrusted PR content must never reach the cloud port.
  if (subject.task.isFork) return reject(`task is from a fork (headRepo=${subject.task.headRepoFullName ?? "?"})`);

  // Data policy — source exposure gate for any cloud consultation.
  if (subject.action === "llm-consult" || subject.action === "draft-fix-pr") {
    if (!manifest.dataPolicy.sendSourceToCloud) {
      return reject(`dataPolicy.sendSourceToCloud=false (classification=${manifest.dataPolicy.classification})`);
    }
    for (const p of subject.cloudPaths ?? []) {
      if (matchesAny(p, manifest.dataPolicy.redactPaths)) {
        return reject(`cloud path ${p} matched dataPolicy.redactPaths`);
      }
    }
  }

  // Autonomy ceiling — the action must not exceed the configured autonomy.
  const requiredAutonomy =
    subject.action === "review-comment"
      ? "comment"
      : subject.action === "create-issue"
        ? "issue"
        : subject.action === "llm-consult"
          ? "comment"
          : "draft-pr";
  if (AUTONOMY_RANK[modeCfg.autonomy] < AUTONOMY_RANK[requiredAutonomy]) {
    return reject(`modes.${mode}.autonomy=${modeCfg.autonomy} below required ${requiredAutonomy} for ${subject.action}`);
  }

  // Fix-mode proposal checks.
  if (subject.action === "draft-fix-pr" && subject.proposal) {
    const p = subject.proposal;
    const fixCfg = manifest.modes.fix;
    if (p.confidence !== "high") return reject(`only high-confidence proposals may be applied (got ${p.confidence})`);
    if (p.risk !== "low") return reject(`only low-risk proposals may be applied (got ${p.risk})`);
    if (p.files.length === 0) return reject(`proposal has no files`);
    if (p.files.length > fixCfg.maxFiles) {
      return reject(`proposal touches ${p.files.length} files > maxFiles=${fixCfg.maxFiles}`);
    }
    if (CONFIDENCE_RANK[p.confidence] < CONFIDENCE_RANK[fixCfg.minConfidence]) {
      return reject(`proposal confidence=${p.confidence} below minConfidence=${fixCfg.minConfidence}`);
    }
    const seen = new Set<string>();
    for (const f of p.files) {
      if (f.content.length > fixCfg.maxFileBytes) {
        return reject(`file ${f.path} is ${f.content.length} bytes > maxFileBytes=${fixCfg.maxFileBytes}`);
      }
      // Canonical-path gate (ported): rejects absolute/traversal/Windows
      // shapes AND requires the proposal to already be in canonical form.
      const canonical = normalizeRepoPath(f.path);
      if (canonical === null) return reject(`unsafe patch path: ${f.path}`);
      if (canonical !== f.path) return reject(`patch path must be normalized: ${f.path}`);
      if (seen.has(canonical)) return reject(`duplicate patch path: ${canonical}`);
      seen.add(canonical);
      if (f.content.includes("\0")) return reject(`binary patch content is not allowed: ${f.path}`);
      // Path gates: hard denylist first, then manifest denylist, then allowlist.
      if (isDeniedPath(canonical)) return reject(`file ${f.path} matched the always-deny rules`);
      if (matchesAny(f.path, manifest.policy.denyPaths)) {
        return reject(`file ${f.path} matched denyPaths`);
      }
      if (!matchesAny(f.path, manifest.policy.allowPaths)) {
        return reject(`file ${f.path} not covered by allowPaths`);
      }
      if (f.content.length === 0) return reject(`file ${f.path} has empty content`);
    }
  }

  // Review budgets.
  if (subject.chunks !== undefined && subject.chunks > manifest.modes.review.maxChunks) {
    return reject(`chunks=${subject.chunks} > maxChunks=${manifest.modes.review.maxChunks}`);
  }
  if (subject.inputTokens !== undefined && subject.inputTokens > manifest.modes.review.maxInputTokens) {
    return reject(`inputTokens=${subject.inputTokens} > maxInputTokens=${manifest.modes.review.maxInputTokens}`);
  }

  return { action: "allow", reasons };
}

function reject(...reasons: string[]): PolicyDecision {
  return { action: "reject", reasons };
}

// ---------------------------------------------------------------------------
// Patch validation against the manifest (pre-LLM, deterministic)
// ---------------------------------------------------------------------------

export interface PatchGuardInput {
  paths: string[];
  /** Called before each file is committed; throw to abort. */
  maxFiles: number;
  maxFileBytes: number;
}

/** Guard applied when materializing a fix branch (defense in depth). */
export function guardPaths(
  paths: string[],
  manifest: AgentManifest,
  limits: { maxFiles: number; maxFileBytes: number },
): PolicyDecision {
  if (paths.length === 0) return reject(`no files to commit`);
  if (paths.length > limits.maxFiles) return reject(`${paths.length} files > maxFiles=${limits.maxFiles}`);
  const seen = new Set<string>();
  for (const p of paths) {
    const canonical = normalizeRepoPath(p);
    if (canonical === null) return reject(`unsafe path: ${p}`);
    if (canonical !== p) return reject(`path must be normalized: ${p}`);
    if (seen.has(canonical)) return reject(`duplicate path: ${canonical}`);
    seen.add(canonical);
    if (isDeniedPath(canonical)) return reject(`file ${p} matched the always-deny rules`);
    if (matchesAny(p, manifest.policy.denyPaths)) return reject(`file ${p} matched denyPaths`);
    if (!matchesAny(p, manifest.policy.allowPaths)) return reject(`file ${p} not covered by allowPaths`);
  }
  return { action: "allow", reasons: [] };
}
