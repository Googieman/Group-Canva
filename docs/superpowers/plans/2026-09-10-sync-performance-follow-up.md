# Synchronization and Performance Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the hosted collaboration path and reduce the remaining mixed brush/eraser rendering cost while preserving authoritative ordering and the existing transport contract.

**Architecture:** Keep the current vanilla Canvas client, authoritative single-process Node room, and Socket.IO WebSocket stream. First separate browser rendering cost from network cost on a real hosted path. Then improve only the mixed tail replay path, with an independent full-replay oracle and a direct-replay fallback for any cache state that cannot be proven equivalent.

**Tech Stack:** TypeScript, HTML5 Canvas, Node.js, Socket.IO/WebSocket, Vite, Vitest, Playwright Chromium/WebKit, and the existing benchmark harness.

**Spec:** `docs/VERIFICATION.md` and `docs/SYNC-REVIEW.md`

## Global Constraints

- Frontend remains Vanilla JavaScript/TypeScript + HTML5 Canvas.
- Backend remains Node.js + Socket.IO WebSockets.
- Do not add React, Vue, Svelte, a drawing library, WebRTC, WebTransport, Redis, a database, persistence, shapes, text, or selection.
- Preserve begin-order compositing, deterministic `destination-out` erasing, completion-order global undo/redo, hydration epoch/revision guards, and the 20 ms / 64-point batching contract.
- Keep functional assertions separate from performance measurements.
- Do not rewrite the original implementation plan or repository history.

---

### Task 1: Establish a hosted transport baseline

**Files:**
- Read: `benchmarks/README.md`, `benchmarks/run.ts`, `docs/VERIFICATION.md`
- Modify: `docs/VERIFICATION.md` only after collecting results
- Create: `benchmarks/results/hosted-same-machine.json`, `benchmarks/results/hosted-remote.json` when the runs exist

**Interfaces:**
- Consumes: the deployed backend URL through `BENCH_SERVER_URL`.
- Produces: per-run counts and p50/p95 values for propagation, command acknowledgement, batch interval, rendered observer FPS, and host-side server processing.

- [ ] **Step 1: Verify the deployment endpoint**

  Confirm that the frontend uses the deployed HTTPS origin, the backend accepts the exact frontend origin, and the endpoint upgrades Socket.IO to WebSocket without an authentication or browser interstitial. Record region, commit, browser, device, network type, and whether the run is on the server machine or a separate device. Store the endpoint in an environment variable rather than in source control.

- [ ] **Step 2: Run the hosted same-machine benchmark**

  ```powershell
  $env:BENCH_SERVER_URL = Read-Host 'Deployed backend HTTPS URL'
  $env:BENCH_PHASE='load'
  $env:BENCH_DURATION_MS='60000'
  $env:BENCH_REPETITIONS='1'
  npm run benchmark -- hosted-same-machine
  ```

  Require all expected deliveries, zero duplicates, zero incomplete rooms, and a saved JSON report. Keep `serverProcessingMs` collected on the backend host separately because an external benchmark report cannot observe it.

- [ ] **Step 3: Run the same workload from a genuinely separate collaborator device**

  Run the identical command and duration from the second device. Do not compare clock-based one-way display latency; use the benchmark’s monotonic propagation and acknowledgement measurements and record both endpoint locations.

- [ ] **Step 4: Update the verification record**

  Add the hosted p50/p95 results, delivery counts, FPS, and server processing values to `docs/VERIFICATION.md`. State explicitly whether the tunnel was bypassed and list any cold-start, Safari, or remote-device limitations that remain.

- [ ] **Step 5: Commit the measurement record**

  ```powershell
  git add docs/VERIFICATION.md benchmarks/results/hosted-same-machine.json benchmarks/results/hosted-remote.json
  git commit -m "test: record hosted collaboration baseline"
  ```

### Task 2: Isolate the mixed brush/eraser renderer bottleneck

**Files:**
- Modify: `benchmarks/render.ts`, `benchmarks/run.ts`
- Test: `tests/browser/compositing.spec.ts`
- Read: `client/canvas.ts`, `benchmarks/results/baseline-final.json`, `benchmarks/results/post-final2.json`

**Interfaces:**
- Consumes: `CanvasBoard.setStrokes()` and `window.canvasDiagnostics`.
- Produces: repeatable mixed-tail scenarios that report `renderMs`, `surfaceCopyMs`, `tailReplayMs`, `repaintAreaPx`, FPS, and exact delivery-independent rendering checks.

- [ ] **Step 1: Add a mixed-tail workload matrix**

  Keep the existing 300-stroke fixture and add scenarios with erasers every 4, 7, and 16 strokes. For each scenario, update an early unfinished stroke and an appended live stroke for at least 5 seconds at DPR 2. Record the number of updates and all renderer component metrics; do not add a pass/fail timing threshold.

- [ ] **Step 2: Extend the full-replay oracle before changing rendering**

  Add transitions that mutate a lower stroke beneath a later eraser, change completion state, remove an eraser, reorder an operation, and update a cached brush run before a later eraser. Require equal alpha and interior pixels, permit only documented one-channel raster rounding and one-device-pixel edge coverage, and verify the expected number of transitions in Chromium and WebKit.

