# Synchronization and history review

This continues the independent review and integration QA stages of the [existing implementation plan](superpowers/plans/2026-09-09-whiteboard.md). It does not replace that plan. The original repository history and authoritative in-memory room design are retained.

## Findings and regression coverage

| Finding | Consequence | Correction / regression |
| --- | --- | --- |
| Hydration silently discarded a buffered event from a newer observed epoch when an older snapshot arrived. | The client could become ready with obsolete state. | Remember the buffered epoch and reject a snapshot from another epoch. Preserve the newer event until a compatible snapshot arrives. `tests/state.test.ts`. |
| A stale snapshot in the current epoch could rewind an already applied revision. | Accepted history disappeared locally until another recovery. | Reject snapshots below the current revision in the same epoch. `tests/state.test.ts`. |
| Hydration buffer overflow discarded evidence of the lost revisions. | A snapshot behind the discarded events could incorrectly enable drawing. | Retain the highest discarded revision and require a snapshot covering it. `tests/state.test.ts`. |
| Socket.io does not automatically reconnect after an explicit server disconnect. | The server's slow-peer eviction could leave a browser permanently disconnected. | Schedule a guarded, jittered reconnect for that reason; retain the manager's existing backoff for transport failures. Real Socket.io test in `tests/network.test.ts`. |
| A failed acknowledgement from an earlier synchronization cycle could trigger a new resync after successful hydration. | A recovered client unnecessarily dropped predictions and paused input. | Invalidate acknowledgements across connection/resync/hydration generations. Real delayed-ack regression in `tests/network.test.ts`. |
| Snapshot handling did not verify the expected room and current socket identity. | An incompatible snapshot could be accepted as the current room state. | Ignore snapshots with a different room or retired connection identity. Real transport regression in `tests/network.test.ts`. |
| Nested slow-peer eviction could install multiple empty-room expiry timers. | After a participant rejoined, an orphan timer could delete the live room; another join could create a second epoch sharing the same room channel. | Independently reproduced with two congested transports and unfinished authors. See `tests/server.hardening.test.ts`; final integration status is recorded in `VERIFICATION.md`. |

The independent reviewer reproduced the three reducer failures, supplied their regression fixes, reviewed the network recovery changes, and independently reproduced the nested server-expiry failure. The fixes are covered by the current unit and real-transport suites. No claim of exhaustive verification is implied.

## Preserved invariants

- A stroke receives its visual layer at begin. Concurrent brushes and erasers remain in that order even when they finish in reverse order or lower points arrive after a later eraser completes.
- Global undo chooses the latest active completed operation by completion order. Redo restores its original visual position. New completion invalidates the shared redo branch.
- Only accepted drawing changes advance a revision. Exact duplicate point batches, including retransmitted accepted points after completion, do not advance revision or append another copy. Conflicting batches and gaps are rejected.
- The reducer applies buffered newer revisions exactly once, pauses on a gap, and retains the tail needed for another snapshot. The Socket.io layer drops drawing packets while a snapshot is hydrating because that snapshot is authoritative; this also prevents a late packet from a closed transport from pinning recovery to a stale epoch. Room epochs are opaque identities; observed transport order identifies the active lifetime rather than numerical comparison of epoch strings.
- Offline input is rejected before Socket.io can buffer a command. Reconnection receives a fresh identity and snapshot; the server cancels abandoned unfinished work.
- The 20 ms / 64-point batching constants and the release flush remain unchanged.

`tests/server.integration.test.ts` now combines concurrent overlapping brush/eraser operations, reverse completion, late points, duplicate batches, buffered late hydration, and history convergence in one real-transport regression. Its separate ten-author functional test runs forty batches per author and verifies identical snapshots at revision 420. Performance samples are collected by `benchmarks/run.ts`, without treating timing variation as a functional assertion.

## Rendering review boundary

