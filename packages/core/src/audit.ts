/**
 * Audit trail: append-only JSONL event log with a default filesystem store.
 *
 * Every LLM consultation, policy decision, and applied action is recorded
 * with prompt version, input/output hashes, usage, and outcome. Records are
 * written in arrival order; the file is the artifact uploaded by CI.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentAuditEvent, AuditStore } from "./types.js";

export class FileAuditStore implements AuditStore {
  constructor(private readonly path: string) {}

  async append(event: AgentAuditEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const line = JSON.stringify(this.sanitize(event)) + "\n";
    await appendFile(this.path, line, "utf8");
  }

  /**
   * Defense in depth: strip anything that looks like a credential from the
   * serialized record. Structured detail fields are already expected to be
   * hash-only, but a copy-paste into `detail` must not leak.
   */
  private sanitize(event: AgentAuditEvent): AgentAuditEvent {
    const redacted = JSON.stringify(event).replace(
      /(ghp_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|ghu_[A-Za-z0-9]+|ghs_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})/g,
      "[REDACTED]",
    );
    return JSON.parse(redacted) as AgentAuditEvent;
  }
}

export class InMemoryAuditStore implements AuditStore {
  readonly events: AgentAuditEvent[] = [];
  async append(event: AgentAuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

/** Helper to stamp the common fields of an event. */
export function auditEvent(
  repo: string,
  mode: AgentAuditEvent["mode"],
  task: string,
  event: AgentAuditEvent["event"],
  extra: Partial<AgentAuditEvent> = {},
): AgentAuditEvent {
  return {
    at: new Date().toISOString(),
    repo,
    mode,
    task,
    event,
    ...extra,
  };
}

/** sha256 hex of a string — shared hashing helper for audit records. */
export function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
