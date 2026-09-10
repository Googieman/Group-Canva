# Verification record

Recorded 10 September 2026 (Asia/Calcutta) in the local Group Canvas workspace. The measurements below were collected from the existing repository at commit `24da114` with an intentionally dirty working tree containing the hardening changes. Functional assertions and performance samples are separate commands.

## Automated checks

- `npx vitest run`: **41 passed** across five files. This includes reducer recovery, concurrent history, duplicate and gap handling, real Socket.io reconnect and hydration cases, server expiry, and canvas behavior.
- `npm run build`: **passed**. Client typecheck, Vite production build, and server TypeScript emit completed.
- `E2E_PORT=3103 npx playwright test tests/browser/compositing.spec.ts --project=chromium`: **3 passed**. Incremental rendering was compared with independent full replay through 38 transitions at DPR 1, 1.5, and 2.
- `E2E_PORT=3107 npx playwright test tests/browser/compositing.spec.ts --project=webkit`: **3 passed** at DPR 1, 1.5, and 2.
- `E2E_PORT=3104 npx playwright test tests/browser/whiteboard.spec.ts --project=chromium`: **2 passed**. This covered live streaming, erase, global undo/redo, late hydration, keyboard controls, offline/reconnect, resize, and 16:9 fit.
- `E2E_PORT=3105 npx playwright test tests/browser/whiteboard.spec.ts --project=webkit`: **2 passed**. Firefox was not run in this environment because its downloaded binary previously failed to launch with Windows `spawn UNKNOWN`.

The compositing checks cover overlapping brush and eraser operations, reverse completion, late points beneath an eraser, removals, reorder, undo and redo, repeated updates, in-place point mutation, and a cached brush run before a later eraser. They require matching alpha and interior pixels, allow a one-channel rounding difference from cached transparent brush rasters, and allow the one-device-pixel antialias neighborhood at repaint boundaries. Native Safari remains unverified; Playwright WebKit is a useful compatibility signal but is not Safari.

## Rendering baseline and post-change measurements

The repeatable fixture uses Chromium `153.0.8010.12`, a 12th Gen Intel(R) Core(TM) i5-12450H, a 1280 × 900 viewport at DPR 2, and three 5-second repetitions unless stated otherwise. Baseline loads the renderer from commit `24da114`; post-change loads the working tree. The synchronization comparison uses the same current instrumented server in both runs because the timing hook is measurement-only. The fixture contains 300 completed strokes with 120 points each and then appends live strokes. Values are per repetition, so they remain reviewable rather than hiding run-to-run variance.

| Scene | Baseline FPS | Post FPS | Baseline frame p95 | Post frame p95 |
| --- | ---: | ---: | ---: | ---: |
| Empty | 60.01, 60.03, 60.01 | 60.09, 60.00, 60.00 | 16.7–16.8 ms | 16.7–16.8 ms |
| Completed prefix | 59.88, 59.63, 59.90 | 60.05, 60.05, 60.12 | 16.7–16.8 ms | 16.7–16.8 ms |
| Mixed brush/eraser unfinished prefix | 11.71, 10.05, 10.02 | 14.98, 13.32, 11.84 | 133.3–150.0 ms | 100.0–116.6 ms |
| Unfinished brush with a long completed brush tail | 11.91, 12.59, 13.06 | 59.67, 60.11, 60.17 | 100.1–133.3 ms | 16.7–16.8 ms |

The regional renderer reduced the typical repaint area for real input to 67,865 device pixels at p50 and 548,352 at p95, compared with the 3,200 × 1,800 full backing surface. It retains ordered replay for erasers. The completed brush-run tail cache removes repeated path replay when a long brush-only run is present; mixed tails containing erasers remain the expensive case by design so compositing order stays deterministic. In the post real-input sample, pointer-to-render p95 was 17.0 ms, pointer-to-next-frame p95 was 31.9 ms, prediction merge p95 was 0.1 ms, and prediction append p95 was 0 ms.

## Synchronization baseline and sustained runs

The ten-client fixture uses five authors, one rendered observer, and four socket observers in a fresh room. Each author attempts a two-point batch every 20 ms. The measured nonempty batch interval is about 31 ms on this Windows runner because the test and OS timers schedule coarsely; the application constants remain 20 ms and 64 points.

