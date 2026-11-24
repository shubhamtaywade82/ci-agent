# Adoption guide

## 1. Workflow (one file)

```yaml
name: nemesis-agent
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_run:
    workflows: ["verify"]   # your CI workflow NAME (not filename)
    types: [completed]
  schedule:
    - cron: "0 5 * * 1"
  workflow_dispatch:
    inputs:
      mode: { type: choice, options: [scan, review, fix, doctor], default: scan }
permissions:
  contents: read
  actions: read
  pull-requests: write
  issues: write
concurrency:
  group: nemesis-agent-${{ github.ref }}
  cancel-in-progress: true
jobs:
  agent:
    if: >
      github.event_name != 'workflow_run' ||
      github.event.workflow_run.conclusion == 'failure'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.repository.default_branch }}   # trusted agent code only
      - uses: nemesis-oss/ci-agent@v1
        with:
          mode: auto
          config: .nemesis/ci-agent.yml
          ollama-api-key: ${{ secrets.OLLAMA_API_KEY }}
          ollama-model: ${{ vars.OLLAMA_MODEL }}
          github-app-id: ${{ secrets.CI_AGENT_APP_ID }}
          github-app-private-key: ${{ secrets.CI_AGENT_APP_PRIVATE_KEY }}
```

Event → mode mapping: `pull_request` → review, failed `workflow_run` → fix,
`schedule` → scan, dispatch → selected mode.

## 2. Secrets & variables

- `OLLAMA_API_KEY` (secret) — Ollama Cloud key.
- `OLLAMA_MODEL` (variable) — pinned model tag.
- `CI_AGENT_APP_ID` / `CI_AGENT_APP_PRIVATE_KEY` (secrets, fix mode only) —
  GitHub App with `contents:write`, `pull-requests:write`, `actions:read`.
  Required because `GITHUB_TOKEN` pushes do not trigger workflow runs.

## 3. Pre-flight

Run the doctor (`mode: doctor` or `ci-agent doctor`). It checks the manifest,
key/model/token presence, and warns about the `workflow_run` name coupling (V4).

## 4. Security model

- Agent code is checked out from the default branch only; PR content enters as
  data via the GitHub API.
- Fork PRs are skipped (policy + router tests cover this).
- Denylist: `.github/**`, lockfiles, `.env*`, secrets, migrations.
- Proprietary repos: set `dataPolicy.classification: proprietary` +
  `sendSourceToCloud: false` (manifest parse rejects the unsafe combination).
