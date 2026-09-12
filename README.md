# Group Canvas

Group Canvas is a live shared whiteboard built with vanilla TypeScript, HTML5 Canvas, Express, and Socket.io over WebSockets. A canvas can be used locally and then shared through a managed host session so guests can draw, add objects, and see the same authoritative document.

## Requirements and local commands

Use Node.js 22.12 or newer.

For a reproducible install and production build:

```sh
npm ci
npm run build
npm start
```

Open <http://localhost:3000> in two or more windows. `npm start` builds the client and server, then serves the production build from one Node process.

For development, run the backend and Vite together:

```sh
npm install
npm run dev
```

Vite serves the client on port 5173 and proxies `/api` and `/socket.io` to the backend. The backend defaults to port 3000. Set `BACKEND_PORT`, `BACKEND_URL`, or `VITE_DEV_SERVER_URL` when the backend is not on port 3000.

Useful checks before a release:

```sh
npm run typecheck
npm test
npm run build
```

The current automated tests include versioned room-join validation. Browser smoke testing is still required for collaboration, reconnection, assets, and export behavior.

## Configuration

`.env.example` lists the supported settings. Node does not automatically load that file; set backend variables in the shell or hosting dashboard.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `PORT` | backend | HTTP/WebSocket port; defaults to `3000` and is normally supplied by Render |
| `HOST` | backend | Listen address; defaults to `0.0.0.0` |
| `ALLOWED_ORIGINS` | backend | Comma-separated exact browser origins allowed to use the server, without paths or trailing slashes |
| `PERSISTENCE_PATH` | backend | Atomic JSON persistence path for completed room state and assets; use a durable mounted disk in production |
| `BACKEND_PORT` | Vite | Local proxy target port when running `npm run dev` |
| `BACKEND_URL` | Vite | Local proxy target URL when the backend is on another host |
| `VITE_DEV_SERVER_URL` | Vite | Overrides the local development proxy target |
| `VITE_SERVER_URL` | client build | Public backend URL embedded into a hosted frontend build; this is not a secret |

The optional `E2E_BASE_URL`, `BENCH_FRONTEND_URL`, and `BENCH_SERVER_URL` values in `.env.example` are test/benchmark targets, not application runtime configuration.

## Product behavior

- Brush and eraser input is predicted locally, streamed in bounded batches, and reconciled against the server's authoritative order.
- Shapes, multiline text, selection, object leases, and PNG/JPEG/WebP image assets are supported.
- Shared undo/redo follows completion order. Erasing affects ink without painting the board background.
- Local canvases and their image bytes are stored in IndexedDB. **Download project** creates a portable JSON backup.
- A managed host session has one host capability and one authoritative server room. Guests can edit while the host is connected; the server rejects commands while the host is recovering or the session is paused.
- When the host reconnects, the saved document and retained assets are restored before the host is allowed to resume editing.
- Host links include a browser-local file identifier. The file itself is stored in IndexedDB, so a host link is not a portable copy of the canvas.

## Synchronization performance

The synchronization path is designed for small, interactive rooms rather than large-scale broadcasting:

- Pointer input is drawn immediately from a local prediction, so the person drawing does not wait for a round trip.
- Brush points are sent in batches of up to 64 points every 20 ms. The server validates offsets and revisions, then broadcasts the authoritative event to the room.
- Shapes and document objects are committed as server-validated transactions. Clients request a fresh snapshot when they detect a revision gap, stale epoch, invalid offset, or incompatible protocol version.
- Socket.io uses WebSocket transport, a 20-second connection timeout, reconnect backoff up to 8 seconds, and a 15-second initial hydration guard. A sleeping free Render service can still make the first connection take longer than normal.
- The server limits each connection to 150 commands per second with a burst allowance of 300, and bounds rooms, participants, points, history, assets, and message size. These limits protect responsiveness but are not a capacity guarantee.

The latest hosted smoke test used the Render backend in Singapore with one host and two guest browser tabs. Warm-room ping was approximately 85–95 ms; a late guest during host recovery measured approximately 314–396 ms. A guest brush stroke and rectangle appeared on the host after the network update, and browser console errors remained empty. This is a small desktop-tab observation, not a formal latency or load benchmark. Real performance depends on geographic distance, Render cold starts, browser load, room size, and the number of simultaneous users.

For dependable collaboration, use a warm backend, keep rooms small, avoid sending very large images, and wait for the UI to show the room as connected before drawing. The server remains authoritative if a client is delayed or reconnects.

## Deployment

The repository includes a Render Blueprint in `render.yaml` for the backend. Deploy the backend first:

