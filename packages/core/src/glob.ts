/**
 * Deterministic glob matching for policy allow/deny/redact path lists.
 *
 * A deliberately small, documented grammar — sufficient for manifest
 * policy lists and easy to reason about in tests:
 *
 *   double-star as a full path segment matches zero or more directories
 *         (src followed by double-star; double-star/package-lock.json;
 *          double-star/migrations/double-star)
 *   single star  any characters except the separator, within one segment
 *   question     exactly one character except the separator
 *
 * Anchoring: a pattern that contains the separator matches from the
 * repository root. A pattern without the separator matches the basename
 * at any depth (for example *.env).
 * Matching is case-sensitive; paths are root-relative POSIX.
 */

const SEPARATOR = "/";

/** Convert one pattern to a RegExp over root-relative POSIX paths. */
export function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.includes(SEPARATOR);

  // Single pass: walk the pattern, translating glob tokens to regex atoms
  // and escaping everything else. Doing the substitutions inline (instead
  // of string replace) keeps inserted atoms from being re-processed.
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        const prevIsSep = i === 0 || pattern[i - 1] === SEPARATOR;
        const after = pattern[i + 2];
        if (prevIsSep && (after === undefined || after === SEPARATOR)) {
          if (after === undefined) {
            // Trailing whole-segment `**`: everything below the prefix,
            // at least one character, at least one separator.
            body += ".+";
            i += 1;
            continue;
          }
          // Interior/leading `**/`: zero or more full directory segments
          // (the following separator is consumed by the atom).
          body += "(?:[^/]+/)*";
          i += 2;
          continue;
        }
        body += "[^/]*"; // `**` inside a segment degrades to `*`
        i += 1;
        continue;
      }
      body += "[^/]*";
      continue;
    }
    if (c === "?") {
      body += "[^/]";
      continue;
    }
    body += escapeRegex(c);
  }

  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(prefix + body + "$");
}

function escapeRegex(c: string): string {
  return /[a-zA-Z0-9_/-]/.test(c) ? c : "\\" + c;
}

/** First pattern in `patterns` that matches `path`, or null. */
export function matchPattern(path: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    if (patternToRegex(pattern).test(path)) return pattern;
  }
  return null;
}

/** True when `path` matches any pattern in `patterns`. */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return matchPattern(path, patterns) !== null;
}

/**
 * Redact obvious secret shapes from text before it is sent to the LLM or
 * written to the audit log. Conservative and purely lexical: this is a
 * backstop, not a substitute for the path-based data policy.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}
