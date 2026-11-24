/**
 * Core domain types: findings, proposals, evidence, audit events.
 *
 * These types are shared by every orchestrator (review / fix / scan) and are
 * the stable contract between the deterministic core and the advisory LLM
 * layer. They are intentionally transport-free: no Octokit, no SDK, no fetch
 * types appear here.
 */

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** Origin of a finding — which evidence collector produced it. */
export type FindingSource =
  | "ci"
  | "test"
  | "lint"
  | "typecheck"
  | "security"
  | "dependency"
  | "coverage"
  | "performance"
  | "docs"
  | "architecture"
  | "llm-review";

export type Severity = "blocker" | "major" | "minor" | "nit" | "info";

export interface Finding {
  id: string;
  source: FindingSource;
  severity: Severity;
  /** Stable content fingerprint used for dedupe across runs. */
  fingerprint: string;
  path?: string;
  line?: number;
  evidenceRefs: string[];
  message: string;
  recommendation?: string;
}

// ---------------------------------------------------------------------------
// Patch proposals
// ---------------------------------------------------------------------------

export type Confidence = "high" | "medium" | "low";
export type Risk = "low" | "medium" | "high";

export interface PatchFile {
  path: string;
  /** Full replacement content for the file. Patches are whole-file. */
  content: string;
}