Regional repaint reconstructs affected ink from the stable completed prefix and every intersecting later operation, in begin order. A contiguous run of at least eight completed brush strokes in the live tail is rasterized once into a reusable tail image; erasers and short runs continue through the ordered replay path so destination-out remains deterministic. The tail image is inserted at its original position and is never moved ahead of an eraser or an unfinished operation. Changed geometry, removed operations, history changes, reordered predictions, and DPR changes invalidate the relevant image.

### Mixed-tail performance sample

`benchmarks/results/mixed-tail-baseline.json` records three 5-second repetitions per scenario in Chromium 153 at DPR 2 on the same Windows machine. Each 300-stroke mixed fixture updates both an early unfinished brush and an appended live brush. The values below are the ranges of each repetition's p50 or p95, so they remain performance observations rather than pass/fail thresholds.

| Eraser interval | Updates / 5 s | FPS | `renderMs` p50 / p95 | `tailReplayMs` p50 / p95 | `surfaceCopyMs` p50 / p95 | `prefixCompareMs` p50 / p95 | `repaintAreaPx` p50 / p95 | `frameIntervalMs` p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Every 4 strokes | 79–80 | 15.67–16.00 | 1.5–1.6 / 1.9–3.3 | 0.5 / 0.7 | 0 / 0.1 | 0.4 / 0.5 | 1,343,296 / 1,488,256 | 66.6 |
| Every 7 strokes | 83–87 | 16.45–17.32 | 1.6 / 2.4–3.3 | 0.5 / 0.7 | 0 / 0.1 | 0.4–0.5 / 0.8 | 1,357,792–1,427,856 / 1,488,256 | 50.1–66.6 |
| Every 16 strokes | 90–94 | 17.86–18.72 | 7.1–7.5 / 8.6–9.3 | 6.0–6.4 / 6.7–7.8 | 0 / 0.1 | 0.4 / 0.5–0.6 | 1,454,432–1,485,840 / 1,488,256 | 50.0 |

The measured bottleneck is main-thread/frame scheduling: the 50–67 ms median frame intervals and 53–63 ms median pointer-to-render delays are much larger than the 1.5–7.5 ms median `renderMs`. Dirty-region comparison and stable-surface copying are not the limiting components. The every-16 case also exposes a synchronous replay hotspot: its reusable tail image raises median `tailReplayMs` from 0.5 ms to 6.0–6.4 ms and accounts for most of its measured render time. Deferred Canvas rasterization may contribute to the scheduling gap, but these component timers do not isolate it from browser frame scheduling, so the baseline does not justify attributing that gap to path submission or rasterization alone.

### Functional compositing oracle

Browser compositing tests compare incremental rendering against an independent full replay over 41 transitions at DPR 1, 1.5, and 2. The sequence covers late lower points beneath a later eraser, completion and history changes, eraser removal, begin-order reordering across an eraser, and mutation of a cached brush run before a later eraser. It requires matching alpha and interior pixels, allowing only one-channel rounding from cached transparent brush rasters and a one-device-pixel neighborhood of a reference edge where clipping affects antialias coverage. This verifies compositing semantics without turning the performance observations above into functional assertions or claiming byte-identical raster edges across repaint paths or browser engines. Native Safari and real remote collaboration remain separate validation scenarios.

See [VERIFICATION.md](VERIFICATION.md) for final command results, measurements, and remaining limitations.

### Task 3 cache decision

The proposed bounded mixed-tail tile operation cache was rejected. The genuine post-change sample in `benchmarks/results/mixed-tail-post.json` used one 3-second Chromium repetition and measured 14.03, 15.15, and 16.28 FPS for erasers every 4, 7, and 16 strokes. Task 2's three 5-second baseline repetitions measured 15.67–16.00, 16.45–17.32, and 17.86–18.72 FPS for those scenarios. Because the mixed cases regressed and the runs differ in duration and repetition count, this is evidence against accepting the cache rather than a timing threshold or proof of a general regression.

The production renderer remains unchanged by Task 3. The independent `verifyMixedTailSequence` oracle remains in the browser suite, and the raw post and diagnostic JSON artifacts are retained for review. No tile backing storage or memory-cap claim is made for the rejected implementation.
