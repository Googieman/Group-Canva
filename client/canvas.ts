import { BOARD_HEIGHT, BOARD_WIDTH, type Point, type Stroke, type Tool } from '../shared/protocol';
import { objectBounds as documentObjectBounds, type CanvasObject } from '../shared/document';
import { panCamera, screenToWorld, SpatialIndex, zoomAround, type Camera } from './viewport';
import { diagnostics } from './diagnostics';

export interface CanvasCallbacks {
  onBegin(point: Point): void;
  onPoints(points: Point[]): void;
  onEnd(): void;
  onCancel(): void;
  onCursor(point: Point | null): void;
  onCameraChange?(camera: Camera): void;
  onWidthChange?(width: number): void;
  onBeginWithModifiers?(point: Point, shift: boolean): void;
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

/** Suppress subpixel jitter and treat tiny pointerup movement as a click. */
export function filterSamples(samples: Point[], previous: Point | null, final: boolean): Point[] {
  const accepted: Point[] = [];
  let last = previous;
  const minimumDistance = final ? 4 : 0.25;
  for (let i = 0; i < samples.length; i++) {
    const point = samples[i];
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const distanceSquared = last ? (point.x - last.x) ** 2 + (point.y - last.y) ** 2 : Infinity;
    if (distanceSquared >= minimumDistance ** 2) {
      accepted.push(point);
      last = point;
    }
  }
  return accepted;
}

export function orderedVisibleStrokes(strokes: Stroke[]): Stroke[] {
  return strokes.filter(stroke => stroke.active).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function renderInkStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, cachedPath?: Path2D): void {
  if (!stroke.points.length) return;
  ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.lineWidth = stroke.width;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (cachedPath) {
    if (stroke.points.length === 1) ctx.fill(cachedPath);
    else ctx.stroke(cachedPath);
    return;
  }
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

interface InkBounds { left: number; top: number; right: number; bottom: number; }

function strokeBounds(stroke: Stroke, from = 0): InkBounds | null {
  if (from >= stroke.points.length) return null;
  const radius = stroke.width / 2;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let i = from; i < stroke.points.length; i++) {
    const point = stroke.points[i];
    left = Math.min(left, point.x - radius);
    top = Math.min(top, point.y - radius);
    right = Math.max(right, point.x + radius);
    bottom = Math.max(bottom, point.y + radius);
  }
  return { left, top, right, bottom };
}

function unionBounds(a: InkBounds | null, b: InkBounds | null): InkBounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom),
  };
}

function intersects(a: InkBounds, b: InkBounds): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function expandBounds(bounds: InkBounds, amount: number): InkBounds {
  return { left: bounds.left - amount, top: bounds.top - amount,
    right: bounds.right + amount, bottom: bounds.bottom + amount };
}

function clampBounds(bounds: InkBounds): InkBounds {
  return { left: Math.max(0, Math.min(BOARD_WIDTH, bounds.left)),
    top: Math.max(0, Math.min(BOARD_HEIGHT, bounds.top)),
    right: Math.max(0, Math.min(BOARD_WIDTH, bounds.right)),
    bottom: Math.max(0, Math.min(BOARD_HEIGHT, bounds.bottom)) };
}

function mergeBounds(bounds: InkBounds[]): InkBounds[] {
  const merged: InkBounds[] = [];
  for (const current of bounds) {
    let next = current;
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < merged.length; i++) {
        if (!intersects(next, merged[i])) continue;
        next = unionBounds(next, merged[i])!;
        merged.splice(i, 1);
        changed = true;
        break;
      }
    }
    merged.push(next);
  }
  return merged;
}

function objectBounds(object: CanvasObject): InkBounds | null { return documentObjectBounds(object); }

function setWorldTransform(ctx: CanvasRenderingContext2D, dpr: number, camera: Camera, viewport: { width: number; height: number }): void {
  ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom,
    dpr * (viewport.width / 2 - camera.x * camera.zoom), dpr * (viewport.height / 2 - camera.y * camera.zoom));
}

function setDefaultWorldTransform(ctx: CanvasRenderingContext2D, dpr: number): void { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }

