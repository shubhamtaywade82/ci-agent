# @nemesis-oss/ci-agent

Policy-gated CI agents for GitHub repositories: pull-request review, CI failure diagnosis with bounded draft autofix PRs, and scheduled engineering-improvement scans. Uses the Nemesis Ollama SDK for Ollama Cloud inference.

> **Operating principle:** deterministic tools establish facts; the model explains and proposes; policy gates actions; normal CI and human review decide acceptance. The agent never approves or merges a pull request.

## Features

- **PR review:** reads changed-file patches through the GitHub API, filters protected paths, chunks context, validates structured findings, checks reported files and added lines, deduplicates and posts one consolidated comment. Fork and draft PRs are excluded.
- **Autofix:** reacts to failed workflow runs, requires a same-repository PR, unchanged head SHA, explicit opt-in label and bounded attempt count; creates a low-risk/high-confidence patch as a stacked draft PR against the contributor PR branch. A deterministic branch per PR/head SHA prevents duplicate draft fixes for repeated failed runs. It never commits to the contributor branch or merges.
- **Improvement scan:** executes only explicitly configured deterministic commands, records command outcomes, asks the model to rank evidence-backed priorities and opens deduplicated issues.
- **Auditing:** JSONL records include evidence hashes and decision metadata, never raw source or credential values.
- **Policy:** strict versioned YAML, allow/deny paths, schema validation, output budgets and explicit source-sharing approval.

## Requirements

- Node.js 24+
- GitHub Actions
- Ollama Cloud API key and model variables
- GitHub App installation token for draft autofix PR creation

## Install

```bash
npm install @nemesis-oss/ci-agent
```

## Configuration

Create `.nemesis/ci-agent.yml`:

```yaml
version: 1
enabled: true
toolchain:
  adapter: auto
  commands:
    verify: ["npm", "test"]
  commandTimeoutMs: 120000
  passEnv: []
modes:
  review:
    enabled: true
    autonomy: comment
  fix:
    enabled: true
    autonomy: draft-pr
    optInLabel: nemesis:autofix
    maxAttempts: 2
    maxFiles: 5
    maxFileBytes: 60000
  scan:
    enabled: true
    autonomy: issue
policy:
  autoMerge: false
  requireHumanApproval: true
  allowPaths: ["src/**", "test/**", "tests/**", "docs/**"]
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

Source transmission defaults to **off**. For private/internal repositories, set `sendSourceToCloud: true` only after repository-owner approval. Public code can use `classification: public`. Credentials are not added to model prompts.

Configured commands run with `shell: false`, a per-command timeout and a minimal environment. GitHub/Ollama secrets are not inherited. Additional variables are forwarded only by explicitly naming them in `toolchain.passEnv`; explicitly forwarded values are redacted from evidence before it reaches the model.

## GitHub Actions setup

The included review workflow deliberately does **not** run on `pull_request` with secrets. It uses trusted default-branch workflow code and supports two triggers:

1. **Comment command:** write `/nemesis review` on a pull request. Only comments from OWNER, MEMBER or COLLABORATOR associations are accepted.
2. **GitHub App dispatch:** a trusted webhook dispatcher can send a `repository_dispatch` event of type `ci-agent-review` with a PR number and expected head SHA.

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

The dispatcher should listen for `pull_request` opened/synchronize/reopened events, reject fork and draft PRs, and send the event using a repository-scoped GitHub App installation token. The review action verifies that the PR head still matches the dispatched SHA before sending the diff to the model. The webhook dispatcher itself is an external integration point; this repository includes the receiving workflow contract.

GitHub's `issue_comment` event runs workflow code from the default branch, and the review workflow checks out only trusted default-branch code. It reads PR diffs through the GitHub API; it never checks out or executes PR source.

The composite Action installs/builds dependencies before the final execution step. GitHub/Ollama credentials are passed as Action inputs and injected only into the final execution step; install scripts do not receive those credentials.

For other repositories, copy the included `ai-review.yml` pattern and configure the Action inputs `ollama-api-key` and `model-review`. The review workflow needs `contents: read`, `pull-requests: read` and `issues: write` permissions.

Configure repository variables/secrets:

| Name | Kind | Purpose |
|---|---|---|
| `OLLAMA_API_KEY` | Secret | Ollama Cloud API key |
| `OLLAMA_MODEL_REVIEW` | Variable | Review model tag |
| `OLLAMA_MODEL_FIX` | Variable | Autofix model tag |
| `OLLAMA_MODEL_SCAN` | Variable | Scan model tag |
| `CI_AGENT_APP_ID` | Variable | GitHub App ID for autofix |
| `CI_AGENT_APP_PRIVATE_KEY` | Secret | GitHub App private key |

For autofix, create a repository label named `nemesis:autofix` and add it only to PRs where an automated draft fix is authorized. If the label is absent, the workflow exits successfully without invoking Ollama or creating a branch. A stale PR head, disabled cloud-sharing policy or exhausted retry budget also produces a safe skip.

Install the GitHub App only on target repositories with **Actions: read, Contents: write, Issues: read, Pull requests: write**. The autofix workflow uses a short-lived installation token; it does not use default `GITHUB_TOKEN` for commits, because those commits do not trigger subsequent workflows by default.

## CLI

```bash
nemesis-ci validate --config .nemesis/ci-agent.yml
nemesis-ci policy-check --config .nemesis/ci-agent.yml --paths src/index.ts,tests/index.test.ts
nemesis-ci evidence --config .nemesis/ci-agent.yml
```

Evidence collection executes only explicitly configured argv arrays; commands are never guessed.

## Architecture

```text
Trusted GitHub event -> trusted default-branch workflow -> API evidence -> policy engine
                   -> Ollama Cloud adapter -> schema validation -> RepoHost action
                   -> JSONL audit -> existing CI + human review
