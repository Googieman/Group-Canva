import { afterEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createAppServer } from '../server/app.js';
import type { ClientEvents, ServerEvents, Snapshot, DrawingEvent, Result, Command } from '../shared/protocol.js';

type Client = Socket<ServerEvents, ClientEvents>;
const servers: Awaited<ReturnType<typeof createAppServer>>[] = [];
const clients: Client[] = [];
afterEach(async () => {
  clients.splice(0).forEach(client => client.disconnect());
  await Promise.all(servers.splice(0).map(server => server.close()));
});
async function start(options: Parameters<typeof createAppServer>[0] = {}) {
  const server = await createAppServer({ host: '127.0.0.1', ...options });
  servers.push(server);
  return server;
}
async function connect(url: string, roomId = 'playground', name = 'Guest') {
  const socket: Client = io(url, { transports: ['websocket'], reconnection: false, autoConnect: false });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  const snapshotPromise = snapshotNext(socket);
  const result = await new Promise<Result>(resolve => socket.emit('room:join', { roomId, name }, resolve));
  expect(result).toEqual({ ok: true });
  return { socket, snapshot: await snapshotPromise };
}
function snapshotNext(socket: Client) { return new Promise<Snapshot>(resolve => socket.once('room:snapshot', resolve)); }
async function resync(socket: Client) { const next = snapshotNext(socket); socket.emit('room:resync'); return next; }
function command(socket: Client, payload: unknown) { return new Promise<Result>(resolve => socket.emit('command', payload as Command, resolve)); }
const begin = (id: string, x = 10) => ({ type: 'stroke:begin', id, tool: 'brush', color: '#ff5500', width: 5, point: { x, y: 10 } });
async function complete(socket: Client, id: string) { expect(await command(socket, begin(id))).toEqual({ ok: true }); expect(await command(socket, { type: 'stroke:end', id })).toEqual({ ok: true }); }

