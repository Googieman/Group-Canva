import { describe, expect, it } from 'vitest';
import { createDocument, type CanvasDocument } from '../shared/document';
import { contentBounds, exportDimensions } from '../client/export';

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
});