export interface PatchProposal {
  diagnosis: string;
  confidence: Confidence;
  risk: Risk;
  files: PatchFile[];
  expectedValidation: string[];
  rationale: string;
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export interface ReviewFinding {
  path: string;
  line: number;
  severity: Severity;
  message: string;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Project profile / toolchain
// ---------------------------------------------------------------------------

export type PackageManagerFamily =
  | "node-npm"
  | "node-pnpm"
  | "node-yarn"
  | "bun"
  | "python-uv"
  | "python-poetry"
  | "python-pip"
  | "go"
  | "rust"
  | "jvm-maven"
  | "jvm-gradle"
  | "dotnet"
  | "docker"
  | "terraform"
  | "generic-make"
  | "unknown";

export interface ToolchainCommands {
  install?: string;
  verify: string[];
  lint?: string;
  formatCheck?: string;
}

export interface ProjectProfile {
  /** Adapter id, e.g. `node-npm`. */
  adapter: PackageManagerFamily;
  /** Resolved commands; empty verify means the adapter could not detect. */
  commands: ToolchainCommands;
  /** Root-relative paths of workspace package roots (monorepo support). */
  packageRoots: string[];
}

/** Immutable snapshot of repository facts the agent may use. */
export interface RepoSnapshot {
  repo: string;
  defaultBranch: string;
  sha: string;
  /** Paths present at the snapshot (root-relative, POSIX separators). */
  paths: string[];
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface CommandResult {
  command: string;
  exitCode: number | null;
  /** Truncated stdout/stderr tail (already redacted). */
  output?: string;
}

export interface EvidenceBundle {
  repo: string;
  sha: string;
  profile: ProjectProfile;
  commands: CommandResult[];
  reports: {
    junit?: unknown[];
    sarif?: unknown[];
    coverage?: unknown[];
    audit?: unknown[];
    benchmarks?: unknown[];
  };
  metrics: {
    coverage?: number;
    complexity?: number;
    bundleSize?: number;
    dependencyAgeDays?: number;
    flakyRate?: number;
  };
  findings: Finding[];
}

// ---------------------------------------------------------------------------
// Agent task / trigger context
// ---------------------------------------------------------------------------

export type AgentMode = "review" | "fix" | "scan" | "triage";

export interface AgentTask {
  mode: AgentMode;
  repo: string;
  /** PR number when the task is PR-scoped. */
  prNumber?: number;
  /** Failed CI run id when the task is failure-scoped. */
  runId?: string;
  /** SHA the evidence is anchored to. */
  sha: string;
  /** Fork provenance — untrusted PRs must be skipped, not executed. */
  headRepoFullName?: string;
  isFork: boolean;
  /** Branch naming for fix tasks: nemesis-agent/fix/{runId}/a{attempt} */
  fixBranchPrefix?: string;
  /** Attempt number parsed from an existing agent fix branch, if any. */
  fixAttempt?: number;
  /** head branch (for fix PR base resolution) */
  headBranch?: string;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface PolicyDecisionAllow {
  action: "allow";
  /** Human-readable trace of the rules evaluated, for the audit record. */
  reasons: string[];
}

export interface PolicyDecisionReject {
  action: "reject";
  reasons: string[];
}

export type PolicyDecision = PolicyDecisionAllow | PolicyDecisionReject;

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface LlmUsageInfo {
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
}

export interface AgentAuditEvent {
  /** ISO-8601 timestamp. */
  at: string;
  repo: string;
  mode: AgentMode;
  task: string;
  event:
    | "task-start"
    | "task-skip"
    | "llm-request"
    | "llm-response"
    | "llm-reject"
    | "policy-reject"
    | "proposal-reject"
    | "action-applied"
    | "task-done"
    | "task-error";
  /** Prompt version identifier for reproducibility. */
  promptVersion?: string;
  /** sha256 of the rendered user prompt (hex). */
  inputHash?: string;
  /** sha256 of the raw model text output (hex). */
  outputHash?: string;
  usage?: LlmUsageInfo;
  /** Decision trace from the policy engine. */
  policy?: { action: "allow" | "reject"; reasons: string[] };
  outcome?: "success" | "skipped" | "failed" | "aborted";
  /** Structured detail (never contains secrets: payloads are hashed). */
  detail?: Record<string, unknown>;
}

export interface AuditStore {
  append(event: AgentAuditEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Ports (the seams every adapter fills)
// ---------------------------------------------------------------------------

export interface PullRequestRef {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  headRefName: string;
  headSha: string;
  headRepoFullName: string;
  /** The branch the PR targets. */
  baseRefName: string;
}

export interface ReviewCommentInput {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export interface PullRequestReviewInput {
  /** COMMIT is the only allowed event: the agent never APPROVEs/REQUEST_CHANGES. */
  event: "COMMENT";
  body: string;
  comments: ReviewCommentInput[];
}

export interface CreatePullRequestInput {
  title: string;
  head: string;
  base: string;
  body: string;
  draft: boolean;
}

export interface PullRequestCreated {
  number: number;
  htmlUrl: string;
}

export interface IssueInput {
  title: string;
  body: string;
  labels?: string[];
}

/** Version-control host abstraction (GitHub adapter in packages/github). */
export interface RepoHost {
  getPullRequest(pr: number): Promise<PullRequestRef>;
  getDiff(pr: number): Promise<string>;
  getFile(path: string, ref: string): Promise<string>;
  listPullRequestsForSha(sha: string): Promise<number[]>;
  createBranch(name: string, sha: string): Promise<void>;
  putFile(path: string, content: string, branch: string): Promise<void>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestCreated>;
  postReview(pr: number, review: PullRequestReviewInput): Promise<void>;
  createIssue(input: IssueInput): Promise<void>;
  /** Marker comment ledger: hidden HTML marker for fingerprint dedupe. */
  findMarkerComment(pr: number, marker: string): Promise<{ id: number; body: string } | null>;
  updateComment(pr: number, commentId: number, body: string): Promise<void>;
  createComment(pr: number, body: string): Promise<number>;
}

/** CI system abstraction (GitHub Actions adapter in packages/github). */
export interface CiProvider {
  getRun(runId: string): Promise<{
    id: number;
    name: string;
    conclusion: string | null;
    headSha: string;
    headBranch: string | null;
    htmlUrl: string;
  }>;
  getFailedLogs(runId: string): Promise<string>;
}

/** Structured-output LLM port. Implementations MUST fail closed on parse. */
export interface LlmPort {
  structured<T>(input: {
    schema: object;
    system: string;
    user: string;
    maxInputTokens: number;
    maxOutputTokens: number;
  }): Promise<T & { __usage?: LlmUsageInfo }>;
}

// ---------------------------------------------------------------------------
// Toolchain adapter port
// ---------------------------------------------------------------------------

export interface ToolchainAdapter {
  readonly id: PackageManagerFamily;
  /** Detection signals are file names, never file contents (headless, cheap). */
  detect(repo: RepoSnapshot): Promise<ProjectProfile | null>;
}
