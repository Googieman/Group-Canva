# Group Canvas Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the approved plan.

**Goal:** A runnable collaborative whiteboard with live drawing, deterministic overlaps, and global history.

**Architecture:** Vanilla TypeScript Canvas client, Socket.io WebSocket transport, authoritative in-memory Node rooms. Visual order at begin; undo order at completion. Revisioned events recover through snapshots.

**Tech Stack:** TypeScript, Vite, Express, Socket.io, Vitest, Playwright.

**Spec:** Approved originating task and implementation brief, transcribed in the architecture and acceptance criteria below.

## Global constraints
- 1600 × 900 logical canvas, DPR scaling, immediate prediction, 20ms/64-point batching.
- Erase ink with destination-out. Preserve background separately.
- Undo latest active completed stroke by any author; redo original layer; new completion clears redo.
- Disable disconnected/unhydrated drawing, discard offline commands, snapshot recovery with epoch/revision guards.
- Validate messages, capacity, ownership, and point offsets; exact duplicate batches do not change revisions.
- No frontend framework, drawing library, authentication, persistence, or paid services.

## Execution and ownership
- [x] Foundation: package scripts, TypeScript configs, shared protocol; coordinator owns shared files and integration.
- [ ] Server worker: server/ and tests/server*.test.ts. Implement room lifecycle and state, validation, origin policy, HTTP health/static serving, integration tests for streaming, overlaps, history, duplicates, disconnects, late join, room isolation and ten clients.
- [ ] Canvas worker: client/canvas.ts and tests/canvas*.test.ts. Export CanvasBoard(canvas, callbacks), setStrokes(strokes), setEnabled(enabled), setTool(tool,color,width), destroy(). Callbacks onBegin(point), onPoints(points), onEnd(), onCancel(), onCursor(point|null). Coordinator assigns stroke IDs and network batches. Input and drawing are separate; cache stable prefixes and render in visual order.
- [ ] UI worker: index.html, client/style.css, client/ui.ts, public/, PRODUCT.md, DESIGN.md. Export createUI(root): UI with canvas, cursors, setConnection(status,message), setUsers(users,selfId), setHistory(canUndo,canRedo), setEmpty(empty), notify(message), onToolChange(callback), onUndo(callback), onRedo(callback). Tool settings {tool,color,width}. Higgsfield concept preflight, existing credits only. No network/canvas ownership.
- [ ] Coordinator: client/state.ts, client/network.ts, client/main.ts and tests/state.test.ts. Test snapshot buffering, duplicates, gaps, epochs before implementation; reconcile predictions with echoes.
- [ ] Independent review: synchronization and history, fix discovered defects and verify regression tests.
- [ ] Integration QA: typecheck/build/unit and WebSocket tests, real browser drawing/eraser/history/reconnect, viewport/keyboard/accessibility, ten-client propagation measurement.
- [ ] Documentation: README.md, ARCHITECTURE.md, deployment config, measured results and actual verification limitations.

## Acceptance procedure
Run `npm test`, `npm run build`, `npm run test:e2e`. Three clients receive points before end; reverse completion changes undo order without changing visual order. Replayed point batches preserve revision. Disconnect cancels unfinished operations. New snapshots replace state; events older than the snapshot are ignored and revision gaps request resync. Report unsupported local browser engines honestly.

## Decisions and progress
- Work directly in the explicitly selected empty project directory. Parallel agents use disjoint file ownership; coordinator integrates and commits. This follows the destination request without copying the new project to other worktrees.
- No deployment/account mutation is needed to deliver this brief's deployment-ready MVP. Provide free hosting instructions and environment configuration.
