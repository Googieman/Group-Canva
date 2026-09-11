import type { CanvasDocument, DocumentHistory } from '../shared/document';

export interface StoredAsset {
  id: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  bytes: ArrayBuffer;
}

export interface LocalFile {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  document: CanvasDocument;
  history?: DocumentHistory;
  assets: StoredAsset[];
  revision: number;
  roomEpoch: string | null;
  /** Host-only recovery credential; never included in project exports or invite URLs. */
  hostCapability?: string;
  camera: { x: number; y: number; zoom: number };
}

interface StoredFile extends Omit<LocalFile, 'assets'> { }
interface DBStoredAsset extends StoredAsset { fileId: string }
interface StorageOptions { dbName?: string; forceMemory?: boolean; indexedDB?: IDBFactory }
export interface WriterLease { readOnly: boolean; reason: string; release(): void }

const memoryFiles = new Map<string, LocalFile>();
const memoryAssets = new Map<string, DBStoredAsset>();
const memoryWriters = new Map<string, string>();

function copy<T>(value: T): T { return structuredClone(value); }
function randomId(prefix: string): string {
  try { return `${prefix}-${crypto.randomUUID()}`; } catch { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

export class CanvasStorage {
  private readonly dbName: string;
  private readonly factory?: IDBFactory;
  private readonly memory: boolean;
  private dbPromise?: Promise<IDBDatabase>;
  private failNextSave = false;

  async claimWriter(fileId: string): Promise<WriterLease> {
    const locks = (typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: { request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void> | void): Promise<void> } }).locks : undefined);
    if (locks) {
      let acquired = false;
      let releaseLock = () => {};
      let resolveRelease!: () => void;
      let resolveAcquired!: (value: boolean) => void;
      const acquiredResult = new Promise<boolean>(resolve => { resolveAcquired = resolve; });
      const held = new Promise<void>(resolve => { resolveRelease = resolve; });
      void locks.request(`group-canvas:${fileId}`, { ifAvailable: true }, lock => {
        if (!lock) { resolveAcquired(false); return; }
        acquired = true;
        releaseLock = resolveRelease;
        resolveAcquired(true);
        return held;
      }).catch(() => resolveAcquired(false));
      if (await acquiredResult && acquired) return { readOnly: false, reason: '', release: () => releaseLock() };
      return { readOnly: true, reason: 'Read-only · another tab is editing', release: () => {} };
    }
    const key = `group-canvas-writer:${fileId}`;
    const owner = randomId('writer');
    const now = Date.now();
    if (memoryWriters.has(fileId)) return { readOnly: true, reason: 'Read-only · another tab is editing', release: () => {} };
    memoryWriters.set(fileId, owner);
    try {
      const current = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
      const parsed = current ? JSON.parse(current) as { owner?: string; expiresAt?: number } : undefined;
      if (parsed?.owner && (parsed.expiresAt ?? 0) > now) { memoryWriters.delete(fileId); return { readOnly: true, reason: 'Read-only · another tab is editing', release: () => {} }; }
      const record = { owner, expiresAt: now + 15_000 };
      localStorage.setItem(key, JSON.stringify(record));
      if (localStorage.getItem(key) !== JSON.stringify(record)) { memoryWriters.delete(fileId); return { readOnly: true, reason: 'Read-only · another tab is editing', release: () => {} }; }
      const heartbeat = setInterval(() => { try { const latest = localStorage.getItem(key); if (latest?.includes(`\"owner\":\"${owner}\"`)) localStorage.setItem(key, JSON.stringify({ owner, expiresAt: Date.now() + 15_000 })); } catch { /* storage can disappear during page lifetime */ } }, 5_000);
      const release = () => { clearInterval(heartbeat); if (memoryWriters.get(fileId) === owner) memoryWriters.delete(fileId); try { const latest = localStorage.getItem(key); if (latest?.includes(`\"owner\":\"${owner}\"`)) localStorage.removeItem(key); } catch { /* storage can disappear during page close */ } };
      return { readOnly: false, reason: '', release };
    } catch {
      // Private browsing and disabled storage still permit a safe single-tab writer.
      return { readOnly: false, reason: '', release: () => { if (memoryWriters.get(fileId) === owner) memoryWriters.delete(fileId); } };
    }
  }

  constructor(options: StorageOptions = {}) {
    this.dbName = options.dbName ?? 'group-canvas';
    this.factory = options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
    this.memory = !!options.forceMemory || !this.factory;
  }

  async listFiles(): Promise<LocalFile[]> {
    if (this.memory) return [...memoryFiles.values()].map(file => this.memoryFile(file)).sort((a, b) => b.updatedAt - a.updatedAt);
    const db = await this.open();
    return this.transaction(db, 'readonly', ['files', 'assets'], async tx => {
      const files = await this.request<StoredFile[]>(tx.objectStore('files').getAll());
      const assets = await this.request<DBStoredAsset[]>(tx.objectStore('assets').getAll());
      return files.map(file => ({ ...file, assets: assets.filter(asset => asset.fileId === file.id).map(({ fileId: _fileId, ...asset }) => asset) })).sort((a, b) => b.updatedAt - a.updatedAt) as LocalFile[];
    });
  }

  async getFile(id: string): Promise<LocalFile | undefined> {
    if (this.memory) {
      const file = memoryFiles.get(id);
      return file ? this.memoryFile(file) : undefined;
    }
    const db = await this.open();
    return this.transaction(db, 'readonly', ['files', 'assets'], async tx => {
      const file = await this.request<StoredFile | undefined>(tx.objectStore('files').get(id));
      if (!file) return undefined;
      const assets = await this.request<DBStoredAsset[]>(tx.objectStore('assets').index('fileId').getAll(id));
      return { ...file, assets: assets.map(({ fileId: _fileId, ...asset }) => asset) } as LocalFile;
    });
  }

  async saveFile(file: LocalFile): Promise<void> {
    if (this.failNextSave) { this.failNextSave = false; throw new Error('Unable to save this canvas on the device.'); }
    const next = copy(file);
    if (this.memory) {
      const previous = memoryFiles.get(next.id);
      try {
        memoryFiles.set(next.id, copy({ ...next, assets: [] }));
        for (const key of memoryAssets.keys()) if (key.startsWith(`${next.id}:`)) memoryAssets.delete(key);
        for (const asset of next.assets) memoryAssets.set(`${next.id}:${asset.id}`, copy({ ...asset, fileId: next.id }));
      } catch (error) {
        if (previous) memoryFiles.set(next.id, previous); else memoryFiles.delete(next.id);
        throw error;
      }
      return;
    }
    const db = await this.open();
    await this.transaction(db, 'readwrite', ['files', 'assets'], async tx => {
      const assetsStore = tx.objectStore('assets');
      const previousAssets = await this.request<DBStoredAsset[]>(assetsStore.index('fileId').getAll(next.id));
      for (const asset of previousAssets) assetsStore.delete([next.id, asset.id]);
      tx.objectStore('files').put({ ...next, assets: [] });
      for (const asset of next.assets) assetsStore.put({ ...asset, fileId: next.id });
    });
  }

  async duplicateFile(sourceId: string, duplicateId = randomId('file')): Promise<LocalFile> {
    const source = await this.getFile(sourceId);
    if (!source) throw new Error('Canvas file not found.');
    const now = Date.now();
        const duplicate: LocalFile = { ...copy(source), id: duplicateId, createdAt: now, updatedAt: now, document: { ...copy(source.document), id: randomId('document') }, roomEpoch: null, hostCapability: undefined, revision: 0 };
    await this.saveFile(duplicate);
    return duplicate;
  }

  async deleteFile(id: string): Promise<void> {
    if (this.memory) {
      memoryFiles.delete(id);
      for (const key of memoryAssets.keys()) if (key.startsWith(`${id}:`)) memoryAssets.delete(key);
      return;
    }
    const db = await this.open();
    await this.transaction(db, 'readwrite', ['files', 'assets'], async tx => {
      const assets = await this.request<DBStoredAsset[]>(tx.objectStore('assets').index('fileId').getAll(id));
      assets.forEach(asset => tx.objectStore('assets').delete([id, asset.id]));
      tx.objectStore('files').delete(id);
    });
  }

  /** Test hook for proving an interrupted write does not replace a valid snapshot. */
  failNextSaveForTests(): void { this.failNextSave = true; }

  private open(): Promise<IDBDatabase> {
    return this.dbPromise ??= new Promise((resolve, reject) => {
      const request = this.factory!.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('assets')) {
          const assets = db.createObjectStore('assets', { keyPath: ['fileId', 'id'] });
          assets.createIndex('fileId', 'fileId');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open local storage.'));
    });
  }

  private memoryFile(file: LocalFile): LocalFile {
    return copy({ ...file, assets: [...memoryAssets.values()].filter(asset => asset.fileId === file.id).map(({ fileId: _fileId, ...asset }) => asset) });
  }

  private request<T>(request: IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result as T); request.onerror = () => reject(request.error ?? new Error('Local storage request failed.')); });
  }

  private transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, stores: string[], run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('Local storage transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Local storage transaction was aborted.'));
      void run(tx).then(value => { result = value; }).catch(error => { try { tx.abort(); } catch { /* transaction already finished */ } reject(error); });
    });
  }
}
