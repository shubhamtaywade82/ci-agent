# Configuration reference

See `.nemesis/ci-agent.yml` for an example.

- `version`: required schema version, currently 1.
- `enabled`: global opt-out.
- `toolchain.commands`: explicit argv arrays; no shell interpolation or guessed scripts.
- `toolchain.commandTimeoutMs`: maximum run time for each configured command (default 120 seconds).
- `toolchain.passEnv`: additional environment variable names to forward to commands. Empty by default; do not forward secrets unless the command genuinely requires them and the repository owner approves.
- `modes.review`: comment-only review with chunk/input budgets.
- `modes.fix`: opt-in label, attempt limit, file count and byte budgets.
- `modes.scan`: issue-only improvement summaries and finding cap.
- `policy.allowPaths` / `denyPaths`: path rules; protected paths are denied in code as well.
- `dataPolicy.sendSourceToCloud`: defaults false; approve explicitly.
- `dataPolicy.classification`: public, internal or proprietary.
- `llm.*ModelEnv`: environment variable names for model tags.
- `audit.path`: JSONL audit file.

Unknown keys and unsupported versions fail validation. Auto-merge cannot be enabled.
