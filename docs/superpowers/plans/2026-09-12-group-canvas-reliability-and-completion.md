# Group Canvas Reliability and Milestone Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make the Group Canvas implementation satisfy the supplied milestone specification and make the local browser smoke test reliably support drawing, text, shapes, saved files, exports, and hosted collaboration.

**Architecture:** Keep one DOM-free document model and command reducer in shared code. Local files use the same command application semantics as a room; collaborative rooms add the Node authority, Socket.IO transport, leases, and host lifecycle around that reducer. Keep camera, selection, predictions, and temporary text editors local, and keep ink compositing separate from shapes, text, and images.

**Tech Stack:** Vanilla TypeScript, DOM, HTML5 Canvas, Vite, Node/Express, Socket.IO, IndexedDB, Vitest, and Playwright.

**Spec:** C:\Users\varug\.codex\attachments\9b74e29e-0cab-4bab-bba9-4aed4846e6a5\pasted-text.txt

## Global Constraints

- Build on the existing vanilla TypeScript, DOM, HTML5 Canvas, Node, and Socket.IO application; preserve repository history, accepted performance work, and existing regression evidence.
- Browser-local saved files use IndexedDB; collaboration pauses on host disconnect with a two-minute recovery window; freehand erasing affects ink only.
- The document model uses schema version 1, a bounded world of plus or minus 100,000 logical units, and zoom from 10% through 400%.
- PNG exports are bounded to 4096 pixels per side and 16 megapixels, have a white background, and exclude controls, cursors, selection, and grid.
- Images are PNG, JPEG, or WebP only; per-image limit is 5 MiB, maximum side is 4096 pixels, maximum image area is 16 megapixels, and total room/document assets are limited as specified.
- Protocol v2 rejects incompatible clients with an update message; frontend and backend releases are coordinated and mixed-version editing is not supported.
- No accounts, ownership transfers, rotation, groups, connectors, layer panel, or collaborative character-by-character text editing are added in this milestone.

## Current Location and Observed Failure

The implementation under repair is in:

    C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap

Its current branch is codex/group-canvas-roadmap, and the implementation changes are uncommitted. The main checkout at C:\Users\varug\Group-Canvas is not the target implementation checkout.

The browser smoke test was run against a local page at 127.0.0.1:3001. The page loaded, but it stayed on Connecting… and Ping unavailable; brush, rectangle, and text gestures produced no committed content; opening the saved file named Hello showed Untitled canvas; Copy invite link did work. The first repair task must distinguish a read-only local-file lock, a stale server, and a real Socket.IO failure so the UI does not silently look editable while input is disabled.

## File and Responsibility Map

- C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\shared\document.ts owns the versioned Document/Object union, validation, bounds, and DOM-free document command application.
- C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\shared\protocol.ts owns Socket.IO payload types, protocol version, stroke streaming, document commands, leases, snapshots, and room lifecycle messages.
- C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\server\app.ts owns room authority, ordering, transaction history, leases, host lifecycle, asset HTTP endpoints, limits, and protocol validation.
- C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\client\state.ts owns authoritative client reduction, snapshot hydration, revision/epoch recovery, legacy stroke compatibility, and document history.
- C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\client\network.ts owns Socket.IO connection state, snapshot recovery, command acknowledgements, asset transport, host controls, and latency probes.
- C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\client\main.ts owns editor composition, local versus shared authority selection, input callbacks, text editing, save scheduling, file hydration, hosting, and export wiring.
- C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\client\canvas.ts owns pointer/touch gestures, camera-aware input conversion, canvas backing surfaces, ink rendering, object rendering, selection overlays, and cursor rendering.
- C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\client\objects.ts owns hit testing and constrained shape geometry; C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\client\viewport.ts owns camera transforms, pan, zoom, fit, and world bounds.
- C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\client\ui.ts and C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\client\style.css own editor/home controls, status messaging, responsive layout, and read-only/connection presentation.
- C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\client\storage.ts owns IndexedDB files/assets, atomic saves, and single-writer leases; C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\client\home.ts owns My canvases and file actions.
- C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\client\projects.ts, C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\client\images.ts, and C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\client\export.ts own project round trips, image validation/decoding, and bounded content-only PNG rendering.
- C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\tests\ contains unit, server integration/hardening, and browser regression tests. Extend existing tests instead of replacing the accepted stroke and compositing coverage.

