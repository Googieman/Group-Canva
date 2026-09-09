import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasBoard, toLogicalPoint, filterSamples, orderedVisibleStrokes } from '../client/canvas';
import type { Stroke } from '../shared/protocol';

const stroke = (id: string, order: number, completed = true): Stroke => ({
  id, order, completed, userId: 'u', tool: 'brush', color: '#123456', width: 8,
  active: true, completionOrder: completed ? 1 : null, points: [{ x: order * 10, y: 20 }],
});

describe('canvas geometry', () => {
  it('maps CSS coordinates into the same logical board at any display size', () => {
    expect(toLogicalPoint(420, 245, { left: 20, top: 20, width: 800, height: 450 })).toEqual({ x: 800, y: 450 });
    expect(toLogicalPoint(30, 55, { left: 20, top: 10, width: 400, height: 225 })).toEqual({ x: 40, y: 180 });
  });
  it('clamps captured input beyond board edges and rejects a zero-size canvas', () => {
    expect(toLogicalPoint(-20, 999, { left: 0, top: 0, width: 800, height: 450 })).toEqual({ x: 0, y: 900 });
    expect(toLogicalPoint(1, 1, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });
  it('drops tiny intermediate moves while preserving a distinct final endpoint', () => {
    expect(filterSamples([{ x: 0.1, y: 0 }, { x: 4, y: 0 }, { x: 4.1, y: 0 }], { x: 0, y: 0 }, false)).toEqual([{ x: 4, y: 0 }]);
    expect(filterSamples([{ x: 4.1, y: 0 }], { x: 4, y: 0 }, true)).toEqual([{ x: 4.1, y: 0 }]);
  });
  it('uses begin order for overlapping strokes and excludes undone strokes', () => {
    const undone = { ...stroke('undone', 2), active: false };
    const strokes = [stroke('late', 3), undone, stroke('early', 1, false)];
    expect(orderedVisibleStrokes(strokes).map(s => s.id)).toEqual(['early', 'late']);
    expect(strokes[0].id).toBe('late');
  });
});

// Node has no canvas implementation. Record the drawing boundary and dispatch real Events.
class TestCanvas extends EventTarget {
  width = 0; height = 0; style: Record<string, string> = {};
  captures = new Set<number>();
  ops: { type: string; x?: number; mode?: string }[] = [];
  ctx = {
    globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '', lineWidth: 0,
    lineCap: '', lineJoin: '',
    setTransform: vi.fn(), clearRect: () => this.ops.push({ type: 'clear' }),
    drawImage: () => this.ops.push({ type: 'image' }), beginPath() {},
    moveTo() {}, lineTo() {},
    arc: (x: number) => this.ops.push({ type: 'dot', x, mode: this.ctx.globalCompositeOperation }),
    fill() {}, stroke: () => this.ops.push({ type: 'stroke', mode: this.ctx.globalCompositeOperation }),
  };
  getContext() { return this.ctx; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 450 }; }
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) { this.captures.delete(id); }
  fire(type: string, properties: Record<string, unknown> = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0, clientX: 10, clientY: 10, ...properties });
    this.dispatchEvent(event);
  }
}

function setup() {
  const canvases: TestCanvas[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('window', Object.assign(new EventTarget(), { devicePixelRatio: 2 }));
  vi.stubGlobal('document', { createElement: () => { const c = new TestCanvas(); canvases.push(c); return c; } });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++frameId, cb); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const canvas = new TestCanvas();
  const callbacks = { onBegin: vi.fn(), onPoints: vi.fn(), onEnd: vi.fn(), onCancel: vi.fn(), onCursor: vi.fn() };
  const board = new CanvasBoard(canvas as unknown as HTMLCanvasElement, callbacks);
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(0)); };
  return { board, canvas, callbacks, flush, canvases, frames };
}
afterEach(() => vi.unstubAllGlobals());

