import { describe, it, expect } from "vitest";
import {
  patternToRegex,
  matchPattern,
  matchesAny,
  redactSecrets,
} from "../src/glob.js";
import { redactText, sanitizeMarkdown } from "../src/text.js";

describe("patternToRegex", () => {
  it("matches a direct path", () => {
    expect(patternToRegex("src/main.ts").test("src/main.ts")).toBe(true);
    expect(patternToRegex("src/main.ts").test("src/other.ts")).toBe(false);
  });

  it("matches single star within a segment", () => {
    const re = patternToRegex("src/*.ts");
    expect(re.test("src/main.ts")).toBe(true);
    expect(re.test("src/a/b.ts")).toBe(false); // * must not cross /
    expect(re.test("src/x.tsx")).toBe(false);
  });

  it("matches trailing double-star below a prefix", () => {
    const re = patternToRegex("src/**");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/a/b/c.ts")).toBe(true);
    expect(re.test("src")).toBe(false); // prefix itself excluded
    expect(re.test("docs/a.ts")).toBe(false);
  });

  it("matches leading double-star at any depth", () => {
    const re = patternToRegex("**/package-lock.json");
    expect(re.test("package-lock.json")).toBe(true);
    expect(re.test("packages/cli/package-lock.json")).toBe(true);
    expect(re.test("packages/cli/package.json")).toBe(false);
  });

  it("matches interior double-star across directories", () => {
    const re = patternToRegex("**/migrations/**");
    expect(re.test("db/migrations/001.sql")).toBe(true);
    expect(re.test("services/api/migrations/v2/x.sql")).toBe(true);
    expect(re.test("db/seeds/001.sql")).toBe(false);
  });

  it("matches basename patterns at any depth when no separator present", () => {
    const re = patternToRegex("*.env");
    expect(re.test(".env")).toBe(true);
    expect(re.test("config/prod.env")).toBe(true);
    expect(re.test("config/.env.production")).toBe(false); // basename must match whole pattern
    expect(re.test("config/env.txt")).toBe(false);
  });

  it("anchors dotfile patterns like **/.env* at any depth", () => {
    const re = patternToRegex("**/.env*");
    expect(re.test(".env")).toBe(true);
    expect(re.test("apps/web/.env.local")).toBe(true);
    expect(re.test("apps/web/env")).toBe(false);
  });

  it("escapes regex metacharacters in literals", () => {
    const re = patternToRegex("a.b+c.ts");
    expect(re.test("a.b+c.ts")).toBe(true);
    expect(re.test("axb+c.ts")).toBe(false); // dot not a wildcard
    expect(re.test("a.b+c.ts")).toBe(true);
  });

  it("handles question mark as exactly one non-separator char", () => {
    const re = patternToRegex("file?.ts");
    expect(re.test("file1.ts")).toBe(true);
    expect(re.test("file12.ts")).toBe(false);
    expect(re.test("file.ts")).toBe(false);
  });
});

describe("matchPattern / matchesAny", () => {
  it("returns the first matching pattern", () => {
    const patterns = ["docs/**", "**/*.md"];
    expect(matchPattern("docs/readme.md", patterns)).toBe("docs/**");
    expect(matchPattern("readme.md", patterns)).toBe("**/*.md");
    expect(matchPattern("src/main.ts", patterns)).toBeNull();
  });

  it("booleans over pattern lists (deny/allow policy lists)", () => {
    const deny = [".github/**", "**/package-lock.json", "**/.env*"];
    expect(matchesAny(".github/workflows/ci.yml", deny)).toBe(true);
    expect(matchesAny("packages/cli/package-lock.json", deny)).toBe(true);
    expect(matchesAny("apps/web/.env.local", deny)).toBe(true);
    expect(matchesAny("src/main.ts", deny)).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("redacts bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer abcdef1234567890abcdef");
    expect(out).not.toContain("abcdef1234567890");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts github and openai style tokens", () => {
    expect(
      redactSecrets("token ghp_0123456789abcdefghij0123456789abcdefghij"),
    ).toContain("[REDACTED]");
    expect(redactSecrets("sk-0123456789abcdef0123")).toContain("[REDACTED]");
  });

  it("redacts PEM private keys", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(pem)).not.toContain("abc");
  });

  it("leaves ordinary text untouched", () => {
    const text = "the function add(a, b) returns a + b";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("redactText / sanitizeMarkdown (ported hardening)", () => {
  it("redacts key=value credential shapes", () => {
    expect(redactText('api_key = "abcd1234efgh5678"')).toContain("[REDACTED]");
    expect(redactText("password: supersecretvalue123")).toContain("[REDACTED]");
  });

  it("sanitizeMarkdown escapes HTML, mentions and images", () => {
    const out = sanitizeMarkdown("<script>@admin ![img](http://x)</script>");
    expect(out).toContain("&lt;script>");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("@admin");
    expect(out).toContain("!\\[img]");
  });
});
