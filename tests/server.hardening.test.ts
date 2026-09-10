import { afterEach, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createAppServer } from '../server/app';
import type { ClientEvents, ServerEvents, Snapshot, Result, Command } from '../shared/protocol';

type Client = Socket<ServerEvents,ClientEvents>;
const clients: Client[] = [];
const servers: Awaited<ReturnType<typeof createAppServer>>[] = [];
afterEach(async () => {
  clients.splice(0).forEach(client => client.disconnect());
  await Promise.all(servers.splice(0).map(server => server.close()));
});
async function join(url: string) {
  const socket: Client = io(url,{transports:['websocket'],reconnection:false,autoConnect:false});
  clients.push(socket);
  await new Promise<void>((resolve,reject) => {
    socket.once('connect',resolve); socket.once('connect_error',reject); socket.connect();
  });
  const snapshot = new Promise<Snapshot>(resolve => socket.once('room:snapshot',resolve));
  const result = await new Promise<Result>(resolve => socket.emit('room:join',{roomId:'eviction',name:'Guest'},resolve));
  expect(result).toEqual({ok:true});
  return {socket,snapshot:await snapshot};
}
function command(socket: Client, value: Command) {
  return new Promise<Result>(resolve => socket.emit('command',value,resolve));
}

it('keeps a rejoined room alive after nested slow-peer eviction cancels two unfinished strokes',async () => {
  const idleRoomMs = 1000;
  const server = await createAppServer({host:'127.0.0.1',limits:{idleRoomMs}}); servers.push(server);
  const peers = [await join(server.url),await join(server.url)];
  for (const [index,peer] of peers.entries()) {
    expect(await command(peer.socket,{
      type:'stroke:begin',id:`unfinished-${index}`,tool:'brush',color:'#000000',width:4,point:{x:10,y:10},
    })).toEqual({ok:true});
  }
  // Simulate congested outgoing transports while retaining real Socket.io
  // packet queues, incoming commands, broadcasts, and disconnect cleanup.
  for (const peer of server.io.sockets.sockets.values()) {
    peer.conn.transport.writable = false;
    for (let packet=0; packet<130; packet++) peer.emit('server:error','Congestion fixture');
  }
  peers[0].socket.emit('command',{
    type:'stroke:points',id:'unfinished-0',offset:1,points:[{x:20,y:20}],
  },() => {});
  await expect.poll(() => server.io.sockets.sockets.size,{interval:5}).toBe(0);
  const returned = await join(server.url);
  expect(returned.snapshot.epoch).toBe(peers[0].snapshot.epoch);
  expect(returned.snapshot.strokes).toEqual([]);
  // Cross the real room-expiry deadline; no drawing activity should be needed
  // to keep a room with a connected participant alive.
  await new Promise(resolve => setTimeout(resolve,idleRoomMs+100));
  expect(returned.socket.connected).toBe(true);
  expect(await (await fetch(`${server.url}/health`)).json()).toMatchObject({rooms:1});
  const late = await join(server.url);
  expect(late.snapshot.epoch).toBe(returned.snapshot.epoch);
  expect(late.snapshot.users).toHaveLength(2);
});
