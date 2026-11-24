# Architecture

```text
Trusted GitHub event -> default-branch agent workflow -> task router
  -> GitHub API evidence / deterministic workspace collectors
  -> policy engine -> Ollama LLM port -> schema validation
  -> GitHub RepoHost (comment / issue / draft PR) -> audit sink
  -> existing CI + human acceptance
```

## Ports

- `LlmPort`: bounded structured generation.
- `RepoHost`: PR metadata/diffs and issue/comment/draft-PR writes.
- `CiProvider`: workflow metadata and failed logs.
- `AuditStore`: append-only audit events.
- Workspace collectors: deterministic profile discovery and explicitly configured command execution.

Core logic does not depend on GitHub request types. Model output cannot invoke tools or change permissions.

## Trusted review triggers

The built-in review workflow is defined and executed from the default branch using `issue_comment` and `repository_dispatch`. An authorized collaborator can comment `/nemesis review`; an installed GitHub App dispatcher can send `ci-agent-review` with a PR number and expected head SHA. No privileged `pull_request` workflow runs model calls or consumes Ollama secrets.

## Trust boundary

PR text, issue text, diffs, workflow logs and model output are untrusted data, never instructions. Privileged review/autofix jobs do not execute PR code. Existing CI and human review remain authoritative.
