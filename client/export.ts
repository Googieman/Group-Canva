import { objectBounds, type CanvasDocument, type InkObject } from '../shared/document';
import { laterErasers, renderDocumentObject, renderInkStroke } from './canvas';
import type { Bounds } from './viewport';
import type { Stroke } from '../shared/protocol';

export const MAX_PNG_SIDE = 4096;
export const MAX_PNG_PIXELS = 16 * 1024 * 1024;

export function exportDimensions(width: number, height: number): { width: number; height: number } {
  const safeWidth = Number.isFinite(width) ? Math.max(1, width) : 1;
  const safeHeight = Number.isFinite(height) ? Math.max(1, height) : 1;
  const scale = Math.min(1, MAX_PNG_SIDE / safeWidth, MAX_PNG_SIDE / safeHeight, Math.sqrt(MAX_PNG_PIXELS / Math.max(1, safeWidth * safeHeight)));
  return { width: Math.max(1, Math.floor(safeWidth * scale)), height: Math.max(1, Math.floor(safeHeight * scale)) };
}

function union(a: Bounds | null, b: Bounds): Bounds {
  if (!a) return { ...b };
  return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}

export function contentBounds(document: CanvasDocument): Bounds | null {
  let bounds: Bounds | null = null;
  for (const object of document.objects) {
    if (object.type === 'ink' && !object.active) continue;
    const value = objectBounds(object);
    if (!value || ![value.left, value.top, value.right, value.bottom].every(Number.isFinite)) continue;
    const padding = object.type === 'shape'
      ? object.shape === 'arrow' ? Math.max(object.strokeWidth / 2, object.strokeWidth * 3, 8) : object.strokeWidth / 2
      : 0;
    bounds = union(bounds, {
      left: value.left - padding,
      top: value.top - padding,
      right: value.right + padding,
      bottom: value.bottom + padding,
    });
  }
  return bounds;
}

export function validatePngExportInputs(documentValue: CanvasDocument, assets: ReadonlyMap<string, CanvasImageSource>, fontReady = true): void {
  for (const object of documentValue.objects) {
    if (object.type === 'image' && !assets.has(object.assetId)) throw new Error(`PNG export blocked: image asset ${object.assetId} is not decoded.`);
    if (object.type === 'text' && !fontReady) throw new Error('PNG export blocked: fonts are still loading. Try again in a moment.');
  }
}

export function inkObjectToStroke(object: InkObject): Stroke {
  return {
    id: object.id,
    userId: object.userId,
    tool: object.tool,
    color: object.color,
    width: object.width,
    points: object.points.map(point => ({ x: point.x + object.translation.x, y: point.y + object.translation.y })),
    order: object.order,
    completed: object.completed,
    completionOrder: object.completionOrder,
    active: object.active,
  };
}

export async function exportDocumentPng(documentValue: CanvasDocument, assets: ReadonlyMap<string, CanvasImageSource>, options: { background?: string; fontReady?: boolean } = {}): Promise<Blob> {
  const fontReady = options.fontReady ?? (typeof document === 'undefined' || typeof document.fonts === 'undefined' || document.fonts.status === 'loaded');
  validatePngExportInputs(documentValue, assets, fontReady);
  const bounds = contentBounds(documentValue);
  const left = bounds?.left ?? 0;
  const top = bounds?.top ?? 0;
  const worldWidth = Math.max(1, (bounds?.right ?? 1) - left);
  const worldHeight = Math.max(1, (bounds?.bottom ?? 1) - top);
  const size = exportDimensions(worldWidth, worldHeight);
  const scaleX = size.width / worldWidth;
  const scaleY = size.height / worldHeight;

  const output = document.createElement('canvas');
  output.width = size.width;
  output.height = size.height;
  const context = output.getContext('2d');
  if (!context) throw new Error('PNG export is unavailable.');
  context.fillStyle = options.background ?? '#ffffff';
  context.fillRect(0, 0, size.width, size.height);

  const orderedObjects = [...documentValue.objects].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const strokes = orderedObjects.filter((object): object is InkObject => object.type === 'ink' && object.active).map(inkObjectToStroke);
  for (const object of orderedObjects) {
    if (object.type === 'ink') {
      if (!object.active) continue;
      const stroke = inkObjectToStroke(object);
      const erasers = laterErasers(stroke, strokes);
      const layer = document.createElement('canvas');
      layer.width = size.width;
      layer.height = size.height;
      const layerContext = layer.getContext('2d');
      if (!layerContext) throw new Error('PNG export is unavailable.');
      layerContext.setTransform(scaleX, 0, 0, scaleY, -left * scaleX, -top * scaleY);
      renderInkStroke(layerContext, stroke);
      for (const eraser of erasers) renderInkStroke(layerContext, eraser);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = 'source-over';
      context.drawImage(layer, 0, 0);
      continue;
    }
    context.setTransform(scaleX, 0, 0, scaleY, -left * scaleX, -top * scaleY);
    renderDocumentObject(context, object, assets, true);
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  return new Promise((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export is unavailable.')), 'image/png'));
}

/** Legacy viewport capture kept for callers outside the editor migration path. */
export function canvasToPng(canvas: HTMLCanvasElement, background = '#fffdf8'): Promise<Blob> {
  const size = exportDimensions(canvas.width, canvas.height);
  const output = document.createElement('canvas'); output.width = size.width; output.height = size.height;
  const context = output.getContext('2d'); if (!context) return Promise.reject(new Error('PNG export is unavailable.'));
  context.fillStyle = background; context.fillRect(0, 0, size.width, size.height); context.drawImage(canvas, 0, 0, size.width, size.height);
  return new Promise((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export is unavailable.')), 'image/png'));
}
