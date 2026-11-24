# Changelog

## Unreleased

- Hardening ported into the monorepo: commenter write-permission check, comment size budgets, sanitized model markdown, `.nemesis/**` always denied, autofix sees current file contents and rejects patches touching unseen files, log tail kept, `npm ci --ignore-scripts`, job-level review concurrency.
- Marker/ledger comments are only trusted when authored by a bot; a forged marker can no longer poison the dedupe ledger or hijack the update.
- Reviews with no findings (or nothing reviewable) still report which files were not reviewed.
- `actionlint` runs in the `verify` workflow.

## 0.1.0

- Initial policy-gated CI agent package and composite GitHub Action.
- Pull-request review, bounded failed-CI autofix as stacked draft PRs, and scheduled improvement scans.
- Strict config, deterministic command evidence, path policy, audit, offline tests and security documentation.
