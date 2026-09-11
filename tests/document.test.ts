import { describe, expect, it } from 'vitest';
import {
  WORLD_LIMIT,
  applyDocumentCommand,
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
});
