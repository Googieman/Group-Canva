# Task 3 report: pointer, camera, selection, and rendering reliability

## Files and design

- `client/canvas.ts` keeps pointer coordinates in CSS bounds and camera space, adds Escape cancellation, indexes object bounds for camera culling, and renders committed translated ink through the same ordered ink replay as streamed strokes.
- `client/objects.ts` hit-tests translated ink and line/arrow endpoints, including negative drags.
- `client/main.ts` preserves line/arrow endpoint direction, excludes erasers from ordinary selection, and keeps selection previews in the document object path.
- `client/viewport.ts` provides a bounded uniform-grid spatial index with an overflow list for large objects.
- `shared/document.ts` stores optional local line/arrow endpoints and validates/bounds them while retaining legacy shape compatibility.

## Verification

Commands run:

```text
npx vitest run tests/canvas.test.ts tests/objects.test.ts tests/viewport.test.ts
  3 test files passed, 24 tests passed

npm run typecheck
  passed

npx playwright test tests/browser/whiteboard.spec.ts --project=chromium --project=webkit
  10 passed

npx playwright test tests/browser/compositing.spec.ts --project=chromium
  6 passed
```

Firefox could not launch in this environment (`spawn UNKNOWN`) before the test body. The first compositing run exposed raster differences from an experimental CSS-sized backing change; that experiment was reverted after tracing it to the unchanged 1600x900 compositing oracle. The existing DPR/cache contract and oracle now pass.

## Review and concerns

The requested subagent reviewer was not available in this Codex environment, so the range was reviewed locally before commit. No critical or important issues were found. The existing logical 1600x900 backing surface remains intentionally preserved because the established compositing oracle depends on that raster contract; the finite world is still not allocated as a bitmap.
