import { afterEach, expect, it, vi } from 'vitest';
import { Connection, medianLatency } from '../client/network';
import { DrawingState } from '../client/state';
import { createAppServer } from '../server/app';
import type { Result, Snapshot } from '../shared/protocol';

it('calculates the median from the latest monotonic latency samples', () => {
  expect(medianLatency([])).toBeNull();
  expect(medianLatency([31, 12, 24, 8, 40])).toBe(24);
  expect(medianLatency([31, 12, 24, 8, 40, 5])).toBe(24);
});

const servers: Awaited<ReturnType<typeof createAppServer>>[] = [];
const connections: Connection[] = [];
afterEach(async () => {
  connections.splice(0).forEach(c => c.destroy());
  await Promise.all(servers.splice(0).map(s => s.close())); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
async function setup() {
  const server = await createAppServer({host:'127.0.0.1'}); servers.push(server);
  vi.stubEnv('VITE_SERVER_URL',server.url);
  const state = new DrawingState(); const snapshots:Snapshot[]=[];
  const callbacks = {status:vi.fn(),snapshot:(s:Snapshot)=>snapshots.push(s),drawing:vi.fn(),users:vi.fn(),cursor:vi.fn(),error:vi.fn()};
  const connection = new Connection(state,'network-test','Tester',callbacks); connections.push(connection);
  await expect.poll(()=>state.ready).toBe(true);
  return {server,state,connection,callbacks,snapshots,peer:[...server.io.sockets.sockets.values()][0]};
}
it('recovers from a server-forced disconnect with a fresh identity and rejects offline input',async()=>{
  const {server,state,connection,snapshots,peer}=await setup();
  connection.send({type:'stroke:begin',id:'abandoned',tool:'brush',color:'#000000',width:4,point:{x:10,y:10}});
  await expect.poll(()=>state.strokes.length).toBe(1);
  peer.disconnect(true);
  await expect.poll(()=>state.ready,{interval:5}).toBe(false);
  expect(connection.send({type:'history:undo'})).toBe(false);
  await expect.poll(()=>state.ready,{timeout:4000}).toBe(true);
  expect(snapshots.at(-1)!.selfId).not.toBe(snapshots[0].selfId);
  expect(state.strokes).toEqual([]); expect(server.io.sockets.sockets.size).toBe(1);
});
it('ignores a snapshot for another room or a retired connection identity',async()=>{
  const {state,peer,snapshots}=await setup();
  const current=snapshots[0];
  peer.emit('room:snapshot',{...current,roomId:'other',epoch:'wrong'});
  peer.emit('room:snapshot',{...current,selfId:'retired',epoch:'also-wrong'});
  // Ordered same-transport marker: both bad snapshots have arrived before this snapshot.
  peer.emit('room:snapshot',current);
  await expect.poll(()=>snapshots.length).toBeGreaterThan(1);
  expect(snapshots.every(s=>s.roomId===current.roomId&&s.selfId===current.selfId)).toBe(true);
  expect(state.epoch).toBe(current.epoch);
});
it('drops drawing packets while a snapshot is hydrating',async()=>{
  const {state,connection,peer,snapshots}=await setup();
  const current=snapshots[0];
  connection.resync();
  await expect.poll(()=>state.ready).toBe(false);
  peer.emit('drawing:event',{epoch:'stale-transport',revision:current.revision+1,
    change:{type:'stroke:cancel',id:'missing'}});
  peer.emit('room:snapshot',current);
  await expect.poll(()=>state.ready).toBe(true);
  expect(state.revision).toBe(current.revision);
  expect(state.strokes).toEqual(current.strokes);
});
it('ignores a failed acknowledgement from before a successful resynchronization',async()=>{
  const {state,connection,callbacks,peer,snapshots}=await setup();
  let reply:((result:Result)=>void)|undefined;
  peer.removeAllListeners('command'); peer.on('command',(_command,ack)=>{reply=ack;});
  connection.send({type:'history:undo'});
  await expect.poll(()=>!!reply).toBe(true);
  connection.resync();
  await expect.poll(()=>snapshots.length).toBe(2);
  reply!({ok:false,error:'old failure'});
  // A real round-trip marker lets the stale acknowledgement be processed.
  peer.emit('room:snapshot',snapshots[0]);
  await expect.poll(()=>snapshots.length).toBe(3);
  expect(state.ready).toBe(true); expect(callbacks.error).not.toHaveBeenCalled();
});
it('hydrates from the current page origin when no server URL is configured', async () => {
  const server = await createAppServer({ host: '127.0.0.1' }); servers.push(server);
  vi.stubEnv('VITE_SERVER_URL', '');
  vi.stubGlobal('window', { location: { origin: server.url, hostname: '127.0.0.1' } });
  vi.stubGlobal('location', { origin: server.url, protocol: 'http:', host: new URL(server.url).host, pathname: '/', search: '', hash: '' });
  const state = new DrawingState();
  const callbacks = { status: vi.fn(), snapshot: vi.fn(), drawing: vi.fn(), users: vi.fn(), cursor: vi.fn(), error: vi.fn() };
  const connection = new Connection(state, 'same-origin-network-test', 'Tester', callbacks); connections.push(connection);
  await expect.poll(() => state.ready, { timeout: 5000 }).toBe(true);
  expect(callbacks.snapshot).toHaveBeenCalled();
});
it('stops on a protocol-mismatched snapshot instead of enabling edits', async () => {
  const { state, peer, callbacks, snapshots } = await setup();
  const current = snapshots[0]!;
  peer.emit('room:snapshot', { ...current, protocolVersion: 999 });
  await expect.poll(() => callbacks.error).toHaveBeenCalledWith(expect.stringMatching(/incompatible|update/i));
  expect(state.ready).toBe(false);
});
