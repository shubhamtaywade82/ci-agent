import { createHash } from "node:crypto";

/** sha256 hex digest of a string. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 hex digest of raw bytes. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Stable fingerprint for a finding: content over coordinates, so an
 * unchanged issue re-reported on a later run dedupes even when line
 * numbers shift. Truncated to 16 hex chars for compact ledgers.
 */
export function findingFingerprint(f: {
  source: string;
  severity: string;
  path?: string;
  line?: number;
  message: string;
}): string {
  return sha256([f.source, f.severity, f.path ?? "-", f.message].join("|")).slice(0, 16);
}

/** Rough token estimate: ~4 characters per token, clamped at zero. */
export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

/** Truncate a string to `max` chars with an explicit marker. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 15)) + `…[truncated ${text.length - max} chars]`;
}