### Task 1: Make local and shared startup truthful and editable

**Files:**
- Modify: client/main.ts functions startEditor, send, discardLocal, and the editor initialization block
- Modify: client/network.ts constructor, connection error handling, endpoint selection, and status callbacks
- Modify: client/ui.ts UI status/read-only methods
- Modify: client/storage.ts claimWriter and WriterLease
- Modify: vite.config.ts development proxy
- Modify: tests/network.test.ts and tests/browser/whiteboard.spec.ts
- Create: tests/browser/local-file.spec.ts

**Interfaces:**
- Produce a single endpoint resolver with signature resolveSocketEndpoint(): string | undefined; undefined means same-origin Socket.IO.
- Extend WriterLease to report readOnly and a user-facing reason while retaining release(): void.
- Extend the editor UI with setLocalMode(readOnly: boolean): void and setConnectionError(message: string): void; local mode must not be represented as a failed collaboration connection.

- [ ] Step 1: Add failing browser tests for the two startup modes.

    Test the local-file fixture with:

        await page.goto(baseUrl + '/?file=' + fileId);
        await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
        await expect(page.getByText('Connecting…', { exact: true })).not.toBeVisible();
        await expect(page.locator('canvas')).toHaveAttribute('aria-disabled', 'false');

    Test the shared-room fixture with:

        await page.goto(baseUrl + '/?room=smoke-' + Date.now());
        await expect(page.getByText('Live together', { exact: true })).toBeVisible({ timeout: 15000 });

    Keep a third test that opens the same local file in a second context and expects a visible read-only message and hidden mutating controls. This proves the lock is enforced without making the first tab look disconnected.

- [ ] Step 2: Add a failing network test for the actual local server endpoint.

    Start createAppServer({ host: '127.0.0.1' }), clear VITE_SERVER_URL, construct Connection with a DOM-like window whose origin is the server URL, and assert that the first snapshot reaches DrawingState.ready. This catches the current “npm start succeeds but the browser remains Connecting…” mismatch.

- [ ] Step 3: Implement deterministic endpoint and mode selection.

    Use this precedence in resolveSocketEndpoint():

        const configured = import.meta.env.VITE_SERVER_URL?.trim();
        if (configured) return configured;
        if (window.location.hostname === 'group-canva.pages.dev') return 'https://group-canvas.onrender.com';
        return undefined;

    Do not create a Connection for a local file opened without room or host parameters. In local mode, set the status to Saved on this device and enable CanvasBoard when the writer lease is writable. If the lease is read-only, keep the canvas disabled and show Read-only · another tab is editing.

- [ ] Step 4: Make connection failure explicit and recoverable.

    Keep Connecting only while the Socket.IO connection or snapshot is within its hydration deadline. After the deadline, set the UI to Unable to connect · Retry, stop enabling drawing, and expose a retry callback that destroys and reconstructs the connection. Preserve disconnected/reconnecting behavior after a successful session so an offline collaborator cannot generate commands.

- [ ] Step 5: Fix the development proxy and startup documentation.

    Make Vite proxy /socket.io target the configured development backend port rather than a hard-coded unrelated port, while preserving npm start’s same-origin production behavior. Document separate commands for npm run dev and npm start, including the port used by each.

