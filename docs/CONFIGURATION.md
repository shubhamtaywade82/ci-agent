# Configuration reference

See `.nemesis/ci-agent.yml` for an example.

- `version`: required schema version, currently 1.
- `enabled`: global opt-out.
- `toolchain.commands`: explicit argv arrays. No shell interpolation or guessed scripts.
- `modes.review`: comment-only review with chunk/input budgets.
- `modes.fix`: opt-in label, attempt limit, file count and byte budgets.
- `modes.scan`: issue-only improvement summaries and finding cap.
- `policy.allowPaths` / `denyPaths`: path rules; protected paths are denied in code as well.
- `dataPolicy.sendSourceToCloud`: defaults false; approve explicitly.
- `dataPolicy.classification`: public, internal or proprietary.
- `llm.*ModelEnv`: environment variable names for model tags.
- `audit.path`: JSONL audit file.

Unknown keys and unsupported versions fail validation. Auto-merge cannot be enabled.
