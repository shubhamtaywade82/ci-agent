# nemesis ci-agent

An advisory CI agent library: LLM-powered PR review, failure-diagnosis draft PRs,
and scheduled improvement scans — wrapped **around** your existing deterministic
pipeline, never inside it.

```
One agent core. One Ollama SDK adapter. One GitHub Action.
Many repo policy manifests. Many toolchain adapters. Zero repo-specific agent logic.
```

## What it is

- `@nemesis-oss/ci-agent-core` — repo-agnostic orchestrators (review / fix / scan),
  policy engine, manifest, JSON schemas, diff chunking, evidence minimization,
  audit JSONL, task router. **No adapter SDKs** — enforced by
  `packages/core/test/architecture.test.ts`.
- `@nemesis-oss/ci-agent-ollama-cloud` — the only package coupled to
  `@nemesis-oss/ollama-sdk` (`OllamaClient`, Bearer auth, timeout/retry, fail-closed
  Ajv validation; the SDK fail-fasts `format` on cloud endpoints, so JSON is enforced
  via prompt + client-side validation).
- `@nemesis-oss/ci-agent-github` — Octokit `RepoHost` + GitHub Actions `CiProvider`
  (failed-job log zip, Git Data API commits, COMMENT-only reviews, marker ledger).
- `@nemesis-oss/ci-agent-toolchains` — detection registry (npm/pnpm/yarn/bun/uv/
  poetry/pip/go/cargo/maven/gradle/dotnet/docker/terraform/make) + JUnit/lcov/SARIF parsers.
- `@nemesis-oss/ci-agent` — CLI (`ci-agent run | doctor`) + composition root.
- `action/` — GitHub Action (`action.yml`, node20, bundled `dist/index.js`).

## Invariants (enforced in code and tests)

1. Fail-closed: schema violation / low confidence / guard rejection aborts with an
   audit record; **no partial application**.
2. The agent never merges, never approves, never edits `.github/**`, lockfiles, or
   secrets (denylist + autonomy ceiling + `autoMerge: false` rejected at parse).
3. PR content is data only; it is never executed. Fork PRs are skipped.
4. Determinism: `temperature: 0`, fixed seed, pinned model via `vars`, prompt
   version + input/output hashes + token usage in the append-only audit JSONL.
5. Budgets enforced in code: attempts (2), files (5), chunks (6), tokens, timeouts.
6. `GITHUB_TOKEN` pushes don't trigger CI — fix mode documents/uses a GitHub App
   installation token path via the adapter's `token` argument.

## Quick start (this repo)

```bash
npm ci
npm run build     # tsc -b, all 5 packages
npm test          # 160 tests, offline, LLM port mocked
node packages/cli/dist/bin.js doctor
```

## Adopting in another repository

1. Add the workflow (see `docs/adoption.md`).
2. Add `.nemesis/ci-agent.yml` (copy `docs/manifest-reference.md`, or start from
   this repo's `.nemesis/ci-agent.yml`).
3. Set secrets `OLLAMA_API_KEY` (+ `CI_AGENT_APP_ID` / `CI_AGENT_APP_PRIVATE_KEY`
   for fix mode) and variable `OLLAMA_MODEL`.
4. Run `ci-agent doctor` (or Action input `mode: doctor`) as the pre-flight check.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | success, or benign skip (disabled / non-failure run / fork / no opt-in / attempt cap) |
| 1 | fail-closed abort — LLM parse/schema/policy refusal; a human should look |
| 2 | configuration error — invalid manifest, missing env/token |

## Layout

```
packages/
  core/           ports, policy, orchestrators, schemas, audit, router
  ollama-cloud/   the only SDK-coupled file (src/index.ts)
  github/         Octokit RepoHost + Actions CiProvider
  toolchains/     detection + report parsers
  cli/            bin, run pipeline, doctor, env wiring
action/          action.yml + src (bundled to dist/)
scripts/          bundle/clean/lint (zero-config structural lint)
.github/workflows  verify (offline hermetic) + agent-doctor
.nemesis/ci-agent.yml   dogfood manifest for this repo
```