```

Core modules depend on ports (`RepoHost`, `CiProvider`, `LlmPort`, `AuditStore`). GitHub and Ollama integrations are adapters. Ollama SDK 1.26.x is used directly. Ollama Cloud currently rejects the request `format` option for structured output, so this adapter requests JSON in the prompt and validates the response locally using the SDK's `parseStructuredOutput` helper.

## Security

- PR review uses `issue_comment` / `repository_dispatch`, which run workflow definitions from the default branch.
- Never use `pull_request_target` with PR checkout.
- Never run a privileged review workflow based on a PR-controlled workflow file.
- Review checks out the default branch and fetches diff data through the GitHub API; PR code is not executed.
- Autofix checks out trusted default-branch code, never PR head code.
- Fork PRs are excluded from review and autofix cloud calls.
- No automatic approval, merge or commit to contributor branches.
- Patch proposals cannot edit `.github/**`, manifests, lockfiles, secrets, migrations or vendor trees.
- Model output is untrusted and schema-validated; paths and patch budgets are checked again.
- Retry attempts, chunks, file count, bytes and model output are bounded.
- Cloud source transmission requires explicit repository policy approval.
- Scan commands run without GitHub/Ollama secrets by default; explicit environment forwarding is redacted before evidence is sent to the model.
- Audit stores hashes/metadata only.
- Pin third-party Actions to reviewed commit SHAs for production.

## Development

```bash
npm install
npm run verify
```

Unit tests are deterministic and do not require Ollama credentials or network access. Live provider checks should remain separate from required offline CI.

## Initial limitations

- Inline review comments are not included; findings are consolidated into one PR conversation comment.
- Scan collection executes explicit commands only. Broader npm/pnpm/yarn, Python, Go, Rust, JVM, .NET and infrastructure analyzers can be added as deterministic adapters.
- Automatic PR update events require an installed GitHub App webhook dispatcher; `/nemesis review` provides an immediate comment-based path.
- The included GitHub Action builds from source at runtime; publish a tagged release before external repositories consume the Action.
