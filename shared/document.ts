import type { Point, Stroke } from './protocol.js';

export const DOCUMENT_SCHEMA_VERSION = 1 as const;
export const WORLD_LIMIT = 100_000;
export const MAX_DOCUMENT_OBJECTS = 10_000;
export const MAX_TEXT_LENGTH = 100_000;
export const MAX_ASSET_IDS = 10_000;

export type InkTool = 'brush' | 'eraser';
export type ShapeKind = 'rectangle' | 'ellipse' | 'line' | 'arrow';

export interface ObjectBase {
  id: string;
  type: 'ink' | 'shape' | 'text' | 'image';
  order: number;
  version: number;
  translation: Point;
}

export interface InkObject extends ObjectBase {
  type: 'ink';
  userId: string;
  tool: InkTool;
  color: string;
  width: number;
  points: Point[];
  completed: boolean;
  completionOrder: number | null;
  active: boolean;
}

export interface ShapeObject extends ObjectBase {
  type: 'shape';
  shape: ShapeKind;
  width: number;
  height: number;
  /** Line and arrow endpoints in local coordinates; omitted for legacy documents. */
  start?: Point;
  end?: Point;
  strokeColor: string;
  strokeWidth: number;
  fill: string | null;
}

export interface TextObject extends ObjectBase {
  type: 'text';
  text: string;
  width: number;
  fontSize: number;
  color: string;
  lineHeight: number;
}

export interface ImageObject extends ObjectBase {
  type: 'image';
  assetId: string;
  intrinsicWidth: number;
  intrinsicHeight: number;
  width: number;
  height: number;
}

export type CanvasObject = InkObject | ShapeObject | TextObject | ImageObject;

export interface CanvasDocument {
  schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
  id: string;
  title: string;
  objects: CanvasObject[];
  assetIds: string[];
}

export interface ObjectPatch {
  id: string;
  before: CanvasObject | null;
  after: CanvasObject | null;
}

export interface Transaction {
  id: string;
  authorId: string;
  kind: 'create' | 'move' | 'resize' | 'text' | 'delete';
  patches: ObjectPatch[];
  timestamp: number;
}

export interface DocumentHistory {
  undo: Transaction[];
  redo: Transaction[];
}

export type DocumentCommand =
  | { type: 'object:create'; object: CanvasObject; operationId?: string }
  | { type: 'object:move'; ids: string[]; delta: Point; expectedVersions: Record<string, number>; leaseId?: string; operationId?: string }
  | { type: 'object:resize'; id: string; width: number; height: number; expectedVersion: number; preserveAspectRatio?: boolean; leaseId?: string; operationId?: string }
  | { type: 'object:text'; id: string; text: string; expectedVersion: number; leaseId?: string; operationId?: string }
  | { type: 'object:delete'; ids: string[]; expectedVersions: Record<string, number>; leaseId?: string; operationId?: string }
  | { type: 'history:undo'; expectedVersions?: Record<string, number>; operationId?: string }
  | { type: 'history:redo'; expectedVersions?: Record<string, number>; operationId?: string };

export interface LeaseCommand {
  type: 'object:lease'; ids: string[]; leaseId: string; action: 'acquire' | 'renew' | 'release';
}

export interface DocumentCommandResult {
  document: CanvasDocument;
  history: DocumentHistory;
  transaction?: Transaction;
}

export interface DocumentValidation {
  ok: boolean;
  error?: string;
}

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validPoint(value: unknown): value is Point {
  return !!value && typeof value === 'object' && finite((value as Point).x) && finite((value as Point).y);
}

