/**
 * Text hygiene: redaction of credential-shaped substrings before text leaves
 * the runner, and markdown sanitization of model output posted to GitHub.
 *
 * Redaction is a lexical backstop, not the primary control — the path-based
 * data policy decides what may be sent at all. Sanitization exists because
 * model output is untrusted: mentions, raw HTML/comments and images are
 * neutralized so a review comment cannot ping users or inject markup.
 */

const SECRET_VALUE =
  /(password|secret|token|api[_-]?key)(\s*[:=]\s*)(?:"[^"\s]{8,}"|'[^'\s]{8,}'|[A-Za-z0-9_\-./+=]{16,}(?![\w(]))/gi;

/** Masks credential-shaped substrings before text leaves the runner. */
export function redactText(value: string): string {
  return value
    .replace(/(gh[pousr]_[A-Za-z0-9_]{20,})/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/(ollama_[A-Za-z0-9_-]{16,})/g, "[REDACTED_API_KEY]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[REDACTED]")
    .replace(SECRET_VALUE, "$1$2[REDACTED]");
}

/**
 * Neutralizes mentions, raw HTML/comments and images in model output posted
 * to GitHub: `<` becomes `&lt;`, `@` gains a zero-width space, `![` escapes
 * the image syntax.
 */
export function sanitizeMarkdown(value: string): string {
  return value
    .replaceAll("<", "&lt;")
    .replaceAll("@", "@​")
    .replaceAll("![", "!\\[");
}
