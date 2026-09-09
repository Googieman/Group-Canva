export const BOARD_WIDTH = 1600;
export const BOARD_HEIGHT = 900;
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
  epoch: string; revision: number; roomId: string; selfId: string;
  strokes: Stroke[]; redoIds: string[]; users: User[];
}
export type Command =
  | { type: 'stroke:begin'; id: string; tool: Tool; color: string; width: number; point: Point }
  | { type: 'stroke:points'; id: string; offset: number; points: Point[] }
  | { type: 'stroke:end'; id: string }
  | { type: 'stroke:cancel'; id: string }
  | { type: 'history:undo' }
  | { type: 'history:redo' };
export type Change =
  | { type: 'stroke:begin'; stroke: Stroke }
  | { type: 'stroke:points'; id: string; offset: number; points: Point[] }
  | { type: 'stroke:end'; id: string; completionOrder: number }
  | { type: 'stroke:cancel'; id: string }
  | { type: 'history:undo'; id: string }
  | { type: 'history:redo'; id: string };
export interface DrawingEvent { epoch: string; revision: number; change: Change }
export interface Cursor { userId: string; point: Point | null }
export interface JoinRequest { roomId: string; name: string }
export type Result = { ok: true } | { ok: false; error: string };
export interface ServerEvents {
  'room:snapshot': (snapshot: Snapshot) => void;
  'drawing:event': (event: DrawingEvent) => void;
  'presence:update': (users: User[]) => void;
  'cursor:update': (cursor: Cursor) => void;
  'server:error': (message: string) => void;
}
export interface ClientEvents {
  'room:join': (request: JoinRequest, ack: (result: Result) => void) => void;
  'room:resync': () => void;
  command: (command: Command, ack: (result: Result) => void) => void;
  'cursor:update': (point: Point | null) => void;
}
