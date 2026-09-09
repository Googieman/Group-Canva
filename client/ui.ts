import type { Tool, User } from '../shared/protocol';
import './style.css';

export interface ToolSettings { tool: Tool; color: string; width: number }
export interface UI {
  canvas: HTMLCanvasElement;
  cursors: HTMLElement;
  setConnection(status: 'connecting' | 'connected' | 'disconnected' | 'syncing', message?: string): void;
  setUsers(users: User[], selfId: string): void;
  setHistory(canUndo: boolean, canRedo: boolean): void;
  setEmpty(empty: boolean): void;
  notify(message: string): void;
  onToolChange(callback: (settings: ToolSettings) => void): void;
  onUndo(callback: () => void): void;
  onRedo(callback: () => void): void;
}

const icons: Record<string, string> = {
  brush: '<path d="m14.5 4.5 5 5M4 20l4.3-1 12-12a2.8 2.8 0 0 0-4-4l-12 12L4 20Z"/><path d="m4.3 15 4.7 4.2"/>',
  eraser: '<path d="m13 4 7 7a2 2 0 0 1 0 3l-6 6H8l-5-5a2 2 0 0 1 0-3l7-8a2 2 0 0 1 3 0Z"/><path d="m7 9 10 9M13 20h8"/>',
  undo: '<path d="M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12" transform="translate(0 -2)"/>',
  redo: '<path d="m16 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12" transform="translate(0 -2)"/>',
  link: '<path d="m10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4-1 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0)"/>',
  people: '<path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M15 3a4 4 0 0 1 0 8"/><circle cx="9" cy="7" r="4"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
};
const icon = (name: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const colors = [
  ['#5446d4', 'Violet'], ['#262832', 'Ink'], ['#e05263', 'Rose'], ['#df7733', 'Orange'],
  ['#e2b534', 'Sunflower'], ['#298568', 'Green'], ['#3487cb', 'Blue'],
];

export function createUI(root: HTMLElement): UI {
  root.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div class="brand"><img src="/favicon.svg" width="40" height="40" alt="" /><div><h1>Group Canvas<span class="brand-dot">.</span></h1><p>a little space for big ideas</p></div></div>
        <div class="header-actions">
          <div class="people-control"><button class="people-button" type="button" aria-label="Show people in this room" aria-expanded="false" aria-controls="people-panel"><span class="avatar-stack"></span><span class="people-count">Just you</span>${icon('chevron')}</button><div id="people-panel" class="people-panel" hidden><h2>Here together</h2><ul class="people-list"></ul></div></div>
          <button type="button" class="share-button">${icon('link')}<span>Copy invite link</span></button>
        </div>
      </header>
      <main class="workspace" aria-label="Shared whiteboard">
        <div class="board-meta"><div class="board-name"><span class="board-mark" aria-hidden="true"></span>Our shared canvas</div><div class="connection" role="status" aria-live="polite" data-status="connecting"><span class="status-dot" aria-hidden="true"></span><span class="connection-label">Connecting…</span></div></div>
        <div class="board-frame">
          <canvas class="drawing-canvas" aria-label="Shared drawing canvas. Choose a brush and drag to draw." tabindex="0"></canvas>
          <div class="empty-state"><img src="/first-mark.svg" width="176" height="120" alt="" /><h2>Good ideas start with a little scribble.</h2><p>Pick a color. Make your mark. Invite a friend.</p></div>
          <div class="cursor-layer" aria-hidden="true"></div>
          <span class="canvas-corner" aria-hidden="true">a space to think together</span>
        </div>
        <div class="toolbar" role="group" aria-label="Drawing tools">
          <div class="tool-group tool-select" role="group" aria-label="Tool"><button type="button" class="icon-button tool-button" data-tool="brush" aria-label="Brush (B)" title="Brush (B)" aria-pressed="true">${icon('brush')}</button><button type="button" class="icon-button tool-button" data-tool="eraser" aria-label="Eraser (E)" title="Eraser (E)" aria-pressed="false">${icon('eraser')}</button></div>
          <div class="tool-group palette" role="group" aria-label="Brush color">${colors.map(([color,name],i) => `<button type="button" class="color-button" style="--swatch:${color}" data-color="${color}" aria-label="${name}" title="${name}" aria-pressed="${i === 0}"><span>${icon('check')}</span></button>`).join('')}</div>
          <div class="tool-group stroke-width" role="group" aria-label="Stroke width">${[3,6,12].map((width,i)=>`<button type="button" class="width-button" data-width="${width}" aria-label="${['Thin','Medium','Thick'][i]} stroke (${width})" title="${['Thin','Medium','Thick'][i]} stroke" aria-pressed="${width === 6}"><span style="--dot-size:${[4,8,13][i]}px"></span></button>`).join('')}</div>
          <div class="tool-group history" role="group" aria-label="Shared history"><button type="button" class="icon-button undo-button" aria-label="Undo last shared stroke (Ctrl or Command Z)" title="Undo last shared stroke (Ctrl / ⌘ Z)" disabled>${icon('undo')}</button><button type="button" class="icon-button redo-button" aria-label="Redo shared stroke (Ctrl or Command Shift Z)" title="Redo shared stroke (Ctrl / ⌘ Shift Z)" disabled>${icon('redo')}</button></div>
        </div>
      </main>
      <footer class="app-footer"><span class="footer-note"><span class="footer-spark" aria-hidden="true">✳</span>More minds. More possibilities.</span><span class="keyboard-hint"><kbd>B</kbd> brush <kbd>E</kbd> eraser <span class="footer-divider"></span>Undo is shared with everyone</span><span class="mobile-hint">Undo is shared with everyone</span></footer>
      <div class="toast" role="status" aria-live="polite" hidden></div>
    </div>`;
  const el = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const canvas = el<HTMLCanvasElement>('.drawing-canvas');
  const cursors = el('.cursor-layer');
  const undo = el<HTMLButtonElement>('.undo-button');
  const redo = el<HTMLButtonElement>('.redo-button');
  const peopleButton = el<HTMLButtonElement>('.people-button');
  const peoplePanel = el('.people-panel');
  const connection = el('.connection');
  const toast = el('.toast');
  let settings: ToolSettings = { tool: 'brush', color: '#5446d4', width: 6 };
  let onTool: (settings: ToolSettings) => void = () => {};
  let onUndo = () => {};
  let onRedo = () => {};
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function notify(message: string) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
  }
  function updateSettings(next: Partial<ToolSettings>) {
    settings = { ...settings, ...next };
    root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === settings.tool)));
    root.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === settings.color)));
    root.querySelectorAll<HTMLButtonElement>('[data-width]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.width) === settings.width)));
    canvas.dataset.tool = settings.tool;
    onTool({ ...settings });
  }
  root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => button.addEventListener('click', () => updateSettings({ tool: button.dataset.tool as Tool })));
  root.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(button => button.addEventListener('click', () => updateSettings({ color: button.dataset.color!, tool: 'brush' })));
  root.querySelectorAll<HTMLButtonElement>('[data-width]').forEach(button => button.addEventListener('click', () => updateSettings({ width: Number(button.dataset.width) })));
  undo.addEventListener('click', () => onUndo());
  redo.addEventListener('click', () => onRedo());
  peopleButton.addEventListener('click', () => {
    peoplePanel.hidden = !peoplePanel.hidden;
    peopleButton.setAttribute('aria-expanded', String(!peoplePanel.hidden));
  });
  document.addEventListener('pointerdown', event => {
    if (!(event.target instanceof Node) || el('.people-control').contains(event.target)) return;
    peoplePanel.hidden = true;
    peopleButton.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', event => {
    if (event.target instanceof HTMLElement && (event.target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') || event.target.isContentEditable)) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      if (key === 'z') { event.preventDefault(); if (event.shiftKey ? !redo.disabled : !undo.disabled) (event.shiftKey ? onRedo : onUndo)(); }
      if (key === 'y') { event.preventDefault(); if (!redo.disabled) onRedo(); }
      return;
    }
    if (event.altKey) return;
    if (key === 'b' || key === 'e') { event.preventDefault(); updateSettings({ tool: key === 'b' ? 'brush' : 'eraser' }); }
    if (key === 'escape') { peoplePanel.hidden = true; peopleButton.setAttribute('aria-expanded', 'false'); }
  });
  el<HTMLButtonElement>('.share-button').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      notify('Invite link copied. Send it to someone to draw together.');
    } catch {
      notify('Copy the address from your browser to invite someone.');
    }
  });
  const ui: UI = {
    canvas, cursors,
    setConnection(status, message) {
      connection.dataset.status = status;
      el('.connection-label').textContent = message || ({ connecting: 'Connecting…', connected: 'Live together', disconnected: 'Offline · reconnecting…', syncing: 'Syncing canvas…' })[status];
      canvas.setAttribute('aria-disabled', String(status !== 'connected'));
      el('.board-frame').classList.toggle('is-offline', status === 'disconnected');
    },
    setUsers(users, selfId) {
      const ordered = [...users].sort((a,b) => Number(b.id === selfId) - Number(a.id === selfId));
      const stack = el('.avatar-stack');
      const list = el('.people-list');
      stack.replaceChildren(); list.replaceChildren();
      ordered.forEach((user, index) => {
        const avatar = document.createElement('span');
        avatar.className = 'avatar';
        avatar.style.setProperty('--user-color', /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : '#5446d4');
        avatar.textContent = user.name.trim().slice(0,1).toUpperCase() || '?';
        avatar.title = `${user.name}${user.id === selfId ? ' (you)' : ''}`;
        if (index < 3) stack.append(avatar.cloneNode(true));
        const item = document.createElement('li');
        const name = document.createElement('span'); name.textContent = user.name;
        item.append(avatar, name);
        if (user.id === selfId) { const you = document.createElement('span'); you.className = 'you-label'; you.textContent = 'you'; item.append(you); }
        list.append(item);
      });
      el('.people-count').textContent = ordered.length === 1 ? 'Just you' : `${ordered.length} here`;
      peopleButton.setAttribute('aria-label', `Show ${ordered.length} ${ordered.length === 1 ? 'person' : 'people'} in this room`);
      if (!ordered.length) { const item = document.createElement('li'); item.textContent = 'Waiting to join the room…'; list.append(item); el('.people-count').textContent = 'Joining…'; }
    },
    setHistory(canUndo, canRedo) { undo.disabled = !canUndo; redo.disabled = !canRedo; },
    setEmpty(empty) { el('.empty-state').hidden = !empty; },
    notify,
    onToolChange(callback) { onTool = callback; callback({ ...settings }); },
    onUndo(callback) { onUndo = callback; },
    onRedo(callback) { onRedo = callback; },
  };
  ui.setUsers([], '');
  ui.setConnection('connecting');
  return ui;
}