- [ ] Step 6: Run the focused checks and commit.

    Run:

        npm run typecheck
        npx vitest run tests/network.test.ts
        npx playwright test tests/browser/local-file.spec.ts tests/browser/whiteboard.spec.ts

    Expected result: local files are editable when writable, shared rooms reach Live together, read-only tabs identify the cause, and a failed backend no longer leaves a misleading indefinitely-connecting editor.

    Commit with:

        git add client/main.ts client/network.ts client/ui.ts client/storage.ts vite.config.ts tests/network.test.ts tests/browser/local-file.spec.ts tests/browser/whiteboard.spec.ts README.md
        git commit -m "fix: make editor startup and connection state truthful"

### Task 2: Unify document commands, transaction history, leases, and deduplication

**Files:**
- Modify: shared/document.ts command result and history validation/application
- Modify: shared/protocol.ts command/change payloads
- Modify: client/state.ts snapshot/revision/document-history reduction
- Modify: client/main.ts local authority and command acknowledgement handling
- Modify: server/app.ts apply, publishDocument, lease, history, and operation-result paths
- Modify: tests/document.test.ts, tests/state.test.ts, tests/server.integration.test.ts, tests/server.hardening.test.ts, and tests/network.test.ts

**Interfaces:**
- Add operationId?: string to every committed stroke command as well as every document/history command; operation IDs are client-generated and bounded by the server.
- Add a shared applyHistoryTransaction(document, history, transaction, direction, expectedVersions): DocumentCommandResult helper that validates the affected object versions before applying a before/after patch.
- Keep all authoritative commits represented as one revisioned Change; camera and selection never enter this path.

- [ ] Step 1: Write failing reducer tests for the transaction contract.

    Cover one transaction for each create, move, resize, text replacement, and multi-delete. Verify undo restores the before patches, redo reapplies the after patches at the original order, and a new commit clears redo. Add a conflict case:

        expect(() => applyHistoryTransaction(document, history, transaction, 'before', { objectId: 99 })).toThrow('Object changed while it was being edited');

    Add a test that an unfinished stroke is absent from both saved document history and undo eligibility.

- [ ] Step 2: Write failing server tests for atomic lease and history conflicts.

    Use two Socket.IO clients. Acquire a lease for two selected objects from client A; assert client B cannot acquire either object and that a move from B changes neither object. Undo a transaction after incrementing one affected object version and assert the server returns a conflict without consuming a different history item.

- [ ] Step 3: Implement shared patch preconditions and exact history behavior.

    Before applying a history transaction, compare every affected object with the transaction side being undone or redone. Reject missing objects, unexpected versions, and partial multi-object matches. Only after all patches pass validation should the reducer construct the next document, history, and revision.

- [ ] Step 4: Make local and collaborative authority use the same document path.

    Remove the fallback that decides between localStrokeCommand and localDocumentCommand based on whether a stroke has previously been seen. Adapt legacy brush/eraser streaming into a committed transaction at stroke end, then call the same document reducer used for shapes, text, images, moves, and deletes. Keep point batching/prediction separate from committed history.

- [ ] Step 5: Add bounded operation deduplication to every committed server command.

    Store successful operation results by operationId per room, return the original result for an exact duplicate, reject a reused ID with a different command body, and evict entries at the configured bound. Confirm that duplicate point batches do not create revisions, while duplicate completed transactions do not create a second history item.

- [ ] Step 6: Implement lease renewal/release and conflict messages.

    Acquire all selected IDs atomically, renew every five seconds, expire after 15 seconds, release on cancel/disconnect, broadcast lease:update, and check leases again at commit. Return a clear retry message for stale versions, expired leases, conflicting delete, and conflicting undo/redo.

- [ ] Step 7: Run unit and server tests and commit.

    Run:

        npx vitest run tests/document.test.ts tests/state.test.ts tests/server.integration.test.ts tests/server.hardening.test.ts tests/network.test.ts

    Expected result: local and server history have identical semantics, no conflict partially applies, operation duplicates are bounded/idempotent, and legacy stroke regression tests remain green.

    Commit with:

        git add shared/document.ts shared/protocol.ts client/state.ts client/main.ts server/app.ts tests/document.test.ts tests/state.test.ts tests/server.integration.test.ts tests/server.hardening.test.ts tests/network.test.ts
        git commit -m "feat: unify document transactions and conflict-safe history"

