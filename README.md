# Group Canvas

A little space for big ideas. A live shared whiteboard built with vanilla TypeScript, HTML5 Canvas, Express, and Socket.io over WebSockets.

## Run locally

Install Node.js **22.12 or newer** (developed with Node 24.19), then from this directory:

```sh
npm install && npm start
```

Open **http://localhost:3000** in two or more windows. Create or open a canvas from **My canvases**, or use a shared room URL to draw together. `npm start` typechecks and builds both applications, then serves them from one Node process. Stop with Ctrl+C.

```sh
npm run dev          # Vite http://localhost:5173 + backend :3000, with reload
# PowerShell: $env:BACKEND_PORT=3001; $env:PORT=3001; npm run dev
npm test             # State, input/rendering helpers, and real WebSocket integration
npm run build        # Strict TypeScript + production bundles
npx playwright install chromium firefox webkit
npm run test:e2e     # Browser interactions and canvas pixel assertions
```

## Draw together

- Use **Brush (B)** or **Eraser (E)**, a color swatch, and the stroke-width slider.
- **Ctrl/Cmd+Z** undoes the latest completed stroke by **any user**. **Ctrl/Cmd+Shift+Z** or **Ctrl/Cmd+Y** redoes it. A new completed stroke clears redo for everyone.
- Others see your cursor and strokes while you draw. Guest names and distinct presence colors are assigned per connection.
- Share the same URL. The default room is `playground`; `/?room=team-sketch` opens a separate in-memory room. Room IDs use letters, numbers, underscores, or hyphens.
- A connection indicator shows joining/reconnecting states. Drawing pauses until the authoritative room snapshot arrives. Work already confirmed by the server survives a temporary client disconnect; unfinished work is canceled.

From **My canvases**, choose **Host** to start a managed session from a saved local file. Copy the invite link for guests; it contains no host capability. Host disconnects pause managed editing for a two-minute recovery window, while ordinary shared room links retain the lightweight legacy behavior.

## Multi-user walkthrough

1. Open the same room in three windows. Draw slowly in the first; observe the line before releasing the pointer in the others.
2. Draw overlapping strokes in two windows; erase across them. All windows converge on the same image.
3. Undo from a different window, redo twice after two undos, then undo and draw something new. Redo should become unavailable.
4. Open a fourth window while someone is drawing. It should receive both finished and unfinished strokes.
5. Disconnect one window's network, then reconnect. Drawing is disabled while offline and no offline stroke is replayed. Reload another window to confirm the same state.
6. Restart the backend. Without `PERSISTENCE_PATH`, the canvas resets because storage is intentionally ephemeral. With a durable `PERSISTENCE_PATH`, completed room state and image assets are restored on startup.

## Free deployment

Live demo: **https://group-canva.pages.dev**. The current backend health endpoint is **https://group-canvas.onrender.com/health**. The published validation uses one Render Free Node service in Singapore and Cloudflare Pages for the frontend; deployment identifiers and measurements are recorded in [docs/VERIFICATION.md](docs/VERIFICATION.md).

1. Push this repository to your own Git provider and connect it to Render. Import `render.yaml` (or choose Web Service, Node, **Free**, **Singapore**). Build: `npm ci --include=dev && npm run build`. Start: `node dist/server/server/index.js`. Health check: `/health`.
2. Set Render's `ALLOWED_ORIGINS` to your exact frontend origin, e.g. `https://your-project.pages.dev`. Comma-separate additional explicit preview/local origins if needed. Do not include a path or trailing slash.
3. Create a Cloudflare Pages project with build command `npm ci && npm run build`, output directory `dist/client`, and Node version `24.19.0`. Set **build-time** `VITE_SERVER_URL=https://your-service.onrender.com`. Socket.io upgrades this HTTPS endpoint to secure WebSocket transport.
4. Redeploy the static frontend whenever `VITE_SERVER_URL` changes. For this repository, the public Pages hostname also has a narrow production-host fallback to the Render URL so the demo remains usable if a Pages build mode fails to inject the public build variable. Open the public Pages URL in several browsers and repeat the walkthrough.

