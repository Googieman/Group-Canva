import { WORLD_LIMIT } from '../shared/document';
import type { Point } from '../shared/protocol';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
export interface Viewport { width: number; height: number }
export interface Camera { x: number; y: number; zoom: number }
export interface Bounds { left: number; top: number; right: number; bottom: number }

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

export function fitCamera(bounds: Bounds, viewport: Viewport, padding = 40): Camera {
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2, zoom: safeZoom(Math.min(availableWidth / width, availableHeight / height)) };
}

