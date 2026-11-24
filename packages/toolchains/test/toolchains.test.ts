import { describe, it, expect } from "vitest";
import { detectToolchain, mergeCommands } from "../src/detect.js";
import { parseJUnit, parseLcov, parseSarif } from "../src/reports.js";
import type { RepoSnapshot } from "@nemesis-oss/ci-agent-core";

function snap(paths: string[]): RepoSnapshot {
  return { repo: "acme/widget", defaultBranch: "main", sha: "abc", paths };
}

describe("detectToolchain", () => {
  it("detects npm from package.json + package-lock.json", () => {
    const p = detectToolchain(snap(["package.json", "package-lock.json", "src/main.ts"]))!;
    expect(p.adapter).toBe("node-npm");
    expect(p.commands.install).toBe("npm ci");
    expect(p.commands.verify.length).toBeGreaterThan(2);
  });

  it("prefers pnpm when pnpm-lock.yaml exists", () => {
    const p = detectToolchain(snap(["package.json", "pnpm-lock.yaml"]))!;
    expect(p.adapter).toBe("node-pnpm");
    expect(p.commands.install).toContain("pnpm");
  });

  it("detects yarn, bun", () => {
    expect(detectToolchain(snap(["package.json", "yarn.lock"]))!.adapter).toBe("node-yarn");
    expect(detectToolchain(snap(["package.json", "bun.lockb"]))!.adapter).toBe("bun");
  });

  it("detects python families by lockfile specificity", () => {
    expect(detectToolchain(snap(["pyproject.toml", "uv.lock"]))!.adapter).toBe("python-uv");
    expect(detectToolchain(snap(["pyproject.toml", "poetry.lock"]))!.adapter).toBe("python-poetry");
    expect(detectToolchain(snap(["requirements.txt", "pyproject.toml"]))!.adapter).toBe("python-pip");
    expect(detectToolchain(snap(["requirements.txt"]))!.adapter).toBe("python-pip");
  });

  it("detects go, rust, maven, gradle", () => {
    expect(detectToolchain(snap(["go.mod"]))!.adapter).toBe("go");
    expect(detectToolchain(snap(["Cargo.toml"]))!.adapter).toBe("rust");
    expect(detectToolchain(snap(["pom.xml"]))!.adapter).toBe("jvm-maven");
    expect(detectToolchain(snap(["build.gradle", "gradlew"]))!.adapter).toBe("jvm-gradle");
    expect(detectToolchain(snap(["build.gradle.kts", "gradlew"]))!.adapter).toBe("jvm-gradle");
  });

  it("detects dotnet by solution/project globs", () => {
    expect(detectToolchain(snap(["Acme.sln", "src/A.csproj"]))!.adapter).toBe("dotnet");
    expect(detectToolchain(snap(["src/App.csproj"]))!.adapter).toBe("dotnet");
  });

  it("detects docker and terraform and make", () => {
    expect(detectToolchain(snap(["Dockerfile"]))!.adapter).toBe("docker");
    expect(detectToolchain(snap(["main.tf", "variables.tf"]))!.adapter).toBe("terraform");
    expect(detectToolchain(snap(["Makefile"]))!.adapter).toBe("generic-make");
  });

  it("returns null for unknown stacks instead of guessing", () => {
    expect(detectToolchain(snap(["README.md", "docs/guide.md"]))).toBeNull();
    expect(detectToolchain(snap([]))).toBeNull();
  });

  it("finds npm-workspaces package roots in monorepos", () => {
    const p = detectToolchain(
      snap(["package.json", "package-lock.json", "packages/core/package.json", "packages/cli/package.json"]),
    )!;
    expect(p.packageRoots).toContain("packages/core");
    expect(p.packageRoots).toContain("packages/cli");
    expect(p.packageRoots).toContain(".");
  });
});

