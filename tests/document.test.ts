import { describe, expect, it } from 'vitest';
import {
  WORLD_LIMIT,
  applyDocumentCommand,
  applyHistoryTransaction,
  createDocument,
  documentToLegacyStrokes,
  legacyStrokesToDocument,
  type CanvasDocument,
  type CanvasObject,
  type DocumentHistory,
} from '../shared/document';
import type { Stroke } from '../shared/protocol';

const ink: Stroke = {
  id: 's1', userId: 'u1', tool: 'brush', color: '#000000', width: 4,
  points: [{ x: 10, y: 20 }, { x: 30, y: 40 }], order: 1,
  completed: true, completionOrder: 1, active: true,
};

function history(): DocumentHistory { return { undo: [], redo: [] }; }

describe('versioned document foundation', () => {
  it('round-trips legacy strokes without changing their observable fields', () => {
    const document = legacyStrokesToDocument([ink], 'doc-1', 'Sketch');
    expect(document.schemaVersion).toBe(1);
    expect(document.title).toBe('Sketch');
    expect(documentToLegacyStrokes(document)).toEqual([ink]);
  });

  it('records object creation as one transaction and undoes then redoes it', () => {
    const document = createDocument('doc-1');
    const object: CanvasObject = {
      id: 'rect-1', type: 'shape', order: 1, version: 1,
      translation: { x: 20, y: 30 }, shape: 'rectangle',
      width: 100, height: 60, strokeColor: '#000000', strokeWidth: 4, fill: null,
    };
    const created = applyDocumentCommand(document, history(), { type: 'object:create', object }, 'u1');
    expect(created.document.objects).toHaveLength(1);
    expect(created.history.undo).toHaveLength(1);
    const undone = applyDocumentCommand(created.document, created.history, { type: 'history:undo' }, 'u2');
    expect(undone.document.objects).toEqual([]);
    const redone = applyDocumentCommand(undone.document, undone.history, { type: 'history:redo' }, 'u2');
    expect(redone.document.objects).toEqual([object]);
  });

  it('rejects edits that leave the finite world', () => {
    const document: CanvasDocument = {
      ...createDocument('doc-1'),
      objects: [{
        id: 'rect-1', type: 'shape', order: 1, version: 1,
        translation: { x: WORLD_LIMIT - 10, y: 0 }, shape: 'rectangle',
        width: 20, height: 20, strokeColor: '#000000', strokeWidth: 4, fill: null,
      }],
    };
    expect(() => applyDocumentCommand(document, history(), {
      type: 'object:move', ids: ['rect-1'], delta: { x: 1, y: 0 },
      expectedVersions: { 'rect-1': 1 },
    }, 'u1')).toThrow(/bounds/i);
  });

  it('returns the exact transaction for create, undo, redo, and clears redo on a new commit', () => {
    const document = createDocument('doc-1');
    const object: CanvasObject = {
      id: 'rect-2', type: 'shape', order: 1, version: 1,
      translation: { x: 10, y: 20 }, shape: 'rectangle', width: 40, height: 30,
      strokeColor: '#000000', strokeWidth: 2, fill: null,
    };
    const created = applyDocumentCommand(document, history(), { type: 'object:create', object }, 'u1');
    expect(created.transaction).toMatchObject({ kind: 'create', patches: [{ before: null, after: object }] });
    const undone = applyDocumentCommand(created.document, created.history, { type: 'history:undo' }, 'u2');
    expect(undone.transaction?.id).toBe(created.transaction?.id);
    expect(undone.history.redo).toEqual([created.transaction]);
    const redone = applyDocumentCommand(undone.document, undone.history, { type: 'history:redo' }, 'u2');
    expect(redone.transaction?.id).toBe(created.transaction?.id);
    const moved = applyDocumentCommand(redone.document, redone.history, {
      type: 'object:move', ids: ['rect-2'], delta: { x: 5, y: 6 }, expectedVersions: { 'rect-2': 1 },
    }, 'u1');
    expect(moved.history.redo).toEqual([]);
    expect(moved.transaction?.patches).toEqual([{ id: 'rect-2', before: object, after: { ...object, version: 2, translation: { x: 15, y: 26 } } }]);
  });

  it('applies a history transaction only when every affected object matches its expected side', () => {
    const first: CanvasObject = {
      id: 'first', type: 'shape', order: 1, version: 1, translation: { x: 0, y: 0 },
      shape: 'rectangle', width: 10, height: 10, strokeColor: '#000000', strokeWidth: 2, fill: null,
    };
    const second: CanvasObject = {
      id: 'second', type: 'shape', order: 2, version: 1, translation: { x: 20, y: 0 },
      shape: 'rectangle', width: 10, height: 10, strokeColor: '#000000', strokeWidth: 2, fill: null,
    };
    const created = applyDocumentCommand({ ...createDocument('doc-1'), objects: [first, second] }, history(), {
      type: 'object:move', ids: ['first', 'second'], delta: { x: 5, y: 0 }, expectedVersions: { first: 1, second: 1 },
    }, 'u1');
    const changed = { ...created.document, objects: created.document.objects.map(object => object.id === 'second' ? { ...object, version: 99 } : object) };
    expect(() => applyHistoryTransaction(changed, created.history, created.transaction!, 'before', { first: 2, second: 2 })).toThrow('Object changed while it was being edited');
    expect(changed.objects.find(object => object.id === 'first')?.version).toBe(2);
    expect(created.history.undo).toHaveLength(1);
  });

  it('rejects an unfinished streamed stroke from the committed document and undo history', () => {
    const document = legacyStrokesToDocument([{ ...ink, completed: false, completionOrder: null, active: true }], 'doc-1');
    expect(document.objects).toEqual([]);
    expect(history().undo).toEqual([]);
  });
});