1. Create or connect the `group-canvas` Render web service. Keep the Blueprint's build/start commands and region unless there is an intentional infrastructure change.
2. Set `ALLOWED_ORIGINS` to the exact frontend origin, without a path or trailing slash. Set `PERSISTENCE_PATH` only when a durable Render disk is mounted at that path; otherwise room state and uploaded assets are ephemeral across restarts.
3. Verify `https://<backend>/health` returns HTTP 200 and verify a WebSocket room before publishing the frontend.
4. Build the Cloudflare Pages project `group-canva` with `npm ci && npm run build`, publish `dist/client`, and set the build-time variable `VITE_SERVER_URL=https://<backend>`.
5. Smoke-test local save/reload, managed host recovery, guest collaboration, image upload/download/PNG export, and reconnect behavior. Keep the previous backend deployment and Pages preview available for rollback.

Current hosted endpoints:

- Frontend: <https://group-canva.pages.dev/>
- Backend: <https://group-canvas.onrender.com/>
- Health check: <https://group-canvas.onrender.com/health>

The frontend fallback for `group-canva.pages.dev` points to the existing Render service, but a replacement backend should always be configured explicitly with `VITE_SERVER_URL`. The last manually verified production backend/frontend release used commit `872d0dd`; repository `master` has since advanced, so production and GitHub should not be considered identical until the newer commit is redeployed and verified.

`VITE_SERVER_URL` is public configuration, not a secret. Do not commit credentials, access tokens, or deployment identifiers.

## Troubleshooting and known limitations

### A room says the room ID or name is invalid

The validation message is also used for unknown room-join fields. A newer frontend talking to an older backend can therefore produce a misleading room-ID error. Check `/health`, confirm that Render and Cloudflare are deployed from compatible commits, and redeploy the backend before loosening validation. Valid room IDs contain 1–48 letters, numbers, hyphens, or underscores; names contain 1–32 characters.

### A guest joins while the host is away

The server pauses managed-room commands when the host disconnects and ends recovery after two minutes. Guests should wait for the host to reconnect. There is a known UI issue in the current release where a guest can temporarily be labeled **Live together** even though the room is paused; drawing commands are still rejected by the server. This status should be treated as unreliable until the host is visible and the room is active again.

### An invite link does not work in another browser

Host links reference a canvas stored in browser-local IndexedDB. They work in the browser profile that owns the file, but they do not carry the file contents to a different profile or device. Use **Download project** and import the project on the other device when a portable copy is required.

There is also a short invite-creation race: the host copies the guest URL and then navigates into the managed host session. If a guest opens the URL before the host has created the room, the guest can create an unmanaged guest-only room and the host will be told to start a new session. Wait until the host shows **Live together** before sending the link.

### The welcome message remains over a canvas with a shape

The current empty-state check looks for brush ink and does not yet count shapes, text, or images. A shape-only canvas can therefore still display the welcome overlay even though content exists.

### The toolbar is clipped or the page scrolls horizontally

The current desktop layout can exceed the viewport width, especially near the zoom controls. This is a responsive-layout issue, not a synchronization failure. Reduce browser zoom or use the horizontal scrollbar as a temporary workaround; mobile and narrow-window behavior still needs dedicated testing.

### The first connection is slow or fails

Render Free services can sleep. The client retries transport connections, but initial hydration has a 15-second guard and a cold backend may take longer. Retry after the service wakes, check `/health`, and inspect the browser console for origin or WebSocket errors. In production, verify `ALLOWED_ORIGINS` and `VITE_SERVER_URL` exactly.

### Data disappears after a restart

Without `PERSISTENCE_PATH` on durable storage, server rooms and uploaded assets are intentionally ephemeral. Local files remain in the user's IndexedDB unless browser storage is cleared. Use project downloads as the portable recovery path.

There is no account or private-board authentication. Origin allowlisting protects browser cross-site access; it does not authenticate users or make a public room private. Offline drawing is not queued. WebKit automation is useful coverage but is not native Safari or iOS certification.

## Release and hosted smoke-test checklist

Before calling a release complete:

1. Run `npm run typecheck`, `npm test`, and `npm run build`.
2. Deploy the backend and confirm `/health` returns 200.
3. Confirm the backend and frontend report the intended commit/deployment.
4. Open the frontend, create a canvas, and choose **Copy invite link**.
5. Open the invite in a separate browser profile or private window. Confirm the guest joins without the validation error.
6. Draw a brush stroke and create a shape as the guest. Confirm both appear on the host and remain after a guest refresh.
7. Disconnect/reconnect the host. Confirm the room pauses, the host restores the saved document, and editing resumes only after restoration.
8. Test image upload, project download/import, PNG export, local save/reload, and a narrow viewport.
9. Keep the previous deployment available until all hosted checks pass.

## Project map

`shared/` defines document and wire contracts. `server/` owns rooms, validation, history, persistence, and asset endpoints. `client/state.ts` reduces revisions; `client/network.ts` owns connection and host recovery; `client/canvas.ts` owns input and ordered rendering; `client/ui.ts` and `client/style.css` own presentation. `ARCHITECTURE.md` describes synchronization, rendering, recovery, persistence, and deployment boundaries.