### Task 3: Repair pointer input, camera mapping, selection, and rendering

**Files:**
- Modify: client/canvas.ts CanvasBoard gesture handlers and render paths
- Modify: client/main.ts CanvasBoard callbacks, selection state, and draft commit flow
- Modify: client/objects.ts hitTestObject and constrainDrag
- Modify: client/viewport.ts camera transforms and fitCamera
- Modify: client/style.css workspace sizing and overflow behavior
- Modify: tests/canvas.test.ts, tests/objects.test.ts, tests/viewport.test.ts, tests/browser/whiteboard.spec.ts, and tests/browser/compositing.spec.ts

**Interfaces:**
- Keep screenToWorld(point, viewport, camera) and worldToScreen(point, viewport, camera) as the only pointer/editor coordinate conversion functions.
- Add a spatial index interface with insert(id, bounds): void, remove(id): void, query(bounds): string[], and clear(): void; use an overflow list for objects too large for normal grid cells.
- Keep CanvasBoard callbacks for begin, points, end, cancel, cursor, camera changes, and width changes; non-ink tools must use the same enabled and pointer-capture lifecycle as ink tools.

- [ ] Step 1: Add failing browser tests that expose the current no-op gestures.

    In a local writable file, select Brush and drag across the canvas; assert the alpha count rises. Repeat with Rectangle and Text. Add selection tests for click, Shift-click, marquee, multi-object move, and Delete. Add a refresh assertion that committed objects remain visible and editable.

- [ ] Step 2: Add failing geometry tests.

    Verify positive and negative drags, Shift squares/circles, 45-degree line/arrow snapping, line/arrow hit testing, text bounds, and translated ink hit testing. Test pan by Space-drag, middle drag, and Hand; test wheel zoom around a non-center pointer and clamp at 10%/400%.

- [ ] Step 3: Make the board’s enabled state and pointer coordinates observable.

    Add a test-only or diagnostics callback that records the first world point and committed command. Confirm that a pointer down in the actual canvas rectangle reaches onBegin when the local writer is writable. Never use browser-window coordinates as world coordinates; derive them from getBoundingClientRect and the current camera.

- [ ] Step 4: Implement separate ink and object compositing.

    Render ordered brush/eraser operations into a transparent ink surface, then render shapes, text, and images above it. Erasers use destination-out only on the ink surface. Move translated ink while preserving its eraser paths in world coordinates. Invalidate camera-dependent caches on pan/zoom/DPR changes and retain direct ordered replay as the correctness fallback.

- [ ] Step 5: Add culling without changing visual order.

    Index transformed object bounds, query the camera view plus dirty padding, merge the returned IDs with the overflow list, then sort by authoritative order before rendering. Keep the actual backing canvases viewport-sized and DPR-aware; do not allocate a world-sized bitmap.

- [ ] Step 6: Implement complete selection and gesture cancellation.

    Hit-test topmost objects in reverse visual order, preserve Shift additive selection, make marquee selection atomic, render move previews without revisions, commit one multi-move transaction on release, and release leases on pointercancel, lostpointercapture, second-touch navigation, disconnect, and Escape. Delete selected objects as one transaction.

- [ ] Step 7: Run focused browser/compositing tests and commit.

    Run:

        npx vitest run tests/canvas.test.ts tests/objects.test.ts tests/viewport.test.ts
        npx playwright test tests/browser/whiteboard.spec.ts tests/browser/compositing.spec.ts

    Expected result: a writable local canvas produces visible brush, shape, and text gestures; camera transforms preserve pointer anchoring; erasers cannot damage objects; selection and multi-object operations commit exactly once; and the existing compositing oracle remains unchanged.

    Commit with:

        git add client/canvas.ts client/main.ts client/objects.ts client/viewport.ts client/style.css tests/canvas.test.ts tests/objects.test.ts tests/viewport.test.ts tests/browser/whiteboard.spec.ts tests/browser/compositing.spec.ts
        git commit -m "fix: restore canvas gestures and camera-aware rendering"