export function renderDocumentObject(ctx: CanvasRenderingContext2D, object: CanvasObject, assets: ReadonlyMap<string, CanvasImageSource>, fontReady = true): void {
  const x = object.translation.x, y = object.translation.y;
  ctx.globalCompositeOperation = 'source-over';
  if (object.type === 'shape') {
    ctx.lineWidth = object.strokeWidth; ctx.strokeStyle = object.strokeColor; ctx.fillStyle = object.fill ?? 'transparent';
    if (object.shape === 'line' || object.shape === 'arrow') {
      const start = object.start ?? { x: 0, y: 0 };
      const end = object.end ?? { x: object.width, y: object.height };
      ctx.beginPath(); ctx.moveTo(x + start.x, y + start.y); ctx.lineTo(x + end.x, y + end.y); ctx.stroke();
      if (object.shape === 'arrow') {
        const angle = Math.atan2(end.y - start.y, end.x - start.x), size = Math.max(8, object.strokeWidth * 3);
        ctx.beginPath(); ctx.moveTo(x + end.x, y + end.y);
        ctx.lineTo(x + end.x - Math.cos(angle - Math.PI / 6) * size, y + end.y - Math.sin(angle - Math.PI / 6) * size);
        ctx.moveTo(x + end.x, y + end.y);
        ctx.lineTo(x + end.x - Math.cos(angle + Math.PI / 6) * size, y + end.y - Math.sin(angle + Math.PI / 6) * size); ctx.stroke();
      }
    } else {
      ctx.beginPath();
      if (object.shape === 'ellipse') ctx.ellipse(x + object.width / 2, y + object.height / 2, Math.abs(object.width / 2), Math.abs(object.height / 2), 0, 0, Math.PI * 2);
      else ctx.rect(x, y, object.width, object.height);
      if (object.fill) ctx.fill();
      ctx.stroke();
    }
    return;
  }
  if (object.type === 'text') {
    if (!fontReady) return;
    ctx.fillStyle = object.color; ctx.font = `${object.fontSize}px Outfit, sans-serif`; ctx.textBaseline = 'top';
    object.text.split('\n').forEach((line, index) => ctx.fillText(line, x, y + index * object.fontSize * object.lineHeight));
    return;
  }
  if (object.type === 'image') {
    const asset = assets.get(object.assetId);
    if (asset) { try { ctx.drawImage(asset, x, y, object.width, object.height); return; } catch { /* retry after image decode */ } }
    ctx.strokeStyle = '#a8a1b0'; if (typeof ctx.setLineDash === 'function') ctx.setLineDash([6, 4]); ctx.strokeRect(x, y, object.width, object.height); if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    ctx.fillStyle = '#77727d'; ctx.font = '14px Outfit, sans-serif'; ctx.fillText('Image unavailable', x + 10, y + 10);
  }
}

function drawObject(ctx: CanvasRenderingContext2D, object: CanvasObject, assets: ReadonlyMap<string, CanvasImageSource>, fontReady = true): void {
  renderDocumentObject(ctx, object, assets, fontReady);
}

function drawSelection(ctx: CanvasRenderingContext2D, objects: CanvasObject[], selectedIds: Set<string>, marquee: { start: Point; end: Point } | null, lineWidth: number): void {
  ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = '#5446d4'; ctx.lineWidth = lineWidth; if (typeof ctx.setLineDash === 'function') ctx.setLineDash([6, 4]);
  for (const object of objects) {
    if (!selectedIds.has(object.id)) continue;
    const bounds = objectBounds(object); if (bounds) ctx.strokeRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
  }
  if (marquee) { const left = Math.min(marquee.start.x, marquee.end.x), top = Math.min(marquee.start.y, marquee.end.y); ctx.strokeRect(left, top, Math.abs(marquee.end.x - marquee.start.x), Math.abs(marquee.end.y - marquee.start.y)); }
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]); ctx.restore();
}

