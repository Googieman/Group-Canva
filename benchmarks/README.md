# Drawing performance measurements

Run from the existing repository with `npm install` and Playwright Chromium installed. These are measurements, separate from the functional assertions in `npm test` and `npm run test:e2e`. There are no timing thresholds in the functional suite.

## Repeatable local comparison

In PowerShell:

```powershell
$env:BENCH_RENDERER_REF='24da114'
npm run benchmark -- baseline-repeat
Remove-Item Env:BENCH_RENDERER_REF
npm run benchmark -- post-repeat
```

The historical renderer is loaded from the existing Git commit, with the current workload and diagnostics. No checkout, history rewrite, or second implementation is created. `24da114` adds instrumentation to the original renderer. Leave the computer otherwise idle and keep power, browser, viewport, and display settings constant. Run comparisons sequentially. JSON records the renderer reference, current commit, dirty-tree flag, browser version, CPU, repetitions, and duration. Do not edit source during a run; hot reload is disabled.

The default performs three repetitions of:

1. Eight seconds per renderer scene: the four original scenes (empty history, a completed prefix, a mixed brush/eraser 36,000-point history with its first operation unfinished, and an all-brush history with a long completed tail), plus the mixed-tail scene with eraser intervals of 4, 7, and 16. A growing live stroke is appended once per animation frame; unfinished scenes also append to the first operation. This measures sustainable rendering throughput, with the number of updates recorded, rather than imposing a fixed hardware pointer rate.
2. Eight seconds of Playwright mouse input through the actual application and prediction/batching path.
3. Eight seconds with ten clients in one unique room: five concurrent authors, one rendered browser, and four additional socket observers. Each author requests two-point batches every 20 ms. Actual scheduling intervals and received batch counts are recorded.

The browser uses a 1280 × 900 viewport and DPR 2; the logical board is 1600 × 900, with a 3200 × 1800 backing surface. The renderer fixture stays outside the production entry point.

## Sustained run and controlled transport delay

```powershell
$env:BENCH_PHASE='load'
$env:BENCH_DURATION_MS='60000'
$env:BENCH_REPETITIONS='1'
npm run benchmark -- sustained-local

$env:BENCH_DURATION_MS='8000'
$env:BENCH_REPETITIONS='3'
$env:BENCH_DELAY_MS='50'
npm run benchmark -- delayed-local

'BENCH_PHASE','BENCH_DURATION_MS','BENCH_REPETITIONS','BENCH_DELAY_MS' |
  ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
```

The delay fixture is a local TCP proxy adding 50 ms in each direction. Actual measured round-trip time is recorded; operating-system timers can exceed the requested delay. This is a synthetic transport profile, not a measurement of VS Code tunnels, international networks, packet loss, or native Safari. Duration is bounded to 1–60 seconds and repetitions to 1–20; use separate runs for longer observation periods so the MVP's intentional room/point limits remain meaningful.

## Remote tunnel comparison

Use the same committed application on the tunnel host and run the benchmark from the collaborator's machine with an accessible backend URL:

```powershell
$env:BENCH_SERVER_URL='https://YOUR-ACCESSIBLE-TUNNEL-HOST'
npm run benchmark -- remote-tunnel
Remove-Item Env:BENCH_SERVER_URL
```

The endpoint must expose the application's Socket.io WebSocket endpoint and allow the test frontend origin. An authentication interstitial cannot be benchmarked as a WebSocket endpoint. Do not weaken tunnel authentication or origin policy just to make a test pass. Record host/client location, browser and hardware, network type, tunnel settings, and application commit alongside the resulting JSON. The benchmark uses a fresh room and does not save the supplied URL in its report.

Running this command on the server's own machine tests the route through the tunnel and back to that machine. Running it on a remote collaborator's machine tests the remote route. Neither is a two-device, clock-synchronized one-way display measurement. Server processing is `null` for an external backend; collect host-side diagnostics separately if needed.

For a real two-person drawing session, both browsers can open their shared room with `&diagnostics=1`. In each browser's developer console:

```javascript
window.canvasDiagnostics.reset()
// Draw together for the agreed interval, then capture:
JSON.stringify(window.canvasDiagnostics.report(), null, 2)
```

Keep both tabs visible. Capture both reports and note which browser was drawing, scene size, and whether an earlier operation was still unfinished. Diagnostics are opt-in, bounded, local, and contain durations/counts rather than stroke content. They send no telemetry.

## What each number means

| Metric | Boundary and limitations |
| --- | --- |
| `pointerToRenderMs` | Accepted pointer event timestamp to completion of Canvas API submission. Includes prediction and animation-frame scheduling; excludes physical display scanout. The renderer fixture uses synthetic update timestamps instead of hardware input. |
| `pointerToNextFrameMs` | Timestamp to the next animation-frame opportunity after drawing submission. A presentation proxy, not proof that a pixel was displayed. |
| `frameIntervalMs`, `fps` | Animation-frame callback intervals and callbacks per elapsed second. Background throttling and host load affect them. |
| `renderMs` | Synchronous rendering JavaScript/Canvas submission time. Deferred rasterization/compositing may occur later, so short CPU time does not establish smooth rendering. |
| `surfaceCopyMs`, `prefixCompareMs`, `tailReplayMs` | CPU submission/comparison components. They do not independently measure GPU execution. |
| `repaintAreaPx` | Total device-pixel area scheduled for regional repaint. A full DPR 2 board is 5,760,000 pixels. |
| `predictionAppendMs`, `predictionMergeMs` | Prediction array extension and list/UI reconciliation cost. |
| `receiveToReduceMs` | Browser event handler's authoritative reducer cost. |
| `batchIntervalMs`, `batchPoints`, `batchesPerSecond` | Actual nonempty batches, not timer ticks. Input generation, batching, and OS scheduling affect these. The 20 ms / 64-point contract is unchanged. |
| `commandAckMs`, `roundTripMs` | Command send to acknowledgement; the latter is measured by the benchmark runner before sustained drawing. |
| `propagationMs` | Runner author send to a separate runner observer's accepted point event, using one monotonic clock. Includes transport and decoding in both legs; excludes waiting in the author's point batch and subsequent browser painting. |
| `serverProcessingMs` | Local server validation, mutation and broadcast enqueue, before acknowledgement. Excludes network transit and deferred socket writes. Unavailable for external hosts. |

Percentiles use the nearest-rank method within each run. Preserve per-run p50/p95 and sample counts; an average of p95 values is not a pooled p95. Browser diagnostics retain at most 20,000 samples per metric. Long runs can reach that cap; counts make this visible.

See [the verification record](../docs/VERIFICATION.md) for actual results and unverified scenarios.