### Task 4: Finish shapes, text editing, and local image behavior

**Files:**
- Modify: client/main.ts startDraft, updateDraft, commitDraft, openTextEditor, and image callback
- Modify: client/canvas.ts object rendering and text/image invalidation
- Modify: client/objects.ts shape geometry/hit testing
- Modify: client/ui.ts text-size, image-picker, and status controls
- Modify: client/images.ts validation and decode retry behavior
- Modify: shared/document.ts ShapeObject, TextObject, and ImageObject validation
- Modify: tests/document.test.ts, tests/objects.test.ts, tests/export.test.ts
- Create: tests/browser/objects.spec.ts

**Interfaces:**
- Text editing uses a temporary HTMLTextAreaElement whose commit path is commitTextEditor(): void and whose cancel path is cancelTextEditor(): void.
- Add renderDocumentObject(context, object, assets, fontReady): void as the single Canvas object renderer used by the editor and export pass.
- Keep image objects proportional by default; resize commands carry preserveAspectRatio?: boolean and are validated against the asset’s intrinsic dimensions.

- [ ] Step 1: Add failing tests for shape and text semantics.

    Test rectangle, ellipse, line, and arrow creation with negative drags and Shift constraints. Verify line/arrow endpoints survive save/load and that arrow direction is rendered from the actual endpoints. Test multiline text with explicit line breaks, selected color, font size, empty-text cancellation, and editing an existing text object as one transaction.

- [ ] Step 2: Add a browser test for the current text-editor failure.

    Select Text, click the canvas, type:

        first line
        second line

    Verify a textarea is visible while editing, clicking another toolbar control does not delete the draft, and the committed canvas contains both lines after refresh.

- [ ] Step 3: Implement explicit text commit/cancel ownership.

    Stop pointer propagation from the textarea, commit on blur or an explicit Ctrl/Command+Enter action, preserve Enter for newlines, cancel on Escape, and close the editor only after the document command is accepted or the user cancels. Reposition and resize the textarea through worldToScreen on camera changes. Wait for the bundled font before final Canvas text rendering.

- [ ] Step 4: Implement image validation and local round trips.

    Validate MIME signature, dimensions, byte length, and total asset bytes before storing. Render a visible placeholder for decode failures and expose a retry path. Store asset blobs separately from file metadata, create the image object only after the local asset is retained, and preserve the asset through undo/redo and project export/import.

- [ ] Step 5: Run focused tests and commit.

    Run:

        npx vitest run tests/document.test.ts tests/objects.test.ts tests/export.test.ts
        npx playwright test tests/browser/objects.spec.ts

    Expected result: shape endpoints, text edits, and local images survive editing and reload without pointer-up deleting a draft or silently losing an asset.

    Commit with:

        git add client/main.ts client/canvas.ts client/objects.ts client/ui.ts client/images.ts shared/document.ts tests/document.test.ts tests/objects.test.ts tests/export.test.ts tests/browser/objects.spec.ts
        git commit -m "feat: complete shapes text and local image editing"

### Task 5: Make IndexedDB files, autosave, home actions, and project workflows durable

**Files:**
- Modify: client/storage.ts CanvasStorage, atomic transaction, writer lease, and failure handling
- Modify: client/home.ts renderHome and file action error paths
- Modify: client/main.ts local-file hydration, rename, saveNow, markDirty, and pagehide cleanup
- Modify: client/projects.ts project size/decode validation
- Modify: client/ui.ts save labels and read-only presentation
- Modify: tests/storage.test.ts, tests/projects.test.ts, tests/browser/local-file.spec.ts