export class CanvasBoard {
  private readonly context: CanvasRenderingContext2D;
  private readonly cache: HTMLCanvasElement;
  private readonly cacheContext: CanvasRenderingContext2D;
  private readonly tailCache: HTMLCanvasElement;
  private readonly tailCacheContext: CanvasRenderingContext2D;
  private strokes: Stroke[] = [];
  private legacyStrokes: Stroke[] = [];
  private objects: CanvasObject[] = [];
  private assets = new Map<string, CanvasImageSource>();
  private readonly objectIndex = new SpatialIndex();
  private selectedIds = new Set<string>();
  private marquee: { start: Point; end: Point } | null = null;
  private camera: Camera = { x: BOARD_WIDTH / 2, y: BOARD_HEIGHT / 2, zoom: 1 };
  private cachedPrefix: Stroke[] = [];
  private paths = new Map<string, { stroke: Stroke; path: Path2D }>();
  private cachedTail: Stroke[] = [];
  private renderedInk = new Map<string, { stroke: Stroke; bounds: InkBounds }>();
  private fullRepaint = true;
  private frame: number | null = null;
  private enabled = false;
  private destroyed = false;
  private pointerId: number | null = null;
  private panPointerId: number | null = null;
  private panLast: Point | null = null;
  private touchPoints = new Map<number, Point>();
  private touchGesture: { center: Point; distance: number } | null = null;
  private navigationMode = false;
  private spaceDown = false;
  private lastPoint: Point | null = null;
  private dpr = 0;
  private viewport = { width: BOARD_WIDTH, height: BOARD_HEIGHT };
  private tool: Tool = 'brush';
  private color = '#27272a';
  private width = 4;
  private fontReady = true;
  private readonly listeners: [string, EventListener][];

  constructor(private readonly canvas: HTMLCanvasElement, private readonly callbacks: CanvasCallbacks) {
    const context = canvas.getContext('2d');
    this.cache = document.createElement('canvas');
    const cacheContext = this.cache.getContext('2d');
    this.tailCache = document.createElement('canvas');
    const tailCacheContext = this.tailCache.getContext('2d');
    if (!context || !cacheContext || !tailCacheContext) throw new Error('A 2D canvas context is required.');
    this.context = context;
    this.cacheContext = cacheContext;
    this.tailCacheContext = tailCacheContext;
    this.canvas.style.touchAction = 'none';
    this.listeners = [
      ['pointerdown', event => this.onDown(event as PointerEvent)],
      ['pointermove', event => this.onMove(event as PointerEvent)],
      ['pointerup', event => this.onUp(event as PointerEvent)],
      ['pointercancel', event => this.onCancel(event as PointerEvent)],
      ['lostpointercapture', event => this.onCancel(event as PointerEvent)],
      ['pointerleave', () => this.callbacks.onCursor(null)],
      ['wheel', event => this.onWheel(event as WheelEvent)],
      ['contextmenu', event => event.preventDefault()],
    ];
    for (const [name, listener] of this.listeners) canvas.addEventListener(name, listener);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.resizeBacking();
    this.updateCursor();
    this.invalidate();
  }

  setStrokes(strokes: Stroke[]): void {
    if (this.destroyed) return;
    this.legacyStrokes = strokes;
    this.rebuildInkStrokes();
    this.invalidate();
  }

  setObjects(objects: CanvasObject[]): void {
    if (this.destroyed) return;
    this.objects = objects.slice().sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    this.objectIndex.clear();
    for (const object of this.objects) { const bounds = objectBounds(object); if (bounds) this.objectIndex.insert(object.id, bounds); }
    this.rebuildInkStrokes();
    this.fullRepaint = true;
    this.invalidate();
  }

  setAssets(assets: Map<string, CanvasImageSource>): void {
    this.assets = new Map(assets);
    this.fullRepaint = true;
    this.invalidate();
  }

  setFontReady(ready: boolean): void { if (this.fontReady === ready) return; this.fontReady = ready; this.fullRepaint = true; this.invalidate(); }

  setSelection(ids: Iterable<string>, marquee: { start: Point; end: Point } | null = null): void {
    if (this.destroyed) return;
    this.selectedIds = new Set(ids); this.marquee = marquee ? { start: { ...marquee.start }, end: { ...marquee.end } } : null; this.invalidate();
  }

  setCamera(camera: Camera): void {
    if (this.destroyed) return;
    this.camera = { x: Math.max(-100_000, Math.min(100_000, camera.x)), y: Math.max(-100_000, Math.min(100_000, camera.y)), zoom: Math.max(0.1, Math.min(4, camera.zoom)) };
    this.fullRepaint = true;
    this.updateCursor();
    this.callbacks.onCameraChange?.(this.camera);
    this.invalidate();
  }

  getCamera(): Camera { return { ...this.camera }; }

  setNavigationMode(enabled: boolean): void { this.navigationMode = enabled; this.updateCursor(); }

