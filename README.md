# Group Canvas

Group Canvas is a live shared whiteboard built with vanilla TypeScript, HTML5 Canvas, Express, and Socket.io over WebSockets.

## Run locally

Use Node.js 22.12 or newer:

```sh
npm install
npm start
```

Open <http://localhost:3000> in two or more windows. `npm start` typechecks, builds the client and server, and serves the production build from one Node process.

For development, run the backend and Vite together:

```sh
npm run dev
```

Vite serves the client on port 5173 and proxies `/api` and `/socket.io` to the backend. Set `BACKEND_PORT`, `BACKEND_URL`, or `VITE_DEV_SERVER_URL` when the backend is not on port 3000.

## Product behavior

- Brush and eraser input is predicted locally, streamed in bounded batches, and reconciled against the server's authoritative order.
- Shapes, multiline text, selection, object leases, and PNG/JPEG/WebP image assets are supported.
- Shared undo/redo follows completion order; erasing affects ink without painting the board background.
- Local canvases and their image bytes are stored in IndexedDB. **Download project** creates a portable JSON backup.
- Managed host sessions keep guests read-only while the host reconnects, restores the saved document and assets, and explicitly confirms a durable save.

## Deployment

The repository includes a Render Blueprint in `render.yaml` for the backend. Deploy the backend first:

1. Create or connect the `group-canvas` Render web service and keep the Blueprint's build/start commands and region unless there is an intentional infrastructure change.
2. Preserve existing environment values. Set `ALLOWED_ORIGINS` to the exact frontend origin, without a path or trailing slash. Set `PERSISTENCE_PATH` to a durable mounted path when room state and uploaded assets must survive restarts.
3. Verify `https://<backend>/health` and a WebSocket room before publishing the frontend.
4. Build the existing Cloudflare Pages project `group-canva` with `npm ci && npm run build`, output directory `dist/client`, and build-time `VITE_SERVER_URL=https://<backend>`.
5. Smoke-test local save/reload, managed host recovery, guest collaboration, image upload/download/PNG export, and reconnect behavior. Keep the previous backend deployment and Pages preview available for rollback.

`VITE_SERVER_URL` is public configuration, not a secret. Backend settings are process environment variables; do not commit credentials or deployment identifiers. The frontend fallback for `group-canva.pages.dev` points at the existing `group-canvas.onrender.com` service, but an intentional replacement should set `VITE_SERVER_URL` explicitly.

## Operational limits

The backend is a single authoritative process with bounded rooms, users, points, history, command rates, and image storage. Without `PERSISTENCE_PATH`, room state is intentionally ephemeral. Render Free services can sleep or restart, so a cold connection may take a while to recover.

There is no account or private-board authentication; origin allowlisting is cross-site protection, not user identity. Offline drawing is not queued. Browser storage can be cleared, and portable project downloads are the recovery path for local files. WebKit automation is useful coverage but is not native Safari or iOS certification.

## Project map

`shared/` defines document and wire contracts. `server/` owns rooms, validation, history, persistence, and asset endpoints. `client/state.ts` reduces revisions; `client/network.ts` owns connection and host recovery; `client/canvas.ts` owns input and ordered rendering; `client/ui.ts` and `client/style.css` own presentation. `ARCHITECTURE.md` describes the synchronization, rendering, recovery, and deployment boundaries.