**Interfaces:**
- Keep LocalFile fields id, title, createdAt, updatedAt, document, assets, revision, roomEpoch, and camera; add no server-owned state to the local file.
- Add loadLocalFile(fileId): Promise<LocalFile | undefined> and snapshotForSave(): LocalFile helpers in the editor composition.
- Save state must be one of Saving…, Saved on this device, or a persistent save error that preserves the previous valid snapshot.

- [ ] Step 1: Add failing storage tests for the durability contract.

    Test save/list/get, atomic file-plus-assets replacement, quota/write failure preserving the previous snapshot, writer exclusion across two storage instances, release and reacquire, and database/storage removal returning a visible error instead of throwing out of the editor.

- [ ] Step 2: Add failing file-workflow tests.

    Verify New canvas creates and opens a file, Open hydrates the stored title and document, Rename updates both file and document titles, Duplicate creates a new document ID with copied assets, Delete requires confirmation and removes file/assets, and Import creates a new file rather than modifying the source.

- [ ] Step 3: Fix local hydration and the Hello-to-Untitled regression.

    Load the file before rendering the editor, use localFile.title for both the file button and state.document.title, restore only the saved camera preference, and explicitly reset undo history when opening a saved file. Never let the default UI template value Untitled canvas overwrite the loaded title.

- [ ] Step 4: Implement correct save scheduling.

    Save authoritative committed content after one second of idle or at the five-second continuous-edit ceiling. Manual Save awaits the IndexedDB transaction. Exclude unfinished strokes, draft shapes, and open text editors. Camera changes may update the local camera preference but must not create a drawing revision. On failure, leave the prior file and assets intact and keep the error label visible until the next successful save.

- [ ] Step 5: Bound import decoding before allocation.

    Reject oversized encoded asset strings before atob, enforce the 5 MiB/20 MiB limits both before and after decoding, validate every document asset reference, and create the new file only after the entire project validates.

- [ ] Step 6: Run storage/project/browser tests and commit.

    Run:

        npx vitest run tests/storage.test.ts tests/projects.test.ts
        npx playwright test tests/browser/local-file.spec.ts

    Expected result: saved file names remain correct after reopen, autosave never persists drafts, failed writes preserve valid data, one tab is writable, and project downloads/imports are editable round trips.

    Commit with:

        git add client/storage.ts client/home.ts client/main.ts client/projects.ts client/ui.ts tests/storage.test.ts tests/projects.test.ts tests/browser/local-file.spec.ts
        git commit -m "fix: make local files and project workflows durable"

### Task 6: Replace viewport PNG capture with a bounded content export

**Files:**
- Modify: client/export.ts
- Modify: client/main.ts export callback
- Modify: client/canvas.ts shared object/ink rendering helpers
- Modify: tests/export.test.ts
- Create: tests/browser/export.spec.ts

**Interfaces:**
- Add exportDocumentPng(document: CanvasDocument, assets: ReadonlyMap<string, CanvasImageSource>, options?: { background?: string }): Promise<Blob>.
- Keep exportDimensions(width, height) as the bounded size calculator and add contentBounds(document): Bounds.
- Export must call the same object and ordered ink render helpers as the editor but must not depend on the visible canvas, camera, selection, or DOM controls.

- [ ] Step 1: Add failing export tests.

    Build a document with content outside the current viewport, a selection, and a translated camera. Assert that the output dimensions follow content bounds, not 1600 by 900 viewport dimensions; assert that no selection/grid/control pixels are rendered; assert that large bounds scale below both limits.

- [ ] Step 2: Implement a separate bounded render pass.

    Compute finite content bounds with stroke width padding, allocate only the bounded output size, paint the default white background, translate the world bounds to the output origin, render ordered ink with ink-only erasing, then render shapes/text/images above ink. Scale down before allocation when either side or total pixels exceeds the limit.

- [ ] Step 3: Wire the editor to the document export.

    Replace canvasToPng(ui.canvas) in main.ts with exportDocumentPng(state.document, loadedAssets). Keep project download and PNG export as separate buttons and hide both for guests.

