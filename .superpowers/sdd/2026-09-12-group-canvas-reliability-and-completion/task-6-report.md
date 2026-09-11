# Task 6 report: bounded content-only PNG export

## Files and design

- `client/export.ts` now computes finite document content bounds, applies shape/arrow stroke padding, caps PNG dimensions at 4096 pixels per side and 16 megapixels, and renders into a bounded white output canvas.
- Ink is replayed in document order on a transparent surface using the same `renderInkStroke` helper as the editor, so erasers use `destination-out` without erasing shapes, text, or images. Non-ink objects are rendered afterward through `renderDocumentObject`.
- `client/main.ts` now exports the committed document and loaded assets instead of capturing the visible editor canvas. The legacy viewport helper remains available for non-editor callers.
- Browser coverage parses the downloaded PNG header and verifies a drawn rectangle exports below the fixed editor viewport dimensions.

## Verification

- `npx vitest run tests/export.test.ts` — 4 tests passed.
- `npx playwright test tests/browser/export.spec.ts --project=chromium` — 1 passed.
- `npx playwright test tests/browser/export.spec.ts --project=webkit` — 1 passed.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `git diff --check` — no whitespace errors; Git reported only the repository's existing LF/CRLF normalization warnings.

## Review

Local review found no critical or important issues. The export pass is intentionally independent of camera, selection, grid, and DOM controls. Empty documents export a bounded 1×1 white PNG; inactive ink is not painted. The remaining release-level concern is that downloaded-image pixel decoding is covered indirectly by browser PNG-header checks rather than a full image-content oracle.
