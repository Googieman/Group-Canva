import express from 'express';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { Server, type Socket } from 'socket.io';
import { applyDocumentCommand, createDocument, createHistory, documentToLegacyStrokes, legacyStrokesToDocument, validateDocument, type CanvasDocument, type CanvasObject, type DocumentCommand, type DocumentHistory, type LeaseCommand, type Transaction } from '../shared/document.js';
import { BATCH_SIZE, DEFAULT_ROOM, PROTOCOL_VERSION, type AssetMeta, type Change, type ClientEvents, type Command, type Point, type Result, type ServerEvents, type Snapshot, type Stroke, type StrokeCommand, type User } from '../shared/protocol.js';

export interface Limits {
  rooms: number; connections: number; usersPerRoom: number; strokesPerRoom: number;
  pointsPerStroke: number; pointsPerRoom: number; totalPoints: number; usedIdsPerRoom: number;
  commandsPerSecond: number; commandBurst: number; operationResultsPerRoom: number; idleRoomMs: number; hostGraceMs: number; assetPerImageBytes: number; assetsPerRoomBytes: number; totalAssetBytes: number;
}
const DEFAULT_LIMITS: Limits = {
  rooms: 32, connections: 256, usersPerRoom: 32, strokesPerRoom: 2000,
  pointsPerStroke: 10000, pointsPerRoom: 50000, totalPoints: 250000, usedIdsPerRoom: 20000,
  commandsPerSecond: 150, commandBurst: 300, operationResultsPerRoom: 4096, idleRoomMs: 30 * 60 * 1000, hostGraceMs: 2 * 60 * 1000, assetPerImageBytes: 5 * 1024 * 1024, assetsPerRoomBytes: 20 * 1024 * 1024, totalAssetBytes: 100 * 1024 * 1024,
};
export interface ServerOptions { port?: number; host?: string; allowedOrigins?: string[]; limits?: Partial<Limits>; staticDir?: string; persistencePath?: string }
interface Room {
  id: string; epoch: string; revision: number; nextOrder: number; nextCompletion: number;
  strokes: Map<string, Stroke>; usedIds: Set<string>; users: Map<string, User>;
  unfinished: Map<string, string>; redoIds: string[]; points: number;
  document: CanvasDocument; documentHistory: DocumentHistory; operationResults: Map<string, { fingerprint: string; result: Result }>; leases: Map<string, { leaseId: string; userId: string; expiresAt: number }>;
  assets: Map<string, { meta: AssetMeta; bytes: Buffer }>; hiddenInkIds: Set<string>;
  managed: boolean; hostSocketId: string | null; hostCapability: string; status: 'active' | 'paused' | 'ended'; hostWatermark: { epoch: string; revision: number } | null; hostGrace?: ReturnType<typeof setTimeout>; hostLagTimer?: ReturnType<typeof setTimeout>; documentMode: boolean;
  expires?: ReturnType<typeof setTimeout>;
}
type Peer = Socket<ClientEvents, ServerEvents>;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const ROOM_ID = /^[a-zA-Z0-9_-]{1,48}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const COLORS = ['#6857e8', '#e66b3b', '#168d83', '#bc4e93', '#3d7fd0', '#a37919'];
const ok: Result = { ok: true };
const fail = (error: string): Result => ({ ok: false, error });
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function optionalOperation(value: Record<string, unknown>, allowed: string[]): boolean {
  if (Object.keys(value).some(key => !allowed.includes(key))) return false;
  return !('operationId' in value) || (typeof value.operationId === 'string' && ID.test(value.operationId));
}
interface PersistedRoom {
  id: string; epoch: string; revision: number; nextOrder: number; nextCompletion: number;
  strokes: Stroke[]; usedIds: string[]; redoIds: string[]; points: number;
  document: CanvasDocument; documentHistory: DocumentHistory;
  assets: Array<{ meta: AssetMeta; bytes: string }>;
  hiddenInkIds: string[]; managed: boolean; hostCapability: string;
  status: Room['status']; hostWatermark: Room['hostWatermark']; documentMode: boolean;
}
interface PersistedState { version: 1; rooms: PersistedRoom[]; endedManagedRooms: string[] }
function expectedVersions(value: unknown): value is Record<string, number> {
  return record(value) && Object.entries(value).every(([id, version]) => ID.test(id) && Number.isSafeInteger(version) && (version as number) >= 1);
}
function validCommand(value: unknown): value is Command {
  if (!record(value) || typeof value.type !== 'string') return false;
  const keys = Object.keys(value).sort().join(',');
  if (value.type === 'history:undo' || value.type === 'history:redo') return optionalOperation(value, ['type', 'expectedVersions', 'operationId']) && (!('expectedVersions' in value) || expectedVersions(value.expectedVersions));
  if (value.type === 'object:lease') return validLeaseCommand(value);
  if (typeof value.type === 'string' && value.type.startsWith('object:')) return validDocumentCommand(value);
  if (typeof value.id !== 'string' || !ID.test(value.id)) return false;
  switch (value.type) {
    case 'stroke:begin': return optionalOperation(value, ['color', 'id', 'operationId', 'point', 'tool', 'type', 'width']) && (value.tool === 'brush' || value.tool === 'eraser') && typeof value.color === 'string' && COLOR.test(value.color) && typeof value.width === 'number' && Number.isFinite(value.width) && value.width >= 1 && value.width <= 64 && pointWithinWorld(value.point);
    case 'stroke:points': return optionalOperation(value, ['id', 'offset', 'operationId', 'points', 'type']) && Number.isSafeInteger(value.offset) && (value.offset as number) >= 1 && Array.isArray(value.points) && value.points.length >= 1 && value.points.length <= BATCH_SIZE && value.points.every(pointWithinWorld);
    case 'stroke:end': case 'stroke:cancel': return optionalOperation(value, ['id', 'operationId', 'type']);
    default: return false;
  }
}
function validDocumentCommand(value: Record<string, unknown>): value is DocumentCommand {
  if (value.type === 'object:create') return optionalOperation(value, ['type', 'object', 'operationId']) && record(value.object);
  if (value.type === 'object:move') return optionalOperation(value, ['type', 'ids', 'delta', 'expectedVersions', 'leaseId', 'operationId']) && Array.isArray(value.ids) && value.ids.length > 0 && value.ids.every(id => typeof id === 'string' && ID.test(id)) && pointWithinWorld(value.delta) && expectedVersions(value.expectedVersions) && (!('leaseId' in value) || typeof value.leaseId === 'string');
  if (value.type === 'object:resize') return optionalOperation(value, ['type', 'id', 'width', 'height', 'expectedVersion', 'preserveAspectRatio', 'leaseId', 'operationId']) && typeof value.id === 'string' && ID.test(value.id) && typeof value.width === 'number' && Number.isFinite(value.width) && typeof value.height === 'number' && Number.isFinite(value.height) && Number.isSafeInteger(value.expectedVersion) && (value.expectedVersion as number) >= 1 && (!('preserveAspectRatio' in value) || typeof value.preserveAspectRatio === 'boolean') && (!('leaseId' in value) || typeof value.leaseId === 'string');
  if (value.type === 'object:text') return optionalOperation(value, ['type', 'id', 'text', 'expectedVersion', 'leaseId', 'operationId']) && typeof value.id === 'string' && ID.test(value.id) && typeof value.text === 'string' && Number.isSafeInteger(value.expectedVersion) && (value.expectedVersion as number) >= 1 && (!('leaseId' in value) || typeof value.leaseId === 'string');
  if (value.type === 'object:delete') return optionalOperation(value, ['type', 'ids', 'expectedVersions', 'leaseId', 'operationId']) && Array.isArray(value.ids) && value.ids.length > 0 && value.ids.every(id => typeof id === 'string' && ID.test(id)) && expectedVersions(value.expectedVersions) && (!('leaseId' in value) || typeof value.leaseId === 'string');
  return false;
}
function validLeaseCommand(value: Record<string, unknown>): boolean {
  return value.type === 'object:lease' && Object.keys(value).sort().join(',') === 'action,ids,leaseId,type' && Array.isArray(value.ids) && value.ids.length > 0 && value.ids.length <= 10_000 && value.ids.every(id => typeof id === 'string' && ID.test(id)) && typeof value.leaseId === 'string' && ID.test(value.leaseId) && ['acquire', 'renew', 'release'].includes(value.action as string);
}
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).filter(key => key !== 'operationId').sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function pointWithinWorld(value: unknown): value is Point {
  return record(value) && Object.keys(value).length === 2 && typeof value.x === 'number' && Number.isFinite(value.x) && Math.abs(value.x) <= 100_000 && typeof value.y === 'number' && Number.isFinite(value.y) && Math.abs(value.y) <= 100_000;
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
  const endedManagedRooms = new Set<string>();
  const assetTokens = new Map<string, { roomId: string; socketId: string }>();
  let notifyAsset: (room: Room, asset: AssetMeta) => void = () => {};
  const outbound = new Map<string, { packets: number; bytes: number }>();
  let totalPoints = 0;
  let totalAssetBytes = 0;
  let closing = false;
  let persistenceTimer: ReturnType<typeof setTimeout> | undefined;
  let persistenceQueue = Promise.resolve();
  const app = express();
  function serializeState(): PersistedState {
    return {
      version: 1,
      rooms: [...rooms.values()].filter(room => room.status !== 'ended').map(room => ({
        id: room.id,
        epoch: room.epoch,
        revision: room.revision,
        nextOrder: room.nextOrder,
        nextCompletion: room.nextCompletion,
        strokes: [...room.strokes.values()].map(stroke => structuredClone(stroke)),
        usedIds: [...room.usedIds],
        redoIds: [...room.redoIds],
        points: room.points,
        document: structuredClone(room.document),
        documentHistory: structuredClone(room.documentHistory),
        assets: [...room.assets.values()].map(asset => ({ meta: structuredClone(asset.meta), bytes: asset.bytes.toString('base64') })),
        hiddenInkIds: [...room.hiddenInkIds],
        managed: room.managed,
        hostCapability: room.hostCapability,
        status: room.status,
        hostWatermark: room.hostWatermark,
        documentMode: room.documentMode,
      })),
      endedManagedRooms: [...endedManagedRooms],
    };
  }
  async function writeState(state: PersistedState): Promise<void> {
    if (!options.persistencePath) return;
    await mkdir(dirname(options.persistencePath), { recursive: true });
    const temporaryPath = `${options.persistencePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(state), 'utf8');
    await rename(temporaryPath, options.persistencePath);
  }
  function persistNow(): Promise<void> {
    if (!options.persistencePath) return Promise.resolve();
    const state = serializeState();
    persistenceQueue = persistenceQueue.catch(() => undefined).then(() => writeState(state));
    return persistenceQueue;
  }
  function schedulePersistence(): void {
    if (!options.persistencePath || persistenceTimer) return;
    persistenceTimer = setTimeout(() => { persistenceTimer = undefined; void persistNow(); }, 25);
    persistenceTimer.unref();
  }
  async function restorePersistence(): Promise<void> {
    if (!options.persistencePath) return;
    let state: PersistedState;
    try {
      state = JSON.parse(await readFile(options.persistencePath, 'utf8')) as PersistedState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`Unable to restore persisted rooms: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (state.version !== 1 || !Array.isArray(state.rooms)) throw new Error('Unable to restore persisted rooms: unsupported state format.');
    for (const roomState of state.rooms) {
      if (roomState.status === 'ended') { if (roomState.managed) endedManagedRooms.add(roomState.id); continue; }
      const documentValidation = validateDocument(roomState.document);
      if (!documentValidation.ok || !Array.isArray(roomState.strokes) || !Array.isArray(roomState.assets)) continue;
      const assets = new Map<string, { meta: AssetMeta; bytes: Buffer }>();
      for (const asset of roomState.assets) {
        const bytes = Buffer.from(asset.bytes, 'base64');
        if (bytes.length !== asset.meta.byteLength) continue;
        assets.set(asset.meta.id, { meta: structuredClone(asset.meta), bytes });
      }
      const room: Room = {
        id: roomState.id,
        epoch: roomState.epoch,
        revision: roomState.revision,
        nextOrder: roomState.nextOrder,
        nextCompletion: roomState.nextCompletion,
        strokes: new Map(roomState.strokes.map(stroke => [stroke.id, structuredClone(stroke)])),
        usedIds: new Set(roomState.usedIds),
        users: new Map(),
        unfinished: new Map(),
        redoIds: [...roomState.redoIds],
        points: roomState.points,
        document: structuredClone(roomState.document),
        documentHistory: structuredClone(roomState.documentHistory),
        operationResults: new Map(),
        leases: new Map(),
        assets,
        hiddenInkIds: new Set(roomState.hiddenInkIds),
        managed: roomState.managed,
        hostSocketId: null,
        hostCapability: roomState.hostCapability,
        status: roomState.managed && roomState.status === 'active' ? 'paused' : roomState.status,
        hostWatermark: roomState.hostWatermark,
        documentMode: roomState.documentMode,
      };
      rooms.set(room.id, room);
      totalPoints += room.points;
      totalAssetBytes += [...room.assets.values()].reduce((sum, asset) => sum + asset.bytes.length, 0);
    }
    for (const roomId of state.endedManagedRooms ?? []) endedManagedRooms.add(roomId);
  }
  const allowedOrigins = new Set(options.allowedOrigins ?? (process.env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean));
  app.disable('x-powered-by');
  app.get('/health', (_request, response) => response.json({ status: 'ok', rooms: rooms.size }));
  function mediaDimensions(bytes: Buffer, mimeType: string): { width: number; height: number } | null {
    if (mimeType === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (mimeType === 'image/webp' && bytes.length >= 30 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' && bytes.subarray(12, 16).toString() === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (mimeType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const marker = bytes[offset + 1]!; offset += 2;
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
        const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) break;
        if (marker >= 0xc0 && marker <= 0xc3 || marker >= 0xc5 && marker <= 0xc7 || marker >= 0xc9 && marker <= 0xcb || marker >= 0xcd && marker <= 0xcf) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
        offset += length;
      }
    }
    return null;
  }
  function tokenFor(request: express.Request, roomId: string): { room: Room; socketId: string } | null {
    const header = request.header('x-room-token') ?? (request.header('authorization')?.replace(/^Bearer\s+/i, ''));
    const entry = header ? assetTokens.get(header) : undefined;
    const room = rooms.get(roomId);
    return entry && room && entry.roomId === roomId && room.users.has(entry.socketId) ? { room, socketId: entry.socketId } : null;
  }
  function issueAssetToken(room: Room, socketId: string): string {
    for (const [token, owner] of assetTokens) if (owner.socketId === socketId) assetTokens.delete(token);
    const token = randomUUID();
    assetTokens.set(token, { roomId: room.id, socketId });
    return token;
  }
  function revokeAssetTokens(socketId: string): void {
    for (const [token, owner] of assetTokens) if (owner.socketId === socketId) assetTokens.delete(token);
  }
  app.use('/api/rooms', (request, response, next) => { const origin = request.headers.origin; if (origin && !originAllowed(request, allowedOrigins)) return response.status(403).end(); if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); response.setHeader('Access-Control-Allow-Headers', 'content-type,x-room-token,x-asset-id,authorization'); response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); } if (request.method === 'OPTIONS') return response.status(204).end(); next(); });
  app.post('/api/rooms/:roomId/assets', express.raw({ type: () => true, limit: '6mb' }), (request, response) => {
    const access = tokenFor(request, request.params.roomId); const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0); const mimeType = request.header('content-type')?.split(';', 1)[0]?.toLowerCase() ?? ''; const assetId = request.header('x-asset-id') ?? '';
    if (!access) return response.status(401).json({ error: 'A valid room participant token is required.' });
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) || !/^[a-zA-Z0-9_-]{1,80}$/.test(assetId)) return response.status(400).json({ error: 'Use a PNG, JPEG, or WebP asset with a valid ID.' });
    if (body.length < 1 || body.length > limits.assetPerImageBytes || totalAssetBytes + body.length > limits.totalAssetBytes || [...access.room.assets.values()].reduce((sum, asset) => sum + asset.bytes.length, 0) + body.length > limits.assetsPerRoomBytes) return response.status(413).json({ error: 'Asset storage limit exceeded.' });
    if (access.room.assets.has(assetId)) return response.status(409).json({ error: 'Asset ID was already used.' });
    const dimensions = mediaDimensions(body, mimeType); if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 4096 || dimensions.height > 4096 || dimensions.width * dimensions.height > 16 * 1024 * 1024) return response.status(400).json({ error: 'Image signature or dimensions are invalid.' });
    const meta: AssetMeta = { id: assetId, mimeType: mimeType as AssetMeta['mimeType'], width: dimensions.width, height: dimensions.height, byteLength: body.length }; access.room.assets.set(assetId, { meta, bytes: body }); totalAssetBytes += body.length; notifyAsset(access.room, meta); schedulePersistence(); return response.status(201).json(meta);
  });
  app.get('/api/rooms/:roomId/assets/:assetId', (request, response) => { const access = tokenFor(request, request.params.roomId); if (!access) return response.status(401).json({ error: 'A valid room participant token is required.' }); const asset = access.room.assets.get(request.params.assetId); if (!asset) return response.status(404).json({ error: 'Asset unavailable.' }); response.type(asset.meta.mimeType).send(asset.bytes); });
  app.use(express.static(options.staticDir ?? resolve(process.cwd(), 'dist/client'), { maxAge: 0 }));
  const httpServer = createServer(app);
  const io = new Server<ClientEvents, ServerEvents>(httpServer, {
    transports: ['websocket'], maxHttpBufferSize: 16 * 1024, perMessageDeflate: false,
    allowRequest: (request, callback) => callback(null, !closing && io.engine.clientsCount < limits.connections && originAllowed(request, allowedOrigins)),
    pingInterval: 15000, pingTimeout: 10000,
  });
  notifyAsset = (room, asset) => { io.to(`canvas:${room.id}`).emit('asset:update', structuredClone(asset)); };
  app.post('/api/rooms/:roomId/restore', express.json({ limit: '32mb', strict: true }), (request, response) => {
    const access = tokenFor(request, request.params.roomId);
    const payload = request.body as Record<string, unknown>;
    if (!access || !access.room.managed || access.room.hostSocketId !== access.socketId || !record(payload) || payload.capability !== access.room.hostCapability) return response.status(401).json(fail('Only the current host can restore this session.'));
    const result = restoreHostDocument(access.room, payload.document, payload.sourceEpoch, payload.sourceRevision);
    return response.status(result.ok ? 200 : 409).json(result);
  });
  function snapshot(room: Room, selfId: string): Snapshot {
    const assetToken = [...assetTokens.entries()].find(([, owner]) => owner.roomId === room.id && owner.socketId === selfId)?.[0];
    const isHost = room.hostSocketId === selfId;
    return { protocolVersion: 2, epoch: room.epoch, revision: room.revision, roomId: room.id, selfId, strokes: [...room.strokes.values()], redoIds: [...room.redoIds], users: [...room.users.values()], document: structuredClone(room.document), ...(room.documentMode ? { documentHistory: structuredClone(room.documentHistory) } : {}), roomStatus: room.status, hostWatermark: room.hostWatermark, host: isHost, hostCapability: isHost ? room.hostCapability : undefined, assets: [...room.assets.values()].map(entry => entry.meta), assetToken };
  }
  function announceStatus(room: Room, message?: string): void { io.to(`canvas:${room.id}`).emit('room:status', { status: room.status, message }); }
  function armHostSaveDeadline(room: Room): void {
    clearTimeout(room.hostLagTimer); room.hostLagTimer = undefined;
    if (!room.managed || room.status !== 'active' || !room.hostSocketId || !room.hostWatermark || room.hostWatermark.revision >= room.revision) return;
    room.hostLagTimer = setTimeout(() => { if (rooms.get(room.id) === room && room.status === 'active' && room.hostWatermark && room.hostWatermark.revision < room.revision) { room.status = 'paused'; announceStatus(room, 'Host save is behind the shared canvas. Editing is paused until it catches up.'); } }, 30_000);
    room.hostLagTimer.unref();
  }
  function removeRoom(room: Room): void {
    if (rooms.get(room.id) !== room) return;
    clearTimeout(room.expires); clearTimeout(room.hostGrace); clearTimeout(room.hostLagTimer);
    totalPoints -= room.points;
    for (const asset of room.assets.values()) totalAssetBytes -= asset.bytes.length;
    for (const [token, owner] of assetTokens) if (owner.roomId === room.id) assetTokens.delete(token);
    rooms.delete(room.id);
    if (room.managed && room.status === 'ended') { endedManagedRooms.add(room.id); while (endedManagedRooms.size > 4096) endedManagedRooms.delete(endedManagedRooms.values().next().value!); }
    schedulePersistence();
  }
  function syncLegacyDocument(room: Room): void {
    if (room.documentMode) return;
    const legacy = legacyStrokesToDocument([...room.strokes.values()].filter(stroke => stroke.completed && stroke.active && !room.hiddenInkIds.has(stroke.id)), room.document.id, room.document.title);
    const nonInk = room.document.objects.filter(object => object.type !== 'ink');
    const priorInk = new Map(room.document.objects.filter((object): object is Extract<CanvasObject, { type: 'ink' }> => object.type === 'ink').map(object => [object.id, object]));
    const ink = legacy.objects.map(object => {
      if (object.type !== 'ink') return object;
      const prior = priorInk.get(object.id);
      if (!prior || (prior.translation.x === 0 && prior.translation.y === 0)) return object;
      return { ...object, translation: prior.translation, points: object.points.map(point => ({ x: point.x - prior.translation.x, y: point.y - prior.translation.y })) };
    });
    room.document = { ...legacy, assetIds: [...room.document.assetIds], objects: [...nonInk, ...ink].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) };
  }
  function transactionForStroke(room: Room, stroke: Stroke): Transaction | undefined {
    const object = room.document.objects.find(candidate => candidate.id === stroke.id && candidate.type === 'ink');
    if (!object || !stroke.completed) return undefined;
    return { id: randomUUID(), authorId: stroke.userId, kind: 'create', patches: [{ id: object.id, before: null, after: structuredClone(object) }], timestamp: Date.now() };
  }
  function enterDocumentMode(room: Room): void {
    if (room.documentMode) return;
    room.documentMode = true;
    const undo = [...room.strokes.values()].filter(stroke => stroke.completed && stroke.active).map(stroke => transactionForStroke(room, stroke)).filter((transaction): transaction is Transaction => !!transaction);
    room.documentHistory = { undo, redo: [] }; room.redoIds = [];
  }
  function syncStrokeFromPatch(room: Room, patch: { id: string; before: CanvasObject | null; after: CanvasObject | null }, direction: 'before' | 'after'): void {
    const next = patch[direction];
    if (next?.type === 'ink') {
      room.hiddenInkIds.delete(next.id);
      room.strokes.set(next.id, { id: next.id, userId: next.userId, tool: next.tool, color: next.color, width: next.width, points: next.points.map(point => ({ x: point.x + next.translation.x, y: point.y + next.translation.y })), order: next.order, completed: next.completed, completionOrder: next.completionOrder, active: next.active });
    } else if (patch.before?.type === 'ink' || patch.after?.type === 'ink') {
      room.hiddenInkIds.add(patch.id);
      const stroke = room.strokes.get(patch.id); if (stroke) room.strokes.set(patch.id, { ...stroke, active: false });
    }
  }
  function syncStrokesAfterDocumentHistory(room: Room, transaction: Transaction, direction: 'before' | 'after'): void {
    for (const patch of transaction.patches) syncStrokeFromPatch(room, patch, direction);
    room.redoIds = room.documentHistory.redo.flatMap(item => item.patches.map(patch => patch.id));
    syncLegacyDocument(room);
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
    armHostSaveDeadline(room);
    protectSlowPeers(room);
    schedulePersistence();
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
    syncLegacyDocument(room);
    publish(room, { type: 'stroke:cancel', id });
  }
  function publishDocument(room: Room, result: ReturnType<typeof applyDocumentCommand>): void {
    if (!result.transaction) return;
    room.revision++;
    io.to(`canvas:${room.id}`).emit('drawing:event', { epoch: room.epoch, revision: room.revision, change: { type: 'document:transaction', transaction: result.transaction, document: result.document, history: result.history } });
    armHostSaveDeadline(room);
    protectSlowPeers(room);
    schedulePersistence();
  }
  function restoreHostDocument(room: Room, input: unknown, sourceEpoch?: unknown, sourceRevision?: unknown): Result {
    const validation = validateDocument(input);
    if (!validation.ok) return fail(validation.error ?? 'The host document is invalid.');
    if (sourceEpoch !== undefined && sourceEpoch !== null && typeof sourceEpoch !== 'string') return fail('The host recovery epoch is invalid.');
    if (sourceRevision !== undefined && (!Number.isSafeInteger(sourceRevision) || (sourceRevision as number) < 0)) return fail('The host recovery revision is invalid.');
    const document = structuredClone(input) as CanvasDocument;
    if (document.assetIds.some(assetId => !room.assets.has(assetId))) return fail('The host document references an asset that was not uploaded.');
    let strokes: Stroke[];
    try { strokes = documentToLegacyStrokes(document); } catch (error) { return fail(error instanceof Error ? error.message : 'The host document is invalid.'); }
    const points = strokes.reduce((total, stroke) => total + stroke.points.length, 0);
    if (points > limits.pointsPerRoom || totalPoints - room.points + points > limits.totalPoints) return fail('The host document exceeds the room point limit.');
    if (sourceEpoch === room.epoch && typeof sourceRevision === 'number' && sourceRevision < room.revision && JSON.stringify(document) !== JSON.stringify(room.document)) return fail('The shared canvas is newer than this saved recovery. Refresh and retry.');
    const changed = JSON.stringify(document) !== JSON.stringify(room.document);
    if (changed) {
      totalPoints += points - room.points;
      room.points = points;
      room.strokes = new Map(strokes.map(stroke => [stroke.id, stroke]));
      room.usedIds = new Set(strokes.map(stroke => stroke.id));
      room.hiddenInkIds.clear(); room.unfinished.clear(); room.redoIds = [];
      room.nextOrder = Math.max(0, ...document.objects.map(object => object.order));
      room.nextCompletion = Math.max(0, ...strokes.map(stroke => stroke.completionOrder ?? 0));
      room.document = document; room.documentHistory = createHistory(); room.documentMode = true;
      room.revision++;
    }
    room.status = 'active'; room.hostWatermark = { epoch: room.epoch, revision: room.revision };
    schedulePersistence();
    announceStatus(room, 'The host restored the saved canvas. Editing is active.');
    for (const participant of room.users.keys()) io.sockets.sockets.get(participant)?.emit('room:snapshot', snapshot(room, participant));
    io.to(`canvas:${room.id}`).emit('room:host-save', room.hostWatermark);
    return ok;
  }
  function currentLeases(room: Room): Array<{ objectId: string; userId: string }> {
    const now = Date.now();
    for (const [objectId, lease] of room.leases) if (lease.expiresAt <= now) room.leases.delete(objectId);
    return [...room.leases.entries()].map(([objectId, lease]) => ({ objectId, userId: lease.userId }));
  }
  function publishLeases(room: Room): void { io.to(`canvas:${room.id}`).emit('lease:update', currentLeases(room)); }
  function releaseLeases(room: Room, userId: string): void { let changed = false; for (const [objectId, lease] of room.leases) if (lease.userId === userId) { room.leases.delete(objectId); changed = true; } if (changed) publishLeases(room); }
  function leave(socket: Peer, room: Room) {
    const wasHost = room.hostSocketId === socket.id;
    revokeAssetTokens(socket.id);
    room.users.delete(socket.id);
    if (wasHost && room.managed && room.hostSocketId === socket.id) {
      room.hostSocketId = null;
      room.status = 'paused';
      announceStatus(room, 'The host disconnected. Editing is paused while the host reconnects.');
      clearTimeout(room.hostGrace);
      room.hostGrace = setTimeout(() => {
        if (rooms.get(room.id) !== room || room.status !== 'paused') return;
        room.status = 'ended';
        announceStatus(room, 'The host recovery window expired. This session has ended.');
        removeRoom(room);
      }, limits.hostGraceMs);
      room.hostGrace.unref();
      schedulePersistence();
    }
    socket.leave(`canvas:${room.id}`);
    cancel(room, socket.id);
    io.to(`canvas:${room.id}`).emit('cursor:update', { userId: socket.id, point: null });
    io.to(`canvas:${room.id}`).emit('presence:update', [...room.users.values()]);
    if (!room.users.size && !closing) {
      clearTimeout(room.expires);
      room.expires = setTimeout(() => {
        if (!room.users.size && rooms.get(room.id) === room) {
          removeRoom(room);
          delete room.expires;
        }
      }, limits.idleRoomMs);
      room.expires.unref();
    }
  }
  function apply(room: Room, userId: string, cmd: Command): Result {
    if (room.managed && room.status !== 'active') return fail(room.status === 'ended' ? 'This session has ended.' : 'The host is offline. Editing is paused until they reconnect.');
    const operationId = 'operationId' in cmd && typeof cmd.operationId === 'string' ? cmd.operationId : undefined;
    const fingerprint = operationId ? canonicalize(cmd) : undefined;
    if (operationId) {
      const prior = room.operationResults.get(operationId);
      if (prior) return prior.fingerprint === fingerprint ? prior.result : fail('operation ID was already used for a different command body.');
    }
    const remember = (result: Result) => { if (operationId && fingerprint && result.ok) { room.operationResults.set(operationId, { fingerprint, result }); while (room.operationResults.size > limits.operationResultsPerRoom) room.operationResults.delete(room.operationResults.keys().next().value!); } return result; };
    if (cmd.type === 'object:lease') {
      currentLeases(room);
      if (new Set(cmd.ids).size !== cmd.ids.length) return fail('Lease selection contains duplicate object IDs.');
      if (cmd.action === 'acquire') {
        if (cmd.ids.some(id => !room.document.objects.some(object => object.id === id))) return fail('One or more selected objects is missing. Refresh and retry.');
        if (cmd.ids.some(id => { const lease = room.leases.get(id); return lease && (lease.userId !== userId || lease.leaseId !== cmd.leaseId); })) return fail('One or more selected objects is being edited by someone else.');
        for (const id of cmd.ids) room.leases.set(id, { leaseId: cmd.leaseId, userId, expiresAt: Date.now() + 15_000 });
      } else if (cmd.action === 'renew') {
        if (cmd.ids.some(id => { const lease = room.leases.get(id); return !lease || lease.leaseId !== cmd.leaseId || lease.userId !== userId; })) return fail('Edit lease expired. Refresh and retry.');
        for (const id of cmd.ids) room.leases.get(id)!.expiresAt = Date.now() + 15_000;
      } else {
        for (const id of cmd.ids) { const lease = room.leases.get(id); if (lease?.leaseId === cmd.leaseId && lease.userId === userId) room.leases.delete(id); }
      }
      publishLeases(room); return ok;
    }
    if (cmd.type.startsWith('object:')) {
      if (cmd.type === 'object:create' && cmd.object.type === 'ink') return fail('Network ink creation is not supported. Use streamed stroke commands.');
      const ids = cmd.type === 'object:create' ? [] : cmd.type === 'object:move' || cmd.type === 'object:delete' ? cmd.ids : cmd.type === 'object:resize' || cmd.type === 'object:text' ? [cmd.id] : [];
      const leaseId = 'leaseId' in cmd ? cmd.leaseId : undefined;
      currentLeases(room);
      if (ids.some(id => { const lease = room.leases.get(id); return lease && (lease.userId !== userId || (leaseId && lease.leaseId !== leaseId)); })) return fail('One or more selected objects is being edited. Retry after it is released.');
      if (leaseId && ids.some(id => room.leases.get(id)?.leaseId !== leaseId || room.leases.get(id)?.userId !== userId)) return fail('Edit lease expired. Refresh and retry.');
      if (cmd.type === 'object:create' && room.document.objects.length >= 10_000) return fail('Document object limit reached.');
      if (cmd.type === 'object:create' && cmd.object.type === 'image' && !room.assets.has(cmd.object.assetId)) return fail('Upload the image before committing it to the canvas.');
      const wasDocumentMode = room.documentMode;
      const previousHistory = room.documentHistory;
      const previousRedoIds = room.redoIds;
      enterDocumentMode(room);
      try {
        let documentCommand: DocumentCommand = cmd as DocumentCommand;
        let nextDocument = room.document;
        let nextOrder = room.nextOrder;
        if (cmd.type === 'object:create') {
          if (cmd.object.type === 'image') {
            if (!nextDocument.assetIds.includes(cmd.object.assetId)) nextDocument = { ...nextDocument, assetIds: [...nextDocument.assetIds, cmd.object.assetId] };
          }
          nextOrder++;
          documentCommand = { ...cmd, object: { ...cmd.object, order: nextOrder, version: 1, ...(cmd.object.type === 'ink' ? { userId } : {}) } };
        }
        const result = applyDocumentCommand(nextDocument, room.documentHistory, documentCommand, userId);
        room.document = result.document; room.documentHistory = result.history; room.nextOrder = nextOrder;
        if (result.transaction) syncStrokesAfterDocumentHistory(room, result.transaction, 'after');
        publishDocument(room, { document: room.document, history: room.documentHistory, transaction: result.transaction });
        return remember(ok);
      } catch (error) {
        if (!wasDocumentMode) { room.documentMode = false; room.documentHistory = previousHistory; room.redoIds = previousRedoIds; }
        return fail(error instanceof Error ? error.message : 'Document command was rejected.');
      }
    }
    if (cmd.type === 'stroke:begin') {
      if (room.usedIds.has(cmd.id) || room.document.objects.some(object => object.id === cmd.id)) return fail('Stroke ID was already used.');
      if (room.unfinished.has(userId)) return fail('Finish or cancel your current stroke first.');
      if (room.strokes.size >= limits.strokesPerRoom || room.usedIds.size >= limits.usedIdsPerRoom || room.points >= limits.pointsPerRoom || totalPoints >= limits.totalPoints) return fail('Canvas capacity reached. Try a new room.');
      const stroke: Stroke = { id: cmd.id, userId, tool: cmd.tool, color: cmd.color, width: cmd.width, points: [cmd.point], order: ++room.nextOrder, completed: false, completionOrder: null, active: true };
      room.strokes.set(cmd.id, stroke); room.usedIds.add(cmd.id); room.unfinished.set(userId, cmd.id);
      room.points++; totalPoints++;
      syncLegacyDocument(room);
      publish(room, { type: 'stroke:begin', stroke });
      return remember(ok);
    }
    if ((cmd.type === 'history:undo' || cmd.type === 'history:redo') && currentLeases(room).some(lease => lease.userId !== userId)) return fail('Shared history is unavailable while another participant is editing.');
    if (cmd.type === 'history:undo') {
      if (room.documentMode && room.documentHistory.undo.length) {
        const transaction = room.documentHistory.undo.at(-1)!;
        try {
          const result = applyDocumentCommand(room.document, room.documentHistory, cmd, userId);
          room.document = result.document; room.documentHistory = result.history;
          syncStrokesAfterDocumentHistory(room, transaction, 'before');
          publishDocument(room, { document: room.document, history: room.documentHistory, transaction: result.transaction });
          return remember(ok);
        } catch (error) {
          return fail(error instanceof Error ? error.message : 'Undo was rejected. Refresh and retry.');
        }
      }
      let latest: Stroke | undefined;
      for (const stroke of room.strokes.values()) if (stroke.active && stroke.completed && (!latest || stroke.completionOrder! > latest.completionOrder!)) latest = stroke;
      if (latest) { latest.active = false; room.redoIds.push(latest.id); syncLegacyDocument(room); publish(room, { type: 'history:undo', id: latest.id }); }
      return remember(ok);
    }
    if (cmd.type === 'history:redo') {
      if (room.documentMode && room.documentHistory.redo.length) {
        const transaction = room.documentHistory.redo.at(-1)!;
        try {
          const result = applyDocumentCommand(room.document, room.documentHistory, cmd, userId);
          room.document = result.document; room.documentHistory = result.history;
          syncStrokesAfterDocumentHistory(room, transaction, 'after');
          publishDocument(room, { document: room.document, history: room.documentHistory, transaction: result.transaction });
          return remember(ok);
        } catch (error) {
          return fail(error instanceof Error ? error.message : 'Redo was rejected. Refresh and retry.');
        }
      }
      const id = room.redoIds.pop();
      if (id) { room.strokes.get(id)!.active = true; syncLegacyDocument(room); publish(room, { type: 'history:redo', id }); }
      return remember(ok);
    }
    if (!cmd.type.startsWith('stroke:')) return fail('This document command is not available in the legacy room.');
    const strokeCommand = cmd as StrokeCommand;
    const stroke = room.strokes.get(strokeCommand.id);
    if (!stroke || stroke.userId !== userId) return fail('Stroke is missing or belongs to another user.');
    if (strokeCommand.type === 'stroke:points') {
      if (strokeCommand.offset < stroke.points.length) {
        const exact = strokeCommand.offset + strokeCommand.points.length <= stroke.points.length && strokeCommand.points.every((p, index) => { const prior = stroke.points[strokeCommand.offset + index]!; return prior.x === p.x && prior.y === p.y; });
        return exact ? remember(ok) : fail('Point batch conflicts with accepted points.');
      }
      if (stroke.completed) return fail('Stroke has already finished.');
      if (strokeCommand.offset !== stroke.points.length) return fail('Point batch is out of order. Resync the room.');
      if (stroke.points.length + strokeCommand.points.length > limits.pointsPerStroke || room.points + strokeCommand.points.length > limits.pointsPerRoom || totalPoints + strokeCommand.points.length > limits.totalPoints) return fail('Point capacity reached. Finish this stroke.');
      stroke.points.push(...strokeCommand.points); room.points += strokeCommand.points.length; totalPoints += strokeCommand.points.length;
      syncLegacyDocument(room);
      publish(room, { type: 'stroke:points', id: strokeCommand.id, offset: strokeCommand.offset, points: strokeCommand.points });
      return remember(ok);
    }
    if (strokeCommand.type === 'stroke:end') {
      if (stroke.completed) return remember(ok);
      stroke.completed = true; stroke.completionOrder = ++room.nextCompletion;
      room.unfinished.delete(userId);
      for (const id of room.redoIds) discard(room, id);
      room.redoIds = [];
      if (room.documentMode) {
        const object = legacyStrokesToDocument([stroke], room.document.id, room.document.title).objects[0];
        if (!object || object.type !== 'ink') return fail('Completed stroke could not be committed.');
        try {
          const result = applyDocumentCommand(room.document, room.documentHistory, { type: 'object:create', object }, userId);
          room.document = result.document; room.documentHistory = result.history;
          if (result.transaction) syncStrokesAfterDocumentHistory(room, result.transaction, 'after');
          publishDocument(room, result);
        } catch (error) {
          stroke.completed = false; stroke.completionOrder = null; room.unfinished.set(userId, stroke.id);
          return fail(error instanceof Error ? error.message : 'Completed stroke could not be committed.');
        }
      } else {
        syncLegacyDocument(room);
        publish(room, { type: 'stroke:end', id: strokeCommand.id, completionOrder: stroke.completionOrder });
      }
      return remember(ok);
    }
    if (stroke.completed) return fail('Completed strokes cannot be cancelled.');
    cancel(room, userId);
    return remember(ok);
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
      if (!room || rooms.get(room.id) !== room) return;
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
      if (room && rooms.get(room.id) !== room) room = undefined;
      if (!token()) { reply(fail('Too many requests.')); return; }
      if (!record(request)) { reply(fail('Invalid room request.')); return; }
      const roomId = request.roomId ?? DEFAULT_ROOM;
      const name = request.name ?? 'Guest';
      const wantsHost = request.host === true;
      const suppliedCapability = typeof request.hostCapability === 'string' ? request.hostCapability : undefined;
      if (request.protocolVersion !== undefined && request.protocolVersion !== PROTOCOL_VERSION) { reply(fail('This session requires a newer Group Canvas client.')); return; }
      if (typeof roomId !== 'string' || !ROOM_ID.test(roomId) || typeof name !== 'string' || name.trim().length < 1 || name.length > 32 || /[\u0000-\u001f\u007f]/.test(name) || (request.protocolVersion !== undefined && !Number.isSafeInteger(request.protocolVersion)) || (request.host !== undefined && typeof request.host !== 'boolean') || (request.hostCapability !== undefined && (typeof request.hostCapability !== 'string' || !ID.test(request.hostCapability))) || Object.keys(request).some(key => !['roomId', 'name', 'protocolVersion', 'host', 'hostCapability'].includes(key))) { reply(fail('Use a room ID of 1–48 letters, numbers, hyphens or underscores and a name of 1–32 characters.')); return; }
      if (room?.id === roomId) { sendSnapshot(); reply(ok); return; }
      if (Date.now() - lastJoin < 500) { reply(fail('Wait before switching rooms.')); return; }
      let next = rooms.get(roomId);
      if (!next && endedManagedRooms.has(roomId)) { reply(fail('This session has ended.')); return; }
      if (next && !next.managed && wantsHost) { reply(fail('This room was created as a guest-only shared link. Start a new host session.')); return; }
      if (next?.managed && wantsHost && suppliedCapability !== next.hostCapability) { reply(fail('The host capability is invalid or expired.')); return; }
      if (next?.managed && wantsHost && next.hostSocketId && next.hostSocketId !== socket.id) { reply(fail('This session already has a connected host.')); return; }
      if (next?.managed && !wantsHost && next.status === 'ended') { reply(fail('This session has ended.')); return; }
      if ((!next && rooms.size >= limits.rooms) || (next && next.users.size >= limits.usersPerRoom && next.hostSocketId !== socket.id)) { reply(fail('This room or server is full.')); return; }
      if (!next) {
        next = { id: roomId, epoch: randomUUID(), revision: 0, nextOrder: 0, nextCompletion: 0, strokes: new Map(), usedIds: new Set(), users: new Map(), unfinished: new Map(), redoIds: [], points: 0, document: createDocument(randomUUID(), roomId), documentHistory: createHistory(), operationResults: new Map(), leases: new Map(), assets: new Map(), hiddenInkIds: new Set(), managed: wantsHost, hostSocketId: null, hostCapability: randomUUID(), status: 'active', hostWatermark: null, documentMode: true };
        rooms.set(roomId, next);
        schedulePersistence();
      }
      if (room) { releaseLeases(room, socket.id); leave(socket, room); }
      clearTimeout(next.expires); delete next.expires;
      room = next; lastJoin = Date.now(); lastSnapshot = 0;
      if (room.managed && wantsHost) { clearTimeout(room.hostGrace); delete room.hostGrace; room.hostSocketId = socket.id; room.status = 'paused'; room.hostWatermark = room.hostWatermark ?? { epoch: room.epoch, revision: room.revision }; }
      room.users.set(socket.id, { id: socket.id, name: name.trim(), color: COLORS[room.users.size % COLORS.length]! });
      issueAssetToken(room, socket.id);
      socket.join(`canvas:${room.id}`);
      sendSnapshot();
      io.to(`canvas:${room.id}`).emit('presence:update', [...room.users.values()]);
      if (room.managed && wantsHost) announceStatus(room, 'The host is connected. Restoring the saved canvas…');
      reply(ok);
    });
    socket.on('command', (value: unknown, ack) => {
      let result: Result;
      if (!token()) result = fail('Drawing rate limit exceeded. Please slow down.');
      else if (!room) result = fail('Join a room before drawing.');
      else if (!validCommand(value)) result = fail('Invalid drawing command.');
      else result = apply(room, socket.id, value);
      if (typeof ack === 'function') ack(result);
      else if (!result.ok) socket.emit('server:error', result.error);
    });
    socket.on('room:resync', () => { if (token()) sendSnapshot(); });
    socket.on('room:host-saved', payload => {
      if (!room || !room.managed || room.status !== 'active' || room.hostSocketId !== socket.id || !record(payload) || payload.capability !== room.hostCapability || payload.epoch !== room.epoch || !Number.isSafeInteger(payload.revision) || payload.revision < 0 || payload.revision > room.revision) { socket.emit('server:error', 'The host save watermark was rejected.'); return; }
      room.hostWatermark = { epoch: payload.epoch, revision: payload.revision }; armHostSaveDeadline(room);
      schedulePersistence();
      io.to(`canvas:${room.id}`).emit('room:host-save', room.hostWatermark);
    });
    socket.on('room:end', (payload, ack) => {
      const reply = (result: Result) => { if (typeof ack === 'function') ack(result); };
      if (!room || !room.managed || room.status !== 'active' || room.hostSocketId !== socket.id || !record(payload) || payload.capability !== room.hostCapability) { reply(fail('Restore the saved canvas before ending this session.')); return; }
      if (!room.hostWatermark || room.hostWatermark.epoch !== room.epoch || room.hostWatermark.revision < room.revision) { reply(fail('Save the latest canvas before ending the session.')); return; }
      room.status = 'ended'; room.hostSocketId = null; announceStatus(room, 'The host ended this session.'); removeRoom(room); reply(ok);
    });
    socket.on('latency:ping', (ack: unknown) => { if (typeof ack === 'function') ack(); });
    socket.on('cursor:update', (value: unknown) => {
      if (!room || (value !== null && !pointWithinWorld(value)) || Date.now() - lastCursor < 30 || !token()) return;
      lastCursor = Date.now();
      io.to(`canvas:${room.id}`).volatile.emit('cursor:update', { userId: socket.id, point: value });
    });
    socket.on('disconnect', () => {
      clearTimeout(snapshotTimer); outbound.delete(socket.id);
    if (room) { const prior = room; room = undefined; releaseLeases(prior, socket.id); leave(socket, prior); }
    });
  });
  await restorePersistence();
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
      if (persistenceTimer) { clearTimeout(persistenceTimer); persistenceTimer = undefined; }
      await persistNow();
      closing = true;
      for (const entry of rooms.values()) clearTimeout(entry.expires);
      await new Promise<void>(resolveClose => io.close(() => resolveClose()));
      rooms.clear();
      endedManagedRooms.clear();
      assetTokens.clear();
      totalAssetBytes = 0;
    },
  };
}
