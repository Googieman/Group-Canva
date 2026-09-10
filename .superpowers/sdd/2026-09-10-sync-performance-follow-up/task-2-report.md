# Task 2 report: mixed tail rendering cost

## Files

- `benchmarks/render.ts`: adds the mixed brush/eraser workload and retains the renderer diagnostics.
- `benchmarks/run.ts`: runs the interval matrix in the benchmark harness.
- `tests/browser/compositing.spec.ts`: raises the independent compositing oracle to 41 transitions at DPR 1, 1.5, and 2.
- `benchmarks/results/mixed-tail-baseline.json`: records the genuine Chromium benchmark run.
- `docs/SYNC-REVIEW.md`: records the measured observations and the performance bottleneck conclusion separately from functional assertions.

`client/canvas.ts` was not modified.

## Measurement

The saved artifact contains three five-second repetitions per scenario on Chromium 153, Windows, DPR 2, using the 300-stroke fixture with an early unfinished brush and an appended live brush. Ranges below span the three repetitions; `renderMs` and `tailReplayMs` are p50 / p95.

| Eraser interval | Updates | FPS | renderMs p50 / p95 | tailReplayMs p50 / p95 | surfaceCopyMs p50 | prefixCompareMs p50 | repaintAreaPx p50–p95 | frameIntervalMs p50 | pointerToRenderMs p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Every 4 strokes | 79–80 | 15.67–16.00 | 1.5–1.6 / 1.9–3.3 | 0.5 / 0.7 | 0 | 0.4 | 1,343,296–1,488,256 | 66.6 | 61.8–63.2 |
| Every 7 strokes | 83–87 | 16.45–17.32 | 1.6 / 2.4–3.3 | 0.5 / 0.7 | 0 | 0.4–0.5 | 1,357,792–1,488,256 | 50.1–66.6 | 57.5–60.7 |
| Every 16 strokes | 90–94 | 17.86–18.72 | 7.1–7.5 / 8.6–9.3 | 6.0–6.4 / 6.7–7.8 | 0 | 0.4 | 1,454,432–1,488,256 | 50.0 | 53.0–55.4 |

The measured bottleneck is main-thread/frame scheduling: 50–67 ms median frame intervals and 53–63 ms median pointer-to-render delays exceed the 1.5–7.5 ms median renderer time. Dirty-region comparison and stable-surface copying are small contributors. The every-16 scenario has a distinct synchronous reusable-tail replay hotspot, where `tailReplayMs` rises to 6.0–6.4 ms and accounts for most of `renderMs`. The component timers do not isolate deferred browser rasterization from frame scheduling, so the data does not support attributing the full scheduling gap to path submission or rasterization alone.

## Test results available

- Chromium compositing oracle: passed, recorded by `test-results/task2-chromium/.last-run.json`.
- WebKit compositing oracle: passed in the existing artifacts, recorded by `test-results/task2-webkit/.last-run.json` and `test-results/task2-webkit-15-final/.last-run.json`.

The benchmark JSON was captured from the working tree (`workingTreeDirty: true`); its commit field is the preceding baseline commit, as expected for a pre-commit measurement.

## Concerns

- This is a same-machine Chromium performance sample and has no cross-device network component.
- Timing values are observations without pass/fail thresholds and may vary with browser scheduling.
- Native Safari and remote collaboration remain separate validation scenarios.

## Commit

Commit: `TO_BE_FILLED_AFTER_COMMIT`
