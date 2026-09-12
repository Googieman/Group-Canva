import { describe, expect, it } from 'vitest';
import { fitCamera, screenToWorld, SpatialIndex, worldToScreen, zoomAround, panCamera, scalePanDelta, type Viewport } from '../client/viewport';

const viewport: Viewport = { width: 800, height: 600 };

describe('camera transforms', () => {
  it('round-trips world and screen coordinates', () => {
    const camera = { x: 100, y: 40, zoom: 2 };
    const screen = worldToScreen({ x: 120, y: 80 }, viewport, camera);
    expect(screen).toEqual({ x: 440, y: 380 });
    expect(screenToWorld(screen, viewport, camera)).toEqual({ x: 120, y: 80 });
  });

  it('keeps the pointer anchored when zooming', () => {
    const camera = zoomAround({ x: 0, y: 0, zoom: 1 }, 2, { x: 500, y: 300 }, viewport);
    expect(worldToScreen({ x: 100, y: 0 }, viewport, camera)).toEqual({ x: 500, y: 300 });
    expect(camera.zoom).toBe(2);
  });

  it('fits content inside the viewport and respects zoom limits', () => {
    const camera = fitCamera({ left: 100, top: 100, right: 300, bottom: 200 }, viewport, 40);
    expect(camera.zoom).toBeGreaterThan(1);
    expect(camera.zoom).toBeLessThanOrEqual(4);
  });

  it('clamps camera zoom at both limits while preserving bounded panning', () => {
    expect(zoomAround({ x: 0, y: 0, zoom: 1 }, 0.001, { x: 400, y: 300 }, viewport).zoom).toBe(0.1);
    expect(zoomAround({ x: 0, y: 0, zoom: 1 }, 100, { x: 400, y: 300 }, viewport).zoom).toBe(4);
    expect(panCamera({ x: 100_000, y: -100_000, zoom: 0.1 }, { x: -100_000, y: 100_000 })).toEqual({ x: 100_000, y: -100_000, zoom: 0.1 });
  });

  it('scales CSS pan deltas into the logical board at half display size', () => {
    expect(scalePanDelta({ x: 20, y: -10 }, { width: 800, height: 450 })).toEqual({ x: 40, y: -20 });
  });

  it('culls indexed bounds while retaining oversized objects in an overflow list', () => {
    const index = new SpatialIndex(100, 4);
    index.insert('small', { left: 10, top: 10, right: 30, bottom: 30 });
    index.insert('far', { left: 500, top: 500, right: 530, bottom: 530 });
    index.insert('large', { left: -10_000, top: -10_000, right: 10_000, bottom: 10_000 });
    expect(index.query({ left: 0, top: 0, right: 40, bottom: 40 })).toEqual(expect.arrayContaining(['small', 'large']));
    expect(index.query({ left: 450, top: 450, right: 550, bottom: 550 })).toEqual(expect.arrayContaining(['far', 'large']));
    expect(index.query({ left: 100, top: 100, right: 200, bottom: 200 })).not.toContain('small');
    index.remove('small');
    expect(index.query({ left: 0, top: 0, right: 40, bottom: 40 })).not.toContain('small');
  });
});
