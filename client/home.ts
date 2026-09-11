import { createDocument } from '../shared/document';
import { importProject } from './projects';
import { CanvasStorage, type LocalFile } from './storage';
import './style.css';

function id(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }
function freshFile(title = 'Untitled canvas'): LocalFile {
  const now = Date.now();
  return { id: id('file'), title, createdAt: now, updatedAt: now, document: createDocument(id('document'), title), assets: [], revision: 0, roomEpoch: null, camera: { x: 800, y: 450, zoom: 1 } };
}
function go(fileId: string): void { window.location.href = `/?file=${encodeURIComponent(fileId)}`; }
function formatDate(time: number): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time); }

export async function renderHome(root: HTMLElement, storage: CanvasStorage): Promise<void> {
  root.innerHTML = `<div class="home-shell"><header class="home-header"><div class="brand"><img src="/favicon.svg" width="40" height="40" alt="" /><div><h1>Group Canvas<span class="brand-dot">.</span></h1><p>a little space for big ideas</p></div></div><button class="new-canvas-button" type="button">New canvas</button></header><main class="home-main"><div class="home-heading"><div><p class="eyebrow">Your workspace</p><h2>My canvases</h2><p>Everything you create here stays on this device.</p></div><button class="import-button" type="button">Import project</button><input class="project-picker" type="file" accept="application/json,.json" hidden /></div><section class="file-list" aria-label="Saved canvases"></section><div class="home-empty" hidden><img src="/first-mark.svg" width="176" height="120" alt="" /><h3>No canvases yet</h3><p>Create a new canvas or import an editable project to get started.</p></div></main><footer class="home-footer">Saved locally in this browser · Download a project for a portable backup</footer><div class="toast" role="status" aria-live="polite" hidden></div></div>`;
  const list = root.querySelector<HTMLElement>('.file-list')!, empty = root.querySelector<HTMLElement>('.home-empty')!, toast = root.querySelector<HTMLElement>('.toast')!;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = (message: string) => { clearTimeout(toastTimer); toast.textContent = message; toast.hidden = false; toastTimer = setTimeout(() => { toast.hidden = true; }, 4000); };
  const refresh = async () => {
    let files: LocalFile[] = [];
    try { files = await storage.listFiles(); } catch { notify('Local files are unavailable in this browser.'); }
    list.replaceChildren(); empty.hidden = files.length > 0;
    for (const file of files) {
      const row = document.createElement('article'); row.className = 'file-card';
      const info = document.createElement('button'); info.className = 'file-card-main'; info.type = 'button';
      const title = document.createElement('strong'); title.textContent = file.title;
      const date = document.createElement('span'); date.textContent = `Edited ${formatDate(file.updatedAt)}`; info.append(title, date); info.addEventListener('click', () => go(file.id));
      const actions = document.createElement('div'); actions.className = 'file-card-actions';
      const action = (label: string, handler: () => void) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', handler); actions.append(button); };
      action('Rename', async () => { const next = window.prompt('Canvas name', file.title)?.trim(); if (!next || next === file.title) return; await storage.saveFile({ ...file, title: next, updatedAt: Date.now(), document: { ...file.document, title: next } }); await refresh(); });
      action('Duplicate', async () => { await storage.duplicateFile(file.id); await refresh(); });
      action('Host', () => { window.location.href = `/?host=${encodeURIComponent(file.id)}`; });
      action('Delete', async () => { if (!window.confirm(`Delete “${file.title}”?`)) return; await storage.deleteFile(file.id); await refresh(); });
      row.append(info, actions); list.append(row);
    }
  };
  root.querySelector<HTMLButtonElement>('.new-canvas-button')!.addEventListener('click', async () => { const file = freshFile(); await storage.saveFile(file); go(file.id); });
  const picker = root.querySelector<HTMLInputElement>('.project-picker')!;
  root.querySelector<HTMLButtonElement>('.import-button')!.addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => { const file = picker.files?.[0]; picker.value = ''; if (!file) return; try { const project = await importProject(file); const next = freshFile(project.document.title); await storage.saveFile({ ...next, document: { ...project.document, id: next.document.id, title: next.title }, assets: project.assets }); go(next.id); } catch (error) { notify(error instanceof Error ? error.message : 'Unable to import that project.'); } });
  await refresh();
}
