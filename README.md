# @nemesis-oss/ci-agent

Policy-gated CI agents for GitHub repositories: pull-request review, CI failure
diagnosis with bounded draft autofix PRs, and scheduled engineering-improvement
scans. Uses the Nemesis Ollama SDK for Ollama Cloud inference.

> **Operating principle:** deterministic tools establish facts; the model explains
> and proposes; policy gates actions; normal CI and human review decide acceptance.
> The agent never approves or merges a pull request.

```
One agent core. One Ollama SDK adapter. One GitHub Action.
Many repo policy manifests. Many toolchain adapters. Zero repo-specific agent logic.
```

## Packages (npm workspaces monorepo)

| Package | Contents |
| --- | --- |
| `packages/core` | Repo-agnostic orchestrators (review / fix / scan), policy engine (fail-closed, autonomy ceilings, path allow/deny globs, budgets), manifest, JSON schemas (Ajv), unified-diff parser with right-side anchoring, evidence minimizer, audit JSONL, task router. **No adapter SDKs** — enforced by `packages/core/test/architecture.test.ts`. |
| `packages/ollama-cloud` | The only package coupled to `@nemesis-oss/ollama-sdk` (`OllamaClient`, Bearer auth, timeout/retry). The SDK fail-fasts `format` on cloud endpoints, so JSON is enforced via prompt + client-side Ajv validation — fail-closed. |
| `packages/github` | Octokit `RepoHost` + GitHub Actions `CiProvider` (failed-job log zip, Git Data API commits, COMMENT-only reviews, marker-comment ledger). |
| `packages/toolchains` | Detection registry (npm/pnpm/yarn/bun/uv/poetry/pip/go/cargo/maven/gradle/dotnet/docker/terraform/make) + JUnit/lcov/SARIF parsers. |
| `packages/cli` | CLI (`ci-agent run | doctor`), composition root, exit-code contract. |
| `action/` | GitHub Action (`node20`, pre-bundled `dist/index.js` — no runtime `npm install`). |

## Features

- **PR review:** reads changed-file patches through the GitHub API, filters
  protected paths, chunks context, validates structured findings, checks reported
  files and added lines, deduplicates via a marker-comment ledger, and posts one
  COMMENT review. Fork and draft PRs are excluded; a dispatched expected head SHA
  is verified before the diff is sent to the model.
- **Autofix:** reacts to failed workflow runs, requires a same-repository PR,
  unchanged head SHA, explicit opt-in label and bounded attempt count; creates a
  high-confidence/low-risk patch as a **stacked draft PR against the contributor
  PR branch** (base re-verified before publishing). A deterministic branch per
  PR/head SHA prevents duplicate draft fixes. It never commits to the contributor
  branch or merges.
- **Improvement scan:** executes only explicitly configured deterministic commands
  (allowlisted environment, timeouts, redaction), records outcomes, asks the model
  to rank evidence-backed priorities and opens deduplicated issues.
- **Auditing:** JSONL records (mode 0600) include evidence hashes and decision
  metadata, never raw source or credential values.
- **Policy:** strict versioned YAML, canonical-path enforcement, allow/deny paths,
  schema validation, output budgets and explicit source-sharing approval.

## Requirements

- Node.js 24+
- GitHub Actions
- Ollama Cloud API key and model variables
- GitHub App installation token for draft autofix PR creation

## Develop (this repo)

```bash
npm ci
npm run build     # tsc -b, all packages
npm test          # offline suite, LLM port mocked, architecture boundary test
node packages/cli/dist/bin.js doctor
```

## Configuration

Create `.nemesis/ci-agent.yml`:

```yaml
version: 1
enabled: true
toolchain:
  adapter: node-npm
  commands:
    verify: ["npm", "run", "verify"]
  commandTimeoutMs: 120000
  passEnv: []
modes:
  review:
    enabled: true
    autonomy: comment
    maxChunks: 6
    maxInputTokens: 30000
  fix:
    enabled: true
    autonomy: draft-pr
    optInLabel: nemesis:autofix
    maxAttempts: 2
    maxFiles: 5
    maxFileBytes: 60000
    minConfidence: medium
  scan:
    enabled: true
    autonomy: issue
    maxFindings: 15
policy:
  autoMerge: false
  requireHumanApproval: true
  allowPaths: ["packages/**", "action/src/**", "docs/**"]
  denyPaths: [".github/**", "**/*.lock", "**/package-lock.json", "**/.env*", "**/*secret*", "**/migrations/**"]
dataPolicy:
  classification: internal
  sendSourceToCloud: false
  redactPaths: ["**/.env*", "**/*secret*", "**/credentials*"]
llm:
  provider: ollama-cloud
  reviewModelEnv: OLLAMA_MODEL_REVIEW
  fixModelEnv: OLLAMA_MODEL_FIX
  scanModelEnv: OLLAMA_MODEL_SCAN
  timeoutMs: 90000
audit:
  path: .nemesis/audit.jsonl
  uploadArtifact: true
```

Source transmission defaults to **off**. For private/internal repositories, set
`sendSourceToCloud: true` only after repository-owner approval. Public code can use
`classification: public`. Credentials are not added to model prompts.

