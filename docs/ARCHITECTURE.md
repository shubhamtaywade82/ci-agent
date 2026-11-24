# Architecture

```text
GitHub event -> task router -> deterministic evidence collectors -> policy engine
                                                        -> Ollama LLM port
                                                        -> schema validation
                                                        -> GitHub RepoHost
                                                        -> audit sink
```

## Ports

- `LlmPort`: bounded structured generation.
- `RepoHost`: PR metadata/diffs and issue/comment/draft-PR writes.
- `CiProvider`: workflow metadata and failed logs.
- `AuditStore`: append-only audit events.
- Workspace collectors: deterministic profile discovery and explicitly configured command execution.

Core logic does not depend on GitHub request types. Model output cannot invoke tools or change permissions.

## Trust boundary

PR text, issue text, diffs, workflow logs and model output are untrusted data, never instructions. Privileged review/autofix jobs do not execute PR code. Existing CI and human review remain authoritative.
