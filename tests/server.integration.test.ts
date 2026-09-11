import { afterEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createAppServer } from '../server/app.js';
import type { ClientEvents, ServerEvents, Snapshot, DrawingEvent, Result, Command } from '../shared/protocol.js';
import { DrawingState } from '../client/state';

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
  it('converges overlapping brushes and eraser, reverse completion, late points and duplicate batches',async()=>{
    const server=await start();
    const peers=await Promise.all(Array.from({length:3},()=>connect(server.url)));
    const states=peers.map(p=>{const s=new DrawingState();s.hydrate(p.snapshot);p.socket.on('drawing:event',e=>s.receive(e));return s;});
    expect(await command(peers[0].socket,begin('lower',100))).toEqual({ok:true});
    expect(await command(peers[1].socket,{...begin('erase',100),tool:'eraser',width:32})).toEqual({ok:true});
    expect(await command(peers[2].socket,begin('upper',100))).toEqual({ok:true});
    await command(peers[1].socket,{type:'stroke:end',id:'erase'});
    const late=await connect(server.url);
    const lateState=new DrawingState();late.socket.on('drawing:event',e=>lateState.receive(e));
    for(let tick=0;tick<20;tick++) {
      await Promise.all([0,2].map(i=>command(peers[i].socket,{type:'stroke:points',id:i===0?'lower':'upper',offset:tick+1,points:[{x:100+tick,y:10}]})));
    }
    const duplicate={type:'stroke:points',id:'lower',offset:1,points:[{x:100,y:10}]};
    expect(await command(peers[0].socket,duplicate)).toEqual({ok:true});
    await command(peers[2].socket,{type:'stroke:end',id:'upper'});
    await command(peers[0].socket,{type:'stroke:end',id:'lower'});
    await command(peers[1].socket,{type:'history:undo'});
    await command(peers[2].socket,{type:'history:undo'});
    await command(peers[0].socket,{type:'history:redo'});
    const authoritative=await resync(late.socket);
    await expect.poll(()=>states.map(s=>s.revision)).toEqual(Array(3).fill(authoritative.revision));
    expect(lateState.hydrate(late.snapshot)).toBe(true);
    expect(lateState.revision).toBe(authoritative.revision);
    for(const state of [...states,lateState]) {
      expect(state.strokes).toEqual(authoritative.strokes);
      expect(state.redoIds).toEqual(['lower']);
    }
    expect(authoritative.revision).toBe(49);
    expect(authoritative.strokes.map(s=>[s.id,s.order,s.completionOrder,s.active])).toEqual([
      ['lower',1,3,false],['erase',2,1,true],['upper',3,2,true],
    ]);
  });
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
    for (const payload of [null, {}, { ...begin('bad'), tool: 'paint' }, { ...begin('bad'), color: 'red' }, { ...begin('bad'), width: 65 }, { ...begin('bad'), point: { x: -100001, y: 20 } }, { ...begin('bad'), id: '<script>' }]) {
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
    for(let tick=0;tick<40;tick++) {
      const results=await Promise.all(peers.map((peer,i)=>command(peer.socket,{type:'stroke:points',id:`ten-${i}`,offset:1+tick,points:[{x:50+tick,y:50+i}]})));
      expect(results.every(result=>result.ok)).toBe(true);
    }
    await Promise.all(peers.map((peer, i) => command(peer.socket, { type: 'stroke:end', id: `ten-${i}` })));
    const snapshots = await Promise.all(peers.map(peer => resync(peer.socket)));
    for (const state of snapshots) { expect(state.revision).toBe(420); expect(state.strokes).toEqual(snapshots[0]!.strokes); expect(state.users).toHaveLength(10); }
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

  it('accepts versioned object transactions with bounded operation deduplication', async () => {
    const server = await start();
    const a = (await connect(server.url)).socket;
    const object = { id:'shape-1',type:'shape' as const,order:1,version:1,translation:{x:20,y:30},shape:'rectangle' as const,width:100,height:60,strokeColor:'#000000',strokeWidth:4,fill:null };
    expect(await command(a, { type:'object:create', object, operationId:'create-1' })).toEqual({ ok:true });
    const duplicate = await command(a, { type:'object:create', object, operationId:'create-1' });
    expect(duplicate).toEqual({ ok:true });
    const moved = await command(a, { type:'object:move',ids:['shape-1'],delta:{x:10,y:5},expectedVersions:{'shape-1':1},operationId:'move-1' });
    expect(moved).toEqual({ ok:true });
    const current = await resync(a);
    expect(current.document?.objects[0]).toMatchObject({ translation:{x:30,y:35}, version:2 });
    expect(current.revision).toBe(2);
    await new Promise<void>((resolve) => a.emit('latency:ping', () => resolve()));
  });

  it('acquires object edit leases atomically and releases them on disconnect', async () => {
    const server = await start();
    const a = (await connect(server.url)).socket;
    const b = (await connect(server.url)).socket;
    const object = { id:'leased-shape',type:'shape' as const,order:1,version:1,translation:{x:20,y:30},shape:'rectangle' as const,width:100,height:60,strokeColor:'#000000',strokeWidth:4,fill:null };
    await command(a, { type:'object:create', object });
    expect(await command(a, { type:'object:lease', ids:['leased-shape'], leaseId:'lease-a', action:'acquire' } as Command)).toEqual({ ok:true });
    expect(await command(b, { type:'object:lease', ids:['leased-shape'], leaseId:'lease-b', action:'acquire' } as Command)).toMatchObject({ ok:false });
    a.disconnect();
    await expect.poll(() => server.io.sockets.sockets.size).toBe(1);
    expect(await command(b, { type:'object:lease', ids:['leased-shape'], leaseId:'lease-b', action:'acquire' } as Command)).toEqual({ ok:true });
  });

  it('keeps legacy strokes and object transactions in one mixed undo order', async () => {
    const server = await start();
    const a = (await connect(server.url)).socket;
    await complete(a, 'old-stroke');
    const object = { id: 'mixed-shape', type: 'shape' as const, order: 1, version: 1, translation: { x: 20, y: 30 }, shape: 'rectangle' as const, width: 100, height: 60, strokeColor: '#000000', strokeWidth: 4, fill: null };
    await command(a, { type: 'object:create', object });
    await complete(a, 'new-stroke');
    await command(a, { type: 'history:undo' });
    const state = await resync(a);
    expect(state.document?.objects.find(item => item.id === 'new-stroke')).toBeUndefined();
    expect(state.documentHistory?.redo).toHaveLength(1);
    expect(state.documentHistory?.undo.at(-1)?.patches[0]?.after?.id).toBe('mixed-shape');
  });
  it('keeps moved ink in world space when a later stroke arrives', async () => {
    const server = await start();
    const a = (await connect(server.url)).socket;
    await complete(a, 'moved-ink');
    expect(await command(a, { type: 'object:move', ids: ['moved-ink'], delta: { x: 10, y: 5 }, expectedVersions: { 'moved-ink': 1 } })).toEqual({ ok: true });
    await complete(a, 'later-stroke');
    const state = await resync(a);
    expect(state.document?.objects.find(object => object.id === 'moved-ink')).toMatchObject({ translation: { x: 10, y: 5 }, points: [{ x: 10, y: 10 }] });
  });

  it('stores image assets behind participant tokens and exposes only validated metadata', async () => {
    const server = await start();
    const peer = await connect(server.url);
    expect(peer.snapshot.assetToken).toEqual(expect.any(String));
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
    const headers = { 'content-type': 'image/png', 'x-room-token': peer.snapshot.assetToken!, 'x-asset-id': 'pixel' };
    const upload = await fetch(`${server.url}/api/rooms/playground/assets`, { method: 'POST', headers, body: png });
    expect(upload.status).toBe(201);
    expect(await upload.json()).toMatchObject({ id: 'pixel', mimeType: 'image/png', width: 1, height: 1, byteLength: 24 });
    const download = await fetch(`${server.url}/api/rooms/playground/assets/pixel`, { headers: { 'x-room-token': peer.snapshot.assetToken! } });
    expect(download.status).toBe(200);
    expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([...png]);
    const unauthorized = await fetch(`${server.url}/api/rooms/playground/assets/pixel`);
    expect(unauthorized.status).toBe(401);
  });

  it('pauses managed rooms for host recovery and rejects stale host operations', async () => {
    const server = await start({ limits: { hostGraceMs: 80 } });
    const host = io(server.url, { transports: ['websocket'], reconnection: false });
    const guest = io(server.url, { transports: ['websocket'], reconnection: false });
    clients.push(host, guest);
    await Promise.all([host, guest].map(socket => new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); })));
    const hostSnapshotPromise = snapshotNext(host as Client);
    await new Promise<Result>(resolve => host.emit('room:join', { roomId: 'managed', name: 'Host', host: true }, resolve));
    const hostSnapshot = await hostSnapshotPromise;
    const guestSnapshotPromise = snapshotNext(guest as Client);
    await new Promise<Result>(resolve => guest.emit('room:join', { roomId: 'managed', name: 'Guest' }, resolve));
    await guestSnapshotPromise;
    const paused = new Promise<{ status: string }>(resolve => guest.once('room:status', resolve));
    host.disconnect();
    expect((await paused).status).toBe('paused');
    expect(await command(guest as Client, begin('paused-stroke'))).toMatchObject({ ok: false });
    const recovered = io(server.url, { transports: ['websocket'], reconnection: false }); clients.push(recovered as Client);
    await new Promise<void>((resolve, reject) => { recovered.once('connect', resolve); recovered.once('connect_error', reject); });
    const recoveredSnapshotPromise = snapshotNext(recovered as Client);
    expect(await new Promise<Result>(resolve => recovered.emit('room:join', { roomId: 'managed', name: 'Host again', host: true, hostCapability: hostSnapshot.hostCapability }, resolve))).toEqual({ ok: true });
    expect((await recoveredSnapshotPromise).roomStatus).toBe('active');
    const ended = new Promise<{ status: string }>(resolve => guest.on('room:status', status => { if (status.status === 'ended') resolve(status); }));
    expect(await new Promise<Result>(resolve => recovered.emit('room:end', { capability: hostSnapshot.hostCapability }, resolve))).toEqual({ ok: true });
    expect((await ended).status).toBe('ended');
  });
});
