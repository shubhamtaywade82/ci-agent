# Task checklist

- [x] Establish npm package and Node 24 TypeScript build.
- [x] Define ports, strict configuration and policy checks.
- [x] Implement Ollama Cloud SDK adapter.
- [x] Implement GitHub PR and CI run adapters.
- [x] Implement review, draft autofix and scheduled scan modes.
- [x] Add offline tests and documentation.
- [x] Confirm GitHub Actions run is green (31 tests, typecheck and build on Node 24).
- [x] Pin GitHub Actions dependencies to reviewed commit SHAs.
- [x] Make autofix idempotent per PR head SHA.
- [ ] Configure Ollama secrets/model variables and GitHub App.
- [ ] Deploy the automatic PR event webhook dispatcher.
- [ ] Publish npm package after repository-owner review.
