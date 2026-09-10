# Task 3 report: mixed-tail cache decision

## Decision

Reject the proposed mixed-tail tile operation cache. The post-change benchmark regressed the mixed workload, so no production cache was accepted. The shared worktree contains no tile-cache implementation in `client/canvas.ts`; the existing Task 2 renderer remains unchanged.

## Files

- `client/canvas.ts`: unchanged; no rejected production cache remains.
- `tests/canvas.test.ts`: removed cache-specific unit tests and mock-only cache assertions.
- `tests/browser/compositing.spec.ts`: retained the independent `verifyMixedTailSequence` oracle at 18 transitions for Chromium and WebKit, alongside the existing 41-transition oracle.
- `benchmarks/render.ts`: retained the mixed-tail full-replay oracle.
- `benchmarks/results/mixed-tail-post.json`: retained raw one-repetition, 3-second post sample.
- `benchmarks/results/mixed-tail-task2-diagnostic.json`: retained raw Task 2 diagnostic sample.
- `docs/SYNC-REVIEW.md`: records the rejection and comparability limits.
- `docs/VERIFICATION.md`: records the rejection, metrics, and memory evidence boundary.
- `.superpowers/sdd/2026-09-10-sync-performance-follow-up/task-3-report.md`: this report.

## Before and after metrics

Task 2 baseline (three 5-second repetitions, Chromium, DPR 2) measured FPS ranges of 15.67–16.00, 16.45–17.32, and 17.86–18.72 for erasers every 4, 7, and 16 strokes. The retained post sample (one 3-second repetition) measured 14.0257, 15.1481, and 16.2760 FPS. Post `renderMs` p50/p95 was 4.3/5.5 ms, 4.4/6.2 ms, and 4.4/5.4 ms; post `tailReplayMs` p50/p95 was 0.5/0.6 ms, 0.5/0.8 ms, and 0.5/0.7 ms. The differing run lengths and repetition counts make this a rejection signal, not a performance threshold.

## Validation and evidence

The controller reports `npm test` and `npm run build` passing (45 tests/build). The mixed-tail browser oracle is retained for the next browser run; its existing 41-transition oracle is unchanged. No tile cache backing storage is retained, so there is no accepted memory-cap result to report. The proposed 64 MiB bound is therefore marked rejected rather than claimed.

## Concerns

The post sample is a same-machine Chromium measurement with one repetition and a 3-second duration, while the baseline uses three repetitions and 5 seconds. Native Safari, Firefox, and a separate collaborator device remain outside this result. The optimization should be reconsidered only with a new design and comparable measurements that preserve begin-order brush/eraser compositing.

## Commit

Package commit: `f2aee95` (`perf: cache mixed canvas tail operations`).