describe('authoritative websocket collaboration', () => {
  it('streams points before completion to three clients, including the author', async () => {
    const server = await start();
    const peers = await Promise.all(Array.from({ length: 3 }, () => connect(server.url)));
    const events = peers.map(() => [] as DrawingEvent[]);
    peers.forEach((peer, i) => peer.socket.on('drawing:event', event => events[i]!.push(event)));
    await command(peers[0]!.socket, begin('live'));
    await command(peers[0]!.socket, { type: 'stroke:points', id: 'live', offset: 1, points: [{ x: 20, y: 30 }, { x: 40, y: 50 }] });
    await expect.poll(() => events.map(list => list.length)).toEqual([2, 2, 2]);
    expect(events[2]![1]).toMatchObject({ revision: 2, change: { type: 'stroke:points', offset: 1 } });
    const late = await connect(server.url);
    expect(late.snapshot.strokes[0]).toMatchObject({ completed: false, points: [{ x: 10, y: 10 }, { x: 20, y: 30 }, { x: 40, y: 50 }] });
  });

  it('preserves begin layering while undo follows completion and redo restores original layer', async () => {
    const server = await start();
    const a = (await connect(server.url)).socket;
    const b = (await connect(server.url)).socket;
    await command(a, begin('lower'));
    await command(b, begin('upper'));
    await command(b, { type: 'stroke:end', id: 'upper' });
    await command(a, { type: 'stroke:end', id: 'lower' });
    await command(b, { type: 'history:undo' });
    await command(a, { type: 'history:undo' });
    let state = (await connect(server.url)).snapshot;
    expect(state.redoIds).toEqual(['lower', 'upper']);
    expect(state.strokes.map(s => [s.id, s.order, s.completionOrder, s.active])).toEqual([['lower', 1, 2, false], ['upper', 2, 1, false]]);
    await command(b, { type: 'history:redo' });
    state = (await connect(server.url)).snapshot;
    expect(state.redoIds).toEqual(['lower']);
    expect(state.strokes.find(s => s.id === 'upper')).toMatchObject({ active: true, order: 2 });
    await complete(a, 'fresh');
    state = (await connect(server.url)).snapshot;
    expect(state.redoIds).toEqual([]);
    expect(state.strokes.map(s => s.id)).toEqual(['upper', 'fresh']);
    const revision = state.revision;
    await command(b, { type: 'history:redo' });
    expect((await resync(b)).revision).toBe(revision);
  });

  it('rejects malformed, out of order, stolen and conflicting batches without corrupting state', async () => {
    const server = await start();
    const a = (await connect(server.url)).socket;
    const b = (await connect(server.url)).socket;
    for (const payload of [null, {}, { ...begin('bad'), tool: 'paint' }, { ...begin('bad'), color: 'red' }, { ...begin('bad'), width: 65 }, { ...begin('bad'), point: { x: -1, y: 20 } }, { ...begin('bad'), id: '<script>' }]) {
      expect(await command(a, payload)).toMatchObject({ ok: false });
    }
    await command(a, begin('owned'));
    expect(await command(a, begin('second'))).toMatchObject({ ok: false });
    expect(await command(b, begin('owned'))).toMatchObject({ ok: false });
    const batch = { type: 'stroke:points', id: 'owned', offset: 1, points: [{ x: 20, y: 30 }] };
    expect(await command(a, { ...batch, offset: 2 })).toMatchObject({ ok: false });
    expect(await command(b, batch)).toMatchObject({ ok: false });
    expect(await command(b, { type: 'stroke:end', id: 'owned' })).toMatchObject({ ok: false });
    expect(await command(b, { type: 'stroke:cancel', id: 'owned' })).toMatchObject({ ok: false });
    expect(await command(a, batch)).toEqual({ ok: true });
    expect(await command(a, batch)).toEqual({ ok: true });
    expect(await command(a, { ...batch, points: [{ x: 20, y: 31 }] })).toMatchObject({ ok: false });
    expect(await command(a, { ...batch, offset: 2, points: Array.from({ length: 65 }, () => ({ x: 1, y: 1 })) })).toMatchObject({ ok: false });
    await command(a, { type: 'stroke:end', id: 'owned' });
    expect(await command(a, batch)).toEqual({ ok: true });
    expect(await command(a, { ...batch, offset: 2 })).toMatchObject({ ok: false });
    const state = (await connect(server.url)).snapshot;
    expect(state.revision).toBe(3);
    expect(state.strokes).toHaveLength(1);
    expect(state.strokes[0]!.points).toHaveLength(2);
  });

  it('cancels unfinished strokes on disconnect and isolates room state', async () => {
    const server = await start();
    const a = (await connect(server.url, 'a')).socket;
    const b = (await connect(server.url, 'a')).socket;
    const c = (await connect(server.url, 'b')).socket;
    await complete(a, 'finished');
    await command(a, begin('unfinished'));
    const cancellation = new Promise<DrawingEvent>(resolve => b.on('drawing:event', event => { if (event.change.type === 'stroke:cancel') resolve(event); }));
    a.disconnect();
    expect((await cancellation).change).toEqual({ type: 'stroke:cancel', id: 'unfinished' });
    const state = (await connect(server.url, 'a')).snapshot;
    expect(state.strokes.map(s => s.id)).toEqual(['finished']);
    expect(state.users).toHaveLength(2);
    expect((await resync(c)).strokes).toEqual([]);
    expect((await resync(b)).epoch).toBe(state.epoch);
  });

  it('supports ten simultaneous authors with identical ordered results', async () => {
    const server = await start();
    const peers = await Promise.all(Array.from({ length: 10 }, (_, i) => connect(server.url, 'load', `Artist ${i}`)));
    await Promise.all(peers.map((peer, i) => command(peer.socket, begin(`ten-${i}`))));
    await Promise.all(peers.map((peer, i) => command(peer.socket, { type: 'stroke:points', id: `ten-${i}`, offset: 1, points: [{ x: 50, y: 50 }] })));
    await Promise.all(peers.map((peer, i) => command(peer.socket, { type: 'stroke:end', id: `ten-${i}` })));
    const snapshots = await Promise.all(peers.map(peer => resync(peer.socket)));
    for (const state of snapshots) { expect(state.revision).toBe(30); expect(state.strokes).toEqual(snapshots[0]!.strokes); expect(state.users).toHaveLength(10); }
  });

  it('serves health and rejects untrusted websocket origins', async () => {
    const server = await start({ allowedOrigins: ['https://canvas.example'] });
    expect(await (await fetch(`${server.url}/health`)).json()).toMatchObject({ status: 'ok' });
    const rejected = io(server.url, { transports: ['websocket'], reconnection: false, extraHeaders: { Origin: 'https://evil.example' } });
    clients.push(rejected);
    await new Promise<void>((resolve, reject) => { rejected.once('connect_error', () => resolve()); rejected.once('connect', () => reject(new Error('Untrusted origin connected'))); });
    const accepted = io(server.url, { transports: ['websocket'], reconnection: false, extraHeaders: { Origin: 'https://canvas.example' } });
    clients.push(accepted);
    await new Promise<void>((resolve, reject) => { accepted.once('connect', resolve); accepted.once('connect_error', reject); });
  });

  it('enforces user, stroke and point capacity without partially applying rejected commands', async () => {
    const server = await start({ limits: { usersPerRoom: 2, strokesPerRoom: 2, pointsPerStroke: 2, pointsPerRoom: 3 } });
    const a = (await connect(server.url)).socket;
    const b = (await connect(server.url)).socket;
    await command(a, begin('one'));
    expect(await command(a, { type: 'stroke:points', id: 'one', offset: 1, points: [{ x: 20, y: 20 }, { x: 30, y: 30 }] })).toMatchObject({ ok: false });
    await command(a, { type: 'stroke:points', id: 'one', offset: 1, points: [{ x: 20, y: 20 }] });
    await command(a, { type: 'stroke:end', id: 'one' });
    await complete(b, 'two');
    expect(await command(a, begin('three'))).toMatchObject({ ok: false });
    const state = await resync(a);
    expect(state.strokes.map(s => s.points.length)).toEqual([2, 1]);
    expect(state.revision).toBe(5);
  });

  it('does not leak a room named after another socket into that socket private channel', async () => {
    const server = await start();
    const victim = (await connect(server.url, 'victim')).socket;
    const events: DrawingEvent[] = [];
    victim.on('drawing:event', event => events.push(event));
    const attacker = (await connect(server.url, victim.id!)).socket;
    await complete(attacker, 'private-room-collision');
    await resync(victim);
    expect(events).toEqual([]);
  });

  it('rejects excess room members and rooms while allowing existing members to keep drawing', async () => {
    const server = await start({ limits: { rooms: 1, usersPerRoom: 1 } });
    const a = (await connect(server.url)).socket;
    const b: Client = io(server.url, { transports: ['websocket'], reconnection: false }); clients.push(b);
    await new Promise<void>((resolve, reject) => { b.once('connect', resolve); b.once('connect_error', reject); });
    const join = (roomId: string) => new Promise<Result>(resolve => b.emit('room:join', { roomId, name: 'Extra' }, resolve));
    expect(await join('playground')).toMatchObject({ ok: false });
    expect(await join('other')).toMatchObject({ ok: false });
    expect(await command(b, begin('unjoined'))).toMatchObject({ ok: false });
    await complete(a, 'existing');
    expect((await resync(a)).strokes.map(s => s.id)).toEqual(['existing']);
  });

  it('expires empty rooms, releases global point capacity, and creates a new epoch', async () => {
    const server = await start({ limits: { idleRoomMs: 25, totalPoints: 1 } });
    const first = await connect(server.url);
    await complete(first.socket, 'old');
    first.socket.disconnect();
    await expect.poll(async () => (await (await fetch(`${server.url}/health`)).json()).rooms).toBe(0);
    const next = await connect(server.url);
    expect(next.snapshot.epoch).not.toBe(first.snapshot.epoch);
    expect(next.snapshot.strokes).toEqual([]);
    await complete(next.socket, 'new');
  });

  it('rate limits command bursts without changing state for rejected commands', async () => {
    const server = await start({ limits: { commandsPerSecond: 1, commandBurst: 3 } });
    const a = (await connect(server.url)).socket;
    await complete(a, 'accepted');
    expect(await command(a, begin('limited'))).toMatchObject({ ok: false });
    const observer = await connect(server.url);
    expect(observer.snapshot.revision).toBe(2);
    expect(observer.snapshot.strokes.map(s => s.id)).toEqual(['accepted']);
  });

  it('keeps cursors ephemeral and sends accepted cursor changes to the author', async () => {
    const server = await start();
    const a = (await connect(server.url)).socket;
    const b = (await connect(server.url)).socket;
    const authorCursor = new Promise(resolve => a.once('cursor:update', resolve));
    const peerCursor = new Promise(resolve => b.once('cursor:update', resolve));
    a.emit('cursor:update', { x: 50, y: 70 });
    expect(await authorCursor).toEqual({ userId: a.id, point: { x: 50, y: 70 } });
    expect(await peerCursor).toEqual({ userId: a.id, point: { x: 50, y: 70 } });
    const state = await resync(b);
    expect(state.revision).toBe(0);
    expect(state.strokes).toEqual([]);
  });
});
