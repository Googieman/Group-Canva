import express from 'express';
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Server, type Socket } from 'socket.io';
import { BATCH_SIZE, BOARD_HEIGHT, BOARD_WIDTH, DEFAULT_ROOM, type Change, type ClientEvents, type Command, type Point, type Result, type ServerEvents, type Snapshot, type Stroke, type User } from '../shared/protocol.js';

export interface Limits {
  rooms: number; connections: number; usersPerRoom: number; strokesPerRoom: number;
  pointsPerStroke: number; pointsPerRoom: number; totalPoints: number; usedIdsPerRoom: number;
  commandsPerSecond: number; commandBurst: number; idleRoomMs: number;
}
const DEFAULT_LIMITS: Limits = {
  rooms: 32, connections: 256, usersPerRoom: 32, strokesPerRoom: 2000,
  pointsPerStroke: 10000, pointsPerRoom: 50000, totalPoints: 250000, usedIdsPerRoom: 20000,
  commandsPerSecond: 150, commandBurst: 300, idleRoomMs: 30 * 60 * 1000,
};
export interface ServerOptions { port?: number; host?: string; allowedOrigins?: string[]; limits?: Partial<Limits>; staticDir?: string; onCommandTiming?: (durationMs: number) => void }
interface Room {
  id: string; epoch: string; revision: number; nextOrder: number; nextCompletion: number;
  strokes: Map<string, Stroke>; usedIds: Set<string>; users: Map<string, User>;
  unfinished: Map<string, string>; redoIds: string[]; points: number; expires?: ReturnType<typeof setTimeout>;
}
type Peer = Socket<ClientEvents, ServerEvents>;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const ROOM_ID = /^[a-zA-Z0-9_-]{1,48}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const COLORS = ['#6857e8', '#e66b3b', '#168d83', '#bc4e93', '#3d7fd0', '#a37919'];
const ok: Result = { ok: true };
const fail = (error: string): Result => ({ ok: false, error });
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function point(value: unknown): value is Point {
  return record(value) && Object.keys(value).length === 2 && typeof value.x === 'number' && Number.isFinite(value.x) && value.x >= 0 && value.x <= BOARD_WIDTH && typeof value.y === 'number' && Number.isFinite(value.y) && value.y >= 0 && value.y <= BOARD_HEIGHT;
}
function validCommand(value: unknown): value is Command {
  if (!record(value) || typeof value.type !== 'string') return false;
  const keys = Object.keys(value).sort().join(',');
  if (value.type === 'history:undo' || value.type === 'history:redo') return keys === 'type';
  if (typeof value.id !== 'string' || !ID.test(value.id)) return false;
  switch (value.type) {
    case 'stroke:begin': return keys === 'color,id,point,tool,type,width' && (value.tool === 'brush' || value.tool === 'eraser') && typeof value.color === 'string' && COLOR.test(value.color) && typeof value.width === 'number' && Number.isFinite(value.width) && value.width >= 1 && value.width <= 64 && point(value.point);
    case 'stroke:points': return keys === 'id,offset,points,type' && Number.isSafeInteger(value.offset) && (value.offset as number) >= 1 && Array.isArray(value.points) && value.points.length >= 1 && value.points.length <= BATCH_SIZE && value.points.every(point);
    case 'stroke:end': case 'stroke:cancel': return keys === 'id,type';
    default: return false;
  }
}
function originAllowed(request: IncomingMessage, allowed: Set<string>) {
  const origin = request.headers.origin;
  // Origin is a browser cross-site guard, not authentication for native clients.
  if (origin === undefined) return true;
  if (allowed.has(origin)) return true;
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) return false;
    if (url.host === request.headers.host) return true;
    return process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export async function createAppServer(options: ServerOptions = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid server limit: ${name}`);
  const rooms = new Map<string, Room>();
  const outbound = new Map<string, { packets: number; bytes: number }>();
  let totalPoints = 0;
  let closing = false;
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_request, response) => response.json({ status: 'ok', rooms: rooms.size }));
  app.use(express.static(options.staticDir ?? resolve(process.cwd(), 'dist/client'), { maxAge: 0 }));
  const httpServer = createServer(app);
  const allowedOrigins = new Set(options.allowedOrigins ?? (process.env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean));
  const io = new Server<ClientEvents, ServerEvents>(httpServer, {
    transports: ['websocket'], maxHttpBufferSize: 16 * 1024, perMessageDeflate: false,
    allowRequest: (request, callback) => callback(null, !closing && io.engine.clientsCount < limits.connections && originAllowed(request, allowedOrigins)),
    pingInterval: 15000, pingTimeout: 10000,
  });
  function snapshot(room: Room, selfId: string): Snapshot {
    return { epoch: room.epoch, revision: room.revision, roomId: room.id, selfId, strokes: [...room.strokes.values()], redoIds: [...room.redoIds], users: [...room.users.values()] };
  }
  function protectSlowPeers(room: Room) {
    for (const id of room.users.keys()) {
      const peer = io.sockets.sockets.get(id);
      const pending = outbound.get(id);
      if (peer && pending && (pending.packets > 128 || pending.bytes > 8 * 1024 * 1024)) peer.disconnect(true);
    }
  }
  function publish(room: Room, change: Change) {
    room.revision++;
    // Enqueue this revision before disconnect cleanup can produce the next one.
    io.to(`canvas:${room.id}`).emit('drawing:event', { epoch: room.epoch, revision: room.revision, change });
    protectSlowPeers(room);
  }
  function discard(room: Room, id: string) {
    const stroke = room.strokes.get(id);
    if (!stroke) return;
    totalPoints -= stroke.points.length;
    room.points -= stroke.points.length;
    room.strokes.delete(id);
  }
  function cancel(room: Room, userId: string) {
    const id = room.unfinished.get(userId);
    if (!id) return;
    room.unfinished.delete(userId);
    discard(room, id);
    publish(room, { type: 'stroke:cancel', id });
  }
  function leave(socket: Peer, room: Room) {
    room.users.delete(socket.id);
    socket.leave(`canvas:${room.id}`);
    cancel(room, socket.id);
    io.to(`canvas:${room.id}`).emit('cursor:update', { userId: socket.id, point: null });
    io.to(`canvas:${room.id}`).emit('presence:update', [...room.users.values()]);
    if (!room.users.size && !closing) {
      room.expires = setTimeout(() => { totalPoints -= room.points; rooms.delete(room.id); }, limits.idleRoomMs);
      room.expires.unref();
    }
  }
  function apply(room: Room, userId: string, cmd: Command): Result {
    if (cmd.type === 'stroke:begin') {
      if (room.usedIds.has(cmd.id)) return fail('Stroke ID was already used.');
      if (room.unfinished.has(userId)) return fail('Finish or cancel your current stroke first.');
      if (room.strokes.size >= limits.strokesPerRoom || room.usedIds.size >= limits.usedIdsPerRoom || room.points >= limits.pointsPerRoom || totalPoints >= limits.totalPoints) return fail('Canvas capacity reached. Try a new room.');
      const stroke: Stroke = { id: cmd.id, userId, tool: cmd.tool, color: cmd.color, width: cmd.width, points: [cmd.point], order: ++room.nextOrder, completed: false, completionOrder: null, active: true };
      room.strokes.set(cmd.id, stroke); room.usedIds.add(cmd.id); room.unfinished.set(userId, cmd.id);
      room.points++; totalPoints++;
      publish(room, { type: 'stroke:begin', stroke });
      return ok;
    }
    if (cmd.type === 'history:undo') {
      let latest: Stroke | undefined;
      for (const stroke of room.strokes.values()) if (stroke.active && stroke.completed && (!latest || stroke.completionOrder! > latest.completionOrder!)) latest = stroke;
      if (latest) { latest.active = false; room.redoIds.push(latest.id); publish(room, { type: 'history:undo', id: latest.id }); }
      return ok;
    }
    if (cmd.type === 'history:redo') {
      const id = room.redoIds.pop();
      if (id) { room.strokes.get(id)!.active = true; publish(room, { type: 'history:redo', id }); }
      return ok;
    }
    const stroke = room.strokes.get(cmd.id);
    if (!stroke || stroke.userId !== userId) return fail('Stroke is missing or belongs to another user.');
    if (cmd.type === 'stroke:points') {
      if (cmd.offset < stroke.points.length) {
        const exact = cmd.offset + cmd.points.length <= stroke.points.length && cmd.points.every((p, index) => { const prior = stroke.points[cmd.offset + index]!; return prior.x === p.x && prior.y === p.y; });
        return exact ? ok : fail('Point batch conflicts with accepted points.');
      }
      if (stroke.completed) return fail('Stroke has already finished.');
      if (cmd.offset !== stroke.points.length) return fail('Point batch is out of order. Resync the room.');
      if (stroke.points.length + cmd.points.length > limits.pointsPerStroke || room.points + cmd.points.length > limits.pointsPerRoom || totalPoints + cmd.points.length > limits.totalPoints) return fail('Point capacity reached. Finish this stroke.');
      stroke.points.push(...cmd.points); room.points += cmd.points.length; totalPoints += cmd.points.length;
      publish(room, { type: 'stroke:points', id: cmd.id, offset: cmd.offset, points: cmd.points });
      return ok;
    }
    if (cmd.type === 'stroke:end') {
      if (stroke.completed) return ok;
      stroke.completed = true; stroke.completionOrder = ++room.nextCompletion;
      room.unfinished.delete(userId);
      for (const id of room.redoIds) discard(room, id);
      room.redoIds = [];
      publish(room, { type: 'stroke:end', id: cmd.id, completionOrder: stroke.completionOrder });
      return ok;
    }
    if (stroke.completed) return fail('Completed strokes cannot be cancelled.');
    cancel(room, userId);
    return ok;
  }
  io.on('connection', socket => {
    const pending = { packets: 0, bytes: 0 };
    outbound.set(socket.id, pending);
    socket.conn.on('packetCreate', packet => {
      pending.packets++;
      pending.bytes += typeof packet.data === 'string' ? packet.data.length * 2 : (packet.data?.byteLength ?? 0);
    });
    socket.conn.on('drain', () => { pending.packets = 0; pending.bytes = 0; });
    let room: Room | undefined;
    let tokens = limits.commandBurst;
    let lastRefill = Date.now();
    let lastCursor = 0;
    let lastSnapshot = 0;
    let lastJoin = 0;
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    function token() {
      const now = Date.now();
      tokens = Math.min(limits.commandBurst, tokens + (now - lastRefill) * limits.commandsPerSecond / 1000);
      lastRefill = now;
      if (tokens < 1) return false;
      tokens--; return true;
    }
    function sendSnapshot() {
      if (!room) return;
      const remaining = 250 - (Date.now() - lastSnapshot);
      if (remaining > 0) {
        snapshotTimer ??= setTimeout(() => { snapshotTimer = undefined; sendSnapshot(); }, remaining);
        return;
      }
      lastSnapshot = Date.now();
      protectSlowPeers(room);
      if (socket.connected) socket.emit('room:snapshot', snapshot(room, socket.id));
    }
    socket.on('room:join', (request: unknown, ack) => {
      const reply = (result: Result) => { if (typeof ack === 'function') ack(result); };
      if (!token()) { reply(fail('Too many requests.')); return; }
      if (!record(request)) { reply(fail('Invalid room request.')); return; }
      const roomId = request.roomId ?? DEFAULT_ROOM;
      const name = request.name ?? 'Guest';
      if (typeof roomId !== 'string' || !ROOM_ID.test(roomId) || typeof name !== 'string' || name.trim().length < 1 || name.length > 32 || /[\u0000-\u001f\u007f]/.test(name) || Object.keys(request).some(key => key !== 'roomId' && key !== 'name')) { reply(fail('Use a room ID of 1–48 letters, numbers, hyphens or underscores and a name of 1–32 characters.')); return; }
      if (room?.id === roomId) { sendSnapshot(); reply(ok); return; }
      if (Date.now() - lastJoin < 500) { reply(fail('Wait before switching rooms.')); return; }
      let next = rooms.get(roomId);
      if ((!next && rooms.size >= limits.rooms) || (next && next.users.size >= limits.usersPerRoom)) { reply(fail('This room or server is full.')); return; }
      if (!next) {
        next = { id: roomId, epoch: randomUUID(), revision: 0, nextOrder: 0, nextCompletion: 0, strokes: new Map(), usedIds: new Set(), users: new Map(), unfinished: new Map(), redoIds: [], points: 0 };
        rooms.set(roomId, next);
      }
      if (room) leave(socket, room);
      clearTimeout(next.expires); delete next.expires;
      room = next; lastJoin = Date.now(); lastSnapshot = 0;
      room.users.set(socket.id, { id: socket.id, name: name.trim(), color: COLORS[room.users.size % COLORS.length]! });
      socket.join(`canvas:${room.id}`);
      sendSnapshot();
      io.to(`canvas:${room.id}`).emit('presence:update', [...room.users.values()]);
      reply(ok);
    });
    socket.on('command', (value: unknown, ack) => {
      const started = options.onCommandTiming ? performance.now() : 0;
      let result: Result;
      if (!token()) result = fail('Drawing rate limit exceeded. Please slow down.');
      else if (!room) result = fail('Join a room before drawing.');
      else if (!validCommand(value)) result = fail('Invalid drawing command.');
      else result = apply(room, socket.id, value);
      options.onCommandTiming?.(performance.now()-started);
      if (typeof ack === 'function') ack(result);
      else if (!result.ok) socket.emit('server:error', result.error);
    });
    socket.on('room:resync', () => { if (token()) sendSnapshot(); });
    socket.on('cursor:update', (value: unknown) => {
      if (!room || (value !== null && !point(value)) || Date.now() - lastCursor < 30 || !token()) return;
      lastCursor = Date.now();
      io.to(`canvas:${room.id}`).volatile.emit('cursor:update', { userId: socket.id, point: value });
    });
    socket.on('disconnect', () => {
      clearTimeout(snapshotTimer); outbound.delete(socket.id);
      if (room) { const prior = room; room = undefined; leave(socket, prior); }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 0, options.host ?? '0.0.0.0', () => { httpServer.off('error', reject); resolveListen(); });
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
  const host = options.host === '::1' ? '[::1]' : options.host === '0.0.0.0' || !options.host ? '127.0.0.1' : options.host;
  return {
    httpServer, io, url: `http://${host}:${address.port}`,
    async close() {
      if (closing) return;
      closing = true;
      for (const entry of rooms.values()) clearTimeout(entry.expires);
      await new Promise<void>(resolveClose => io.close(() => resolveClose()));
      rooms.clear();
    },
  };
}
