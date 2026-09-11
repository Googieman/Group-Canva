# Task 8 report: failure injection and release verification

## Coverage added

- Protocol-mismatch snapshots and incompatible join versions stop editing instead of hydrating an unsupported state.
- IndexedDB `versionchange` closes the cached connection; deleting the database then reaches the visible save-error path.
- Camera zoom and pan remain bounded at both zoom limits and the finite world boundary.
- The existing disconnect/revision-gap/deduplication/storage-write/lease/asset/recovery coverage remains in the complete unit suite.
- Browser coverage now includes local/hosted startup, local project workflows, images and host asset recovery, content PNG export, managed host recovery and read-only guest ownership, compositing, mobile layout, reconnect, and the database-deletion failure path.

## Final verification

- `npm run typecheck` — passed.
- `npm test` — 12 files, 87 tests passed.
- `npm run test:e2e` with isolated `E2E_PORT=3339` — 40 Chromium/WebKit tests passed; 20 Firefox cases failed before test execution with Windows `spawn UNKNOWN`.
- `npm run benchmark -- task8-final` — passed and saved `benchmarks/results/task8-final.json`; the ten-client/five-author workload reported zero missing batches, zero duplicate batches, and zero acknowledgement failures.
- `npm run verify:hosted` — blocked by missing `E2E_BASE_URL`/`BENCH_FRONTEND_URL` and `BENCH_SERVER_URL`; no hosted deployment claim was made.
- `npm run build` — passed.
- `git diff --check` — no whitespace errors; only LF/CRLF normalization warnings.

## Review and release status

Local review found no critical or important implementation issues. The release gate is not fully green because Firefox cannot launch in this Windows environment and hosted endpoint variables were not provided. No deployment, merge, push, or public release was performed. The worktree is ready for a separately configured hosted verification and a machine/environment where Firefox can launch.
