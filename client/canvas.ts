import { BOARD_HEIGHT, BOARD_WIDTH, type Point, type Stroke, type Tool } from '../shared/protocol';
import { diagnostics } from './diagnostics';

export interface CanvasCallbacks {
  onBegin(point: Point): void;
  onPoints(points: Point[]): void;
  onEnd(): void;
  onCancel(): void;
  onCursor(point: Point | null): void;
}

/** Input uses CSS bounds, never the device-pixel backing dimensions. */
export function toLogicalPoint(clientX: number, clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): Point | null {
  if (rect.width <= 0 || rect.height <= 0 || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  return {
    x: Math.max(0, Math.min(BOARD_WIDTH, (clientX - rect.left) * BOARD_WIDTH / rect.width)),
    y: Math.max(0, Math.min(BOARD_HEIGHT, (clientY - rect.top) * BOARD_HEIGHT / rect.height)),
  };
}

/** Suppress subpixel jitter; the distinct pointerup endpoint is always retained. */
export function filterSamples(samples: Point[], previous: Point | null, final: boolean): Point[] {
  const accepted: Point[] = [];
  let last = previous;
  for (let i = 0; i < samples.length; i++) {
    const point = samples[i];
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const distanceSquared = last ? (point.x - last.x) ** 2 + (point.y - last.y) ** 2 : Infinity;
    if (distanceSquared >= 0.25 ** 2 || (final && i === samples.length - 1 && distanceSquared > 0)) {
      accepted.push(point);
      last = point;
    }
  }
  return accepted;
}

export function orderedVisibleStrokes(strokes: Stroke[]): Stroke[] {
  return strokes.filter(stroke => stroke.active).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  if (!stroke.points.length) return;
  ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.lineWidth = stroke.width;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const first = stroke.points[0];
  if (stroke.points.length === 1) {
    ctx.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    ctx.stroke();
  }
}

function sameInk(a: Stroke, b: Stroke): boolean {
  return a.id === b.id && a.order === b.order && a.tool === b.tool && a.color === b.color
    && a.width === b.width && a.points.length === b.points.length
    && a.points.every((point, i) => point.x === b.points[i].x && point.y === b.points[i].y);
}

export class CanvasBoard {
  private readonly context: CanvasRenderingContext2D;
  private readonly cache: HTMLCanvasElement;
  private readonly cacheContext: CanvasRenderingContext2D;
  private strokes: Stroke[] = [];
  private cachedPrefix: Stroke[] = [];
  private frame: number | null = null;
  private enabled = false;
  private destroyed = false;
  private pointerId: number | null = null;
  private lastPoint: Point | null = null;
  private dpr = 0;
  private tool: Tool = 'brush';
  private color = '#27272a';
  private width = 4;
  private readonly listeners: [string, EventListener][];

  constructor(private readonly canvas: HTMLCanvasElement, private readonly callbacks: CanvasCallbacks) {
    const context = canvas.getContext('2d');
    this.cache = document.createElement('canvas');
    const cacheContext = this.cache.getContext('2d');
    if (!context || !cacheContext) throw new Error('A 2D canvas context is required.');
    this.context = context;
    this.cacheContext = cacheContext;
    this.canvas.style.touchAction = 'none';
    this.listeners = [
      ['pointerdown', event => this.onDown(event as PointerEvent)],
      ['pointermove', event => this.onMove(event as PointerEvent)],
      ['pointerup', event => this.onUp(event as PointerEvent)],
      ['pointercancel', event => this.onCancel(event as PointerEvent)],
      ['lostpointercapture', event => this.onCancel(event as PointerEvent)],
      ['pointerleave', () => this.callbacks.onCursor(null)],
      ['contextmenu', event => event.preventDefault()],
    ];
    for (const [name, listener] of this.listeners) canvas.addEventListener(name, listener);
    window.addEventListener('resize', this.onResize);
    this.resizeBacking();
    this.updateCursor();
    this.invalidate();
  }

  setStrokes(strokes: Stroke[]): void {
    if (this.destroyed) return;
    this.strokes = orderedVisibleStrokes(strokes);
    this.invalidate();
  }

  setEnabled(enabled: boolean): void {
    if (this.destroyed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.cancelPointer();
      this.callbacks.onCursor(null);
    }
    this.updateCursor();
  }

  setTool(tool: Tool, color: string, width: number): void {
    this.tool = tool;
    this.color = /^#[\da-f]{6}$/i.test(color) ? color : '#27272a';
    this.width = width;
    this.updateCursor();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelPointer();
    this.callbacks.onCursor(null);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    for (const [name, listener] of this.listeners) this.canvas.removeEventListener(name, listener);
    window.removeEventListener('resize', this.onResize);
    this.cache.width = 0;
    this.cache.height = 0;
    this.strokes = [];
    this.cachedPrefix = [];
  }

  private point(event: Pick<PointerEvent, 'clientX' | 'clientY'>): Point | null {
    return toLogicalPoint(event.clientX, event.clientY, this.canvas.getBoundingClientRect());
  }

  private onDown(event: PointerEvent): void {
    if (!this.enabled || this.pointerId !== null || event.button !== 0) return;
    const point = this.point(event);
    if (!point) return;
    diagnostics?.input(event.timeStamp);
    event.preventDefault();
    // Capture before publishing a begin: failed capture must not leave an orphan stroke.
    try { this.canvas.setPointerCapture(event.pointerId); } catch { return; }
    this.pointerId = event.pointerId;
    this.lastPoint = point;
    this.callbacks.onBegin(point);
    if (this.enabled) this.callbacks.onCursor(point);
  }

  private onMove(event: PointerEvent): void {
    if (!this.enabled || (this.pointerId !== null && event.pointerId !== this.pointerId)) return;
    this.callbacks.onCursor(this.point(event));
    if (this.pointerId === null) return;
    event.preventDefault();
    this.publishSamples(event, false);
  }

  private onUp(event: PointerEvent): void {
    if (!this.enabled || event.pointerId !== this.pointerId) return;
    event.preventDefault();
    this.publishSamples(event, true);
    // onPoints may synchronously disable the board (for example after a
    // connection loss). That cancellation owns the gesture; do not publish a
    // second, misleading end event.
    if (this.pointerId !== event.pointerId || !this.enabled) return;
    this.releasePointer();
    this.callbacks.onEnd();
  }

  private onCancel(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return;
    this.cancelPointer();
    this.callbacks.onCursor(null);
  }

  private publishSamples(event: PointerEvent, final: boolean): void {
    const rect = this.canvas.getBoundingClientRect();
    const coalesced = event.getCoalescedEvents?.() ?? [];
    // Browser coalesced lists can be empty or omit the dispatched event.
    const points = [...coalesced, event].map(sample => toLogicalPoint(sample.clientX, sample.clientY, rect))
      .filter((point): point is Point => point !== null);
    const samples = filterSamples(points, this.lastPoint, final);
    if (!samples.length) return;
    diagnostics?.input(event.timeStamp);
    this.lastPoint = samples[samples.length - 1];
    this.callbacks.onPoints(samples);
  }

  private releasePointer(): void {
    const pointerId = this.pointerId;
    this.pointerId = null;
    this.lastPoint = null;
    if (pointerId !== null && this.canvas.hasPointerCapture(pointerId)) {
      try { this.canvas.releasePointerCapture(pointerId); } catch { /* Already released by browser. */ }
    }
  }

  private cancelPointer(): void {
    if (this.pointerId === null) return;
    this.releasePointer();
    this.callbacks.onCancel();
  }

  private readonly onResize = (): void => {
    this.resizeBacking();
    this.updateCursor();
    this.invalidate();
  };

  private resizeBacking(): void {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    if (dpr === this.dpr) return;
    this.dpr = dpr;
    for (const canvas of [this.canvas, this.cache]) {
      canvas.width = Math.round(BOARD_WIDTH * dpr);
      canvas.height = Math.round(BOARD_HEIGHT * dpr);
    }
    this.cachedPrefix = [];
  }

  private updateCursor(): void {
    if (!this.enabled) { this.canvas.style.cursor = 'not-allowed'; return; }
    const cssScale = this.canvas.getBoundingClientRect().width / BOARD_WIDTH;
    const diameter = Math.min(96, Math.max(6, this.width * cssScale));
    const size = Math.ceil(diameter + 4);
    const center = size / 2;
    const dot = this.tool === 'brush' ? `<circle cx="${center}" cy="${center}" r="1.5" fill="${this.color}"/>` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${center}" cy="${center}" r="${diameter / 2}" fill="none" stroke="white" stroke-width="3"/><circle cx="${center}" cy="${center}" r="${diameter / 2}" fill="none" stroke="#27272a" stroke-width="1"/>${dot}</svg>`;
    this.canvas.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${Math.floor(center)} ${Math.floor(center)}, crosshair`;
  }

  private invalidate(): void {
    if (this.destroyed || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.render(); });
  }

  private render(): void {
    const started = diagnostics ? performance.now() : 0;
    this.resizeBacking();
    const compareStarted = diagnostics ? performance.now() : 0;
    let stableCount = 0;
    while (stableCount < this.strokes.length && this.strokes[stableCount].completed) stableCount++;
    // Only a completed, contiguous prefix can be cached. Later erasers must still
    // composite over earlier live ink when new points arrive beneath the eraser.
    const prefixMatches = this.cachedPrefix.length <= stableCount
      && this.cachedPrefix.every((cached, i) => sameInk(cached, this.strokes[i]));
    diagnostics?.record('prefixCompareMs', performance.now()-compareStarted);
    if (!prefixMatches) {
      this.cacheContext.setTransform(1, 0, 0, 1, 0, 0);
      this.cacheContext.clearRect(0, 0, this.cache.width, this.cache.height);
      this.cachedPrefix = [];
    }
    this.cacheContext.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    for (let i = this.cachedPrefix.length; i < stableCount; i++) {
      const stroke = this.strokes[i];
      drawStroke(this.cacheContext, stroke);
      // An ink snapshot also detects replacement snapshots and in-place edits.
      this.cachedPrefix.push({ ...stroke, points: stroke.points.map(point => ({ ...point })) });
    }
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    const copyStarted = diagnostics ? performance.now() : 0;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.globalCompositeOperation = 'source-over';
    this.context.drawImage(this.cache, 0, 0);
    diagnostics?.record('surfaceCopyMs', performance.now()-copyStarted);
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const replayStarted = diagnostics ? performance.now() : 0;
    for (let i = stableCount; i < this.strokes.length; i++) drawStroke(this.context, this.strokes[i]);
    diagnostics?.record('tailReplayMs', performance.now()-replayStarted);
    diagnostics?.record('renderMs', performance.now()-started);
    diagnostics?.painted();
  }
}
