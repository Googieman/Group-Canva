# Task 2 report: conflict-safe transactions and history

## Files and design

- `shared/document.ts` now validates every history patch before applying it, moves the exact transaction between undo and redo, returns that transaction in the result, and excludes unfinished/inactive legacy strokes from committed document snapshots.
- `shared/protocol.ts` carries bounded optional operation IDs on stroke commands and expected versions on history commands.
- `client/state.ts` keeps streamed unfinished strokes renderable without including them in committed document state, and hydrates authoritative document/history payloads.
- `client/main.ts` gives local files a fresh history and completes local strokes through the shared document reducer.
- `server/app.ts` uses document mode for new rooms, checks leases atomically, rechecks history/object preconditions, fingerprints successful operation IDs, and evicts operation results at the configured per-room bound.

## Verification

Commands run:

```text
npx vitest run tests/document.test.ts tests/state.test.ts tests/server.integration.test.ts tests/server.hardening.test.ts tests/network.test.ts
  5 test files passed, 47 tests passed

npm run typecheck
  passed
```

## Review and concerns

The requested subagent reviewer was not available in this Codex environment, so the range was reviewed locally against `5acc53d`. No critical or important issues were found. The pre-existing Task 2 planning note remains untracked and was not altered. Legacy protocol compatibility remains intentionally supported for stroke streaming; new rooms publish completed strokes as document transactions.