  setEnabled(enabled: boolean): void {
    if (this.destroyed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.cancelPointer();
      this.releasePan();
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
    this.releasePan();
    this.callbacks.onCursor(null);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    for (const [name, listener] of this.listeners) this.canvas.removeEventListener(name, listener);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.cache.width = 0;
    this.cache.height = 0;
    this.tailCache.width = 0;
    this.tailCache.height = 0;
    this.strokes = [];
    this.legacyStrokes = [];
    this.cachedPrefix = [];
    this.paths.clear();
    this.renderedInk.clear();
    this.cachedTail = [];
    this.objectIndex.clear();
    this.touchPoints.clear();
    this.touchGesture = null;
  }

  private rebuildInkStrokes(): void {
    const inkObjects = this.objects.filter((object): object is Extract<CanvasObject, { type: 'ink' }> => object.type === 'ink' && object.active);
    const documentIds = new Set(inkObjects.map(object => object.id));
    const committed = inkObjects.map(object => ({
      ...object,
      points: object.points.map(point => ({ x: point.x + object.translation.x, y: point.y + object.translation.y })),
    }));
    this.strokes = orderedVisibleStrokes([
      ...this.legacyStrokes.filter(stroke => !documentIds.has(stroke.id)),
      ...committed,
    ]);
  }

  private point(event: Pick<PointerEvent, 'clientX' | 'clientY'>): Point | null {
    const screen = toLogicalPoint(event.clientX, event.clientY, this.canvas.getBoundingClientRect());
    return screen ? screenToWorld(screen, { width: BOARD_WIDTH, height: BOARD_HEIGHT }, this.camera) : null;
  }

  private onDown(event: PointerEvent): void {
    if (event.pointerType === 'touch') { this.onTouchDown(event); return; }
    this.beginPointer(event);
  }

  private beginPointer(event: PointerEvent): void {
    if (!this.enabled || this.pointerId !== null || this.panPointerId !== null || (event.button !== 0 && event.button !== 1)) return;
    const point = this.point(event);
    if (!point) return;
    diagnostics?.input(event.timeStamp);
    event.preventDefault();
    if (event.button === 1 || this.spaceDown || this.navigationMode) {
      try { this.canvas.setPointerCapture(event.pointerId); } catch { return; }
      this.panPointerId = event.pointerId; this.panLast = { x: event.clientX, y: event.clientY }; return;
    }
    // Capture before publishing a begin: failed capture must not leave an orphan stroke.
    try { this.canvas.setPointerCapture(event.pointerId); } catch { return; }
    this.pointerId = event.pointerId;
    this.lastPoint = point;
    this.callbacks.onBegin(point);
    this.callbacks.onBeginWithModifiers?.(point, event.shiftKey);
    if (this.enabled) this.callbacks.onCursor(point);
  }

  private onTouchDown(event: PointerEvent): void {
    if (!this.enabled || (event.button !== 0 && event.button !== 1)) return;
    this.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { this.canvas.setPointerCapture(event.pointerId); } catch { this.touchPoints.delete(event.pointerId); return; }
    if (this.touchPoints.size >= 2) {
      if (this.pointerId !== null) this.cancelPointer();
      this.releasePan();
      this.touchGesture = this.touchMetrics();
      this.callbacks.onCursor(null);
      return;
    }
    this.beginPointer(event);
  }

  private onMove(event: PointerEvent): void {
    if (event.pointerType === 'touch') { this.onTouchMove(event); return; }
    if (!this.enabled || (this.pointerId !== null && event.pointerId !== this.pointerId) || (this.panPointerId !== null && event.pointerId !== this.panPointerId)) return;
    if (this.panPointerId === event.pointerId) {
      if (this.panLast) this.setCamera(panCamera(this.camera, { x: event.clientX - this.panLast.x, y: event.clientY - this.panLast.y }));
      this.panLast = { x: event.clientX, y: event.clientY }; return;
    }
    this.callbacks.onCursor(this.point(event));
    if (this.pointerId === null) return;
    event.preventDefault();
    this.publishSamples(event, false);
  }

  private onTouchMove(event: PointerEvent): void {
    if (!this.enabled || !this.touchPoints.has(event.pointerId)) return;
    this.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.touchPoints.size >= 2) {
      const next = this.touchMetrics();
      if (this.touchGesture) {
        const delta = { x: next.center.x - this.touchGesture.center.x, y: next.center.y - this.touchGesture.center.y };
        let camera = panCamera(this.camera, delta);
        const screen = toLogicalPoint(next.center.x, next.center.y, this.canvas.getBoundingClientRect());
        if (screen && this.touchGesture.distance > 0) camera = zoomAround(camera, next.distance / this.touchGesture.distance, screen, { width: BOARD_WIDTH, height: BOARD_HEIGHT });
        this.setCamera(camera);
      }
      this.touchGesture = next;
      return;
    }
    this.onMove({ ...event, pointerType: 'mouse' } as PointerEvent);
  }

