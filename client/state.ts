import { legacyStrokesToDocument, type CanvasDocument, type DocumentHistory } from '../shared/document';
import type { DrawingEvent, Snapshot, Stroke } from '../shared/protocol';
export class DrawingState {
  strokes: Stroke[] = []; redoIds: string[] = []; revision = 0; epoch = ''; ready = false;
  document?: CanvasDocument;
  documentHistory?: DocumentHistory;
  private buffered: DrawingEvent[] = [];
  private bufferedEpoch = '';
  private discardedThrough = 0;
  get canUndo() { return this.ready && (this.documentHistory ? this.documentHistory.undo.length > 0 : this.strokes.some(s => s.active && s.completed)); }
  get canRedo() { return this.ready && (this.documentHistory ? this.documentHistory.redo.length > 0 : this.redoIds.length > 0); }
  receive(event: DrawingEvent): 'applied'|'ignored'|'resync'|'buffered' {
    if (!this.ready) {
      // Events are ordered by the transport. A changed epoch supersedes the
      // entire previous lifetime, but an old snapshot must not supersede it.
      if (this.bufferedEpoch !== event.epoch) {
        this.buffered = []; this.discardedThrough = 0; this.bufferedEpoch = event.epoch;
      }
      // Bound memory while a slow or interrupted snapshot is being recovered.
      if (this.buffered.length >= 4096) {
        this.discardedThrough = Math.max(this.discardedThrough,event.revision,...this.buffered.map(e => e.revision));
        this.buffered = []; return 'resync';
      }
      this.buffered.push(event); return 'buffered';
    }
    if (event.epoch !== this.epoch) return this.requireSnapshot(event);
    if (event.revision <= this.revision) return 'ignored';
    if (event.revision !== this.revision + 1) return this.requireSnapshot(event);
    const c = event.change;
    if (c.type === 'document:transaction') {
      if (!this.document || c.document.id !== this.document.id) return this.requireSnapshot(event);
      this.document = structuredClone(c.document);
      this.redoIds = [];
      this.documentHistory = c.history ? structuredClone(c.history) : {
        undo: c.transaction ? [...(this.documentHistory?.undo ?? []), structuredClone(c.transaction)] : [...(this.documentHistory?.undo ?? [])],
        redo: [],
      };
      this.strokes = this.documentToStrokes();
      this.revision = event.revision;
      return 'applied';
    }
    if (c.type === 'stroke:begin') {
      if (this.strokes.some(s => s.id === c.stroke.id)) return this.requireSnapshot(event);
      this.strokes = [...this.strokes, structuredClone(c.stroke)].sort((a,b) => a.order-b.order);
    } else {
      const s = this.strokes.find(s => s.id === c.id);
      if (!s) return this.requireSnapshot(event);
      let replacement: Stroke | undefined;
      switch (c.type) {
        case 'stroke:points':
          if (s.points.length !== c.offset || s.completed) return this.requireSnapshot(event);
          replacement = {...s,points:[...s.points,...c.points]}; break;
        case 'stroke:end':
          replacement = {...s,completed:true,completionOrder:c.completionOrder};
          this.strokes = this.strokes.filter(s => !this.redoIds.includes(s.id));
          this.redoIds = []; break;
        case 'stroke:cancel': this.strokes = this.strokes.filter(s => s.id !== c.id); break;
        case 'history:undo': replacement = {...s,active:false}; this.redoIds = [...this.redoIds,c.id]; break;
        case 'history:redo': replacement = {...s,active:true}; this.redoIds = this.redoIds.filter(id => id !== c.id); break;
      }
      if (replacement) this.strokes = this.strokes.map(s => s.id === c.id ? replacement! : s);
    }
    if (this.document) {
      const legacy = legacyStrokesToDocument(this.strokes, this.document.id, this.document.title);
      const nonInk = this.document.objects.filter(object => object.type !== 'ink');
      const priorInk = new Map(this.document.objects.filter((object): object is Extract<CanvasDocument['objects'][number], { type: 'ink' }> => object.type === 'ink').map(object => [object.id, object]));
      const ink = legacy.objects.map(object => {
        if (object.type !== 'ink') return object;
        const prior = priorInk.get(object.id);
        if (!prior || (prior.translation.x === 0 && prior.translation.y === 0)) return object;
        return { ...object, translation: prior.translation, points: object.points.map(point => ({ x: point.x - prior.translation.x, y: point.y - prior.translation.y })) };
      });
      this.document = { ...legacy, assetIds: [...this.document.assetIds], objects: [...nonInk, ...ink].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) };
    }
    this.revision = event.revision; return 'applied';
  }
  hydrate(snapshot: Snapshot) {
    if ((snapshot.epoch === this.epoch && snapshot.revision < this.revision) ||
        (this.bufferedEpoch && snapshot.epoch !== this.bufferedEpoch) ||
        snapshot.revision < this.discardedThrough) {
      this.ready = false; return false;
    }
    this.strokes = structuredClone(snapshot.strokes).sort((a,b) => a.order-b.order);
    this.redoIds = [...snapshot.redoIds]; this.epoch = snapshot.epoch; this.revision = snapshot.revision;
    this.document = snapshot.document ? structuredClone(snapshot.document) : undefined;
    this.documentHistory = snapshot.documentHistory ? structuredClone(snapshot.documentHistory) : undefined;
    const queued = this.buffered; this.buffered = []; this.bufferedEpoch = ''; this.discardedThrough = 0; this.ready = true;
    for (const event of queued) {
      if (event.epoch === this.epoch && event.revision > snapshot.revision) this.receive(event);
    }
    return this.ready;
  }
  disconnect() { this.ready = false; this.buffered = []; this.bufferedEpoch = ''; this.discardedThrough = 0; }
  private documentToStrokes(): Stroke[] {
    if (!this.document) return this.strokes;
    return this.document.objects.filter(object => object.type === 'ink').map(object => ({
      id: object.id, userId: object.userId, tool: object.tool, color: object.color, width: object.width,
      points: object.points.map(point => ({ x: point.x + object.translation.x, y: point.y + object.translation.y })),
      order: object.order, completed: object.completed, completionOrder: object.completionOrder, active: object.active,
    }));
  }
  private requireSnapshot(event: DrawingEvent): 'resync' {
    this.ready = false; this.buffered = [event]; this.bufferedEpoch = event.epoch; return 'resync';
  }
}