Configured commands run with `shell: false`, a per-command timeout and a minimal
environment. GitHub/Ollama secrets are not inherited. Additional variables are
forwarded only by explicitly naming them in `toolchain.passEnv`; explicitly
forwarded values are redacted from evidence before it reaches the model.

## GitHub Actions setup

The review workflow deliberately does **not** run on `pull_request` with secrets.
It uses trusted default-branch workflow code and supports two triggers:

1. **Comment command:** write `/nemesis review` on a pull request. Only comments
   from OWNER, MEMBER or COLLABORATOR associations are accepted.
2. **GitHub App dispatch:** a trusted webhook dispatcher can send a
   `repository_dispatch` event of type `ci-agent-review` with a PR number and
   expected head SHA.

Example dispatch payload:

```json
{
  "event_type": "ci-agent-review",
  "client_payload": {
    "pr_number": 42,
    "head_sha": "0123456789abcdef0123456789abcdef01234567"
  }
}
```

The review action verifies that the PR head still matches the dispatched SHA
before sending the diff to the model. The `issue_comment` event runs workflow
code from the default branch; the workflow checks out only trusted
default-branch code and reads PR diffs through the GitHub API — it never checks
out or executes PR source.

For other repositories, use the published Action (`uses: shubhamtaywade82/ci-agent/action@v1`,
`mode: review`) or copy the included `ai-review.yml` pattern. The review workflow
needs `contents: read`, `pull-requests: write` (posting the review) and
`issues: write` permissions.

Configure repository variables/secrets:

| Name | Kind | Purpose |
|---|---|---|
| `OLLAMA_API_KEY` | Secret | Ollama Cloud API key |
| `OLLAMA_MODEL_REVIEW` | Variable | Review model tag |
| `OLLAMA_MODEL_FIX` | Variable | Autofix model tag |
| `OLLAMA_MODEL_SCAN` | Variable | Scan model tag |
| `CI_AGENT_APP_ID` | Variable | GitHub App ID for autofix |
| `CI_AGENT_APP_PRIVATE_KEY` | Secret | GitHub App private key |

For autofix, create a repository label named `nemesis:autofix` and add it only to
PRs where an automated draft fix is authorized. If the label is absent, the
workflow exits successfully without invoking Ollama or creating a branch. A stale
PR head, disabled cloud-sharing policy or exhausted retry budget also produces a
safe skip.

Install the GitHub App only on target repositories with **Actions: read,
Contents: write, Issues: read, Pull requests: write**. The autofix workflow uses
a short-lived installation token; it does not use default `GITHUB_TOKEN` for
commits, because those commits do not trigger subsequent workflows by default.

## CLI

```bash
ci-agent run      # route on the current GitHub event
ci-agent doctor   # adoption pre-flight checks
```

Library entry points:

```bash
nemesis-ci validate --config .nemesis/ci-agent.yml
nemesis-ci policy-check --config .nemesis/ci-agent.yml --paths src/index.ts,tests/index.test.ts
nemesis-ci evidence --config .nemesis/ci-agent.yml
```

## Exit codes

| code | meaning |
| --- | --- |
| 0 | success, or benign skip (disabled / non-failure run / fork / draft / no opt-in / attempt cap / duplicate) |
| 1 | fail-closed abort — LLM parse/schema/policy refusal; a human should look |
| 2 | configuration error — invalid manifest, missing env/token |

## Further documentation

- `docs/adoption.md` — step-by-step adoption guide
- `docs/manifest-reference.md` — full manifest field reference
- `docs/ARCHITECTURE.md`, `docs/THREAT-MODEL.md`, `docs/CONFIGURATION.md`, `docs/ROADMAP.md`

## Releasing

Packages are published to npm under the `@nemesis-oss` scope, in lockstep, with
provenance, via npm trusted publishing (OIDC; no npm token is stored).

- `release-please.yml` keeps a release PR open from Conventional Commits; merging
  it tags the release and calls `publish.yml`.
- `publish.yml` runs `npm run verify:release` (lint, build, tests and a tarball
  contents check) and publishes `core`, `ollama-cloud`, `github`, `toolchains`,
  then `cli`, skipping versions already on the registry.
### First publish (one-time bootstrap)

npm only lets you attach a trusted publisher to a package that already exists,
so the very first publish of each package is done by hand with your npm login
and 2FA; CI cannot do it (it fails with `ENEEDAUTH`). Local publishes cannot
produce provenance, so that flag is turned off for this one release.

```bash
npm login
git pull && npm ci --ignore-scripts && npm run verify:release
for p in core ollama-cloud github toolchains cli; do
  npm publish -w packages/$p --access public --provenance=false --otp=<code>
done
```

Publish in that order (`core` first, `cli` last). If a 2FA code expires part-way,
re-run with a fresh code; versions already published are rejected, so skip those.

Then, on npmjs.com, for each of the five packages: Settings → Trusted Publisher →
GitHub Actions, with repository `shubhamtaywade82/ci-agent`, workflow
`release-please.yml`, and no environment.

From then on, merging a release PR publishes automatically with provenance. A
failed or skipped publish can be retried from Actions → Release Please → Run
workflow, which publishes the current `main` and skips versions already on the
registry. Do not store an `NPM_TOKEN`: npm is restricting 2FA-bypass tokens, and
OIDC needs none.