describe('CanvasBoard input and rendering', () => {
  it('guards disconnected input, ignores right clicks, and captures a single pointer', () => {
    const { board, canvas, callbacks } = setup();
    canvas.fire('pointerdown');
    expect(callbacks.onBegin).not.toHaveBeenCalled();
    board.setEnabled(true);
    canvas.fire('pointerdown', { button: 2 });
    expect(callbacks.onBegin).not.toHaveBeenCalled();
    canvas.fire('pointerdown');
    canvas.fire('pointerdown', { pointerId: 2 });
    expect(callbacks.onBegin.mock.calls).toEqual([[{ x: 20, y: 20 }]]);
    expect(canvas.captures.has(1)).toBe(true);
    board.destroy();
  });
  it('takes coalesced samples and sends the final pointerup location before ending', () => {
    const { board, canvas, callbacks } = setup();
    board.setEnabled(true); canvas.fire('pointerdown');
    canvas.fire('pointermove', { clientX: 30, getCoalescedEvents: () => [{ clientX: 10.02, clientY: 10 }, { clientX: 20, clientY: 10 }, { clientX: 30, clientY: 10 }] });
    expect(callbacks.onPoints.mock.calls[0][0]).toEqual([{ x: 40, y: 20 }, { x: 60, y: 20 }]);
    canvas.fire('pointerup', { clientX: 30.02 });
    expect(callbacks.onPoints.mock.calls[1][0]).toEqual([{ x: 60.04, y: 20 }]);
    expect(callbacks.onPoints.mock.invocationCallOrder[1]).toBeLessThan(callbacks.onEnd.mock.invocationCallOrder[0]);
    expect(canvas.captures.size).toBe(0);
    board.destroy();
  });
  it('cancels exactly once on pointer cancellation or connection loss', () => {
    const { board, canvas, callbacks } = setup();
    board.setEnabled(true); canvas.fire('pointerdown');
    canvas.fire('pointercancel'); canvas.fire('lostpointercapture');
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    canvas.fire('pointerdown'); board.setEnabled(false); canvas.fire('pointerup');
    expect(callbacks.onCancel).toHaveBeenCalledTimes(2);
    expect(callbacks.onEnd).not.toHaveBeenCalled();
    expect(callbacks.onCursor).toHaveBeenLastCalledWith(null);
    board.destroy();
  });
  it('renders erased dots in begin order and caches the completed prefix', () => {
    const { board, canvas, canvases, flush, frames } = setup();
    const base = stroke('base', 1); const active = stroke('active', 2, false);
    const eraser: Stroke = { ...stroke('eraser', 3), tool: 'eraser' };
    board.setStrokes([eraser, active, base]); flush();
    expect(canvas.width).toBe(3200); expect(canvas.height).toBe(1800);
    expect(canvases[0].ops.filter(o => o.type === 'dot')).toEqual([{ type: 'dot', x: 10, mode: 'source-over' }]);
    expect(canvas.ops.filter(o => o.type === 'dot')).toEqual([
      { type: 'dot', x: 20, mode: 'source-over' }, { type: 'dot', x: 30, mode: 'destination-out' },
    ]);
    canvases[0].ops.length = 0;
    board.setStrokes([base, { ...active, points: [...active.points, { x: 25, y: 30 }] }, eraser]);
    board.setStrokes([base, { ...active, points: [...active.points, { x: 26, y: 30 }] }, eraser]);
    expect(frames.size).toBe(1); flush();
    expect(canvases[0].ops).toEqual([]);
    board.setStrokes([{ ...base, active: false }, active, eraser]); flush();
    expect(canvases[0].ops.some(o => o.type === 'clear')).toBe(true);
    board.destroy();
  });
  it('removes input listeners and scheduled drawing on destroy', () => {
    const { board, canvas, callbacks, frames } = setup();
    board.setEnabled(true); canvas.fire('pointerdown');
    expect(callbacks.onBegin).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(1); callbacks.onBegin.mockClear();
    board.destroy(); canvas.fire('pointerdown');
    expect(callbacks.onBegin).not.toHaveBeenCalled(); expect(frames.size).toBe(0);
  });
  it('does not end a stroke if publishing the final sample synchronously disables drawing', () => {
    const { board, canvas, callbacks } = setup();
    board.setEnabled(true); canvas.fire('pointerdown');
    callbacks.onPoints.mockImplementation(() => board.setEnabled(false));
    canvas.fire('pointerup', { clientX: 50 });
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onEnd).not.toHaveBeenCalled();
    board.destroy();
  });
  it('invalidates cached ink when a snapshot changes an interior point', () => {
    const { board, canvases, flush } = setup();
    const base = { ...stroke('base', 1), points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] };
    board.setStrokes([base]); flush(); canvases[0].ops.length = 0;
    base.points[1].y = 200;
    board.setStrokes([base]); flush();
    expect(canvases[0].ops.map(op => op.type)).toEqual(['clear', 'stroke']);
    board.destroy();
  });
  it('extends the cache in original order after reverse completion and rebuilds at a new DPR', () => {
    const { board, canvas, canvases, flush, frames } = setup();
    const early = stroke('early', 1, false); const late = stroke('late', 2);
    board.setStrokes([late, early]); flush();
    expect(canvases[0].ops).toEqual([]);
    board.setStrokes([late, { ...early, completed: true }]); flush();
    expect(canvases[0].ops.filter(op => op.type === 'dot').map(op => op.x)).toEqual([10, 20]);
    canvases[0].ops.length = 0;
    window.devicePixelRatio = 1.5; window.dispatchEvent(new Event('resize')); flush();
    expect(canvas.width).toBe(2400); expect(canvas.height).toBe(1350);
    expect(canvases[0].ops.filter(op => op.type === 'dot').map(op => op.x)).toEqual([10, 20]);
    expect(frames.size).toBe(0);
    board.destroy();
  });
  it('updates hover cursors independently without scheduling an ink repaint', () => {
    const { board, canvas, callbacks, flush, frames } = setup();
    board.setEnabled(true); flush();
    canvas.fire('pointermove', { clientX: 15, clientY: 25 });
    expect(callbacks.onCursor).toHaveBeenLastCalledWith({ x: 30, y: 50 });
    expect(callbacks.onPoints).not.toHaveBeenCalled(); expect(frames.size).toBe(0);
    canvas.fire('pointerleave');
    expect(callbacks.onCursor).toHaveBeenLastCalledWith(null);
    board.destroy();
  });
});
