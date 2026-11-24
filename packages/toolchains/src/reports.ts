/**
 * Report parsers: JUnit XML, lcov coverage, SARIF 2.1.0.
 *
 * Parsers are deliberately defensive: malformed input yields empty
 * results (with the failure visible in the returned diagnostics), never
 * a throw — a corrupt report must not abort a deterministic scan.
 */

import { XMLParser } from "fast-xml-parser";
import type { Finding } from "@nemesis-oss/ci-agent-core";
import { findingFingerprint } from "@nemesis-oss/ci-agent-core";

// ---------------------------------------------------------------------------
// JUnit XML
// ---------------------------------------------------------------------------

export interface JUnitTestCase {
  "@_classname"?: string;
  "@_name"?: string;
  "@_time"?: number | string;
  failure?: { "#text"?: string; "@_message"?: string; "@_type"?: string } | string;
  error?: { "#text"?: string; "@_message"?: string; "@_type"?: string } | string;
  skipped?: unknown;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

export interface JunitParseResult {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  time?: number;
  failedCaseNames: string[];
  findings: Finding[];
}

export function parseJUnit(xml: string): JunitParseResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
  });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return emptyJunit();
  }
  const root = (doc.testsuites ?? doc.testsuite) as Record<string, unknown> | undefined;
  if (!root) return emptyJunit();

  // Suite shape varies: <testsuites><testsuite/>…, a single bare
  // <testsuite>, or <testsuites> with direct <testcase> children. Flatten
  // every variant into a list of suite objects.
  const suites: Record<string, unknown>[] = [];
  if (doc.testsuites) {
    const inner = root.testsuite;
    if (Array.isArray(inner)) suites.push(...(inner as Record<string, unknown>[]));
    else if (inner && typeof inner === "object") suites.push(inner as Record<string, unknown>);
    // `testsuites` may itself carry testcase children (non-standard but seen).
    if (Array.isArray(root.testcase) || (root.testcase && typeof root.testcase === "object")) {
      suites.push(root);
    }
  } else {
    suites.push(root); // single <testsuite> root
  }

  const out: JunitParseResult = {
    tests: numberOrZero((root as { "@_tests"?: number | string })["@_tests"]),
    failures: numberOrZero((root as { "@_failures"?: number | string })["@_failures"]),
    errors: numberOrZero((root as { "@_errors"?: number | string })["@_errors"]),
    skipped: numberOrZero((root as { "@_skipped"?: number | string })["@_skipped"]),
    failedCaseNames: [],
    findings: [],
  };

  for (const suite of suites) {
    const cases = (suite.testcase ?? []) as JUnitTestCase | JUnitTestCase[];
    const caseList = Array.isArray(cases) ? cases : [cases];
    for (const tc of caseList) {
      if (!tc || typeof tc !== "object") continue;
      const name = stringField(tc as Record<string, unknown>, "@_name");
      const classname = stringField(tc as Record<string, unknown>, "@_classname");
      if (tc.failure !== undefined || tc.error !== undefined) {
        const label = `${classname} ${name}`.trim();
        out.failedCaseNames.push(label);
        const message = extractFailureMessage(tc);
        out.findings.push({
          id: `junit-${out.findings.length}`,
          source: "test",
          severity: "major",
          fingerprint: findingFingerprint({ source: "test", severity: "major", message }),
          evidenceRefs: [label],
          message,
        });
      }
    }
  }
  return out;
}

function emptyJunit(): JunitParseResult {
  return { tests: 0, failures: 0, errors: 0, skipped: 0, failedCaseNames: [], findings: [] };
}

function numberOrZero(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function extractFailureMessage(tc: JUnitTestCase): string {
  const f = tc.failure ?? tc.error;
  if (typeof f === "string") return f.slice(0, 500);
  if (f && typeof f === "object") {
    return String(f["@_message"] ?? f["#text"] ?? "test failure").slice(0, 500);
  }
  return "test failure";
}

// ---------------------------------------------------------------------------
// lcov coverage
// ---------------------------------------------------------------------------

export interface LcovParseResult {
  coverage: number | undefined;
  covered: number;
  hit: number;
  filesMissingCoverage: { file: string; lineHit: number; lineFound: number }[];
}

export function parseLcov(text: string): LcovParseResult {
  let covered = 0;
  let hit = 0;
  const missing: { file: string; lineHit: number; lineFound: number }[] = [];
  let currentFile = "";
  let currentHit: number | null = null;
  let currentFound: number | null = null;
  let reported = false;

  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("SF:")) {
      currentFile = t.slice(3).trim();
      currentHit = null;
      currentFound = null;
      reported = false;
    } else if (t.startsWith("LF:")) {
      currentFound = Number(t.slice(3)) || 0;
      covered += currentFound;
      reported = false;
    } else if (t.startsWith("LH:")) {
      currentHit = Number(t.slice(3)) || 0;
      hit += currentHit;
    } else if (t.startsWith("end_of_record")) {
      if (!reported && currentFile && currentHit !== null && currentFound !== null && currentHit < currentFound) {
        missing.push({ file: currentFile, lineHit: currentHit, lineFound: currentFound });
        reported = true;
      }
      currentHit = null;
      currentFound = null;
    }
  }
  const coverage = covered > 0 ? hit / covered : undefined;
  return { coverage, covered, hit, filesMissingCoverage: missing };
}

// ---------------------------------------------------------------------------
// SARIF 2.1.0 (CodeQL/Semgrep/gitleaks shape)
// ---------------------------------------------------------------------------

export interface SarifParseResult {
  findings: Finding[];
  ruleIds: string[];
}

export function parseSarif(json: string): SarifParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return { findings: [], ruleIds: [] };
  }
  const runs = (doc as { runs?: unknown[] })?.runs;
  if (!Array.isArray(runs)) return { findings: [], ruleIds: [] };

  const findings: Finding[] = [];
  const ruleIds: string[] = [];
  let idx = 0;
  for (const run of runs) {
    const results = (run as { results?: unknown[] })?.results;
    if (!Array.isArray(results)) continue;
    const rules = extractRuleMap((run as { tool?: { driver?: { rules?: unknown[] } } })?.tool?.driver?.rules);
    for (const r of results) {
      const res = r as {
        ruleId?: string;
        level?: string;
        message?: { text?: string };
        locations?: { physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }[];
      };
      const path = res.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
      const line = res.locations?.[0]?.physicalLocation?.region?.startLine;
      const message = res.message?.text ?? res.ruleId ?? "sarif result";
      const severity = sarifLevel(res.level);
      const ruleId = res.ruleId ?? "unknown-rule";
      ruleIds.push(ruleId);
      findings.push({
        id: `sarif-${idx}`,
        source: "security",
        severity,
        fingerprint: findingFingerprint({ source: "security", severity, path, message }),
        path,
        line,
        evidenceRefs: [ruleId],
        message,
      });
      idx++;
    }
  }
  return { findings, ruleIds };
}

function extractRuleMap(rules: unknown[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(rules)) return map;
  for (const r of rules) {
    const rule = r as { id?: string; shortDescription?: { text?: string } };
    if (rule?.id) map.set(rule.id, rule.shortDescription?.text ?? rule.id);
  }
  return map;
}

function sarifLevel(level: string | undefined): "blocker" | "major" | "minor" | "nit" | "info" {
  switch (level) {
    case "error":
      return "major";
    case "warning":
      return "minor";
    case "note":
      return "nit";
    case "none":
      return "info";
    default:
      return "minor";
  }
}
