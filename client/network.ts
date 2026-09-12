import { io, type Socket } from 'socket.io-client';
import type { CanvasDocument } from '../shared/document';
import { PROTOCOL_VERSION } from '../shared/protocol';
import type { AssetMeta, ClientEvents, Command, Cursor, Point, ServerEvents, Snapshot, User, Result } from '../shared/protocol';
import { DrawingState } from './state';

export type ConnectionStatus = 'connecting'|'connected'|'disconnected'|'syncing';
interface Callbacks {
  status(status: ConnectionStatus, message?: string): void;
  snapshot(snapshot: Snapshot, reset: boolean): void;
  drawing(): void;
  users(users: User[]): void;
  cursor(cursor: Cursor): void;
  error(message: string): void;
  ping?(label: string): void;
  roomStatus?(status: { status: 'active' | 'paused' | 'ended'; message?: string }): void;
  hostSave?(watermark: { epoch: string; revision: number } | null): void;
  connectionError?(message: string): void;
  asset?(asset: AssetMeta): void;
}
interface ConnectionOptions { host?: boolean; hostCapability?: string }
export function resolveSocketEndpoint(): string | undefined {
  const configuredServerUrl = import.meta.env.VITE_SERVER_URL?.trim();
  if (configuredServerUrl) return configuredServerUrl;
  if (typeof window !== 'undefined' && window.location.hostname === 'group-canva.pages.dev') return 'https://group-canvas.onrender.com';
  return undefined;
}
export function medianLatency(samples: readonly number[]): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}
export class Connection {
  private socket: Socket<ServerEvents, ClientEvents>;
  private resyncPending = false;
  private hydrateTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private destroyed = false;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pingOutstanding = false;
  private pingSamples: number[] = [];
  private roomPaused = false;
  private assetToken: string | undefined;
  private assetIds = new Set<string>();
  private everHydrated = false;
  private failed = false;
  constructor(readonly state: DrawingState, private readonly roomId: string, private readonly name: string, private callbacks: Callbacks, private readonly options: ConnectionOptions = {}) {
    this.socket = io(resolveSocketEndpoint(), {
      transports:['websocket'],autoConnect:false,reconnection:true,reconnectionDelay:500,
      reconnectionDelayMax:8000,randomizationFactor:0.5,timeout:20000,
    });
    this.socket.on('connect', () => {
      if (this.failed) return;
      const generation = ++this.generation;
      clearTimeout(this.reconnectTimer);
      this.resyncPending = false;
      callbacks.status('syncing','Joining your shared canvas…');
      this.armHydrationTimeout();
      this.socket.emit('room:join',{roomId,name, protocolVersion: PROTOCOL_VERSION, ...(options.host ? { host: true } : {}), ...(options.hostCapability ? { hostCapability: options.hostCapability } : {})},result => {
        if (generation !== this.generation || !this.socket.connected) return;
        if (!result.ok) { callbacks.error(result.error); this.socket.disconnect(); callbacks.status('disconnected',result.error); }
      });
    });
    this.socket.on('room:snapshot', snapshot => {
      if (!this.socket.connected || snapshot.roomId !== roomId || snapshot.selfId !== this.socket.id) return;
      clearTimeout(this.hydrateTimer); this.resyncPending = false;
      const reset = !!state.epoch && state.epoch !== snapshot.epoch;
      if (snapshot.protocolVersion !== undefined && snapshot.protocolVersion !== 2) { callbacks.error('This session uses an incompatible Group Canvas version. Update and try again.'); this.socket.disconnect(); return; }
      this.roomPaused = snapshot.roomStatus === 'paused' || snapshot.roomStatus === 'ended';
      this.assetToken = snapshot.assetToken;
      this.assetIds = new Set(snapshot.assets?.map(asset => asset.id) ?? []);
      if (snapshot.hostCapability && this.options.host) this.options.hostCapability = snapshot.hostCapability;
      if (!state.hydrate(snapshot)) { this.resync(); return; }
      this.everHydrated = true;
      this.failed = false;
      this.generation++;
      callbacks.snapshot(snapshot,reset); callbacks.users(snapshot.users); callbacks.roomStatus?.({ status: snapshot.roomStatus ?? 'active' });
      callbacks.status('connected'); callbacks.drawing(); this.startPings();
    });
    this.socket.on('drawing:event', event => {
      // A packet from a transport that was closed during reconnect must not
      // become the first event of the new room lifetime. The next snapshot is
      // authoritative for an epoch change.
      // Snapshots are authoritative while a connection is joining or
      // recovering. Dropping packets in that window prevents a late event
      // from an older transport lifetime from pinning the reducer to a stale
      // epoch; the snapshot already contains every committed revision up to
      // its capture point.
      if (!this.socket.connected || !this.state.ready) return;
      const result = state.receive(event);
      if (result === 'resync') this.resync();
      if (result === 'applied') {
        callbacks.drawing();
      }
    });
    this.socket.on('presence:update', users => callbacks.users(users));
    this.socket.on('cursor:update', cursor => callbacks.cursor(cursor));
    this.socket.on('asset:update', asset => { this.assetIds.add(asset.id); callbacks.asset?.(asset); });
    this.socket.on('server:error', message => callbacks.error(message));
    this.socket.on('room:status', status => { this.roomPaused = status.status !== 'active'; callbacks.roomStatus?.(status); });
    this.socket.on('room:host-save', watermark => callbacks.hostSave?.(watermark));
    this.socket.on('disconnect', reason => {
      this.generation++;
      clearTimeout(this.hydrateTimer); this.resyncPending = false; state.disconnect();
      this.stopPings(); callbacks.ping?.('Ping unavailable');
      callbacks.status('disconnected','Connection lost. Reconnecting…');
      // Socket.io does not automatically reconnect after a server disconnect,
      // including our server's slow-peer eviction. Normal transport loss uses
      // the manager's existing exponential backoff.
      if (reason === 'io server disconnect' && !this.destroyed) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          if (!this.destroyed) this.socket.connect();
        },500 + Math.random()*500);
      }
    });
    this.socket.on('connect_error', () => { if (!this.failed) callbacks.status('disconnected','Unable to connect. Retrying… A sleeping server may take a minute.'); });
    this.socket.io.on('reconnect_attempt', () => callbacks.status('connecting','Reconnecting to your canvas…'));
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibilityChange);
    callbacks.status('connecting'); this.armHydrationTimeout(); this.socket.connect();
  }
  send(command: Command) {
    if (!this.socket.connected || !this.state.ready || this.resyncPending || this.roomPaused) return false;
    const generation = this.generation;
    // Check connection before emit: Socket.io's offline send buffer must never hold drawing commands.
    this.socket.timeout(8000).emit('command',command,(error,result) => {
      if (generation !== this.generation || !this.socket.connected || this.destroyed) return;
      if (error || !result?.ok) {
        this.callbacks.error(error || !result ? 'A drawing update was not confirmed. Resyncing…' : !result.ok ? result.error : 'Resyncing…');
        this.resync();
      }
    });
    return true;
  }
  cursor(point: Point|null) {
    if (this.socket.connected && this.state.ready) this.socket.volatile.emit('cursor:update',point);
  }
  resync() {
    if (!this.socket.connected || this.resyncPending) return;
    this.generation++;
    this.resyncPending = true; this.state.ready = false;
    this.callbacks.status('syncing','Refreshing the shared canvas…');
    this.armHydrationTimeout(); this.socket.emit('room:resync');
  }
  retry(): void {
    if (this.destroyed) return;
    this.failed = false;
    this.generation++;
    this.state.disconnect();
    this.callbacks.status('connecting', 'Retrying…');
    this.armHydrationTimeout();
    if (this.socket.connected) this.socket.disconnect();
    this.socket.connect();
  }
  private armHydrationTimeout() {
    clearTimeout(this.hydrateTimer);
    this.hydrateTimer = setTimeout(() => {
      if (this.destroyed || this.everHydrated || this.failed) return;
      this.failed = true;
      this.generation++;
      this.socket.disconnect();
      this.stopPings();
      this.callbacks.connectionError?.('Unable to connect');
    },15000);
  }
  destroy() {
    this.destroyed = true; this.generation++;
    clearTimeout(this.hydrateTimer); clearTimeout(this.reconnectTimer); this.stopPings(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibilityChange); this.socket.disconnect();
  }

  async uploadAsset(asset: { id: string; mimeType: string; bytes: ArrayBuffer }): Promise<Result> {
    if (!this.assetToken) return { ok: false, error: 'The room asset credential is not ready.' };
    const base = resolveSocketEndpoint() || '';
    try {
      const response = await fetch(`${base}/api/rooms/${encodeURIComponent(this.roomId)}/assets`, { method: 'POST', headers: { 'content-type': asset.mimeType, 'x-room-token': this.assetToken, 'x-asset-id': asset.id }, body: asset.bytes });
      if (!response.ok) { const value = await response.json().catch(() => ({})) as { error?: string }; return { ok: false, error: value.error ?? 'The image could not be uploaded.' }; }
      this.assetIds.add(asset.id);
      return { ok: true };
    } catch { return { ok: false, error: 'The image could not be uploaded.' }; }
  }

  async downloadAsset(assetId: string): Promise<ArrayBuffer | undefined> {
    if (!this.assetToken) return undefined;
    const base = resolveSocketEndpoint() || '';
    try {
      const response = await fetch(`${base}/api/rooms/${encodeURIComponent(this.roomId)}/assets/${encodeURIComponent(assetId)}`, { headers: { 'x-room-token': this.assetToken } });
      return response.ok ? await response.arrayBuffer() : undefined;
    } catch { return undefined; }
  }

  restoreHost(document: CanvasDocument, assets: Array<{ id: string; mimeType: string; bytes: ArrayBuffer }>, capability: string, source?: { epoch: string | null; revision: number }): Promise<Result> {
    return (async () => {
      for (const asset of assets) { if (this.assetIds.has(asset.id)) continue; const result = await this.uploadAsset(asset); if (!result.ok) return result; }
      if (!this.assetToken) return { ok: false, error: 'The room recovery credential is not ready.' };
      const base = resolveSocketEndpoint() || '';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(`${base}/api/rooms/${encodeURIComponent(this.roomId)}/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-room-token': this.assetToken },
          body: JSON.stringify({ capability, document, ...(source ? { sourceEpoch: source.epoch, sourceRevision: source.revision } : {}) }),
          signal: controller.signal,
        });
        const value = await response.json().catch(() => ({})) as Result;
        return response.ok && value.ok ? value : { ok: false, error: !value.ok && value.error ? value.error : 'The saved canvas could not be restored.' };
      } catch { return { ok: false, error: 'The saved canvas could not be restored before the recovery window expired.' }; }
      finally { clearTimeout(timeout); }
    })();
  }

  hostSaved(capability: string, epoch: string, revision: number): void { if (this.socket.connected) this.socket.emit('room:host-saved', { capability, epoch, revision }); }
  endSession(capability: string): Promise<Result> { return new Promise(resolve => this.socket.emit('room:end', { capability }, resolve)); }

  private startPings(): void {
    if (this.pingTimer || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    this.probePing();
    this.pingTimer = setInterval(() => this.probePing(), 10_000);
  }

  private stopPings(): void { clearInterval(this.pingTimer); this.pingTimer = undefined; this.pingOutstanding = false; }

  private probePing(): void {
    if (!this.socket.connected || !this.state.ready || this.destroyed || this.pingOutstanding || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    this.pingOutstanding = true;
    const started = performance.now();
    this.socket.timeout(5000).emit('latency:ping', (error?: Error) => {
      this.pingOutstanding = false;
      if (error) { this.callbacks.ping?.('Ping unavailable'); return; }
      this.pingSamples = [...this.pingSamples, Math.max(0, performance.now() - started)].slice(-5);
      const median = medianLatency(this.pingSamples);
      this.callbacks.ping?.(median === null ? 'Ping unavailable' : `Ping ${Math.round(median)} ms`);
    });
  }

  private readonly onVisibilityChange = (): void => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') this.stopPings(); else if (this.state.ready) this.startPings();
  };
}