`VITE_SERVER_URL` is public configuration, never a secret. For local development it defaults to the page's origin and Vite proxies `/socket.io` to `BACKEND_PORT` (or `PORT`, then 3000). Backend `PORT`, `HOST`, `ALLOWED_ORIGINS`, and optional `PERSISTENCE_PATH` are process environment variables; `.env.example` is a reference and is not automatically loaded by Node. Persistence uses atomic JSON snapshots and bounded base64 image assets, so production deployments need a durable filesystem or external storage. If a backend port is already occupied, stop the old process or choose a free `PORT`/`BACKEND_PORT` pair before starting the dev server.

Cloudflare distributes the interface globally; the drawing stream still travels to the authoritative Singapore server. Render Free can spin down after **15 minutes without inbound traffic**, take **about a minute** to wake, and restart at any time. Set `PERSISTENCE_PATH` to a durable mounted path to retain completed room snapshots and assets across graceful restarts; an ephemeral service filesystem does not provide durable recovery. Free quotas also apply; do not enable paid upgrades or artificial keep-alive requests. See [Render Free](https://render.com/docs/free), [Render regions](https://render.com/docs/regions), and [Cloudflare Vite deployment](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/).

## Release verification

From the roadmap worktree, the release gate is:

```powershell
npm run typecheck
npm test
$env:E2E_PORT='3339'; npm run test:e2e
npm run benchmark -- task8-final
$env:E2E_BASE_URL='https://your-project.pages.dev'; $env:BENCH_SERVER_URL='https://your-service.onrender.com'; npm run verify:hosted
npm run build
```

The hosted verifier requires an HTTPS frontend URL, an HTTPS backend URL, and a backend `ALLOWED_ORIGINS` entry matching the exact frontend origin. If local port 3000 is occupied, use a unique `E2E_PORT` for Playwright or choose a matching `PORT`/`BACKEND_PORT` pair; do not reuse a stale server when validating a new build. Release the backend first, verify `/health` and WebSocket origin handling, then publish the frontend bundle with its `VITE_SERVER_URL`, and retain the previous backend deployment URL and frontend preview URL for rollback. The public deployment is not updated by this worktree and must not be called current until this gate succeeds.

## Scope and limitations

- Local files and image assets are stored in browser IndexedDB. Use **Download project** for portable backups; clearing browser storage removes local files.
- Projects support brush/eraser, selection, rectangles, ellipses, lines, arrows, multiline text, and PNG/JPEG/WebP images. PNG export is a separate content-only action.
- Host sessions use in-memory room state by default, or atomic restart snapshots when `PERSISTENCE_PATH` points to durable storage. Guests can edit shared content but do not receive local project ownership controls. A join URL is not an account-based security boundary.
- One authoritative process. Memory/capacity and message-rate limits reject excess work with a visible error; this is a bounded demo, not an unbounded archive.
- Offline input is intentionally unavailable. A disconnect cancels unfinished strokes once the server detects it. A cold server may leave the UI in reconnecting state for a minute.
- Ink layer order follows **stroke start**, while transaction undo follows **completion**. Shapes, text, and images render above the transparent ink layer; erasers affect ink only. An earlier stroke's late-arriving points remain under a later eraser.
- Local predictions can briefly change layering when the server's authoritative start order arrives.
- The canvas uses a bounded world with local pan/zoom from 10% to 400%. Pointer input supports touch pinch/pan and pen, but no pressure sensitivity.
- Higgsfield had **0 available credits** at implementation time. No trial, purchase, or generation was started. The shipped design uses real HTML/CSS and an original SVG empty-state illustration. See `docs/design-concept.md`.
- Browser-engine testing uses Chromium, Firefox, and WebKit. A WebKit run on Windows is not a claim that native macOS/iOS Safari has been tested. See `docs/VERIFICATION.md` for actual results and remaining manual checks.

## Project map

`shared/protocol.ts` defines wire contracts; `server/` owns rooms/history/validation; `client/state.ts` owns revision reduction; `client/network.ts` owns recovery; `client/canvas.ts` owns input/rendering; `client/ui.ts` and `client/style.css` own controls/presentation. `tests/` contains automated acceptance checks.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for synchronization, history, conflict handling, performance, and scaling tradeoffs.

## Time spent

Implemented on 9 September 2026 in one assisted development session with parallel server, canvas, and UI workers. The session began around 21:00 IST. Actual elapsed time and final test measurements are recorded in `docs/VERIFICATION.md`; the original 3–5 day estimate was a scope target, not a claim of time worked.