| Run | Batches / received | Propagation p50 / p95 | Server processing p50 / p95 | Batch interval p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| Baseline, 5 s × 3 | 815 / 815; 825 / 825; 815 / 815 | 1.93/5.21; 2.49/7.02; 3.10/6.52 ms | 0.18/0.45; 0.22/0.63; 0.28/0.62 ms | 31.12/32.64; 30.98/32.64; 30.96/32.27 ms |
| Post, 5 s × 3 | 820 / 820; 815 / 815; 830 / 830 | 2.24/6.15; 1.92/4.28; 2.25/5.38 ms | 0.22/0.56; 0.18/0.40; 0.22/0.57 ms | 31.02/32.09; 31.08/32.05; 30.90/31.80 ms |
| Post sustained local, 60 s | 10,400 / 10,400 | 2.09/5.38 ms | 0.20/0.53 ms | 30.64/33.91 ms |
| Post local proxy, 50 ms each direction | 1,315 / 1,315; 1,310 / 1,310; 1,315 / 1,315 | 126.88/134.58; 126.70/130.90; 126.85/132.36 ms | 0.24/0.68; 0.28/0.56; 0.28/0.59 ms | 30.98/32.34; 30.75/32.09; 30.88/32.11 ms |

Propagation is measured from the author runner's monotonic send timestamp to a separate observer's accepted point event. It includes transport and decoding on both legs, excludes the time a point waits for the next batch and excludes browser paint. Server processing ends after validation, mutation, broadcast enqueue, and acknowledgement preparation; it excludes network transit and deferred socket writes. The local delay run shows that transport delay, rather than server processing, dominates under a controlled 100 ms round trip.

During the 60-second post sustained run the rendered observer remained active at 41.1 FPS under the ten-client load (frame p95 50 ms, render p95 1.5 ms). This is a load-stress result; the isolated brush-tail renderer stays near 60 FPS.

Raw reports are retained in `benchmarks/results/baseline-final.json`, `benchmarks/results/post-final2.json`, `benchmarks/results/sustained-final.json`, and `benchmarks/results/delayed-local.json`.

## Remote tunnel evidence and limits

Two exploratory fork runs went through the VS Code tunnel endpoint. They were not merged implementation branches and should not be compared directly with the controlled local runs: one ten-client same-machine route recorded propagation p50/p95 of 3,455/7,795 ms with 17 acknowledgement timeouts; a separate two-client route recorded 700/1,175 ms. Both used one machine's clock, and the ten-client run completed 810 commands with no missing or duplicate deliveries. Server processing was unavailable from the external endpoint. These runs establish that the tunnel route can dominate the observed delay, but they do not measure a remote collaborator's display latency.

For a real two-device measurement, open the shared room with `&diagnostics=1` in both browsers, reset `window.canvasDiagnostics`, draw for a fixed interval, and save both reports with browser, device, location, network, commit, and scene size. The diagnostics are opt-in, bounded, local, and send no telemetry. Record the supplied endpoint only in local notes; the benchmark report intentionally omits it.

## Hosted baseline readiness (unverified, 11 September 2026)

No hosted baseline was recorded in this workspace. `README.md` states that no hosted demo has been created, `BENCH_SERVER_URL` was unset in the benchmark environment, and no deployed frontend origin or backend URL was supplied. There was also no separate collaborator device available for the required remote run. Accordingly, `benchmarks/results/hosted-same-machine.json` and `benchmarks/results/hosted-remote.json` were intentionally not created; there are no hosted p50/p95, delivery, FPS, or host-side `serverProcessingMs` values to report.

The deployment configuration is ready for a future run: `render.yaml` specifies one Render Free Node service in Singapore, and the frontend instructions require a build-time `VITE_SERVER_URL` pointing to that service plus an exact Cloudflare Pages origin in backend `ALLOWED_ORIGINS`. The server is configured for Socket.IO's WebSocket transport. These are configuration facts only; this run did not verify a live HTTPS origin, origin acceptance, WebSocket upgrade, authentication interstitial behavior, cold start, or server-side processing.

The missing prerequisites are a real deployed HTTPS backend/frontend pair with the exact frontend origin allowed by the backend, and access to a second collaborator device and its browser/network details. Once available, run the identical 60-second `BENCH_PHASE=load`, one-repetition command from the server machine and the separate device, retain both JSON reports, and collect `serverProcessingMs` on the backend host. The existing local and exploratory tunnel evidence above remains separate and must not be labeled as this hosted baseline.

