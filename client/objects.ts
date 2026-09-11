import type { CanvasObject, ShapeKind } from '../shared/document';
import type { Point } from '../shared/protocol';

export interface DragGeometry { x: number; y: number; width: number; height: number }

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

export function hitTestObject(point: Point, object: CanvasObject, tolerance = 6): boolean {
  const local = { x: point.x - object.translation.x, y: point.y - object.translation.y };
  if (object.type === 'ink') {
    const radius = object.width / 2 + tolerance;
    for (let index = 0; index < object.points.length; index++) {
      const current = object.points[index]!;
      if (index === 0 && Math.hypot(local.x - current.x, local.y - current.y) <= radius) return true;
      const previous = object.points[index - 1]!;
      if (distanceToSegment(local, previous, current) <= radius) return true;
    }
    return false;
  }
  const height = object.type === 'text' ? Math.max(1, object.text.split('\n').length) * object.fontSize * object.lineHeight : object.height;
  if (local.x < -tolerance || local.y < -tolerance || local.x > object.width + tolerance || local.y > height + tolerance) return false;
  if (object.type === 'shape' && object.shape === 'ellipse') {
    const rx = object.width / 2 + tolerance;
    const ry = object.height / 2 + tolerance;
    return ((local.x - object.width / 2) / rx) ** 2 + ((local.y - object.height / 2) / ry) ** 2 <= 1;
  }
  if (object.type === 'shape' && (object.shape === 'line' || object.shape === 'arrow')) {
    return distanceToSegment(local, { x: 0, y: 0 }, { x: object.width, y: object.height }) <= object.strokeWidth / 2 + tolerance;
  }
  return true;
}

export function constrainDrag(start: Point, end: Point, shape: ShapeKind, shift: boolean): DragGeometry {
  let width = end.x - start.x;
  let height = end.y - start.y;
  if (shift && (shape === 'rectangle' || shape === 'ellipse')) {
    const size = Math.max(Math.abs(width), Math.abs(height));
    width = Math.sign(width || 1) * size; height = Math.sign(height || 1) * size;
  } else if (shift && (shape === 'line' || shape === 'arrow')) {
    const angle = Math.atan2(height, width);
    const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
    const size = Math.max(Math.abs(width), Math.abs(height));
    width = Math.sign(Math.cos(snapped)) * (Math.abs(Math.cos(snapped)) > 0.5 ? size : 0);
    height = Math.sign(Math.sin(snapped)) * (Math.abs(Math.sin(snapped)) > 0.5 ? size : 0);
  }
  return { x: start.x, y: start.y, width, height };
}
