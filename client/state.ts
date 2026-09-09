import type { DrawingEvent, Snapshot, Stroke } from '../shared/protocol';
export class DrawingState {
  strokes: Stroke[] = []; redoIds: string[] = []; revision = 0; epoch = ''; ready = false;
  private buffered: DrawingEvent[] = [];
  get canUndo() { return this.ready && this.strokes.some(s => s.active && s.completed); }
  get canRedo() { return this.ready && this.redoIds.length > 0; }
  receive(event: DrawingEvent): 'applied'|'ignored'|'resync'|'buffered' {
    if (!this.ready) {
      // Bound memory while a slow or interrupted snapshot is being recovered.
      if (this.buffered.length >= 4096) { this.buffered = []; return 'resync'; }
      this.buffered.push(event); return 'buffered';
    }
    if (event.epoch !== this.epoch) return this.requireSnapshot(event);
    if (event.revision <= this.revision) return 'ignored';
    if (event.revision !== this.revision + 1) return this.requireSnapshot(event);
    const c = event.change;
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
    this.revision = event.revision; return 'applied';
  }
  hydrate(snapshot: Snapshot) {
    this.strokes = structuredClone(snapshot.strokes).sort((a,b) => a.order-b.order);
    this.redoIds = [...snapshot.redoIds]; this.epoch = snapshot.epoch; this.revision = snapshot.revision;
    const queued = this.buffered; this.buffered = []; this.ready = true;
    for (const event of queued) {
      if (event.epoch === this.epoch && event.revision > snapshot.revision) this.receive(event);
    }
    return this.ready;
  }
  disconnect() { this.ready = false; this.buffered = []; }
  private requireSnapshot(event: DrawingEvent): 'resync' {
    this.ready = false; this.buffered = [event]; return 'resync';
  }
}