Remaining validation:

- Run native Chrome, Firefox, and Safari on target devices; Playwright WebKit remains a compatibility signal rather than a Safari result.
- Repeat the ten-client benchmark from a genuinely remote collaborator machine through the tunnel, recording both endpoints and network conditions.
- Validate the deployed Render and Cloudflare configuration, cold-start behavior, and expected empty in-memory room after a restart.
- Persistence, shapes, text, selection, and multi-region clock synchronization are outside this MVP and were not added.

See [benchmarks/README.md](../benchmarks/README.md) for commands and metric definitions, and [SYNC-REVIEW.md](SYNC-REVIEW.md) for the synchronization invariants and regression coverage.

## Task 3 mixed-tail cache decision

The proposed tile operation cache was rejected after the genuine post sample in `benchmarks/results/mixed-tail-post.json` regressed the mixed scenarios to 14.0257, 15.1481, and 16.2760 FPS (eraser intervals 4, 7, and 16). The Task 2 baseline ranges were 15.67–16.00, 16.45–17.32, and 17.86–18.72 FPS respectively. The post run was one 3-second repetition, while the baseline was three 5-second repetitions, so these values are recorded as evidence and not a pass/fail performance gate.

Task 3 leaves `client/canvas.ts` unchanged and removes the cache-specific unit tests. The 18-transition `verifyMixedTailSequence` browser oracle remains as independent correctness coverage. The raw post and Task 2 diagnostic JSON files are retained. No accepted cache implementation, memory-cap measurement, or performance improvement is claimed.

## Follow-up final gate (11 September 2026)

The final automated gate passed after rejecting the regressing tile cache:

- `npm test`: **41 passed** across five files.
- `npm run build`: **passed** (`tsc --noEmit`, Vite production build, and server TypeScript emit).
- `git diff --check`: **passed**.
- `$env:E2E_PORT=3111; npx playwright test tests/browser/compositing.spec.ts --project=chromium`: **6 passed**. This covers the 41-transition full oracle and the 18-transition mixed-tail oracle at DPR 1, 1.5, and 2.
- `$env:E2E_PORT=3112; npx playwright test tests/browser/compositing.spec.ts --project=webkit`: **6 passed** at the same DPR values.
- `$env:E2E_PORT=3113; npx playwright test tests/browser/whiteboard.spec.ts --project=chromium`: **2 passed**.
- `$env:E2E_PORT=3114; npx playwright test tests/browser/whiteboard.spec.ts --project=webkit`: **2 passed**.

`benchmarks/results/mixed-tail-no-cache-final.json` records a fresh three-repetition, five-second same-machine Chromium run after the cache was removed. At DPR 2, mixed-tail FPS ranges were 14.16–14.70 (eraser every 4), 15.30–15.78 (every 7), and 16.72–17.26 (every 16); `renderMs` p50 remained 1.6–7.2 ms and `tailReplayMs` p50 0.5–6.1 ms. This is a comparable no-cache reference for future work, not a performance threshold. The raw Task 2 baseline, rejected-cache post sample, and no-cache reference remain separate artifacts.

The authoritative stream remains Socket.IO over WebSocket. Local and controlled-delay measurements show server processing below 1 ms while transport delay dominates when delay is introduced; no hosted evidence isolates a transport defect. A future unreliable cursor channel would require a separate design and is outside this follow-up.

Firefox was not part of this final matrix because its downloaded Playwright binary previously failed to launch on Windows with `spawn UNKNOWN`. Playwright WebKit is a compatibility signal, not native Safari. A deployed HTTPS endpoint, exact frontend origin, cold-start run, host-side processing sample, and genuinely remote collaborator device are still unavailable and remain explicitly unverified above.

The rejected-cache post sample also included an unfinished-brush control at 16.53 FPS versus the earlier 60.05–60.09 FPS baseline. A fresh three-repetition no-cache control in `mixed-tail-no-cache-final.json` returned 60.16–60.21 FPS. The post run had one 3-second repetition and was collected while the experimental cache path was being evaluated; the control is therefore stronger rejection evidence but still not a pass/fail threshold. The accepted renderer remains the no-cache implementation.

The experimental cache source was never committed and is not retained as production code. The raw post JSON, no-cache reference, task reports, and review artifacts preserve the measurements and decision; reproducing the rejected implementation would require a new experiment.
