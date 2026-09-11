import './style.css';
import { BATCH_INTERVAL, BATCH_SIZE, BOARD_HEIGHT, BOARD_WIDTH, type Point, type Stroke, type User, type Command } from '../shared/protocol';
import { applyDocumentCommand, createHistory, documentToLegacyStrokes, legacyStrokesToDocument, objectBounds, type CanvasObject, type DocumentCommand } from '../shared/document';
import { CanvasBoard } from './canvas';
import { Connection } from './network';
import { DrawingState } from './state';
import { createUI, type EditorTool, type ToolSettings, type ZoomAction } from './ui';
import { CanvasStorage, type LocalFile, type StoredAsset, type WriterLease } from './storage';
import { exportProject, MAX_TOTAL_ASSET_BYTES } from './projects';
import { exportDocumentPng } from './export';
import { decodeImageAsset, readImageFile } from './images';
import { renderHome } from './home';
import { fitCamera, worldToScreen } from './viewport';
import { hitTestObject, constrainDrag } from './objects';
import { diagnostics } from './diagnostics';

const root = document.querySelector<HTMLElement>('#app')!;
const storage = new CanvasStorage();
const params = new URL(location.href).searchParams;
const roomParam = params.get('room');
const fileParam = params.get('file');
const hostParam = params.get('host');

if (!roomParam && !fileParam && !hostParam) {
  void renderHome(root, storage);
} else {
  void startEditor(root, storage, roomParam && /^[a-zA-Z0-9_-]{1,48}$/.test(roomParam) ? roomParam : null, fileParam, hostParam);
}