- [ ] Step 4: Run export tests and commit.

    Run:

        npx vitest run tests/export.test.ts
        npx playwright test tests/browser/export.spec.ts

    Expected result: PNGs contain only drawing content, include offscreen content, preserve ink-only eraser behavior, and never allocate beyond the specified bounds.

    Commit with:

        git add client/export.ts client/main.ts client/canvas.ts tests/export.test.ts tests/browser/export.spec.ts
        git commit -m "fix: export bounded content without editor chrome"

### Task 7: Complete hosted lifecycle, asset transport, and latency reporting

**Files:**
- Modify: server/app.ts room creation, snapshot, apply, disconnect, host restore/save/end, asset routes, and ping handling
- Modify: client/network.ts snapshots, reconnect, asset upload/download, host control, ping timer, and visibility handling
- Modify: client/main.ts host save/recovery and guest ownership behavior
- Modify: client/ui.ts ended/paused/watermark/read-only status
- Modify: shared/protocol.ts room status, watermark, and asset messages
- Modify: tests/server.integration.test.ts, tests/server.hardening.test.ts, tests/network.test.ts
- Create: tests/browser/host-lifecycle.spec.ts and tests/browser/assets.spec.ts

**Interfaces:**
- Keep room status active, paused, and ended; host capabilities never appear in invite URLs or project exports.
- Add explicit snapshot text for Saved by host, Waiting for host save, Session ended or unavailable, and host recovery pause.
- Keep latency:ping independent of drawing revisions; expose median of the latest five monotonic-clock samples.

- [ ] Step 1: Add failing lifecycle tests.

    Cover host creation, guest join, guest read-only controls, host disconnect pausing edits, guest rejection while paused, host capability reconnect, two-minute grace expiry with no promotion, explicit End session after a successful save, and backend restart producing a fresh epoch that invalidates old links.

- [ ] Step 2: Add failing asset tests.

    Test authenticated upload/download, invalid token, wrong room, signature/dimension/size rejection, duplicate asset ID, per-room and global limits, guest image hydration, missing asset placeholder, and images staying out of drawing events and snapshots.

- [ ] Step 3: Make host/guest state transitions atomic.

    Pause before canceling unfinished operations on host departure, release leases, preserve the last committed room document, authenticate the host capability on reconnect, restore assets before the document, and only resume after a successful local save. If host save fails, keep the room paused and offer retry/download; never promote a guest.

- [ ] Step 4: Enforce ownership and protocol behavior in the client.

    Guests stay read-only and cannot see Save, Download project, Export PNG, Save As, or End session. Invalid/expired links show Session ended or unavailable rather than silently opening an arbitrary room. On protocol mismatch, stop editing and show the update message.

- [ ] Step 5: Verify ping and visibility rules.

    Send at most one request/ack probe every ten seconds while connected and visible, timeout after five seconds, stop while hidden/disconnected, and display Ping unavailable rather than zero. Add a fake monotonic clock test for median calculation.

- [ ] Step 6: Run integration/browser tests and commit.

    Run:

        npx vitest run tests/server.integration.test.ts tests/server.hardening.test.ts tests/network.test.ts
        npx playwright test tests/browser/host-lifecycle.spec.ts tests/browser/assets.spec.ts

    Expected result: room ownership, host recovery, asset authorization, guest controls, protocol mismatch, and ping behavior match the specification without revision corruption.

    Commit with:

        git add server/app.ts client/network.ts client/main.ts client/ui.ts shared/protocol.ts tests/server.integration.test.ts tests/server.hardening.test.ts tests/network.test.ts tests/browser/host-lifecycle.spec.ts tests/browser/assets.spec.ts
        git commit -m "feat: complete hosted lifecycle assets and ping"

### Task 8: Add complete regression coverage, performance checks, and release verification

