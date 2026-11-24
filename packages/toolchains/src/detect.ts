/**
 * Toolchain detection registry.
 *
 * Detection is signal-based (file NAMES present in the repo snapshot),
 * never content-based: cheap, deterministic, and no untrusted bytes are
 * parsed before policy gates run. When detection is ambiguous, the most
 * specific lockfile wins (pnpm-lock.yaml beats package.json etc.).
 * Unknown stacks are NOT guessed — the caller requires explicit commands
 * in the manifest (adapter: auto → no match → error, not a silent default).
 */

import type {
  PackageManagerFamily,
  ProjectProfile,
  RepoSnapshot,
  ToolchainAdapter,
  ToolchainCommands,
} from "@nemesis-oss/ci-agent-core";

interface Signal {
  /** Marker files — root-relative presence check. */
  files: string[];
  commands: ToolchainCommands;
  /** Optional package-root discovery for monorepos (npm family only). */
  monorepo?: (paths: readonly string[]) => string[];
}

const REGISTRY: { id: PackageManagerFamily; signals: Signal[] }[] = [
  {
    id: "node-npm",
    signals: [
      {
        files: ["package.json", "package-lock.json"],
        commands: { install: "npm ci", verify: ["npm ci", "npm run typecheck", "npm test", "npm run build"] },
      },
    ],
  },
  {
    id: "node-pnpm",
    signals: [
      {
        files: ["package.json", "pnpm-lock.yaml"],
        commands: { install: "pnpm install --frozen-lockfile", verify: ["pnpm install --frozen-lockfile", "pnpm run typecheck", "pnpm test", "pnpm run build"] },
      },
    ],
  },
  {
    id: "node-yarn",
    signals: [
      {
        files: ["package.json", "yarn.lock"],
        commands: { install: "yarn install --immutable", verify: ["yarn install --immutable", "yarn typecheck", "yarn test", "yarn build"] },
      },
    ],
  },
  {
    id: "bun",
    signals: [
      {
        files: ["package.json", "bun.lockb"],
        commands: { install: "bun install --frozen-lockfile", verify: ["bun install --frozen-lockfile", "bun run typecheck", "bun test", "bun run build"] },
      },
    ],
  },
  {
    id: "python-uv",
    signals: [
      {
        files: ["pyproject.toml", "uv.lock"],
        commands: { install: "uv sync --frozen", verify: ["uv sync --frozen", "uv run pytest", "uv run ruff check .", "uv run ruff format --check ."] },
      },
    ],
  },
  {
    id: "python-poetry",
    signals: [
      {
        files: ["pyproject.toml", "poetry.lock"],
        commands: { install: "poetry install", verify: ["poetry install", "poetry run pytest", "poetry run ruff check ."] },
      },
    ],
  },
  {
    id: "python-pip",
    signals: [
      {
        files: ["pyproject.toml", "requirements.txt"],
        commands: { install: "python -m pip install -r requirements.txt", verify: ["python -m pip install -r requirements.txt", "python -m pytest", "python -m ruff check ."] },
      },
      {
        files: ["requirements.txt"],
        commands: { install: "python -m pip install -r requirements.txt", verify: ["python -m pip install -r requirements.txt", "python -m pytest"] },
      },
    ],
  },
  {
    id: "go",
    signals: [
      {
        files: ["go.mod"],
        commands: { install: "go mod download", verify: ["go mod download", "go build ./...", "go test ./...", "go vet ./..."] },
      },
    ],
  },
  {
    id: "rust",
    signals: [
      {
        files: ["Cargo.toml"],
        commands: { install: "cargo fetch", verify: ["cargo fetch", "cargo build --locked", "cargo test --locked", "cargo clippy --locked"] },
      },
    ],
  },
  {
    id: "jvm-maven",
    signals: [
      {
        files: ["pom.xml"],
        commands: { install: "mvn -B dependency:go-offline", verify: ["mvn -B verify"] },
      },
    ],
  },
  {
    id: "jvm-gradle",
    signals: [
      {
        files: ["build.gradle", "gradlew"],
        commands: { install: "./gradlew dependencies --no-daemon", verify: ["./gradlew build --no-daemon"] },
      },
      {
        files: ["build.gradle.kts", "gradlew"],
        commands: { install: "./gradlew dependencies --no-daemon", verify: ["./gradlew build --no-daemon"] },
      },
    ],
  },
  {
    id: "dotnet",
    signals: [
      {
        files: ["*.sln"],
        commands: { install: "dotnet restore", verify: ["dotnet restore", "dotnet build --no-restore", "dotnet test --no-restore"] },
      },
      {
        files: ["*.csproj"],
        commands: { install: "dotnet restore", verify: ["dotnet restore", "dotnet build --no-restore", "dotnet test --no-restore"] },
      },
    ],
  },
  {
    id: "docker",
    signals: [
      {
        files: ["Dockerfile"],
        commands: { install: "docker build -t ci-agent-scan .", verify: ["docker build -t ci-agent-scan ."] },
      },
    ],
  },
  {
    id: "terraform",
    signals: [
      {
        files: ["*.tf"],
        commands: { install: "terraform init", verify: ["terraform init -backend=false", "terraform validate"] },
      },
    ],
  },
  {
    id: "generic-make",
    signals: [
      {
        files: ["Makefile"],
        commands: { install: "make setup", verify: ["make verify"] },
      },
    ],
  },
];

