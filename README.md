# Group Canvas

A little space for big ideas. A live shared whiteboard built with vanilla TypeScript, HTML5 Canvas, Express, and Socket.io over WebSockets.

## Run locally

Install Node.js **22.12 or newer** (developed with Node 24.19), then from this directory:

```sh
npm install && npm start
```

Open **http://localhost:3000** in two or more windows. Everyone on the same URL shares the canvas. `npm start` typechecks and builds both applications, then serves them from one Node process. Stop with Ctrl+C.

```sh
npm run dev          # Vite http://localhost:5173 + backend :3000, with reload
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

## Multi-user walkthrough

1. Open the same room in three windows. Draw slowly in the first; observe the line before releasing the pointer in the others.
2. Draw overlapping strokes in two windows; erase across them. All windows converge on the same image.
3. Undo from a different window, redo twice after two undos, then undo and draw something new. Redo should become unavailable.
4. Open a fourth window while someone is drawing. It should receive both finished and unfinished strokes.
5. Disconnect one window's network, then reconnect. Drawing is disabled while offline and no offline stroke is replayed. Reload another window to confirm the same state.
6. Restart the backend. The canvas resets because there is no persistent storage; reconnecting clients show a session-reset notice.

## Free deployment

Deployment configuration is included; **no hosted demo has been created from this workspace**. Use one Render Free Node service in Singapore and Cloudflare Pages for the frontend. Keep a single backend instance.

1. Push this repository to your own Git provider and connect it to Render. Import `render.yaml` (or choose Web Service, Node, **Free**, **Singapore**). Build: `npm ci --include=dev && npm run build`. Start: `node dist/server/server/index.js`. Health check: `/health`.
2. Set Render's `ALLOWED_ORIGINS` to your exact frontend origin, e.g. `https://your-project.pages.dev`. Comma-separate additional explicit preview/local origins if needed. Do not include a path or trailing slash.
3. Create a Cloudflare Pages project with build command `npm ci && npm run build`, output directory `dist/client`, and Node version `24.19.0`. Set **build-time** `VITE_SERVER_URL=https://your-service.onrender.com`. Socket.io upgrades this HTTPS endpoint to secure WebSocket transport.
4. Redeploy the static frontend whenever `VITE_SERVER_URL` changes. Open the public Pages URL in several browsers and repeat the walkthrough.

`VITE_SERVER_URL` is public configuration, never a secret. For local development it defaults to the page's origin and Vite proxies `/socket.io` to port 3000. Backend `PORT`, `HOST`, and `ALLOWED_ORIGINS` are process environment variables; `.env.example` is a reference and is not automatically loaded by Node.

Cloudflare distributes the interface globally; the drawing stream still travels to the authoritative Singapore server. Render Free can spin down after **15 minutes without inbound traffic**, take **about a minute** to wake, and restart at any time. Restarting clears this app's memory. Free quotas also apply; do not enable paid upgrades or artificial keep-alive requests. See [Render Free](https://render.com/docs/free), [Render regions](https://render.com/docs/regions), and [Cloudflare Vite deployment](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/).

## Scope and limitations

- In-memory only: no accounts, database, persistence, export, images, shapes, or private access control. A room URL is not a security boundary; anyone who knows it can draw and use global history.
- One authoritative process. Memory/capacity and message-rate limits reject excess work with a visible error; this is a bounded demo, not an unbounded archive.
- Offline input is intentionally unavailable. A disconnect cancels unfinished strokes once the server detects it. A cold server may leave the UI in reconnecting state for a minute.
- Layer order follows **stroke start**, but undo follows **stroke completion**. An earlier stroke's late-arriving points remain under a later eraser. This prevents arrival timing from producing different images on different clients.
- Local predictions can briefly change layering when the server's authoritative start order arrives.
- The canvas fits a fixed 16:9 board; it does not provide infinite pan/zoom. Pointer input supports touch and pen, but no pressure sensitivity or simultaneous pointers on one device.
- Higgsfield had **0 available credits** at implementation time. No trial, purchase, or generation was started. The shipped design uses real HTML/CSS and an original SVG empty-state illustration. See `docs/design-concept.md`.
- Browser-engine testing uses Chromium, Firefox, and WebKit. A WebKit run on Windows is not a claim that native macOS/iOS Safari has been tested. See `docs/VERIFICATION.md` for actual results and remaining manual checks.

## Project map

`shared/protocol.ts` defines wire contracts; `server/` owns rooms/history/validation; `client/state.ts` owns revision reduction; `client/network.ts` owns recovery; `client/canvas.ts` owns input/rendering; `client/ui.ts` and `client/style.css` own controls/presentation. `tests/` contains automated acceptance checks.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for synchronization, history, conflict handling, performance, and scaling tradeoffs.

## Time spent

Implemented on 9 September 2026 in one assisted development session with parallel server, canvas, and UI workers. The session began around 21:00 IST. Actual elapsed time and final test measurements are recorded in `docs/VERIFICATION.md`; the original 3–5 day estimate was a scope target, not a claim of time worked.
