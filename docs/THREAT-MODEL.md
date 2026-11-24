# Threat model

| Threat | Control |
|---|---|
| Prompt injection in repository content/logs | Treat all retrieved text as data; model has no tools |
| Fork PR secret exposure | Review workflow is triggered by trusted default-branch events; fork PRs are rejected before model invocation |
| PR-controlled workflow execution | Review uses issue_comment/repository_dispatch; workflow exists on and runs from default branch |
| Privileged PR-code execution | Review reads diff via API; workflow_run fix checks out default branch; no PR-head checkout |
| Path traversal | Reject absolute paths, drive paths and parent traversal |
| Workflow/credential changes | Hard-deny .github, env/secret files, manifests, lockfiles and migrations |
| Malicious patch output | Zod validation, path policy, confidence/risk gate, file/byte budget, draft PR only |
| Credential misuse | Short-lived repository-scoped GitHub App token |
| Secrets exposed to scan commands | Commands run with a minimal environment; explicit passEnv allowlist; allowlisted values redacted from evidence |
| Runaway command | Per-command deadline and process termination |
| Duplicate autofix workflow runs | Deterministic branch per PR head SHA; existing draft/orphan branch detection; workflow concurrency |
| Policy self-modification | `.nemesis/**` is hard-denied for patches regardless of `allowPaths` |
| Markdown/mention injection via model output | Model text is escaped (`<`, `@`, `![`) before posting comments, issues and PR bodies |
| Silent review gaps | Comments list every file that was skipped (policy, size, chunk budget) |
| Audit leakage | Store hashes and metadata only |

## Residual risk

Valid structured output is not proof of correct code. CI and human review remain mandatory. Each repository owner is responsible for approving transmission of source material to Ollama Cloud.
