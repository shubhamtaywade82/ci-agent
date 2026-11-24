# Implementation plan: Nemesis CI Agent

## Objective

Build a reusable Node.js 24+ package and GitHub Action for PR review, failed-CI diagnosis with draft autofix, and scheduled engineering-improvement scans.

## Architecture decisions

- Ports/adapters isolate GitHub, Ollama, workspace evidence and audit implementations.
- Deterministic collectors own facts; model outputs are schema-validated proposals.
- All write operations are policy-gated. No automatic approval or merge.
- Cloud source transmission defaults off. Fork-originated PRs are excluded from model workflows.
- Autofix uses a short-lived GitHub App installation token and creates a stacked draft PR against the exact failed PR head SHA.

## Implementation slices

- [x] Package and strict TypeScript configuration.
- [x] Config schema, CLI and path policy.
- [x] Ollama SDK adapter using the actual exported SDK API.
- [x] GitHub API adapter and failed workflow log collector.
- [x] PR review comment workflow.
- [x] Label-gated failed-CI autofix and draft PR workflow.
- [x] Deterministic scan evidence and issue reporting.
- [x] Offline tests and security/operations documentation.
- [ ] Run GitHub Actions checks in the target repository.
- [ ] Configure secrets, model variables and GitHub App permissions.
- [ ] Publish the first npm release after CI verification.

## Risks

| Risk | Mitigation |
|---|---|
| Model invents findings | Validate output; restrict paths and changed lines |
| Prompt injection | Treat retrieved text as untrusted; no model tool access |
| Sensitive data in prompts | Source-sharing opt-in; redact common secret patterns |
| Stale fixes | Match failed-run SHA and re-check the branch ref before committing |
| Privilege escalation | No fork PR execution; scoped App token; draft PR only |

## Verification

Run npm run verify on Node 24. Live Ollama/GitHub integration checks remain separate from required offline verification.
