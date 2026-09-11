import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { io } from 'socket.io-client';
import type { Result, Snapshot } from '../shared/protocol.js';

const frontendUrl = process.env.E2E_BASE_URL ?? process.env.BENCH_FRONTEND_URL;
const serverUrl = process.env.BENCH_SERVER_URL;
const output = process.env.HOSTED_VERIFY_OUTPUT ?? 'benchmarks/results/hosted-transport.json';
const unrelatedOrigin = process.env.HOSTED_UNRELATED_ORIGIN ?? 'https://unrelated.example';
if (!frontendUrl || !serverUrl) throw new Error('Set E2E_BASE_URL or BENCH_FRONTEND_URL and BENCH_SERVER_URL.');

const frontend = new URL(frontendUrl);
const backend = new URL(serverUrl);
if (frontend.protocol !== 'https:' || backend.protocol !== 'https:') throw new Error('Hosted verification requires HTTPS frontend and backend URLs.');
const response = await fetch(frontend);
if (!response.ok) throw new Error(`Frontend returned HTTP ${response.status}.`);
const healthResponse = await fetch(new URL('/health', backend));
if (!healthResponse.ok) throw new Error(`Backend health returned HTTP ${healthResponse.status}.`);
const health = await healthResponse.json() as { status?: string; rooms?: number };

async function probe(origin: string, join: boolean) {
  const socket = io(backend.origin, { transports: ['websocket'], reconnection: false, timeout: 10000, extraHeaders: { Origin: origin } });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const transport = socket.io.engine.transport.name;
    let snapshot: Snapshot | undefined;
    if (join) {
      const snapshotReady = new Promise<Snapshot>(resolve => socket.once('room:snapshot', resolve));
      const result = await new Promise<Result>(resolve => socket.emit('room:join', { roomId: `hosted-${Date.now()}`, name: 'Hosted verifier' }, resolve));
      if (!result.ok) throw new Error(result.error);
      snapshot = await snapshotReady;
    }
    return { accepted: true, transport, roomId: snapshot?.roomId ?? null };
  } catch (error) {
    return { accepted: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    socket.disconnect();
  }
}

const accepted = await probe(frontend.origin, true);
const rejected = await probe(unrelatedOrigin, false);
const report = {
  at: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  frontendOrigin: frontend.origin,
  backendOrigin: backend.origin,
  frontendHttps: frontend.protocol === 'https:',
  backendHttps: backend.protocol === 'https:',
  frontendHttpStatus: response.status,
  health,
  acceptedOrigin: accepted,
  unrelatedOrigin: { origin: unrelatedOrigin, rejected: !rejected.accepted, probe: rejected },
  websocketTransport: accepted.transport ?? null,
  websocketTransportConfirmed: accepted.accepted && accepted.transport === 'websocket',
};
await mkdir(output.split(/[\\/]/).slice(0, -1).join('/') || '.', { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
