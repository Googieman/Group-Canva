import { io, type Socket } from 'socket.io-client';
import type { ClientEvents, Command, Cursor, Point, ServerEvents, Snapshot, User } from '../shared/protocol';
import { DrawingState } from './state';

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
  constructor(readonly state: DrawingState, roomId: string, name: string, private callbacks: Callbacks) {
    this.socket = io(import.meta.env.VITE_SERVER_URL || undefined, {
      transports:['websocket'],autoConnect:false,reconnection:true,reconnectionDelay:500,
      reconnectionDelayMax:8000,randomizationFactor:0.5,timeout:20000,
    });
    this.socket.on('connect', () => {
      this.resyncPending = false;
      callbacks.status('syncing','Joining your shared canvas…');
      this.armHydrationTimeout();
      this.socket.emit('room:join',{roomId,name},result => {
        if (!result.ok) { callbacks.error(result.error); this.socket.disconnect(); callbacks.status('disconnected',result.error); }
      });
    });
    this.socket.on('room:snapshot', snapshot => {
      clearTimeout(this.hydrateTimer); this.resyncPending = false;
      const reset = !!state.epoch && state.epoch !== snapshot.epoch;
      if (!state.hydrate(snapshot)) { this.resync(); return; }
      callbacks.snapshot(snapshot,reset); callbacks.users(snapshot.users);
      callbacks.status('connected'); callbacks.drawing();
    });
    this.socket.on('drawing:event', event => {
      const result = state.receive(event);
      if (result === 'resync') this.resync();
      if (result === 'applied') callbacks.drawing();
    });
    this.socket.on('presence:update', users => callbacks.users(users));
    this.socket.on('cursor:update', cursor => callbacks.cursor(cursor));
    this.socket.on('server:error', message => callbacks.error(message));
    this.socket.on('disconnect', () => {
      clearTimeout(this.hydrateTimer); this.resyncPending = false; state.disconnect();
      callbacks.status('disconnected','Connection lost. Reconnecting…');
    });
    this.socket.on('connect_error', () => callbacks.status('disconnected','Unable to connect. Retrying… A sleeping server may take a minute.'));
    this.socket.io.on('reconnect_attempt', () => callbacks.status('connecting','Reconnecting to your canvas…'));
    callbacks.status('connecting'); this.socket.connect();
  }
  send(command: Command) {
    if (!this.socket.connected || !this.state.ready || this.resyncPending) return false;
    // Check connection before emit: Socket.io's offline send buffer must never hold drawing commands.
    this.socket.timeout(8000).emit('command',command,(error,result) => {
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
  destroy() { clearTimeout(this.hydrateTimer); this.socket.disconnect(); }
}
