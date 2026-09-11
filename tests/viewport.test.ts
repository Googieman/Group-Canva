import { describe, expect, it } from 'vitest';
import { fitCamera, screenToWorld, worldToScreen, zoomAround, type Viewport } from '../client/viewport';

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
});
