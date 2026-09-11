import { io, type Socket } from 'socket.io-client';
import type { ClientEvents, Command, Cursor, Point, ServerEvents, Snapshot, User } from '../shared/protocol';
import { DrawingState } from './state';
import { diagnostics } from './diagnostics';

export type ConnectionStatus = 'connecting'|'connected'|'disconnected'|'syncing';
interface Callbacks {
  status(status: ConnectionStatus, message?: string): void;
  snapshot(snapshot: Snapshot, reset: boolean): void;
  drawing(): void;
  users(users: User[]): void;
  cursor(cursor: Cursor): void;
  error(message: string): void;
}
export class Connection {
  private socket: Socket<ServerEvents, ClientEvents>;
  private resyncPending = false;
  private hydrateTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private destroyed = false;
  constructor(readonly state: DrawingState, roomId: string, name: string, private callbacks: Callbacks) {
    const configuredServerUrl = import.meta.env.VITE_SERVER_URL?.trim();
    const hostedDemoUrl = typeof window !== 'undefined' && window.location.hostname === 'group-canva.pages.dev'
      ? 'https://group-canvas.onrender.com'
      : undefined;
    this.socket = io(configuredServerUrl || hostedDemoUrl || undefined, {
      transports:['websocket'],autoConnect:false,reconnection:true,reconnectionDelay:500,
      reconnectionDelayMax:8000,randomizationFactor:0.5,timeout:20000,
    });
    this.socket.on('connect', () => {
      const generation = ++this.generation;
      clearTimeout(this.reconnectTimer);
      this.resyncPending = false;
      callbacks.status('syncing','Joining your shared canvas…');
      this.armHydrationTimeout();
      this.socket.emit('room:join',{roomId,name},result => {
        if (generation !== this.generation || !this.socket.connected) return;
        if (!result.ok) { callbacks.error(result.error); this.socket.disconnect(); callbacks.status('disconnected',result.error); }
      });
    });
    this.socket.on('room:snapshot', snapshot => {
      if (!this.socket.connected || snapshot.roomId !== roomId || snapshot.selfId !== this.socket.id) return;
      clearTimeout(this.hydrateTimer); this.resyncPending = false;
      const reset = !!state.epoch && state.epoch !== snapshot.epoch;
      if (!state.hydrate(snapshot)) { this.resync(); return; }
      this.generation++;
      callbacks.snapshot(snapshot,reset); callbacks.users(snapshot.users);
      callbacks.status('connected'); callbacks.drawing();
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
      const started = diagnostics ? performance.now() : 0;
      const result = state.receive(event);
      diagnostics?.record('receiveToReduceMs',performance.now()-started);
      if (result === 'resync') this.resync();
      if (result === 'applied') callbacks.drawing();
    });
    this.socket.on('presence:update', users => callbacks.users(users));
    this.socket.on('cursor:update', cursor => callbacks.cursor(cursor));
    this.socket.on('server:error', message => callbacks.error(message));
    this.socket.on('disconnect', reason => {
      this.generation++;
      clearTimeout(this.hydrateTimer); this.resyncPending = false; state.disconnect();
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
    this.socket.on('connect_error', () => callbacks.status('disconnected','Unable to connect. Retrying… A sleeping server may take a minute.'));
    this.socket.io.on('reconnect_attempt', () => callbacks.status('connecting','Reconnecting to your canvas…'));
    callbacks.status('connecting'); this.socket.connect();
  }
  send(command: Command) {
    if (!this.socket.connected || !this.state.ready || this.resyncPending) return false;
    const started = diagnostics ? performance.now() : 0;
    const generation = this.generation;
    if (command.type === 'stroke:points') diagnostics?.batch(command.points.length);
    // Check connection before emit: Socket.io's offline send buffer must never hold drawing commands.
    this.socket.timeout(8000).emit('command',command,(error,result) => {
      if (generation !== this.generation || !this.socket.connected || this.destroyed) return;
      diagnostics?.record('commandAckMs',performance.now()-started);
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
  private armHydrationTimeout() {
    clearTimeout(this.hydrateTimer);
    this.hydrateTimer = setTimeout(() => {
      this.socket.disconnect(); this.socket.connect();
    },15000);
  }
  destroy() {
    this.destroyed = true; this.generation++;
    clearTimeout(this.hydrateTimer); clearTimeout(this.reconnectTimer); this.socket.disconnect();
  }
}
