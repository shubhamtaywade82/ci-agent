/**
 * Composition root: wires env → manifest → adapters → router → orchestrator.
 *
 * Exit-code contract (the CLI/Action contract):
 *   0 success — the task ran and produced its advisory output (or skipped
 *     for an explicit, benign reason: disabled mode, non-failure run,
 *     fork, no opt-in label, attempt cap)
 *   1 fail-closed abort — LLM parse/schema/policy failure: the agent
 *     refused to act; a human should look
 *   2 configuration error — missing manifest, missing env, bad repo slug
 *
 * The distinction matters: exit 1 is a *system* event (the advisor hit
 * its own guard), exit 2 is an adoption error. Neither ever reddens the
 * deterministic `verify` pipeline — the agent runs in its own workflow.
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  GitHubRepoHost,
  GitHubActionsCiProvider,
} from "@nemesis-oss/ci-agent-github";
import { OllamaCloudLlm } from "@nemesis-oss/ci-agent-ollama-cloud";
import {
  InMemoryAuditStore,
  FileAuditStore,
  parseManifest,
  route,
  runReview,
  runFix,
  runScan,
  DEFAULT_MANIFEST,
} from "@nemesis-oss/ci-agent-core";
import type { AgentManifest, LlmPort, RepoHost, CiProvider, AuditStore } from "@nemesis-oss/ci-agent-core";
import { composeEvent, loadPayload, parseRepo, readGithubEnv } from "./env.js";

/** Permission levels that may trigger the advisory pipeline by comment. */
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);

export interface RunOptions {
  /** Path to the policy manifest; defaults to .nemesis/ci-agent.yml */
  configPath?: string;
  /** Overrides for tests. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Port overrides for tests. */
  overrides?: {
    host?: RepoHost;
    ci?: CiProvider;
    llm?: LlmPort;
    audit?: AuditStore;
    payload?: string; // JSON payload literal, overrides the file
  };
  stdout?: (line: string) => void;
}

export interface RunResult {
  exitCode: 0 | 1 | 2;
  mode: string;
  outcome: string;
  reason?: string;
}

