import { minimatch } from "minimatch";
import { posix } from "node:path";
import type { AgentConfig } from "./config.js";
import type { PatchFile, PatchProposal } from "./types.js";
export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
}
// .nemesis holds the policy itself; a patch must never be able to loosen its own guardrails.
const ALWAYS_DENY = [
  /^\.github\//i,
  /^\.nemesis\//i,
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:secrets?|credentials?)(?:\/|\.|$)/i,
  /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/i,
  /(^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|.*\.csproj)$/i,
  /(^|\/)migrations?\//i,
  /\.lock$/i,
];
export function normalizeRepoPath(input: string): string | null {
  if (!input || input.includes("\0") || input.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input)) return null;
  const slashed = input.replaceAll("\\", "/");
  if (slashed.split("/").some((part) => part === "..")) return null;
  const normalized = posix.normalize(slashed).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) return null;
  return normalized;
}
export function isAlwaysDeniedPath(path: string): boolean {
  return ALWAYS_DENY.some((rule) => rule.test(path));
}
export function isDeniedPath(path: string, config: AgentConfig): boolean {
  return isAlwaysDeniedPath(path) || config.policy.denyPaths.some((pattern) => minimatch(path, pattern, { dot: true }));
}
export function evaluatePaths(paths: string[], config: AgentConfig): PolicyDecision {
  const reasons: string[] = [];
  for (const raw of paths) {
    const path = normalizeRepoPath(raw);
    if (!path) {
      reasons.push("Unsafe path: " + raw);
      continue;
    }
    if (isDeniedPath(path, config)) {
      reasons.push("Denied path: " + path);
      continue;
    }
    if (
      config.policy.allowPaths.length &&
      !config.policy.allowPaths.some((pattern) => minimatch(path, pattern, { dot: true }))
    )
      reasons.push("Path outside allowlist: " + path);
  }
  return { allowed: reasons.length === 0, reasons };
}
function budgetReasons(proposal: PatchProposal, config: AgentConfig): string[] {
  const reasons: string[] = [];
  if (proposal.confidence !== "high") reasons.push("Only high-confidence proposals may be applied.");
  if (proposal.risk !== "low") reasons.push("Only low-risk proposals may be applied.");
  if (!proposal.files.length) reasons.push("Patch is empty.");
  if (proposal.files.length > config.modes.fix.maxFiles) reasons.push("Patch exceeds maxFiles.");
  return reasons;
}

function pathShapeReason(path: string | null, raw: string, seen: Set<string>): string | null {
  if (!path) return "Unsafe patch path: " + raw;
  if (path !== raw) return "Patch path must be normalized: " + raw;
  if (seen.has(path)) return "Duplicate patch path: " + path;
  seen.add(path);
  return null;
}

function contentReasons(file: PatchFile, config: AgentConfig): string[] {
  const reasons: string[] = [];
  if (Buffer.byteLength(file.content, "utf8") > config.modes.fix.maxFileBytes)
    reasons.push("File exceeds size limit: " + file.path);
  if (file.content.includes("\0")) reasons.push("Binary patch content is not allowed: " + file.path);
  return reasons;
}

export function validatePatchProposal(proposal: PatchProposal, config: AgentConfig): PolicyDecision {
  const reasons = budgetReasons(proposal, config);
  const seen = new Set<string>();
  for (const file of proposal.files) {
    const shape = pathShapeReason(normalizeRepoPath(file.path), file.path, seen);
    if (shape) reasons.push(shape);
    reasons.push(...contentReasons(file, config));
  }
  reasons.push(
    ...evaluatePaths(
      proposal.files.map((file) => file.path),
      config,
    ).reasons,
  );
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}
