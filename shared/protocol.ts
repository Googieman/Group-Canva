import type { CanvasDocument, DocumentCommand, DocumentHistory, LeaseCommand } from './document.js';

export const BOARD_WIDTH = 1600;
export const BOARD_HEIGHT = 900;
export const PROTOCOL_VERSION = 2;
export const BATCH_SIZE = 64;
export const BATCH_INTERVAL = 20;
export const DEFAULT_ROOM = 'playground';
export type Tool = 'brush' | 'eraser';
export interface Point { x: number; y: number }
export interface User { id: string; name: string; color: string }
export interface Stroke {
  id: string; userId: string; tool: Tool; color: string; width: number;
  points: Point[]; order: number; completed: boolean; completionOrder: number | null;
  active: boolean;
}
export interface Snapshot {
  protocolVersion?: number; epoch: string; revision: number; roomId: string; selfId: string;
  strokes: Stroke[]; redoIds: string[]; users: User[];
  document?: CanvasDocument;
  documentHistory?: DocumentHistory;
  hostWatermark?: { epoch: string; revision: number } | null;
  roomStatus?: 'active' | 'paused' | 'ended';
  host?: boolean;
  hostCapability?: string;
  assets?: AssetMeta[];
  assetToken?: string;
}
export interface AssetMeta { id: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number; byteLength: number }
export type StrokeCommand =
  | { type: 'stroke:begin'; id: string; tool: Tool; color: string; width: number; point: Point; operationId?: string }
  | { type: 'stroke:points'; id: string; offset: number; points: Point[]; operationId?: string }
  | { type: 'stroke:end'; id: string; operationId?: string }
  | { type: 'stroke:cancel'; id: string; operationId?: string };
export type Command = StrokeCommand | DocumentCommand | LeaseCommand;
export type Change =
  | { type: 'stroke:begin'; stroke: Stroke }
  | { type: 'stroke:points'; id: string; offset: number; points: Point[] }
  | { type: 'stroke:end'; id: string; completionOrder: number }
  | { type: 'stroke:cancel'; id: string }
  | { type: 'history:undo'; id: string }
  | { type: 'history:redo'; id: string }
  | { type: 'document:transaction'; transaction: NonNullable<import('./document.js').DocumentCommandResult['transaction']>; document: CanvasDocument; history?: DocumentHistory };
export interface DrawingEvent { epoch: string; revision: number; change: Change }
export interface Cursor { userId: string; point: Point | null }
export interface JoinRequest { roomId: string; name: string; protocolVersion?: number; host?: boolean; hostCapability?: string }
export type Result = { ok: true } | { ok: false; error: string };
export interface ServerEvents {
  'room:snapshot': (snapshot: Snapshot) => void;
  'drawing:event': (event: DrawingEvent) => void;
  'presence:update': (users: User[]) => void;
  'cursor:update': (cursor: Cursor) => void;
  'server:error': (message: string) => void;
  'room:status': (status: { status: 'active' | 'paused' | 'ended'; message?: string }) => void;
  'room:host-save': (watermark: { epoch: string; revision: number } | null) => void;
  'lease:update': (leases: Array<{ objectId: string; userId: string }>) => void;
}
export interface ClientEvents {
  'room:join': (request: JoinRequest, ack: (result: Result) => void) => void;
  'room:resync': () => void;
  command: (command: Command, ack: (result: Result) => void) => void;
  'cursor:update': (point: Point | null) => void;
  'latency:ping': (ack: () => void) => void;
  'room:host-restore': (payload: { capability: string; document: CanvasDocument }, ack: (result: Result) => void) => void;
  'room:host-saved': (payload: { capability: string; epoch: string; revision: number }) => void;
  'room:end': (payload: { capability: string }, ack: (result: Result) => void) => void;
}