export async function run(opts: RunOptions = {}): Promise<RunResult> {
  const say = opts.stdout ?? ((l: string) => console.log(l));
  const env = readGithubEnv(opts.env ?? process.env);
  const payload = opts.overrides?.payload
    ? (JSON.parse(opts.overrides.payload) as Awaited<ReturnType<typeof loadPayload>>)
    : await loadPayload(env.payloadPath);
  const event = composeEvent(env, payload);

  // -- manifest ------------------------------------------------------------
  let manifest: AgentManifest;
  const configPath = opts.configPath ?? ".nemesis/ci-agent.yml";
  try {
    const text = await readFile(configPath, "utf8");
    manifest = parseManifest(text.trim().startsWith("{") ? JSON.parse(text) : parseYaml(text));
  } catch (err) {
    // Fail-open to defaults ONLY when the file is absent — an invalid file
    // is a configuration error, never silently ignored.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      manifest = DEFAULT_MANIFEST;
      say(`::notice::no ${configPath} found; using built-in conservative defaults`);
    } else {
      say(`::error::invalid manifest ${configPath}: ${String(err)}`);
      return { exitCode: 2, mode: "none", outcome: "config-error", reason: String(err) };
    }
  }

  if (process.env.CI_AGENT_VALIDATE_ONLY === "1") {
    say("Nemesis CI Agent configuration is valid.");
    return { exitCode: 0, mode: "validate", outcome: "valid" };
  }

  if (!manifest.enabled) {
    say("::notice::manifest.enabled=false; nothing to do");
    return { exitCode: 0, mode: "none", outcome: "disabled" };
  }

  // -- routing -------------------------------------------------------------
  const routed = route({
    eventName: event.eventName,
    pr: event.pr,
    workflowRun: event.workflowRun,
    selectedMode: event.selectedMode,
    repo: event.repository,
    defaultBranch: event.defaultBranch,
  });

  if ("skip" in routed) {
    say(`::notice::skip: ${routed.reason}`);
    return { exitCode: 0, mode: "none", outcome: "skipped", reason: routed.reason };
  }
  const task = routed.task;
  say(`routed ${routed.via} → mode=${task.mode}`);

  // -- adapters ------------------------------------------------------------
  const parsed = parseRepo(event.repository);
  if (!parsed) {
    say(`::error::cannot parse repository "${event.repository}"`);
    return { exitCode: 2, mode: task.mode, outcome: "config-error", reason: "bad repository slug" };
  }

  // App-token or fallback token: the fix path MUST have an App token in
  // production; review works with GITHUB_TOKEN.
  const token = env.token ?? "";
  if (!token) {
    say(`::error::no token (GH_TOKEN/GITHUB_TOKEN) for ${event.repository}`);
    return { exitCode: 2, mode: task.mode, outcome: "config-error", reason: "missing token" };
  }

  const host = opts.overrides?.host ?? new GitHubRepoHost({ owner: parsed.owner, repo: parsed.repo, token });
  const ci = opts.overrides?.ci ?? new GitHubActionsCiProvider({ owner: parsed.owner, repo: parsed.repo, token });
  const audit = opts.overrides?.audit ?? new FileAuditStore(".nemesis/audit.jsonl");

  // Commenter permission check (ported from upstream hardening): a comment
  // can only trigger the advisory pipeline when its author has real write
  // access. author_association alone is too coarse; resolve it via the API.
  if (event.eventName === "issue_comment") {
    if (!event.commentLogin) {
      say("::error::comment author could not be determined from the event payload");
      return { exitCode: 2, mode: task.mode, outcome: "config-error", reason: "missing comment author" };
    }
    if (host.getCollaboratorPermission) {
      const permission = await host.getCollaboratorPermission(event.commentLogin);
      if (!WRITE_ROLES.has(permission)) {
        say(`::notice::skip: commenter ${event.commentLogin} lacks write access (permission: ${permission})`);
        return { exitCode: 0, mode: task.mode, outcome: "skipped", reason: `commenter lacks write access (${permission})` };
      }
    }
  }

  let llm: LlmPort;
  try {
    llm =
      opts.overrides?.llm ??
      new OllamaCloudLlm({
        host: process.env[manifest.llm.hostEnv],
        apiKey: process.env[manifest.llm.apiKeyEnv],
        model: process.env[manifest.llm.modelEnv] ?? "",
      });
  } catch (err) {
    say(`::error::${String(err)}`);
    return { exitCode: 2, mode: task.mode, outcome: "config-error", reason: String(err) };
  }

  // -- orchestrators ---------------------------------------------------------
  try {
    if (task.mode === "review" && task.prNumber !== undefined) {
      const pr = await host.getPullRequest(task.prNumber);
      // Benign skips surfaced as notices, never failures (advisory layer).
      if (pr.draft) {
        say("::notice::skip: draft pull request (waiting for ready_for_review)");
        return { exitCode: 0, mode: "review", outcome: "skipped", reason: "draft PR" };
      }
      if (pr.headRepoFullName !== event.repository) {
        say(`::notice::skip: fork pull request (head repo ${pr.headRepoFullName})`);
        return { exitCode: 0, mode: "review", outcome: "skipped", reason: "fork PR" };
      }
      const expected = event.pr?.head.sha;
      if (expected && /^[a-f0-9]{40}$/i.test(expected) && pr.headSha !== expected) {
        say("::notice::skip: PR head SHA changed since the trusted dispatch");
        return { exitCode: 0, mode: "review", outcome: "skipped", reason: "head SHA changed" };
      }
      const r = await runReview(pr, { host, llm, audit, manifest });
      say(`review: posted=${r.posted} findings=${r.findings} skipped=${r.skipped}`);
      return { exitCode: 0, mode: "review", outcome: r.posted ? "reviewed" : "no-findings" };
    }

    if (task.mode === "fix" && task.runId !== undefined) {
      const prs = await host.listPullRequestsForSha(task.sha);
      const r = await runFix(
        { runId: task.runId, repo: event.repository, prNumber: task.prNumber ?? prs[0], isFork: task.isFork, headRepoFullName: task.headRepoFullName },
        { host, ci, llm, audit, manifest, repoPaths: [] },
      );
      say(`fix: outcome=${r.outcome} attempt=${r.attempt}${r.prUrl ? ` pr=${r.prUrl}` : ""}${r.reason ? ` reason=${r.reason}` : ""}`);
      return {
        exitCode: r.outcome === "aborted" ? 1 : 0,
        mode: "fix",
        outcome: r.outcome,
        reason: r.reason,
      };
    }

    if (task.mode === "scan") {
      const r = await runScan(
        {
          repo: event.repository,
          sha: task.sha,
          profile: { adapter: "unknown", commands: { verify: [] }, packageRoots: [] },
          commands: [],
          reports: {},
          metrics: {},
          findings: [],
        },
        {
          llm,
          audit,
          manifest,
          createIssue: async (input) => {
            await host.createIssue({ title: input.title, body: input.body });
          },
        },
      );
      say(`scan: outcome=${r.outcome} issues=${r.issues}${r.reason ? ` reason=${r.reason}` : ""}`);
      return { exitCode: r.outcome === "aborted" ? 1 : 0, mode: "scan", outcome: r.outcome, reason: r.reason };
    }

    if (task.mode === "triage") {
      say("::notice::triage mode not implemented in v1");
      return { exitCode: 0, mode: "triage", outcome: "not-implemented" };
    }

    say(`::notice::mode ${task.mode} has no runner`);
    return { exitCode: 0, mode: task.mode, outcome: "skipped" };
  } catch (err) {
    // Fail-closed surfaces as exit 1 — audit records were already written
    // by the orchestrators; the agent never acts on partial output.
    say(`::error::${String(err)}`);
    return { exitCode: 1, mode: task.mode, outcome: "fail-closed", reason: String(err) };
  }
}
