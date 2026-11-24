# Manifest reference (`.nemesis/ci-agent.yml`)

Every field with defaults; omitted sections fall back to the most conservative
behavior. Validation rejects: `autoMerge: true`, `proprietary` +
`sendSourceToCloud: true`, non-positive budgets, malformed types.

| field | default | notes |
| --- | --- | --- |
| version | 1 | only supported version |
| enabled | true | master switch |
| toolchain.adapter | auto | `node-npm`, `node-pnpm`, `node-yarn`, `bun`, `python-uv`, `python-poetry`, `python-pip`, `go`, `rust`, `jvm-maven`, `jvm-gradle`, `dotnet`, `docker`, `terraform`, `generic-make` |
| toolchain.commands.verify | (detected) | required when the stack is unknown |
| modes.review.autonomy | comment | `comment` \| `issue` \| `draft-pr` ceiling |
| modes.fix.optInLabel | nemesis:autofix | label gate before any patch |
| modes.fix.maxAttempts | 2 | recursion guard for fix branches |
| modes.fix.maxFiles / maxFileBytes | 5 / 60000 | proposal budgets |
| modes.fix.minConfidence | medium | `low` proposals become comment-only |
| modes.scan.autonomy | issue | issues only by default |
| policy.allowPaths / denyPaths | src/tests/docs vs .github/locks/.env | glob grammar: `**` dirs, `*` segment, `?` char |
| dataPolicy.sendSourceToCloud | true | false + proprietary blocks LLM consultation |
| audit.format | jsonl | append-only, sanitized of token shapes |