function randomId(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }
function downloadBlob(blob: Blob, name: string): void { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

async function startEditor(rootElement: HTMLElement, localStorage: CanvasStorage, roomId: string | null, fileId: string | null, hostFileId: string | null): Promise<void> {
  const ui = createUI(rootElement); const state = new DrawingState();
  const isHostSession = !!hostFileId; const sessionRoomId = roomId ?? (isHostSession ? randomId('room').slice(0, 40) : null); const isSharedSession = sessionRoomId !== null;
  let localFile: LocalFile | undefined; let localWriter: WriterLease | undefined; let connection: Connection | undefined; let enabled = false; let selfId = 'local'; let users: User[] = []; let hostCapability: string | undefined; let hostRestored = !isHostSession; let hostRestorePending = isHostSession; let localDocumentMode = false;
  let board!: CanvasBoard;
  let settings: ToolSettings = { tool: 'brush', color: '#5446d4', width: 6, fontSize: 28 };
  let activeId: string | null = null; let offset = 1; const pending: Point[] = []; const predictions = new Map<string, Stroke>();
  let draftObject: CanvasObject | null = null; let draftStart: Point | null = null; let editingTextId: string | null = null; let moveStart: Point | null = null; let moveDelta: Point = { x: 0, y: 0 }; let selectedIds = new Set<string>(); let marqueeStart: Point | null = null; let marqueeEnd: Point | null = null; let marqueeAdditive = false; let shapeShift = false; let leaseId: string | null = null; let leaseTimer: ReturnType<typeof setInterval> | undefined; let textEditor: HTMLTextAreaElement | null = null;
  const loadedAssets = new Map<string, CanvasImageSource>();
  const cursors = new Map<string, { element: HTMLElement; updated: number; point: Point }>();
  let fontReadyScheduled = false;
  async function hydrateAssets(assets: Array<{ id: string; mimeType: StoredAsset['mimeType']; bytes: ArrayBuffer }>): Promise<void> { await Promise.all(assets.map(async asset => { try { loadedAssets.set(asset.id, await decodeImageAsset(asset)); } catch { /* Keep a visible placeholder and allow a later retry. */ } })); if (board) render(); }
  async function loadLocalFile(id: string): Promise<LocalFile | undefined> { return localStorage.getFile(id); }

  if (fileId || hostFileId) {
    try { localFile = await loadLocalFile(fileId ?? hostFileId!); } catch (error) { ui.notify(error instanceof Error ? error.message : 'Saved files are unavailable in this browser.'); return; }
    if (!localFile) { if (fileId || hostFileId) window.location.href = '/'; return; }
    localWriter = await localStorage.claimWriter(fileId ?? hostFileId!);
    state.hydrate({ epoch: `local-${localFile.id}`, revision: localFile.revision, roomId: localFile.id, selfId, strokes: documentToLegacyStrokes(localFile.document), redoIds: [], users: [{ id: selfId, name: 'You', color: '#5446d4' }], document: localFile.document, documentHistory: createHistory() });
    localDocumentMode = true;
    void hydrateAssets(localFile.assets);
    enabled = !isHostSession && !localWriter.readOnly; users = [{ id: selfId, name: 'You', color: '#5446d4' }]; if (localWriter.readOnly) { ui.setReadOnly(true); ui.canvas.closest('.app-shell')?.classList.add('local-read-only'); }
  }
  if (!fileId || hostFileId) {
    connection = new Connection(state, sessionRoomId!, isHostSession ? 'Host' : `Guest ${Math.floor(Math.random() * 9000 + 1000)}`, {
      status(status, message) { enabled = status === 'connected' && (!isHostSession || !hostRestorePending); if (!enabled) discardLocal(); if (!board) return; board.setEnabled(enabled); ui.setConnection(status, message); render(); },
      snapshot(snapshot, reset) { selfId = snapshot.selfId; hostCapability = snapshot.hostCapability; predictions.clear(); pending.length = 0; activeId = null; ui.setFile(isHostSession ? (localFile?.title ?? 'Shared canvas') : `Shared canvas · ${snapshot.roomId}`, 'saved'); const invite = new URL(window.location.href); invite.search = `?room=${encodeURIComponent(snapshot.roomId)}`; ui.setInviteUrl(invite.toString()); if (!isHostSession) ui.setSaveLabel(snapshot.hostWatermark ? 'Saved by host' : 'Waiting for host save'); if (snapshot.assets?.length && connection) void Promise.all(snapshot.assets.map(async meta => { if (loadedAssets.has(meta.id)) return; const bytes = await connection!.downloadAsset(meta.id); if (!bytes) return; try { loadedAssets.set(meta.id, await decodeImageAsset({ mimeType: meta.mimeType, bytes })); } catch { /* Placeholder remains visible when decoding fails. */ } })).then(() => { if (board) render(); }); ui.setReadOnly(isHostSession ? (!snapshot.host || !!localWriter?.readOnly) : true); ui.setHost(!!snapshot.host && isHostSession && !localWriter?.readOnly); if (reset) { hostRestored = false; hostRestorePending = isHostSession; ui.notify('The server restarted. This is a fresh canvas.'); } if (isHostSession && snapshot.host && !localWriter?.readOnly && localFile && hostCapability && connection && !hostRestored) { hostRestored = true; hostRestorePending = true; void connection.restoreHost(localFile.document, localFile.assets, hostCapability).then(result => { hostRestorePending = false; enabled = result.ok && connection !== undefined; board?.setEnabled(enabled); if (!result.ok) { hostRestored = false; ui.notify(result.error); } }); } for (const stroke of snapshot.strokes) if (stroke.userId === selfId && !stroke.completed) connection?.send({ type: 'stroke:cancel', id: stroke.id }); },
      drawing() { render(); if (isHostSession && !hostRestorePending) scheduleSave(); },
      users(value) { users = value; ui.setUsers(users, selfId); for (const [id, cursor] of cursors) if (!users.some(user => user.id === id)) { cursor.element.remove(); cursors.delete(id); } },
      cursor({ userId, point }) { if (userId === selfId) return; const user = users.find(candidate => candidate.id === userId); if (!user) return; if (!point) { cursors.get(userId)?.element.remove(); cursors.delete(userId); return; } let cursor = cursors.get(userId); if (!cursor) { const element = document.createElement('div'); element.className = 'remote-cursor'; const arrow = document.createElement('span'); arrow.className = 'cursor-arrow'; arrow.textContent = '➤'; const label = document.createElement('span'); label.className = 'cursor-label'; label.textContent = user.name; element.append(arrow, label); element.style.setProperty('--cursor-color', user.color); ui.cursors.append(element); cursor = { element, updated: performance.now(), point }; cursors.set(userId, cursor); } cursor.updated = performance.now(); cursor.point = point; const screen = worldToScreen(point, { width: BOARD_WIDTH, height: BOARD_HEIGHT }, board.getCamera()); cursor.element.style.left = `${screen.x / BOARD_WIDTH * 100}%`; cursor.element.style.top = `${screen.y / BOARD_HEIGHT * 100}%`; },
      error(message) { ui.notify(message); }, connectionError(message) { enabled = false; discardLocal(); ui.setConnectionError?.(message); render(); }, ping(label) { ui.setPing(label); }, hostSave(watermark) { if (!isHostSession) ui.setSaveLabel(watermark ? 'Saved by host' : 'Waiting for host save'); }, roomStatus(value) { enabled = value.status === 'active' && (!localWriter || !localWriter.readOnly); if (value.status === 'paused' && isHostSession) void saveNow(); if (value.status === 'ended') { ui.setHost(false); ui.setReadOnly(true); } if (value.status !== 'active') discardLocal(); if (board) board.setEnabled(enabled); if (value.status === 'paused') ui.setConnection('disconnected', value.message ?? 'Waiting for the host to reconnect…'); else if (value.status === 'ended') ui.setConnection('disconnected', value.message ?? 'Session ended.'); else if (value.status === 'active') { ui.setConnection('connected'); render(); } },
    }, isHostSession ? { host: true } : undefined);
    ui.onRetry?.(() => connection?.retry());
    if (!isHostSession) ui.setReadOnly(true);
  }

  function render(): void {
    if (!fontReadyScheduled) {
      fontReadyScheduled = true;
      board.setFontReady(typeof document.fonts === 'undefined' || document.fonts.status === 'loaded');
      void (document.fonts?.ready ?? Promise.resolve()).then(() => board.setFontReady(true));
    }
    const started = diagnostics ? performance.now() : 0;
    const strokes = state.strokes.map(stroke => { const prediction = predictions.get(stroke.id); if (stroke.completed) { predictions.delete(stroke.id); return stroke; } return prediction && prediction.points.length > stroke.points.length ? { ...stroke, points: prediction.points } : stroke; });
    for (const prediction of predictions.values()) if (!strokes.some(stroke => stroke.id === prediction.id)) strokes.push(prediction);
    const objects: CanvasObject[] = [...(state.document?.objects ?? [])]; if (draftObject) objects.push(draftObject); if (moveDelta.x || moveDelta.y) for (const index in objects) { const object = objects[index as unknown as number]; if (object && selectedIds.has(object.id)) objects[index as unknown as number] = { ...object, translation: { x: object.translation.x + moveDelta.x, y: object.translation.y + moveDelta.y } }; }
    board.setStrokes(strokes.sort((a, b) => a.order - b.order)); board.setObjects(objects.sort((a, b) => a.order - b.order)); board.setSelection(selectedIds, marqueeStart && marqueeEnd ? { start: marqueeStart, end: marqueeEnd } : null); board.setAssets(loadedAssets); ui.setEmpty(!strokes.some(stroke => stroke.active && stroke.tool === 'brush')); ui.setHistory(state.canUndo, state.canRedo); diagnostics?.record('predictionMergeMs', performance.now() - started);
  }
  function flush(): void { while (activeId && pending.length && enabled) { const points = pending.splice(0, BATCH_SIZE); if (!send({ type: 'stroke:points', id: activeId, offset, points, operationId: randomId('operation') })) break; offset += points.length; } }
  function discardLocal(): void { activeId = null; pending.length = 0; predictions.clear(); draftObject = null; draftStart = null; releaseSelectionLease(); selectedIds.clear(); moveDelta = { x: 0, y: 0 }; closeTextEditor(); board?.setEnabled(false); cursors.forEach(cursor => cursor.element.remove()); cursors.clear(); }
  function ensureLocalDocumentMode(): void { localDocumentMode = true; if (!state.documentHistory) state.documentHistory = createHistory(); }
  function localStrokeCommand(command: Extract<Command, { type: `stroke:${string}` }> | { type: 'history:undo' } | { type: 'history:redo' }): boolean {
    const changeRevision = state.revision + 1; let change: import('../shared/protocol').Change;
    if (command.type === 'stroke:begin') { if (state.strokes.some(stroke => stroke.userId === selfId && !stroke.completed)) return false; const stroke: Stroke = { id: command.id, userId: selfId, tool: command.tool, color: command.color, width: command.width, points: [command.point], order: Math.max(0, ...state.strokes.map(item => item.order)) + 1, completed: false, completionOrder: null, active: true }; change = { type: 'stroke:begin', stroke }; }
    else if (command.type === 'stroke:points') { const stroke = state.strokes.find(item => item.id === command.id); if (!stroke || stroke.completed || command.offset !== stroke.points.length) return false; change = { type: 'stroke:points', id: command.id, offset: command.offset, points: command.points }; }
    else if (command.type === 'stroke:end' && localDocumentMode) {
      const stroke = state.strokes.find(item => item.id === command.id);
      if (!stroke || stroke.completed || !state.document) return false;
      ensureLocalDocumentMode();
      const completed: Stroke = { ...stroke, completed: true, completionOrder: Math.max(0, ...state.strokes.map(item => item.completionOrder ?? 0)) + 1, active: true };
      const object = legacyStrokesToDocument([completed], state.document.id, state.document.title).objects[0];
      if (!object || !state.documentHistory) return false;
      try {
        const result = applyDocumentCommand(state.document, state.documentHistory, { type: 'object:create', object, operationId: randomId('operation') }, selfId);
        if (!result.transaction) return false;
        state.receive({ epoch: state.epoch, revision: changeRevision, change: { type: 'document:transaction', transaction: result.transaction, document: result.document, history: result.history } });
        render(); scheduleSave(); return true;
      } catch (error) { ui.notify(error instanceof Error ? error.message : 'Stroke completion was rejected.'); return false; }
    }
    else if (command.type === 'stroke:cancel') { change = { type: 'stroke:cancel', id: command.id }; }
    else if (command.type === 'history:undo') { const stroke = [...state.strokes].filter(item => item.active && item.completed).sort((a, b) => (b.completionOrder ?? 0) - (a.completionOrder ?? 0))[0]; if (!stroke) return true; change = { type: 'history:undo', id: stroke.id }; }
    else { const stroke = state.strokes.find(item => item.id === state.redoIds.at(-1)); if (!stroke) return true; change = { type: 'history:redo', id: stroke.id }; }
    state.receive({ epoch: state.epoch, revision: changeRevision, change }); render(); scheduleSave(); return true;
  }
  function localDocumentCommand(command: DocumentCommand): boolean {
    if (!state.document) return false;
    ensureLocalDocumentMode();
    if (!state.documentHistory) return false;
    try {
      const result = applyDocumentCommand(state.document, state.documentHistory, command, selfId); if (!result.transaction && (command.type !== 'history:undo' && command.type !== 'history:redo')) return false;
      const transaction = result.transaction; if (!transaction) return true;
      state.receive({ epoch: state.epoch, revision: state.revision + 1, change: { type: 'document:transaction', transaction, document: result.document, history: result.history } }); render(); scheduleSave(); return true;
    } catch (error) { ui.notify(error instanceof Error ? error.message : 'Edit rejected.'); return false; }
  }
  function send(command: Command): boolean {
    if (!enabled) return false;
    if (command.type === 'object:lease') return isSharedSession ? connection?.send(command) ?? false : true;
    if (isSharedSession) return connection?.send(command) ?? false;
    const historyCommand = command.type === 'history:undo' || command.type === 'history:redo';
    if (historyCommand && localDocumentMode) return localDocumentCommand(command as DocumentCommand);
    if (command.type.startsWith('stroke:') || historyCommand) return localStrokeCommand(command as Extract<Command, { type: `stroke:${string}` }> | { type: 'history:undo' } | { type: 'history:redo' });
    return localDocumentCommand(command as DocumentCommand);
  }
  let saveTimer: ReturnType<typeof setTimeout> | undefined; let maxSaveTimer: ReturnType<typeof setTimeout> | undefined; let saveInProgress = false; let dirtySince = 0; let dirtyVersion = 0;
  function markDirty(): void {
    if (!localFile || localWriter?.readOnly) return;
    dirtyVersion++;
    if (!dirtySince) { dirtySince = Date.now(); maxSaveTimer = setTimeout(() => { void saveNow(); }, 5000); }
    clearTimeout(saveTimer); saveTimer = setTimeout(() => { void saveNow(); }, 1000);
  }
  async function saveNow(): Promise<boolean> {
    if (!localFile || localWriter?.readOnly || saveInProgress) return false;
    saveInProgress = true; const version = dirtyVersion; const title = localFile.title; ui.setFile(title, 'saving');
    try {
      const next = snapshotForSave();
      await localStorage.saveFile(next); localFile = next; if (isHostSession && hostCapability) connection?.hostSaved(hostCapability, state.epoch, state.revision); ui.setFile(title, 'saved');
      if (dirtyVersion === version) { dirtySince = 0; clearTimeout(maxSaveTimer); maxSaveTimer = undefined; }
      else { clearTimeout(saveTimer); saveTimer = setTimeout(() => { void saveNow(); }, 1000); }
      return true;
    } catch (error) { ui.setFile(title, 'error', error instanceof Error ? error.message : 'Unable to save'); return false; }
    finally { saveInProgress = false; }
  }
  function snapshotForSave(): LocalFile { if (!localFile || !state.document) throw new Error('There is no committed canvas to save.'); return { ...localFile, updatedAt: Date.now(), document: { ...state.document, title: localFile.title }, revision: state.revision, camera: board.getCamera(), roomEpoch: isHostSession ? state.epoch : localFile.roomEpoch }; }
  function scheduleSave(): void { if (localFile) markDirty(); }
  function closeTextEditor(): void { textEditor?.remove(); textEditor = null; }
  function commitTextEditor(): void { if (textEditor && draftObject?.type === 'text') commitDraft(); }
  function cancelTextEditor(): void { if (!textEditor && !draftObject) return; closeTextEditor(); draftObject = null; draftStart = null; editingTextId = null; releaseSelectionLease(); render(); }
  function openTextEditor(point: Point, value = ''): void {
    closeTextEditor();
    const editor = document.createElement('textarea'); textEditor = editor; editor.className = 'canvas-text-editor'; editor.value = value; editor.placeholder = 'Type here…';
    editor.addEventListener('pointerdown', event => event.stopPropagation());
    editor.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); cancelTextEditor(); }
      else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); commitTextEditor(); }
    });
    editor.addEventListener('blur', () => { queueMicrotask(() => { if (textEditor === editor) commitTextEditor(); }); });
    const screen = worldToScreen(point, { width: BOARD_WIDTH, height: BOARD_HEIGHT }, board.getCamera()); editor.style.left = `${screen.x / BOARD_WIDTH * 100}%`; editor.style.top = `${screen.y / BOARD_HEIGHT * 100}%`; editor.style.fontSize = `${settings.fontSize * board.getCamera().zoom}px`; ui.canvas.parentElement?.append(editor); editor.focus();
  }
  function startDraft(point: Point): void { draftStart = point; if (settings.tool === 'text') { const existing = [...(state.document?.objects ?? [])].reverse().find(object => object.type === 'text' && hitTestObject(point, object)); if (existing?.type === 'text') { editingTextId = existing.id; selectedIds = new Set([existing.id]); acquireSelectionLease(); draftObject = existing; openTextEditor(existing.translation, existing.text); } else { editingTextId = null; openTextEditor(point); draftObject = { id: randomId('text'), type: 'text', order: Math.max(0, ...state.document?.objects.map(item => item.order) ?? []) + 1, version: 1, translation: point, text: '', width: 320, fontSize: settings.fontSize, color: settings.color, lineHeight: 1.25 }; } } else if (settings.tool === 'rectangle' || settings.tool === 'ellipse' || settings.tool === 'line' || settings.tool === 'arrow') { draftObject = { id: randomId('shape'), type: 'shape', order: Math.max(0, ...state.document?.objects.map(item => item.order) ?? []) + 1, version: 1, translation: point, shape: settings.tool, width: 1, height: 1, strokeColor: settings.color, strokeWidth: settings.width, fill: null }; } }
  function updateDraft(point: Point, shift = false): void {
    if (!draftStart || !draftObject) return;
    if (draftObject.type === 'shape') {
      const geometry = constrainDrag(draftStart, point, draftObject.shape, shift);
      if (draftObject.shape === 'line' || draftObject.shape === 'arrow') {
        draftObject = {
          ...draftObject,
          translation: { x: geometry.x, y: geometry.y },
          width: Math.max(1, Math.abs(geometry.width)),
          height: Math.max(1, Math.abs(geometry.height)),
          start: { x: 0, y: 0 },
          end: { x: geometry.width, y: geometry.height },
        };
      } else {
        const x = Math.min(geometry.x, geometry.x + geometry.width), y = Math.min(geometry.y, geometry.y + geometry.height);
        draftObject = { ...draftObject, translation: { x, y }, width: Math.max(1, Math.abs(geometry.width)), height: Math.max(1, Math.abs(geometry.height)) };
      }
    }
    render();
  }
  function commitDraft(): void { if (!draftObject) return; const object = draftObject; draftObject = null; draftStart = null; if (object.type === 'text') { const text = textEditor?.value ?? ''; closeTextEditor(); if (!text.trim()) { editingTextId = null; releaseSelectionLease(); render(); return; } if (editingTextId) { send({ type: 'object:text', id: editingTextId, text, expectedVersion: object.version, operationId: randomId('operation'), ...(leaseId ? { leaseId } : {}) }); releaseSelectionLease(); editingTextId = null; } else send({ type: 'object:create', object: { ...object, text }, operationId: randomId('operation') }); } else send({ type: 'object:create', object, operationId: randomId('operation') }); render(); }
  function releaseSelectionLease(): void { const current = leaseId; leaseId = null; clearInterval(leaseTimer); leaseTimer = undefined; if (current && isSharedSession) connection?.send({ type: 'object:lease', ids: [...selectedIds], leaseId: current, action: 'release' }); }
  function acquireSelectionLease(): void { if (!isSharedSession || !selectedIds.size || !enabled) return; releaseSelectionLease(); const current = randomId('lease'); leaseId = current; connection?.send({ type: 'object:lease', ids: [...selectedIds], leaseId: current, action: 'acquire' }); leaseTimer = setInterval(() => { if (leaseId === current && enabled) connection?.send({ type: 'object:lease', ids: [...selectedIds], leaseId: current, action: 'renew' }); }, 5000); }
  function selectAt(point: Point, additive: boolean): void { const objects = state.document?.objects ?? []; const hit = [...objects].sort((a, b) => b.order - a.order).find(object => object.type !== 'ink' || object.tool !== 'eraser' ? hitTestObject(point, object) : false); releaseSelectionLease(); marqueeStart = null; marqueeEnd = null; marqueeAdditive = additive; if (!additive) selectedIds.clear(); if (hit) { if (additive && selectedIds.has(hit.id)) selectedIds.delete(hit.id); else selectedIds.add(hit.id); moveStart = point; acquireSelectionLease(); } else { moveStart = null; marqueeStart = point; marqueeEnd = point; } moveDelta = { x: 0, y: 0 }; render(); }
  function selectMarquee(): void { if (!marqueeStart || !marqueeEnd) return; const left = Math.min(marqueeStart.x, marqueeEnd.x), right = Math.max(marqueeStart.x, marqueeEnd.x), top = Math.min(marqueeStart.y, marqueeEnd.y), bottom = Math.max(marqueeStart.y, marqueeEnd.y); releaseSelectionLease(); if (!marqueeAdditive) selectedIds.clear(); for (const object of state.document?.objects ?? []) { if (object.type === 'ink' && object.tool === 'eraser') continue; const bounds = objectBounds(object); if (bounds && bounds.left <= right && bounds.right >= left && bounds.top <= bottom && bounds.bottom >= top) selectedIds.add(object.id); } marqueeStart = null; marqueeEnd = null; acquireSelectionLease(); }
  function deleteSelection(event: KeyboardEvent): void { if ((event.key !== 'Delete' && event.key !== 'Backspace') || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !selectedIds.size || (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'))) return; event.preventDefault(); const expectedVersions: Record<string, number> = {}; for (const object of state.document?.objects ?? []) if (selectedIds.has(object.id)) expectedVersions[object.id] = object.version; if (send({ type: 'object:delete', ids: [...selectedIds], expectedVersions, operationId: randomId('operation'), ...(leaseId ? { leaseId } : {}) })) { releaseSelectionLease(); selectedIds.clear(); render(); } }
  window.addEventListener('keydown', deleteSelection);
  board = new CanvasBoard(ui.canvas, { onBegin(point) { if (!enabled || activeId) return; if (settings.tool === 'brush' || settings.tool === 'eraser') { const id = randomId('stroke'); activeId = id; offset = 1; predictions.set(id, { id, userId: selfId, tool: settings.tool, color: settings.color, width: settings.width, points: [point], order: Number.MAX_SAFE_INTEGER, completed: false, completionOrder: null, active: true }); if (!send({ type: 'stroke:begin', id, tool: settings.tool, color: settings.color, width: settings.width, point, operationId: randomId('operation') })) { discardLocal(); return; } render(); } else if (settings.tool === 'select') return; else if (settings.tool === 'hand') return; else startDraft(point); }, onBeginWithModifiers(point, shift) { if (settings.tool === 'select') selectAt(point, shift); else if (settings.tool === 'rectangle' || settings.tool === 'ellipse' || settings.tool === 'line' || settings.tool === 'arrow') shapeShift = shift; }, onPoints(points) { const point = points.at(-1); if (!point) return; if (activeId && (settings.tool === 'brush' || settings.tool === 'eraser')) { const prediction = predictions.get(activeId); if (!prediction) return; const started = diagnostics ? performance.now() : 0; predictions.set(activeId, { ...prediction, points: [...prediction.points, ...points] }); diagnostics?.record('predictionAppendMs', performance.now() - started); pending.push(...points); if (pending.length >= BATCH_SIZE) flush(); render(); } else if (draftObject) updateDraft(point, shapeShift); else if (marqueeStart) { marqueeEnd = point; render(); } else if (selectedIds.size && moveStart) { moveDelta = { x: point.x - moveStart.x, y: point.y - moveStart.y }; render(); } }, onEnd() { if (activeId && enabled) { flush(); send({ type: 'stroke:end', id: activeId, operationId: randomId('operation') }); activeId = null; } else if (draftObject?.type === 'text') { /* The textarea owns text commit and cancellation. */ } else if (draftObject) commitDraft(); else if (marqueeStart && marqueeEnd) { selectMarquee(); } else if (selectedIds.size && (moveDelta.x || moveDelta.y)) { const expectedVersions: Record<string, number> = {}; for (const object of state.document?.objects ?? []) if (selectedIds.has(object.id)) expectedVersions[object.id] = object.version; send({ type: 'object:move', ids: [...selectedIds], delta: moveDelta, expectedVersions, operationId: randomId('operation'), ...(leaseId ? { leaseId } : {}) }); releaseSelectionLease(); moveDelta = { x: 0, y: 0 }; } shapeShift = false; render(); }, onCancel() { if (activeId) { send({ type: 'stroke:cancel', id: activeId, operationId: randomId('operation') }); predictions.delete(activeId); activeId = null; pending.length = 0; } cancelTextEditor(); marqueeStart = null; marqueeEnd = null; releaseSelectionLease(); moveDelta = { x: 0, y: 0 }; shapeShift = false; render(); }, onCursor(point) { if (isSharedSession) connection?.cursor(point); }, onCameraChange(camera) { ui.setZoom(camera.zoom); if (textEditor && draftObject) { const screen = worldToScreen(draftObject.translation, { width: BOARD_WIDTH, height: BOARD_HEIGHT }, camera); textEditor.style.left = `${screen.x / BOARD_WIDTH * 100}%`; textEditor.style.top = `${screen.y / BOARD_HEIGHT * 100}%`; textEditor.style.fontSize = `${settings.fontSize * camera.zoom}px`; } for (const cursor of cursors.values()) { const screen = worldToScreen(cursor.point, { width: BOARD_WIDTH, height: BOARD_HEIGHT }, board.getCamera()); cursor.element.style.left = `${screen.x / BOARD_WIDTH * 100}%`; cursor.element.style.top = `${screen.y / BOARD_HEIGHT * 100}%`; } scheduleSave(); }, onWidthChange(width) { settings = { ...settings, width }; } });
  ui.onToolChange(next => { settings = next; board.setTool(next.tool === 'eraser' ? 'eraser' : 'brush', next.color, next.width); board.setNavigationMode(next.tool === 'hand'); }); ui.onUndo(() => { send({ type: 'history:undo', operationId: randomId('operation') }); }); ui.onRedo(() => { send({ type: 'history:redo', operationId: randomId('operation') }); }); ui.onSave(() => { void saveNow(); }); ui.onRename(() => { if (!localFile) return; const title = window.prompt('Canvas name', localFile.title)?.trim(); if (!title || title === localFile.title) return; localFile = { ...localFile, title, document: { ...localFile.document, title }, updatedAt: Date.now() }; void saveNow(); }); ui.onEndSession(async () => { if (!isHostSession || !hostCapability || !connection || !window.confirm('End this shared session? Guests will no longer be able to edit it.')) return; const saved = await saveNow(); if (!saved) { ui.notify('Save the latest canvas before ending the session.'); return; } const result = await connection.endSession(hostCapability); if (!result.ok) ui.notify(result.error); }); ui.onDownload(async () => { if (!state.document) return; try { downloadBlob(await exportProject({ version: 1, document: state.document, assets: localFile?.assets ?? [] }), `${localFile?.title ?? 'group-canvas'}.group-canvas.json`); } catch (error) { ui.notify(error instanceof Error ? error.message : 'Unable to download project.'); } }); ui.onExportPng(async () => { if (!state.document) return; try { downloadBlob(await exportDocumentPng(state.document, loadedAssets), `${localFile?.title ?? 'group-canvas'}.png`); } catch (error) { ui.notify(error instanceof Error ? error.message : 'Unable to export PNG.'); } }); ui.onZoom(action => { const camera = board.getCamera(); if (action === 'in') board.setCamera({ ...camera, zoom: camera.zoom * 1.25 }); else if (action === 'out') board.setCamera({ ...camera, zoom: camera.zoom / 1.25 }); else if (action === 'reset') board.setCamera({ x: BOARD_WIDTH / 2, y: BOARD_HEIGHT / 2, zoom: 1 }); else { const bounds = (state.document?.objects ?? []).map(objectBounds).filter((value): value is NonNullable<ReturnType<typeof objectBounds>> => !!value); if (bounds.length) board.setCamera(fitCamera(bounds.reduce((all, value) => ({ left: Math.min(all.left, value.left), top: Math.min(all.top, value.top), right: Math.max(all.right, value.right), bottom: Math.max(all.bottom, value.bottom) }), bounds[0]!), { width: BOARD_WIDTH, height: BOARD_HEIGHT }, 80)); } }); ui.onImageFile(async file => { if (!localFile && !connection) { ui.notify('Images can only be added after joining a canvas.'); return; } try { const { asset, source } = await readImageFile(file); if (localFile && localFile.assets.reduce((total, current) => total + current.bytes.byteLength, 0) + asset.bytes.byteLength > MAX_TOTAL_ASSET_BYTES) throw new Error('This canvas has reached its 20 MiB image limit.'); loadedAssets.set(asset.id, source); if (localFile) localFile = { ...localFile, assets: [...localFile.assets, asset] }; else if (connection) { const upload = await connection.uploadAsset(asset); if (!upload.ok) { ui.notify(upload.error); return; } } state.document = { ...state.document!, assetIds: state.document!.assetIds.includes(asset.id) ? state.document!.assetIds : [...state.document!.assetIds, asset.id] }; const width = Math.min(500, asset.width), height = width * asset.height / asset.width; send({ type: 'object:create', object: { id: randomId('image'), type: 'image', order: Math.max(0, ...state.document!.objects.map(item => item.order)) + 1, version: 1, translation: { x: 800 - width / 2, y: 450 - height / 2 }, assetId: asset.id, intrinsicWidth: asset.width, intrinsicHeight: asset.height, width, height }, operationId: randomId('operation') }); } catch (error) { ui.notify(error instanceof Error ? error.message : 'Unable to add image.'); } });
  let lastCursor = 0; const flushTimer = setInterval(flush, BATCH_INTERVAL); const cursorTimer = setInterval(() => { for (const [id, cursor] of cursors) if (performance.now() - cursor.updated > 6000) { cursor.element.remove(); cursors.delete(id); } }, 1000);
  if (localFile) { ui.setFile(localFile.title, 'saved'); ui.setUsers(users, selfId); ui.setConnection('connected', localWriter?.readOnly ? localWriter.reason : 'Local canvas · saved locally'); if (localWriter?.readOnly) ui.canvas.setAttribute('aria-disabled', 'true'); board.setCamera(localFile.camera); } else ui.setUsers([], ''); board.setEnabled(enabled); render();
  window.addEventListener('pagehide', () => { clearInterval(flushTimer); clearInterval(cursorTimer); clearTimeout(saveTimer); clearTimeout(maxSaveTimer); clearInterval(leaseTimer); releaseSelectionLease(); window.removeEventListener('keydown', deleteSelection); board.destroy(); connection?.destroy(); const pendingSave = localFile ? saveNow() : Promise.resolve(); void pendingSave.finally(() => localWriter?.release()); }, { once: true });
}
