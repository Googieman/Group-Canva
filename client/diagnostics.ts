/** Opt-in, bounded local diagnostics. No drawing content or telemetry leaves the browser. */
export class Diagnostics {
  private samples = new Map<string, number[]>();
  private started = performance.now();
  private lastBatch = 0;
  private batches = 0;
  private frames = 0;
  private lastFrame = 0;
  private inputs: number[] = [];
  record(name: string, value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    let values = this.samples.get(name);
    if (!values) this.samples.set(name, values = []);
    if (values.length < 20000) values.push(value);
  }
  input(timestamp: number) { if (this.inputs.length < 512) this.inputs.push(timestamp); }
  painted() {
    const now = performance.now();
    const inputs = this.inputs; this.inputs = [];
    for (const stamp of inputs) this.record('pointerToRenderMs', now - stamp);
    // Next rAF is a presentation opportunity proxy, not a physical display measurement.
    if (inputs.length) requestAnimationFrame(time => {
      for (const stamp of inputs) this.record('pointerToNextFrameMs', time - stamp);
    });
  }
  frame(timestamp: number) {
    this.frames++;
    if (this.lastFrame) this.record('frameIntervalMs', timestamp - this.lastFrame);
    this.lastFrame = timestamp;
  }
  batch(points: number) {
    const now = performance.now(); this.batches++;
    if (this.lastBatch) this.record('batchIntervalMs', now - this.lastBatch);
    this.lastBatch = now; this.record('batchPoints', points);
  }
  reset() {
    this.samples.clear(); this.started = performance.now();
    this.lastBatch = this.lastFrame = this.frames = this.batches = 0; this.inputs = [];
  }
  report() {
    const elapsedMs = performance.now() - this.started;
    return {
      elapsedMs, frames: this.frames, fps: this.frames * 1000 / elapsedMs,
      batches: this.batches, batchesPerSecond: this.batches * 1000 / elapsedMs,
      metrics: Object.fromEntries([...this.samples].map(([name, values]) => {
        const sorted = [...values].sort((a,b) => a-b);
        const quantile = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length*q)-1)] ?? null;
        return [name,{count:values.length,p50:quantile(.5),p95:quantile(.95),max:sorted.at(-1) ?? null}];
      })),
    };
  }
}
declare global { interface Window { canvasDiagnostics?: Diagnostics } }
export const diagnostics = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('diagnostics') === '1'
  ? (window.canvasDiagnostics = new Diagnostics()) : undefined;
if (diagnostics) {
  const frame = (time: number) => { diagnostics.frame(time); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
}
