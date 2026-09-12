import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocument, type CanvasDocument } from '../shared/document';
import { contentBounds, exportDimensions, exportDocumentPng } from '../client/export';

describe('PNG export bounds', () => {
  it('keeps normal exports at source size', () => {
    expect(exportDimensions(1600, 900)).toEqual({ width: 1600, height: 900 });
  });
  it('scales oversized content under both side and pixel limits', () => {
    const size = exportDimensions(10_000, 8_000);
    expect(size.width).toBeLessThanOrEqual(4096);
    expect(size.height).toBeLessThanOrEqual(4096);
    expect(size.width * size.height).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it('uses document content bounds instead of the viewport', () => {
    const document: CanvasDocument = {
      ...createDocument('export-doc'),
      objects: [{
        id: 'shape-1', type: 'shape', order: 1, version: 1,
        translation: { x: 4_000, y: 3_000 }, shape: 'rectangle', width: 240, height: 120,
        strokeColor: '#000000', strokeWidth: 8, fill: null,
      }],
    };
    expect(contentBounds(document)).toEqual({ left: 3_996, top: 2_996, right: 4_244, bottom: 3_124 });
  });

  it('returns no bounds for an empty document', () => {
    expect(contentBounds(createDocument('empty-export'))).toBeNull();
  });

  it('applies ink translation and preserves mixed document order during export', async () => {
    const calls: string[] = [];
    class RecordingContext {
      globalCompositeOperation = 'source-over'; fillStyle = ''; strokeStyle = ''; lineWidth = 0; lineCap = ''; lineJoin = ''; font = ''; textBaseline = '';
      constructor(readonly name: string) {}
      setTransform() {} clearRect() {} fillRect() {} save() {} restore() {} beginPath() {} rect() {} ellipse() {} setLineDash() {}
      moveTo(x: number, y: number) { if (this.name === 'ink') calls.push(`ink:moveTo:${x},${y}`); }
      lineTo() {}
      arc() {}
      stroke() { calls.push(`${this.name}:stroke`); }
      fill() {}
      strokeRect() {}
      fillText() {}
      drawImage(source: RecordingCanvas) { calls.push(`${this.name}:drawImage:${source.name}`); }
    }
    class RecordingCanvas {
      width = 0; height = 0;
      readonly context: RecordingContext;
      constructor(readonly name: string) { this.context = new RecordingContext(name); }
      getContext() { return this.context; }
      toBlob(callback: (blob: Blob | null) => void) { callback(new Blob([new Uint8Array([1])], { type: 'image/png' })); }
    }
    const canvases: RecordingCanvas[] = [];
    vi.stubGlobal('document', { createElement: () => { const canvas = new RecordingCanvas(canvases.length ? 'ink' : 'output'); canvases.push(canvas); return canvas; } });
    const documentValue: CanvasDocument = {
      ...createDocument('ordered-export'),
      objects: [
        { id: 'shape-1', type: 'shape', order: 1, version: 1, translation: { x: 10, y: 10 }, shape: 'rectangle', width: 20, height: 20, strokeColor: '#000000', strokeWidth: 2, fill: null },
        { id: 'ink-1', type: 'ink', order: 2, version: 1, translation: { x: 100, y: 80 }, userId: 'u', tool: 'brush', color: '#000000', width: 4, points: [{ x: 0, y: 0 }, { x: 20, y: 0 }], completed: true, completionOrder: 1, active: true },
      ],
    };
    await exportDocumentPng(documentValue, new Map());
    expect(calls).toContain('ink:moveTo:100,80');
    expect(calls.indexOf('output:stroke')).toBeLessThan(calls.indexOf('output:drawImage:ink'));
  });
});

afterEach(() => vi.unstubAllGlobals());