function validTranslation(value: unknown): value is Point {
  return validPoint(value) && Math.abs(value.x) <= WORLD_LIMIT && Math.abs(value.y) <= WORLD_LIMIT;
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

export function createDocument(id: string, title = 'Untitled canvas'): CanvasDocument {
  if (!ID.test(id)) throw new Error('Invalid document ID.');
  return { schemaVersion: DOCUMENT_SCHEMA_VERSION, id, title: title.trim().slice(0, 120) || 'Untitled canvas', objects: [], assetIds: [] };
}

export function createHistory(): DocumentHistory { return { undo: [], redo: [] }; }

export function objectBounds(object: CanvasObject): { left: number; top: number; right: number; bottom: number } | null {
  const x = object.translation.x;
  const y = object.translation.y;
  if (object.type === 'ink') {
    if (!object.points.length) return null;
    const radius = object.width / 2;
    return object.points.reduce((bounds, point) => ({
      left: Math.min(bounds.left, x + point.x - radius), top: Math.min(bounds.top, y + point.y - radius),
      right: Math.max(bounds.right, x + point.x + radius), bottom: Math.max(bounds.bottom, y + point.y + radius),
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  }
  if (object.type === 'text') {
    const lines = Math.max(1, object.text.split('\n').length);
    return { left: x, top: y, right: x + object.width, bottom: y + lines * object.fontSize * object.lineHeight };
  }
  if (object.type === 'shape' && (object.shape === 'line' || object.shape === 'arrow')) {
    const start = object.start ?? { x: 0, y: 0 };
    const end = object.end ?? { x: object.width, y: object.height };
    const radius = object.strokeWidth / 2;
    return {
      left: x + Math.min(start.x, end.x) - radius,
      top: y + Math.min(start.y, end.y) - radius,
      right: x + Math.max(start.x, end.x) + radius,
      bottom: y + Math.max(start.y, end.y) + radius,
    };
  }
  return { left: x, top: y, right: x + object.width, bottom: y + object.height };
}

function objectValidation(object: unknown): DocumentValidation {
  if (!object || typeof object !== 'object') return { ok: false, error: 'Object must be a record.' };
  const value = object as Partial<CanvasObject>;
  if (typeof value.id !== 'string' || !ID.test(value.id)) return { ok: false, error: 'Object ID is invalid.' };
  const order = value.order;
  const version = value.version;
  if (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 1 || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return { ok: false, error: 'Object order or version is invalid.' };
  if (!validTranslation(value.translation)) return { ok: false, error: 'Object translation is outside the world.' };
  if (value.type === 'ink') {
    const ink = value as Partial<InkObject>;
    if (typeof ink.userId !== 'string' || !ID.test(ink.userId) || (ink.tool !== 'brush' && ink.tool !== 'eraser') || typeof ink.color !== 'string' || !COLOR.test(ink.color) || !finite(ink.width) || ink.width < 1 || ink.width > 64 || !Array.isArray(ink.points) || ink.points.length > 100_000 || !ink.points.every(validPoint) || typeof ink.completed !== 'boolean' || typeof ink.active !== 'boolean' || (ink.completionOrder !== null && !Number.isSafeInteger(ink.completionOrder))) return { ok: false, error: 'Ink object is invalid.' };
  } else if (value.type === 'shape') {
    const shape = value as Partial<ShapeObject>;
    const lineLike = shape.shape === 'line' || shape.shape === 'arrow';
    if (!['rectangle', 'ellipse', 'line', 'arrow'].includes(shape.shape as string) || !finite(shape.width) || !finite(shape.height) || shape.width <= 0 || shape.height <= 0 || !finite(shape.strokeWidth) || shape.strokeWidth < 1 || shape.strokeWidth > 64 || typeof shape.strokeColor !== 'string' || !COLOR.test(shape.strokeColor) || (shape.fill !== null && (typeof shape.fill !== 'string' || !COLOR.test(shape.fill))) || (lineLike && ((shape.start !== undefined && !validPoint(shape.start)) || (shape.end !== undefined && !validPoint(shape.end))))) return { ok: false, error: 'Shape object is invalid.' };
  } else if (value.type === 'text') {
    const text = value as Partial<TextObject>;
    if (!validText(text.text) || !finite(text.width) || text.width <= 0 || !finite(text.fontSize) || text.fontSize < 8 || text.fontSize > 256 || typeof text.color !== 'string' || !COLOR.test(text.color) || !finite(text.lineHeight) || text.lineHeight < 1 || text.lineHeight > 3) return { ok: false, error: 'Text object is invalid.' };
  } else if (value.type === 'image') {
    const image = value as Partial<ImageObject>;
    if (typeof image.assetId !== 'string' || !ID.test(image.assetId) || !finite(image.intrinsicWidth) || !finite(image.intrinsicHeight) || image.intrinsicWidth < 1 || image.intrinsicHeight < 1 || !finite(image.width) || !finite(image.height) || image.width <= 0 || image.height <= 0) return { ok: false, error: 'Image object is invalid.' };
  } else return { ok: false, error: 'Object type is invalid.' };
  const bounds = objectBounds(value as CanvasObject);
  if (bounds && (bounds.left < -WORLD_LIMIT || bounds.top < -WORLD_LIMIT || bounds.right > WORLD_LIMIT || bounds.bottom > WORLD_LIMIT)) return { ok: false, error: 'Object is outside the finite world bounds.' };
  return { ok: true };
}

export function validateDocument(value: unknown): DocumentValidation {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Document must be a record.' };
  const document = value as Partial<CanvasDocument>;
  if (document.schemaVersion !== DOCUMENT_SCHEMA_VERSION) return { ok: false, error: 'Unsupported document schema version.' };
  if (typeof document.id !== 'string' || !ID.test(document.id)) return { ok: false, error: 'Document ID is invalid.' };
  if (typeof document.title !== 'string' || document.title.length > 120) return { ok: false, error: 'Document title is invalid.' };
  if (!Array.isArray(document.objects) || document.objects.length > MAX_DOCUMENT_OBJECTS) return { ok: false, error: 'Document object limit exceeded.' };
  if (!Array.isArray(document.assetIds) || document.assetIds.length > MAX_ASSET_IDS || !document.assetIds.every(assetId => typeof assetId === 'string' && ID.test(assetId))) return { ok: false, error: 'Document asset references are invalid.' };
  const ids = new Set<string>();
  let previousOrder = 0;
  for (const object of document.objects) {
    const result = objectValidation(object);
    if (!result.ok) return result;
    const typed = object as CanvasObject;
    if (ids.has(typed.id)) return { ok: false, error: 'Document contains duplicate object IDs.' };
    if (typed.order <= previousOrder) return { ok: false, error: 'Document objects must retain visual order.' };
    ids.add(typed.id); previousOrder = typed.order;
    if (typed.type === 'image' && !document.assetIds.includes(typed.assetId)) return { ok: false, error: 'Image references a missing asset.' };
  }
  return { ok: true };
}

function assertDocument(document: CanvasDocument): void {
  const result = validateDocument(document);
  if (!result.ok) throw new Error(result.error);
}

function assertExpectedVersion(object: CanvasObject | undefined, expected: number): asserts object is CanvasObject {
  if (!object) throw new Error('Object is missing. Refresh and retry.');
  if (object.version !== expected) throw new Error('Object changed while it was being edited. Refresh and retry.');
}

function nextObjectList(objects: CanvasObject[]): CanvasObject[] { return objects.slice().sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)); }

function newTransaction(authorId: string, kind: Transaction['kind'], patches: ObjectPatch[]): Transaction {
  return { id: crypto.randomUUID(), authorId, kind, patches: clone(patches), timestamp: Date.now() };
}

function applyPatches(document: CanvasDocument, patches: ObjectPatch[], direction: 'before' | 'after'): CanvasDocument {
  const byId = new Map(document.objects.map(object => [object.id, object]));
  for (const patch of patches) {
    const next = patch[direction];
    if (next) byId.set(next.id, clone(next)); else byId.delete(patch.id);
  }
  const nextDocument = { ...document, objects: nextObjectList([...byId.values()]) };
  assertDocument(nextDocument);
  return nextDocument;
}

function equivalentObject(left: CanvasObject | null | undefined, right: CanvasObject | null | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function applyHistoryTransaction(
  inputDocument: CanvasDocument,
  inputHistory: DocumentHistory,
  inputTransaction: Transaction,
  direction: 'before' | 'after',
  expectedVersions: Record<string, number> = {},
): DocumentCommandResult {
  const document = clone(inputDocument);
  const history = { undo: clone(inputHistory.undo), redo: clone(inputHistory.redo) };
  const transaction = clone(inputTransaction);
  assertDocument(document);
  const source = direction === 'before' ? history.undo : history.redo;
  const target = direction === 'before' ? history.redo : history.undo;
  if (source.at(-1)?.id !== transaction.id) throw new Error('History changed while it was being edited. Refresh and retry.');

  const currentById = new Map(document.objects.map(object => [object.id, object]));
  for (const patch of transaction.patches) {
    const current = currentById.get(patch.id);
    const expectedCurrent = direction === 'before' ? patch.after : patch.before;
    const expectedVersion = expectedVersions[patch.id];
    if (expectedVersion !== undefined && (!current || current.version !== expectedVersion)) {
      throw new Error('Object changed while it was being edited. Refresh and retry.');
    }
    if (!equivalentObject(current, expectedCurrent)) {
      throw new Error('Object changed while it was being edited. Refresh and retry.');
    }
  }

  const nextDocument = applyPatches(document, transaction.patches, direction);
  const nextHistory: DocumentHistory = direction === 'before'
    ? { undo: source.slice(0, -1), redo: [...target, transaction] }
    : { undo: [...target, transaction], redo: source.slice(0, -1) };
  return { document: nextDocument, history: nextHistory, transaction };
}

export function applyDocumentCommand(inputDocument: CanvasDocument, inputHistory: DocumentHistory, command: DocumentCommand, authorId = 'local'): DocumentCommandResult {
  const document = clone(inputDocument);
  const history = { undo: clone(inputHistory.undo), redo: clone(inputHistory.redo) };
  assertDocument(document);
  if (command.type === 'history:undo') {
    const transaction = history.undo.at(-1);
    if (!transaction) return { document, history };
    return applyHistoryTransaction(document, history, transaction, 'before', command.expectedVersions);
  }
  if (command.type === 'history:redo') {
    const transaction = history.redo.at(-1);
    if (!transaction) return { document, history };
    return applyHistoryTransaction(document, history, transaction, 'after', command.expectedVersions);
  }

  let nextDocument = document;
  let patches: ObjectPatch[] = [];
  let kind: Transaction['kind'];
  if (command.type === 'object:create') {
    if (document.objects.some(object => object.id === command.object.id)) throw new Error('Object ID was already used.');
    if (document.objects.length >= MAX_DOCUMENT_OBJECTS) throw new Error('Document object limit reached.');
    const result = objectValidation(command.object);
    if (!result.ok) throw new Error(result.error);
    nextDocument = { ...document, objects: nextObjectList([...document.objects, clone(command.object)]) };
    patches = [{ id: command.object.id, before: null, after: clone(command.object) }]; kind = 'create';
  } else if (command.type === 'object:move') {
    if (!command.ids.length || command.ids.length > MAX_DOCUMENT_OBJECTS || !validPoint(command.delta) || Math.abs(command.delta.x) > WORLD_LIMIT || Math.abs(command.delta.y) > WORLD_LIMIT) throw new Error('Move is invalid.');
    const selected = new Set(command.ids);
    if (selected.size !== command.ids.length) throw new Error('Move contains duplicate object IDs.');
    const replacements = document.objects.map(object => {
      if (!selected.has(object.id)) return object;
      assertExpectedVersion(object, command.expectedVersions[object.id]!);
      const next = { ...object, version: object.version + 1, translation: { x: object.translation.x + command.delta.x, y: object.translation.y + command.delta.y } };
      const result = objectValidation(next);
      if (!result.ok) throw new Error(`Move exceeds world bounds. ${result.error}`);
      patches.push({ id: object.id, before: clone(object), after: clone(next) });
      return next;
    });
    if (patches.length !== selected.size) throw new Error('Object is missing. Refresh and retry.');
    nextDocument = { ...document, objects: replacements }; kind = 'move';
  } else if (command.type === 'object:resize') {
    const object = document.objects.find(candidate => candidate.id === command.id);
    assertExpectedVersion(object, command.expectedVersion);
    if (!finite(command.width) || !finite(command.height) || command.width <= 0 || command.height <= 0) throw new Error('Resize is invalid.');
    let height = command.height;
    if (command.preserveAspectRatio !== false && object.type === 'image') height = command.width * object.intrinsicHeight / object.intrinsicWidth;
    const next = { ...object, version: object.version + 1, width: command.width, height } as CanvasObject;
    const result = objectValidation(next);
    if (!result.ok) throw new Error(`Resize exceeds world bounds. ${result.error}`);
    nextDocument = { ...document, objects: document.objects.map(candidate => candidate.id === object.id ? next : candidate) };
    patches = [{ id: object.id, before: clone(object), after: clone(next) }]; kind = 'resize';
  } else if (command.type === 'object:text') {
    const object = document.objects.find(candidate => candidate.id === command.id);
    assertExpectedVersion(object, command.expectedVersion);
    if (object.type !== 'text' || !validText(command.text)) throw new Error('Text edit is invalid.');
    const next: TextObject = { ...object, version: object.version + 1, text: command.text };
    nextDocument = { ...document, objects: document.objects.map(candidate => candidate.id === object.id ? next : candidate) };
    patches = [{ id: object.id, before: clone(object), after: clone(next) }]; kind = 'text';
  } else {
    const selected = new Set(command.ids);
    if (!selected.size || selected.size !== command.ids.length) throw new Error('Delete selection is invalid.');
    for (const object of document.objects) {
      if (!selected.has(object.id)) continue;
      assertExpectedVersion(object, command.expectedVersions[object.id]!);
      patches.push({ id: object.id, before: clone(object), after: null });
    }
    if (patches.length !== selected.size) throw new Error('Object is missing. Refresh and retry.');
    nextDocument = { ...document, objects: document.objects.filter(object => !selected.has(object.id)) }; kind = 'delete';
  }
  assertDocument(nextDocument);
  const transaction = newTransaction(authorId, kind!, patches);
  return { document: nextDocument, history: { undo: [...history.undo, transaction], redo: [] }, transaction };
}

export function legacyStrokesToDocument(strokes: Stroke[], id: string, title = 'Untitled canvas'): CanvasDocument {
  const document = createDocument(id, title);
  document.objects = nextObjectList(strokes.filter(stroke => stroke.completed && stroke.active).map(stroke => ({
    id: stroke.id, type: 'ink', userId: stroke.userId, order: stroke.order, version: 1, translation: { x: 0, y: 0 },
    tool: stroke.tool, color: stroke.color, width: stroke.width, points: clone(stroke.points),
    completed: stroke.completed, completionOrder: stroke.completionOrder, active: stroke.active,
  })));
  assertDocument(document);
  return document;
}

export function documentToLegacyStrokes(document: CanvasDocument): Stroke[] {
  assertDocument(document);
  return document.objects.filter((object): object is InkObject => object.type === 'ink').map(object => ({
    id: object.id, userId: object.userId, tool: object.tool, color: object.color, width: object.width,
    points: object.points.map(point => ({ x: point.x + object.translation.x, y: point.y + object.translation.y })),
    order: object.order, completed: object.completed, completionOrder: object.completionOrder, active: object.active,
  }));
}
