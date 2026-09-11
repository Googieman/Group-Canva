Implement the Group Canvas repair plan in the existing repository.

Repository and current implementation:
- Worktree: C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap
- Branch: codex/group-canvas-roadmap
- The implementation changes are currently uncommitted.
- The full requirements/specification is at C:\Users\varug\.codex\attachments\9b74e29e-0cab-4bab-bba9-4aed4846e6a5\pasted-text.txt.
- The detailed implementation plan is at C:\Users\varug\Group-Canvas\.worktrees\group-canvas-roadmap\docs\superpowers\plans\2026-09-12-group-canvas-reliability-and-completion.md. Read that file and the specification before editing.

Observed browser failures that must be fixed first:
- Local page 127.0.0.1:3001 loaded but remained on Connecting… and Ping unavailable.
- Brush, rectangle, and text gestures produced no committed content.
- Opening the saved canvas Hello displayed Untitled canvas.
- Copy invite link worked.

Execution rules:
- Work only in the worktree above; do not modify master, push, merge, or deploy.
- Use test-driven development: add a failing focused test, implement the smallest fix, run the focused test, then run the relevant regression suite.
- Preserve existing stroke, revision/recovery, compositing, benchmark, and hardening evidence.
- Use one shared DOM-free document command/reducer for local and collaborative edits.
- Keep local camera/selection outside document history; preserve ink-only erasing, IndexedDB persistence, host capability privacy, protocol v2 checks, and all specified limits.
- Complete the plan in order. After each task, commit the task, review its diff against the task requirements, fix review findings, and record the result in the plan’s SDD ledger.

Task order:
1. Make local/shared startup truthful: local files must be editable when the writer lease is available; read-only tabs must say why; shared rooms must reach Live together; connection failures need a visible retry state; fix the development proxy/port mismatch.
2. Unify document commands, transaction history, operation-ID deduplication, leases, version checks, atomic conflict rejection, and local/server semantics.
3. Repair pointer input, camera transforms, selection, touch/pan/zoom, separate ink/object compositing, culling, DPR handling, and gesture cancellation.
4. Finish rectangle/ellipse/line/arrow, multiline text editing with explicit commit/cancel, bundled-font rendering, image validation, local image storage, placeholders, and proportional resize.
5. Make IndexedDB files/autosave/manual save/writer exclusion/home CRUD/project import-export durable; fix Hello reopening as Untitled and never save drafts.
6. Replace viewport PNG capture with bounded content-only document rendering that includes offscreen content and excludes grid, controls, cursors, and selection.
7. Complete host/guest lifecycle, two-minute host recovery, save watermarks, end-session behavior, room-scoped asset transfer, invalid-link handling, protocol mismatch, and median latency ping.
8. Add the full browser/failure-injection requirement matrix, preserve benchmarks, update operational docs, run typecheck/unit/e2e/benchmark/hosted/build verification, and leave deployment untouched until all checks pass.

At the end, report changed files, commits, test commands/results, remaining concerns, and confirm whether the public deployment was intentionally left unchanged.
