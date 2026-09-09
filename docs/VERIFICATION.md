# Verification record

Recorded 9 September 2026 (Asia/Calcutta) in the local Group Canvas workspace.

## Automated checks

- `npx vitest run`: **31 passed** across state recovery, canvas input/rendering, and Socket.io integration.
- `npm run build`: **passed**. Strict client typecheck, Vite production build, and server TypeScript emit completed.
- `npx playwright test --project=chromium`: **2 passed**. This covered three-page live point streaming before release, global undo/redo, erasing, late join hydration, keyboard shortcuts, offline/reconnect recovery, resize, and 16:9 fit.
- `npx playwright test --project=webkit`: **2 passed**. The same acceptance flows passed through Playwright WebKit on Windows.
- `npx playwright test --project=firefox`: **not runnable in this runner**. The downloaded Firefox binary failed to launch with Windows `spawn UNKNOWN`; this is an environment failure, not an application assertion failure.

The browser tests save desktop and mobile screenshots under Playwright's ignored `test-results/` directory. Chromium and WebKit screenshots were inspected during the run; the board remains the dominant surface, the toolbar wraps on narrow viewports, and no horizontal overflow was detected.

## What was measured

The live-client tests use polling against actual canvas pixels rather than fixed sleeps. They prove that a remote canvas receives visible ink while the pointer is still held, then converges after end/undo/redo. The current suite does not claim an international p95 latency number: no controlled WAN profile or remote region was available in this local run. Socket transport uses the documented 20 ms client batching and the server accepts/rebroadcasts each revision synchronously.

## Manual follow-up before public demo

- Run the same walkthrough in native Chrome/Brave, Firefox, and Safari on the target devices; Playwright WebKit is only a proxy for Safari behavior.
- Measure propagation with a 100 ms round-trip profile and record p95 remote visibility, plus a ten-client sustained drawing run on the target host.
- Deploy to one Render Free Singapore service and Cloudflare Pages, then validate the exact `ALLOWED_ORIGINS` and `VITE_SERVER_URL` values.
- Confirm cold-start behavior after Render's free service sleeps. Expect roughly one minute to wake and an empty canvas after any restart because state is intentionally in memory.