**Files:**
- Modify: tests/browser/whiteboard.spec.ts and tests/browser/compositing.spec.ts
- Modify: tests/canvas.test.ts, tests/document.test.ts, tests/network.test.ts, tests/objects.test.ts, tests/projects.test.ts, tests/state.test.ts, tests/storage.test.ts, and tests/viewport.test.ts
- Modify: ARCHITECTURE.md, README.md, docs/VERIFICATION.md, and docs/SYNC-REVIEW.md
- Modify: benchmarks/render.ts, benchmarks/run.ts, and benchmarks/verify-hosted.ts only where new mixed-object cases require it

**Interfaces:**
- Preserve the existing ten-client/five-author benchmark acceptance: no missing or duplicate accepted batches and no acknowledgement failures.
- Add mixed-object and mostly-offscreen scenes without inventing FPS targets; compare against the recorded baseline files.
- Keep deployment verification tied to one backend commit and one frontend bundle, with the previous verified deployment available for rollback.

- [ ] Step 1: Add an end-to-end requirement matrix.

    Use Playwright tests for local startup, shared startup, brush/eraser, shapes, Shift constraints, text, images, selection, Delete, move/resize, pan/zoom, refresh, My canvases, rename/duplicate/delete, project import/download, PNG export, guest ownership, host pause/recovery, ping, and mobile layout.

- [ ] Step 2: Add explicit failure-injection tests.

    Simulate Socket.IO disconnect during a stroke, revision gap, duplicate operation, quota/write failure, removed IndexedDB database, hidden host tab, missing image, stale capability, old protocol version, and a camera at each zoom limit. Assert a user-visible recovery path and preservation of the last valid committed state.

- [ ] Step 3: Run the full verification sequence.

    Run:

        npm run typecheck
        npm test
        npm run test:e2e
        npm run benchmark
        npm run verify:hosted
        npm run build

    Do not call the result complete unless every command passes and the browser smoke test shows a writable local canvas and Live together for a room.

- [ ] Step 4: Update operational documentation.

    Record the actual local commands, the required VITE_SERVER_URL/ALLOWED_ORIGINS values, the deployed frontend/backend commits, the known port conflict recovery, the rollback URL, and the manual frontend/backend release order. Document that the public deployed site is not updated until this verification succeeds.

- [ ] Step 5: Commit the verification and documentation changes.

    Commit with:

        git add tests ARCHITECTURE.md README.md docs/VERIFICATION.md docs/SYNC-REVIEW.md benchmarks
        git commit -m "test: verify Group Canvas milestone end to end"

## Requirement Traceability

| Specification area | Repair task |
| --- | --- |
| My canvases, new/open/import, rename/duplicate/delete, save states, IndexedDB, autosave, writer exclusion | Tasks 1 and 5 |
| Document union, shared command application, transaction history, global undo/redo, operation IDs, revision recovery | Task 2 |
| Full viewport, camera, pan/zoom/touch, selection, shape constraints, ink-only erasing, culling, DPR | Task 3 |
| Text editing and bundled-font rendering | Task 4 |
| Local and collaborative images, validation, asset retention, room-scoped transfer | Tasks 4 and 7 |
| Content-only bounded PNG export and separate editable project export | Task 6 |
| Leases, previews, conflict rejection, host authority, guest ownership | Tasks 2, 3, and 7 |
| Host pause/grace/reconnect/end, watermark, backend restart, invalid links | Task 7 |
| Ping median/timeout/visibility behavior | Task 7 |
| Browser/mobile/manual release/benchmark/rollback evidence | Task 8 |

## Plan Self-Review

- Every major requirement in the supplied specification maps to at least one repair task.
- The first task directly covers the observed browser failure rather than assuming it is only a rendering defect.
- The Hello-to-Untitled regression is covered by an explicit hydration test in Task 5.
- The current canvasToPng(ui.canvas) viewport export is replaced by a document-based bounded pass in Task 6.
- Unfinished strokes/drafts are explicitly excluded from saves and history.
- No task weakens the host capability, asset authorization, writer exclusion, protocol version, or resource limits.
- Existing stroke, revision, recovery, and compositing tests remain part of the required verification.