- [ ] **Step 3: Run the matrix against the current renderer**

  ```powershell
  $env:BENCH_REPETITIONS='3'
  $env:BENCH_DURATION_MS='5000'
  npm run benchmark -- mixed-tail-baseline
  ```

  Use the component metrics to decide whether the remaining cost is path submission, repeated Canvas rasterization, dirty-region intersection, or main-thread scheduling. Record the decision in `docs/SYNC-REVIEW.md` before writing an optimization.

- [ ] **Step 4: Commit the independent workload and oracle**

  ```powershell
  git add benchmarks/render.ts benchmarks/run.ts tests/browser/compositing.spec.ts docs/SYNC-REVIEW.md
  git commit -m "test: isolate mixed tail rendering cost"
  ```

### Task 3: Implement a correctness-gated mixed-tail cache

**Files:**
- Modify: `client/canvas.ts`
- Test: `tests/canvas.test.ts`, `tests/browser/compositing.spec.ts`
- Read: `benchmarks/render.ts`

**Interfaces:**
- Consumes: ordered visible strokes, dirty `InkBounds`, device-pixel ratio, and the full-replay oracle from Task 2.
- Produces: an internal mixed-tail cache with deterministic ordered replay and a direct-replay fallback.

- [ ] **Step 1: Write a failing browser regression for cached mixed tails**

  Exercise a long sequence containing brush runs, erasers, an unfinished stroke before the sequence, and a live stroke after it. Mutate the unfinished stroke repeatedly, toggle an eraser through undo/redo, remove an operation, and change DPR. The test must compare the visible Canvas result with independent full replay at DPR 1, 1.5, and 2.

- [ ] **Step 2: Add a bounded tile operation cache**

  Partition only completed tail operations into 256 logical-pixel tiles. For each tile, retain rasterized operation images in original begin order, including separate `source-over` brush images and `destination-out` eraser images. Include a one-device-pixel source margin, key entries by stroke geometry/style and DPR, and cap total backing storage at 64 MiB. If a tile exceeds the cap or an operation cannot be represented safely, replay that tile directly from the ordered stroke list.

- [ ] **Step 3: Integrate the cache behind the existing dirty-region renderer**

  Clear and restore only dirty tiles, draw the stable prefix tile, then apply cached operation images in begin order. Keep unfinished strokes on the direct path. Invalidate entries on point/style changes, removal, history changes, order changes, and DPR changes. Never combine brush and eraser layers in a way that changes their relative order.

- [ ] **Step 4: Run correctness tests before measuring speed**

  ```powershell
  npm test
  $env:E2E_PORT='3110'; npx playwright test tests/browser/compositing.spec.ts --project=chromium --project=webkit
  ```

  Expected result: all functional tests pass, all compositing transitions pass, and no alpha/interior mismatch is reported. If the oracle fails, disable the new cache for the failing case and keep direct replay.

- [ ] **Step 5: Measure post-change performance**

  ```powershell
  $env:BENCH_REPETITIONS='3'
  $env:BENCH_DURATION_MS='5000'
  npm run benchmark -- mixed-tail-post
  ```

  Compare p50/p95 `renderMs`, `tailReplayMs`, FPS, repaint area, and memory behavior with Task 2. Keep the optimization only if it improves the measured mixed case without regressing the brush-only case or increasing cache memory beyond 64 MiB.

- [ ] **Step 6: Commit the renderer change**

  ```powershell
  git add client/canvas.ts tests/canvas.test.ts tests/browser/compositing.spec.ts benchmarks/results/mixed-tail-post.json docs/VERIFICATION.md docs/SYNC-REVIEW.md
  git commit -m "perf: cache mixed canvas tail operations"
  ```

### Task 4: Final cross-browser and hosted regression gate

**Files:**
- Modify: `docs/VERIFICATION.md`, `ARCHITECTURE.md` only if the accepted cache changes the documented design
- Test: all existing unit, browser, and benchmark commands

**Interfaces:**
- Consumes: committed implementation and benchmark reports from Tasks 1–3.
- Produces: a reviewable final verification record and a clean worktree.

- [ ] **Step 1: Run the complete automated suite**

  ```powershell
  npm test
  npm run build
  git diff --check
  ```

- [ ] **Step 2: Run browser QA**

  Run Chromium and WebKit whiteboard flows plus the compositing oracle. Record Firefox launch failures as environment limitations instead of changing application behavior.

- [ ] **Step 3: Review synchronization invariants**

  Confirm that concurrent overlap, reverse completion, late points beneath erasers, hydration races, epoch changes, revision gaps, reconnects, duplicate batches, and ten-client convergence still pass with unchanged 20 ms / 64-point batching.

- [ ] **Step 4: Decide whether transport changes are justified**

  Keep authoritative strokes on Socket.IO/WebSocket unless hosted measurements show a transport problem that rendering and deployment placement cannot explain. If cursors need a lower-latency channel later, write a separate design for an unreliable channel; do not replace the authoritative stream as part of this plan.

- [ ] **Step 5: Update documentation and commit**

  ```powershell
  git add docs/VERIFICATION.md ARCHITECTURE.md
  git commit -m "docs: record synchronization performance verification"
  ```
