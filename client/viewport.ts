import { WORLD_LIMIT } from '../shared/document';
import { BOARD_HEIGHT, BOARD_WIDTH } from '../shared/protocol';
import type { Point } from '../shared/protocol';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
export interface Viewport { width: number; height: number }
export interface Camera { x: number; y: number; zoom: number }
export interface Bounds { left: number; top: number; right: number; bottom: number }

export interface SpatialIndexContract {
  insert(id: string, bounds: Bounds): void;
  remove(id: string): void;
  query(bounds: Bounds): string[];
  clear(): void;
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

/** A bounded uniform grid with an overflow list for very large world objects. */
export class SpatialIndex implements SpatialIndexContract {
  private readonly cells = new Map<string, Set<string>>();
  private readonly entries = new Map<string, { bounds: Bounds; cells: string[] }>();
  private readonly overflow = new Set<string>();
  constructor(private readonly cellSize = 512, private readonly maxCellsPerObject = 64) {}

  insert(id: string, bounds: Bounds): void {
    this.remove(id);
    const normalized = { left: Math.min(bounds.left, bounds.right), top: Math.min(bounds.top, bounds.bottom), right: Math.max(bounds.left, bounds.right), bottom: Math.max(bounds.top, bounds.bottom) };
    const left = Math.floor(normalized.left / this.cellSize), right = Math.floor(normalized.right / this.cellSize);
    const top = Math.floor(normalized.top / this.cellSize), bottom = Math.floor(normalized.bottom / this.cellSize);
    const count = (right - left + 1) * (bottom - top + 1);
    if (!Number.isFinite(count) || count > this.maxCellsPerObject) {
      this.overflow.add(id); this.entries.set(id, { bounds: normalized, cells: [] }); return;
    }
    const cellKeys: string[] = [];
    for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) {
      const key = `${x}:${y}`; cellKeys.push(key);
      let ids = this.cells.get(key); if (!ids) { ids = new Set(); this.cells.set(key, ids); }
      ids.add(id);
    }
    this.entries.set(id, { bounds: normalized, cells: cellKeys });
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id); this.overflow.delete(id);
    for (const key of entry.cells) { const ids = this.cells.get(key); ids?.delete(id); if (ids?.size === 0) this.cells.delete(key); }
  }

  query(bounds: Bounds): string[] {
    const normalized = { left: Math.min(bounds.left, bounds.right), top: Math.min(bounds.top, bounds.bottom), right: Math.max(bounds.left, bounds.right), bottom: Math.max(bounds.top, bounds.bottom) };
    const left = Math.floor(normalized.left / this.cellSize), right = Math.floor(normalized.right / this.cellSize);
    const top = Math.floor(normalized.top / this.cellSize), bottom = Math.floor(normalized.bottom / this.cellSize);
    const candidateIds = new Set<string>(this.overflow);
    for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) for (const id of this.cells.get(`${x}:${y}`) ?? []) candidateIds.add(id);
    return [...candidateIds].filter(id => { const entry = this.entries.get(id); return !!entry && intersects(entry.bounds, normalized); });
  }

  clear(): void { this.cells.clear(); this.entries.clear(); this.overflow.clear(); }
}

function safeZoom(zoom: number): number { return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number.isFinite(zoom) ? zoom : 1)); }

export function worldToScreen(point: Point, viewport: Viewport, camera: Camera): Point {
  const zoom = safeZoom(camera.zoom);
  return { x: viewport.width / 2 + (point.x - camera.x) * zoom, y: viewport.height / 2 + (point.y - camera.y) * zoom };
}

export function screenToWorld(point: Point, viewport: Viewport, camera: Camera): Point {
  const zoom = safeZoom(camera.zoom);
  return { x: camera.x + (point.x - viewport.width / 2) / zoom, y: camera.y + (point.y - viewport.height / 2) / zoom };
}

export function zoomAround(camera: Camera, factor: number, screenPoint: Point, viewport: Viewport): Camera {
  const before = screenToWorld(screenPoint, viewport, camera);
  const zoom = safeZoom(camera.zoom * (Number.isFinite(factor) && factor > 0 ? factor : 1));
  const next = { x: before.x - (screenPoint.x - viewport.width / 2) / zoom, y: before.y - (screenPoint.y - viewport.height / 2) / zoom, zoom };
  return { x: Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, next.x)), y: Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, next.y)), zoom: next.zoom };
}

export function panCamera(camera: Camera, deltaScreen: Point): Camera {
  const zoom = safeZoom(camera.zoom);
  return { x: Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, camera.x - deltaScreen.x / zoom)), y: Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, camera.y - deltaScreen.y / zoom)), zoom };
}

export function scalePanDelta(deltaCss: Point, viewport: Pick<Viewport, 'width' | 'height'>): Point {
  if (viewport.width <= 0 || viewport.height <= 0) return { x: 0, y: 0 };
  return { x: deltaCss.x * BOARD_WIDTH / viewport.width, y: deltaCss.y * BOARD_HEIGHT / viewport.height };
}

export function fitCamera(bounds: Bounds, viewport: Viewport, padding = 40): Camera {
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2, zoom: safeZoom(Math.min(availableWidth / width, availableHeight / height)) };
}
