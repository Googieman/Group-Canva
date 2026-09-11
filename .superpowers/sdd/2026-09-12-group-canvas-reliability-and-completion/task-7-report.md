# Task 7 report: hosted lifecycle, assets, and ping

## Files and design

- Managed rooms remain paused while a host is reconnecting or restoring. Guests cannot issue drawing commands until the host restore succeeds; the initial host restore follows the same gate.
- Host recovery credentials are persisted only in local file metadata, are sent only on host reconnect, and are excluded from invite URLs and project exports. The host URL now retains the room ID across reloads.
- Recovery uploads only missing assets, preventing duplicate-ID failures when a room already retained its assets. Shared-host image insertion uploads the asset before creating its document object.
- Asset requests remain participant-token authenticated and do not create drawing revisions/events. Signature, dimension, byte, duplicate-ID, wrong-room, and unauthorized cases are covered.
- Latency samples use a monotonic `performance.now()` clock, maintain the latest five samples, display their median, and stop during hidden/disconnected states.
- Image decode now falls back from `createImageBitmap` to an `<img>` decoder for WebKit compatibility.

## Verification

- `npx vitest run tests/server.integration.test.ts tests/server.hardening.test.ts tests/network.test.ts` — 3 files, 29 tests passed.
- `npx playwright test tests/browser/host-lifecycle.spec.ts tests/browser/assets.spec.ts --project=chromium` — passed after the final test correction.
- `npx playwright test tests/browser/host-lifecycle.spec.ts tests/browser/assets.spec.ts --project=webkit` — 3 tests passed in the final asset run; host lifecycle also passed in the preceding cross-engine run.
- `npm run typecheck` — passed.
- `git diff --check` — no whitespace errors; only LF/CRLF normalization warnings.

## Review

Local review found no critical or important issues. Recovery remains deliberately host-only and never promotes guests. Remaining release concerns are external backend restart persistence and the known Firefox launch failure in this environment; those are covered in the final verification report.
