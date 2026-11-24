# Changelog

## Unreleased

- Autofix now sends current file contents to the model and rejects patches touching unseen files; failure logs keep the tail.
- Review comments list skipped files, are size-capped, sanitized, include the reviewed commit and are updated in place on re-runs.
- Comment-triggered reviews verify the commenter has write access.
- `.nemesis/**` is always denied for patches; executable bits are preserved.
- Job-level review concurrency, `npm ci --ignore-scripts`, committed lockfile, `actionlint`, Dependabot and CODEOWNERS.
- One retry for transient or malformed model output.

## 0.1.0

- Initial policy-gated CI agent package and composite GitHub Action.
- Pull-request review, bounded failed-CI autofix as stacked draft PRs, and scheduled improvement scans.
- Strict config, deterministic command evidence, path policy, audit, offline tests and security documentation.