  private touchMetrics(): { center: Point; distance: number } {
    const points = [...this.touchPoints.values()];
    const first = points[0]!, second = points[1] ?? first;
    return { center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }, distance: Math.hypot(first.x - second.x, first.y - second.y) };
  }

  private onUp(event: PointerEvent): void {
    if (event.pointerType === 'touch' && this.touchPoints.has(event.pointerId)) {
      const before = this.touchPoints.size;
      this.touchPoints.delete(event.pointerId);
      if (before >= 2) { this.touchGesture = null; if (this.canvas.hasPointerCapture(event.pointerId)) { try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* Already released by browser. */ } } return; }
    }
    if (event.pointerId === this.panPointerId) { this.releasePan(); return; }
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
    if (event.pointerType === 'touch') { this.touchPoints.delete(event.pointerId); this.touchGesture = this.touchPoints.size >= 2 ? this.touchMetrics() : null; }
    if (event.pointerId === this.panPointerId) { this.releasePan(); return; }
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

  private releasePan(): void {
    const pointerId = this.panPointerId;
    this.panPointerId = null; this.panLast = null;
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

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Space') this.spaceDown = true;
    if (event.code === 'Escape') {
      this.cancelPointer();
      this.releasePan();
      this.touchPoints.clear();
      this.touchGesture = null;
    }
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => { if (event.code === 'Space') this.spaceDown = false; };
  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    if ((this.tool === 'brush' || this.tool === 'eraser') && !event.ctrlKey && !event.metaKey) {
      const next = Math.max(1, Math.min(64, this.width + (event.deltaY < 0 ? 1 : -1)));
      if (next !== this.width) { this.width = next; this.callbacks.onWidthChange?.(next); this.updateCursor(); }
      return;
    }
    const screen = toLogicalPoint(event.clientX, event.clientY, this.canvas.getBoundingClientRect());
    if (!screen) return;
    this.setCamera(zoomAround(this.camera, Math.exp(-event.deltaY * 0.001), screen, { width: BOARD_WIDTH, height: BOARD_HEIGHT }));
  };

  private resizeBacking(): void {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    if (dpr === this.dpr) return;
    this.dpr = dpr;
    for (const canvas of [this.canvas, this.cache, this.tailCache]) {
      canvas.width = Math.round(BOARD_WIDTH * dpr);
      canvas.height = Math.round(BOARD_HEIGHT * dpr);
    }
    this.cachedPrefix = [];
    this.cachedTail = [];
    this.paths.clear();
    this.renderedInk.clear();
    this.fullRepaint = true;
  }

  private updateCursor(): void {
    if (!this.enabled) { this.canvas.style.cursor = 'not-allowed'; return; }
    const cssScale = this.canvas.getBoundingClientRect().width / BOARD_WIDTH;
    const diameter = Math.min(96, Math.max(6, this.width * cssScale * this.camera.zoom));
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
    if (this.camera.zoom !== 1 || this.camera.x !== BOARD_WIDTH / 2 || this.camera.y !== BOARD_HEIGHT / 2) {
      this.renderCameraFrame();
      return;
    }
    const visibleIds = new Set(this.strokes.map(stroke => stroke.id));
    for (const id of this.paths.keys()) if (!visibleIds.has(id)) this.paths.delete(id);
    const compareStarted = diagnostics ? performance.now() : 0;
    const dirty: InkBounds[] = [];
    for (const previous of this.renderedInk.values()) {
      if (!visibleIds.has(previous.stroke.id)) dirty.push(previous.bounds);
    }
    for (const stroke of this.strokes) {
      const bounds = strokeBounds(stroke);
      if (!bounds) continue;
      const previous = this.renderedInk.get(stroke.id);
      if (!previous || !sameInk(previous.stroke, stroke) || previous.stroke.completed !== stroke.completed) {
        if (previous) dirty.push(previous.bounds);
        dirty.push(bounds);
      }
    }
    let stableCount = 0;
    while (stableCount < this.strokes.length && this.strokes[stableCount].completed) stableCount++;
    // Only a completed, contiguous prefix can be cached. Later erasers must still
    // composite over earlier live ink when new points arrive beneath the eraser.
    const prefixMatches = this.cachedPrefix.length <= stableCount
      && this.cachedPrefix.every((cached, i) => sameInk(cached, this.strokes[i]));
    diagnostics?.record('prefixCompareMs', performance.now()-compareStarted);
    if (!prefixMatches) {
      const previousPrefix = this.cachedPrefix;
      if (previousPrefix.length) {
        let affected: InkBounds | null = null;
        for (const stroke of previousPrefix) affected = unionBounds(affected, strokeBounds(stroke));
        for (let i = 0; i < stableCount; i++) affected = unionBounds(affected, strokeBounds(this.strokes[i]));
        if (affected) dirty.push(affected);
      }
      this.cacheContext.setTransform(1, 0, 0, 1, 0, 0);
      this.cacheContext.clearRect(0, 0, this.cache.width, this.cache.height);
      this.cachedPrefix = [];
    }
    setDefaultWorldTransform(this.cacheContext, this.dpr);
    for (let i = this.cachedPrefix.length; i < stableCount; i++) {
      const stroke = this.strokes[i];
      renderInkStroke(this.cacheContext, stroke, this.pathFor(stroke));
      // An ink snapshot also detects replacement snapshots and in-place edits.
      this.cachedPrefix.push({ ...stroke, points: stroke.points.map(point => ({ ...point })) });
    }
    // A long completed brush run can be rasterized once and inserted at its
    // original position between live operations. Eraser runs stay on the
    // ordered path replay so destination-out remains deterministic.
    let cacheStart = -1, cacheEnd = -1;
    for (let i = stableCount; i < this.strokes.length;) {
      if (!this.strokes[i].completed || this.strokes[i].tool !== 'brush') { i++; continue; }
      const start = i;
      while (i < this.strokes.length && this.strokes[i].completed && this.strokes[i].tool === 'brush') i++;
      if (i - start > cacheEnd - cacheStart) { cacheStart = start; cacheEnd = i; }
    }
    const canCacheTail = cacheStart >= 0 && cacheEnd - cacheStart >= 8;
    if (!canCacheTail) {
      this.cachedTail = [];
    } else {
      const tail = this.strokes.slice(cacheStart, cacheEnd);
      const tailMatches = this.cachedTail.length === tail.length
        && this.cachedTail.every((cached, i) => sameInk(cached, tail[i]));
      if (!tailMatches) {
        this.tailCacheContext.setTransform(1, 0, 0, 1, 0, 0);
        this.tailCacheContext.clearRect(0, 0, this.tailCache.width, this.tailCache.height);
        setDefaultWorldTransform(this.tailCacheContext, this.dpr);
        for (const stroke of tail) renderInkStroke(this.tailCacheContext, stroke, this.pathFor(stroke));
        this.cachedTail = tail.map(stroke => ({ ...stroke, points: stroke.points.map(point => ({ ...point })) }));
      }
    }
    const fullBoard: InkBounds = { left: 0, top: 0, right: BOARD_WIDTH, bottom: BOARD_HEIGHT };
    const regions = this.fullRepaint ? [fullBoard] : mergeBounds(dirty.map(bounds => clampBounds(expandBounds(bounds, 1))));
    let copyMs = 0, replayMs = 0;
    let repaintArea = 0;
    for (const region of regions) {
      const left = Math.floor(region.left * this.dpr);
      const top = Math.floor(region.top * this.dpr);
      const right = Math.ceil(region.right * this.dpr);
      const bottom = Math.ceil(region.bottom * this.dpr);
      if (right <= left || bottom <= top) continue;
      repaintArea += (right - left) * (bottom - top);
      this.context.save();
      setDefaultWorldTransform(this.context, this.dpr);
      this.context.beginPath();
      this.context.rect(left / this.dpr, top / this.dpr, (right - left) / this.dpr, (bottom - top) / this.dpr);
      this.context.clip();
      this.context.setTransform(1, 0, 0, 1, 0, 0);
      const regionCopyStarted = diagnostics ? performance.now() : 0;
      this.context.clearRect(left, top, right - left, bottom - top);
      this.context.globalCompositeOperation = 'source-over';
      this.context.drawImage(this.cache, left, top, right - left, bottom - top, left, top, right - left, bottom - top);
      if (diagnostics) copyMs += performance.now() - regionCopyStarted;
      setDefaultWorldTransform(this.context, this.dpr);
      const regionReplayStarted = diagnostics ? performance.now() : 0;
      for (let i = stableCount; i < this.strokes.length; i++) {
        if (canCacheTail && i === cacheStart) {
          this.context.globalCompositeOperation = 'source-over';
          this.context.setTransform(1, 0, 0, 1, 0, 0);
          this.context.drawImage(this.tailCache, left, top, right - left, bottom - top, left, top, right - left, bottom - top);
          setDefaultWorldTransform(this.context, this.dpr);
          i = cacheEnd - 1;
          continue;
        }
        const stroke = this.strokes[i];
        const bounds = strokeBounds(stroke);
        if (bounds && intersects(bounds, region)) renderInkStroke(this.context, stroke, this.pathFor(stroke));
      }
      this.context.globalCompositeOperation = 'source-over';
      setDefaultWorldTransform(this.context, this.dpr);
      for (const object of this.objects) {
        const bounds = objectBounds(object);
        if (!bounds || !intersects(bounds, region)) continue;
        drawObject(this.context, object, this.assets, this.fontReady);
      }
      if (diagnostics) replayMs += performance.now() - regionReplayStarted;
      this.context.restore();
    }
    setDefaultWorldTransform(this.context, this.dpr);
    drawSelection(this.context, this.objects, this.selectedIds, this.marquee, 1.5);
    this.fullRepaint = false;
    diagnostics?.record('surfaceCopyMs', copyMs);
    diagnostics?.record('repaintAreaPx', repaintArea);
    diagnostics?.record('tailReplayMs', replayMs);
    this.renderedInk.clear();
    for (const stroke of this.strokes) {
      const bounds = strokeBounds(stroke);
      if (bounds) this.renderedInk.set(stroke.id, { stroke: { ...stroke, points: stroke.points.map(point => ({ ...point })) }, bounds });
    }
    diagnostics?.record('renderMs', performance.now()-started);
    diagnostics?.painted();
  }

  private renderCameraFrame(): void {
    const view: InkBounds = { left: this.camera.x - this.viewport.width / (2 * this.camera.zoom), top: this.camera.y - this.viewport.height / (2 * this.camera.zoom), right: this.camera.x + this.viewport.width / (2 * this.camera.zoom), bottom: this.camera.y + this.viewport.height / (2 * this.camera.zoom) };
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.globalCompositeOperation = 'source-over';
    setWorldTransform(this.context, this.dpr, this.camera, this.viewport);
    for (const stroke of this.strokes) { const bounds = strokeBounds(stroke); if (!bounds || intersects(bounds, view)) renderInkStroke(this.context, stroke, this.pathFor(stroke)); }
    this.context.globalCompositeOperation = 'source-over';
    const visibleObjectIds = new Set(this.objectIndex.query(view));
    for (const object of this.objects) { if (visibleObjectIds.has(object.id)) drawObject(this.context, object, this.assets, this.fontReady); }
    drawSelection(this.context, this.objects, this.selectedIds, this.marquee, Math.max(1, 1.5 / this.camera.zoom));
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.fullRepaint = false;
  }

  private pathFor(stroke: Stroke): Path2D | undefined {
    if (!stroke.completed || typeof Path2D === 'undefined' || !stroke.points.length) return undefined;
    const cached = this.paths.get(stroke.id);
    if (cached && sameInk(cached.stroke, stroke)) return cached.path;
    const path = new Path2D();
    const first = stroke.points[0];
    if (stroke.points.length === 1) {
      path.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2);
    } else {
      path.moveTo(first.x, first.y);
      for (let i = 1; i < stroke.points.length; i++) path.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    this.paths.set(stroke.id, { stroke: { ...stroke, points: stroke.points.map(point => ({ ...point })) }, path });
    return path;
  }
}