describe("mergeCommands", () => {
  it("manifest overrides win over detected commands", () => {
    const merged = mergeCommands(
      { install: "npm ci", verify: ["npm test"] },
      { verify: ["npm run typecheck", "npm test"] },
    );
    expect(merged.verify).toEqual(["npm run typecheck", "npm test"]);
    expect(merged.install).toBe("npm ci");
  });

  it("falls back to detected when no overrides given", () => {
    const merged = mergeCommands({ install: "go mod download", verify: ["go test ./..."] });
    expect(merged.verify).toEqual(["go test ./..."]);
  });

  it("handles no detection at all", () => {
    const merged = mergeCommands(null, { verify: ["make verify"] });
    expect(merged.verify).toEqual(["make verify"]);
    expect(merged.install).toBeUndefined();
  });
});

describe("parseJUnit", () => {
  const XML = `<?xml version="1.0"?>
<testsuites tests="3" failures="1" errors="0" skipped="1">
  <testsuite name="core" tests="3" failures="1" errors="0" skipped="1">
    <testcase classname="core.math" name="add" time="0.01">
      <failure message="expected 5 to be 3" type="AssertionError">stack</failure>
    </testcase>
    <testcase classname="core.math" name="sub" time="0.01"/>
    <testcase classname="core.math" name="skipped one">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`;

  it("counts tests, failures, skipped", () => {
    const r = parseJUnit(XML);
    expect(r.tests).toBe(3);
    expect(r.failures).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.failedCaseNames).toEqual(["core.math add"]);
  });

  it("creates findings with messages", () => {
    const r = parseJUnit(XML);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.message).toContain("expected 5 to be 3");
    expect(r.findings[0]!.source).toBe("test");
    expect(r.findings[0]!.severity).toBe("major");
  });

  it("survives malformed XML without throwing", () => {
    const r = parseJUnit("<not-xml");
    expect(r.tests).toBe(0);
    expect(r.findings).toEqual([]);
  });
});

describe("parseLcov", () => {
  const LCOV = `
TN:
SF:src/a.ts
DA:1,1
DA:2,0
LF:2
LH:1
end_of_record
SF:src/b.ts
DA:1,1
LF:1
LH:1
end_of_record
`;

  it("computes total coverage", () => {
    const r = parseLcov(LCOV);
    expect(r.covered).toBe(3);
    expect(r.hit).toBe(2);
    expect(r.coverage).toBeCloseTo(2 / 3, 5);
  });

  it("lists files with missing coverage", () => {
    const r = parseLcov(LCOV);
    expect(r.filesMissingCoverage).toHaveLength(1);
    expect(r.filesMissingCoverage[0]!.file).toBe("src/a.ts");
  });

  it("handles empty input", () => {
    const r = parseLcov("");
    expect(r.coverage).toBeUndefined();
  });
});

describe("parseSarif", () => {
  const SARIF = JSON.stringify({
    runs: [
      {
        tool: { driver: { rules: [{ id: "no-secrets", shortDescription: { text: "secret in code" } }] } },
        results: [
          {
            ruleId: "no-secrets",
            level: "error",
            message: { text: "hardcoded token in src/a.ts" },
            locations: [
              { physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 12 } } },
            ],
          },
          {
            ruleId: "no-secrets",
            level: "warning",
            message: { text: "weak hash" },
            locations: [
              { physicalLocation: { artifactLocation: { uri: "src/b.ts" }, region: { startLine: 3 } } },
            ],
          },
        ],
      },
    ],
  });

  it("maps SARIF results to findings with severity levels", () => {
    const r = parseSarif(SARIF);
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]!.severity).toBe("major"); // error → major
    expect(r.findings[1]!.severity).toBe("minor"); // warning → minor
    expect(r.findings[0]!.path).toBe("src/a.ts");
    expect(r.findings[0]!.line).toBe(12);
    expect(r.findings[0]!.source).toBe("security");
    expect(r.ruleIds).toContain("no-secrets");
  });

  it("survives malformed JSON", () => {
    const r = parseSarif("{ broken");
    expect(r.findings).toEqual([]);
  });
});
