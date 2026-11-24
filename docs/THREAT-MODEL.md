# Threat model

| Threat | Control |
|---|---|
| Prompt injection in repository content/logs | Treat all retrieved text as data; model has no tools |
| Fork PR secret exposure | Fork events excluded; no privileged PR checkout |
| PR-code execution in privileged jobs | Review checks out base SHA; workflow_run fix checks out default branch |
| Path traversal | Reject absolute paths, drive paths and parent traversal |
| Workflow/credential changes | Hard-deny .github, env/secret files, manifests, lockfiles and migrations |
| Malicious patch output | Zod validation, path policy, confidence/risk gate, file/byte budgets, draft PR only |
| Credential misuse | Short-lived repository-scoped GitHub App token |
| CI retry loop | Workflow attempt budget; no auto-merge |
| Audit leakage | Store hashes and metadata only |

## Residual risk

Valid structured output is not proof of correct code. CI and human review remain mandatory. Each repository owner is responsible for approving transmission of source material to Ollama Cloud.