/** npm-workspaces monorepo package roots. */
function npmPackageRoots(paths: readonly string[]): string[] {
  const roots = new Set<string>(["."]);
  for (const p of paths) {
    if (p === "package.json") continue;
    if (p.startsWith("packages/") && p.endsWith("package.json")) {
      roots.add(p.slice(0, -"package.json".length - 1));
    }
    if (p === "pnpm-workspace.yaml" || p === "lerna.json" || p === "turbo.json") {
      // workspace config implies multi-package repo; packages/ covered above
    }
  }
  return [...roots].sort();
}

export function detectToolchain(repo: RepoSnapshot): ProjectProfile | null {
  const pathSet = new Set(repo.paths);

  // Specificity order: lockfile-bearing families before bare package.json.
  for (const family of REGISTRY) {
    for (const signal of family.signals) {
      const hasAll = signal.files.every((f) => matchFile(pathSet, f));
      if (!hasAll) continue;
      const packageRoots =
        family.id === "node-npm" || family.id === "node-pnpm" || family.id === "node-yarn"
          ? npmPackageRoots(repo.paths)
          : ["."];
      return {
        adapter: family.id,
        commands: signal.commands,
        packageRoots,
      };
    }
  }
  return null;
}

function matchFile(pathSet: Set<string>, marker: string): boolean {
  if (marker.includes("*")) {
    const pattern = marker;
    for (const p of pathSet) {
      const base = p.split("/").pop() ?? p;
      if (globSimple(base, pattern)) return true;
    }
    return false;
  }
  return pathSet.has(marker);
}

function globSimple(name: string, pattern: string): boolean {
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$",
  );
  return re.test(name);
}

/** Registry-backed adapter for the ToolchainAdapter port. */
export class RegistryToolchainAdapter implements ToolchainAdapter {
  readonly id: PackageManagerFamily = "unknown";

  async detect(repo: RepoSnapshot): Promise<ProjectProfile | null> {
    return detectToolchain(repo);
  }
}

/** Merge manifest command overrides over detected commands. */
export function mergeCommands(
  detected: ToolchainCommands | null,
  overrides?: { install?: string; verify?: string[]; lint?: string; formatCheck?: string },
): ToolchainCommands {
  const base: ToolchainCommands = detected ?? { verify: [] };
  return {
    install: overrides?.install ?? base.install,
    verify: overrides?.verify ?? base.verify,
    lint: overrides?.lint ?? base.lint,
    formatCheck: overrides?.formatCheck ?? base.formatCheck,
  };
}
