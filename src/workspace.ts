import { readdir, readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { redactText } from "./text.js";
import type { AgentConfig } from "./config.js";
import type { EvidenceBundle, Finding, ProjectProfile } from "./types.js";

const ROOT_MARKERS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Dockerfile",
  "Makefile",
  "turbo.json",
  "nx.json",
  "pnpm-workspace.yaml",
]);
const LANGUAGE_MARKERS: [string, string[]][] = [
  ["python", ["pyproject.toml", "requirements.txt", "Pipfile"]],
  ["go", ["go.mod"]],
  ["rust", ["Cargo.toml"]],
  ["jvm", ["pom.xml", "build.gradle", "build.gradle.kts"]],
];
const PACKAGE_MANAGER_MARKERS: [string, string[]][] = [
  ["pnpm", ["pnpm-lock.yaml"]],
  ["yarn", ["yarn.lock"]],
  ["bun", ["bun.lock", "bun.lockb"]],
  ["npm", ["package-lock.json", "package.json"]],
];
const KNOWN_FRAMEWORKS = ["react", "next", "vite", "express", "fastify", "@nestjs/core", "vue", "svelte"];
const MONOREPO_MARKERS = ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"];

const isDotnet = (name: string): boolean => name.endsWith(".sln") || name.endsWith(".csproj");
const hasAny = (names: string[], markers: string[]): boolean => markers.some((marker) => names.includes(marker));

async function detectNodeFrameworks(root: string): Promise<string[]> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    return KNOWN_FRAMEWORKS.filter((key) => deps[key]);
  } catch {
    // A malformed manifest stays a verify-job concern.
    return [];
  }
}

export async function discoverProject(root = process.cwd()): Promise<ProjectProfile> {
  const names = await readdir(root);
  const isNode = names.includes("package.json");
  const languages = LANGUAGE_MARKERS.filter(([, markers]) => hasAny(names, markers)).map(([language]) => language);
  if (isNode) languages.unshift("javascript", "typescript");
  if (names.some(isDotnet)) languages.push("dotnet");
  const manager = PACKAGE_MANAGER_MARKERS.find(([, markers]) => hasAny(names, markers));
  const frameworks = isNode ? await detectNodeFrameworks(root) : [];
  if (names.includes("Dockerfile")) frameworks.push("docker");
  return {
    languages,
    packageManagers: manager ? [manager[0]] : [],
    frameworks,
    rootFiles: names.filter((name) => ROOT_MARKERS.has(name) || isDotnet(name)),
    monorepo: hasAny(names, MONOREPO_MARKERS),
  };
}
export function redactCommandOutput(value: string, passEnv: string[] = []): string {
  let result = redactText(value);
  for (const key of passEnv) {
    const secret = process.env[key];
    if (secret && secret.length >= 4) result = result.split(secret).join("[REDACTED_ENV:" + key + "]");
  }
  return result;
}
function failureFinding(
  name: string,
  result: { code: number; output: string },
  sha: string,
  passEnv: string[],
): Finding {
  const excerpt = redactCommandOutput(result.output, passEnv).slice(0, 1500);
  return {
    id: "tool-" + name + "-" + sha.slice(0, 8),
    source: name === "verify" ? "ci" : "test",
    severity: "high",
    fingerprint: createHash("sha256")
      .update(name + result.output)
      .digest("hex"),
    message: "Configured command " + name + " failed with exit code " + result.code + ". Evidence: " + excerpt,
    evidenceRefs: ["command:" + name],
    recommendation: "Inspect the failing command and add a regression test for the root cause.",
  };
}

export async function collectEvidence(input: {
  config: AgentConfig;
  repository: string;
  sha: string;
  root?: string;
}): Promise<EvidenceBundle> {
  const { toolchain } = input.config;
  const root = input.root ?? process.cwd();
  const profile = await discoverProject(root);
  const findings: Finding[] = [];
  const metrics: Record<string, number> = { configuredCommands: Object.keys(toolchain.commands).length };
  for (const [name, argv] of Object.entries(toolchain.commands)) {
    const result = await runCommand(argv, root, toolchain.commandTimeoutMs, toolchain.passEnv);
    metrics["command." + name + ".exitCode"] = result.code;
    if (result.code !== 0) findings.push(failureFinding(name, result, input.sha, toolchain.passEnv));
  }
  return { repository: input.repository, sha: input.sha, profile, findings, metrics };
}

const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
  "LANG",
  "LC_ALL",
];
const OUTPUT_TAIL_CHARS = 20000;
const KILL_GRACE_MS = 5000;

// Secrets never reach project commands unless the repo owner lists them in passEnv.
function buildCommandEnv(passEnv: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...BASE_ENV_KEYS, ...passEnv]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.CI = "true";
  return env;
}

function enforceDeadline(child: ChildProcess, timeoutMs: number): { clear: () => void; timedOut: () => boolean } {
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  }, timeoutMs);
  return {
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    },
  };
}

function collectTail(child: ChildProcess): () => string {
  let output = "";
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output;
}

export function runCommand(
  argv: string[],
  cwd: string,
  timeoutMs = 120000,
  passEnv: string[] = [],
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = argv;
    if (!executable) return resolve({ code: 1, output: "Missing executable" });
    const child = spawn(executable, args, { cwd, env: buildCommandEnv(passEnv), shell: false, windowsHide: true });
    const deadline = enforceDeadline(child, timeoutMs);
    const output = collectTail(child);
    child.on("error", (error) => {
      deadline.clear();
      reject(error);
    });
    child.on("close", (code) => {
      deadline.clear();
      if (deadline.timedOut())
        return resolve({ code: 124, output: output() + "\n[CI Agent] Command timed out after " + timeoutMs + "ms." });
      resolve({ code: code ?? 1, output: output() });
    });
  });
}
