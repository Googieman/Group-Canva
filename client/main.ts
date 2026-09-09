import './style.css';
import { BATCH_INTERVAL, BATCH_SIZE, DEFAULT_ROOM, type Point, type Stroke, type Tool, type User } from '../shared/protocol';
import { CanvasBoard } from './canvas';
import { Connection } from './network';
import { DrawingState } from './state';
import { createUI } from './ui';

const ui = createUI(document.querySelector<HTMLElement>('#app')!);
const state = new DrawingState();
let selfId = '', users: User[] = [], enabled = false;
let settings: {tool:Tool;color:string;width:number} = {tool:'brush',color:'#5446d4',width:6};
let activeId: string|null = null;
const predictions = new Map<string,Stroke>();
const pending: Point[] = [];
let offset = 1;
let connection: Connection;
const cursors = new Map<string, {element:HTMLElement;updated:number}>();
function render() {
  const strokes = state.strokes.map(s => {
    const prediction = predictions.get(s.id);
    if (s.completed) { predictions.delete(s.id); return s; }
    return prediction && prediction.points.length > s.points.length ? {...s,points:prediction.points} : s;
  });
  for (const [id,prediction] of predictions) if (!strokes.some(s => s.id === id)) strokes.push(prediction);
  board.setStrokes(strokes.sort((a,b) => a.order-b.order));
  ui.setEmpty(!strokes.some(s => s.active && s.tool === 'brush'));
  ui.setHistory(enabled && state.canUndo, enabled && state.canRedo);
}
function flush() {
  while (activeId && pending.length && enabled) {
    const points = pending.splice(0,BATCH_SIZE);
    if (!connection.send({type:'stroke:points',id:activeId,offset,points})) break;
    offset += points.length;
  }
}
function discardLocal() {
  activeId = null; pending.length = 0; predictions.clear();
  board.setEnabled(false); cursors.forEach(c => c.element.remove()); cursors.clear();
}
let lastCursor = 0;
const board = new CanvasBoard(ui.canvas,{
  onBegin(point) {
    if (!enabled || activeId) return;
    const id = crypto.randomUUID(); activeId = id; offset = 1;
    predictions.set(id,{id,userId:selfId,...settings,points:[point],order:Number.MAX_SAFE_INTEGER,completed:false,completionOrder:null,active:true});
    if (!connection.send({type:'stroke:begin',id,...settings,point})) { discardLocal(); return; }
    render();
  },
  onPoints(points) {
    if (!activeId || !enabled) return;
    const prediction = predictions.get(activeId);
    if (!prediction) return;
    predictions.set(activeId,{...prediction,points:[...prediction.points,...points]});
    pending.push(...points); if (pending.length >= BATCH_SIZE) flush(); render();
  },
  onEnd() { if (activeId && enabled) { flush(); connection.send({type:'stroke:end',id:activeId}); activeId = null; } },
  onCancel() {
    if (activeId) { connection?.send({type:'stroke:cancel',id:activeId}); predictions.delete(activeId); activeId = null; pending.length = 0; render(); }
  },
  onCursor(point) {
    const now = performance.now();
    if (point === null || now-lastCursor >= 40) { connection?.cursor(point); lastCursor = now; }
  },
});
ui.onToolChange(value => { settings = value; board.setTool(value.tool,value.color,value.width); });
ui.onUndo(() => { if (enabled) connection.send({type:'history:undo'}); });
ui.onRedo(() => { if (enabled) connection.send({type:'history:redo'}); });
const roomParam = new URL(location.href).searchParams.get('room');
const roomId = roomParam && /^[a-zA-Z0-9_-]{1,40}$/.test(roomParam) ? roomParam : DEFAULT_ROOM;
const name = `Guest ${Math.floor(Math.random()*9000+1000)}`;
connection = new Connection(state,roomId,name,{
  status(status,message) {
    enabled = status === 'connected';
    if (!enabled) discardLocal();
    board.setEnabled(enabled); ui.setConnection(status,message); render();
  },
  snapshot(snapshot,reset) {
    selfId = snapshot.selfId; predictions.clear(); pending.length = 0; activeId = null;
    if (reset) ui.notify('The server restarted. This is a fresh canvas.');
    // Hydration interrupted the pointer gesture. Cancel any unfinished operation owned by this socket.
    for (const s of snapshot.strokes) if (s.userId === selfId && !s.completed) connection.send({type:'stroke:cancel',id:s.id});
  },
  drawing: render,
  users(value) {
    users = value; ui.setUsers(users,selfId);
    for (const [id,cursor] of cursors) if (!users.some(u => u.id === id)) { cursor.element.remove(); cursors.delete(id); }
  },
  cursor({userId,point}) {
    if (userId === selfId) return;
    const user = users.find(u => u.id === userId); if (!user) return;
    if (!point) { cursors.get(userId)?.element.remove(); cursors.delete(userId); return; }
    let cursor = cursors.get(userId);
    if (!cursor) {
      const element = document.createElement('div'); element.className = 'remote-cursor';
      const arrow = document.createElement('span'); arrow.className = 'cursor-arrow'; arrow.textContent = '➤';
      const label = document.createElement('span'); label.className = 'cursor-label'; label.textContent = user.name;
      element.append(arrow,label); element.style.setProperty('--cursor-color',user.color);
      ui.cursors.append(element); cursor = {element,updated:performance.now()}; cursors.set(userId,cursor);
    }
    cursor.updated = performance.now(); cursor.element.style.left = `${point.x/1600*100}%`; cursor.element.style.top = `${point.y/900*100}%`;
  },
  error(message) { ui.notify(message); },
});
const flushTimer = setInterval(flush,BATCH_INTERVAL);
const cursorTimer = setInterval(() => { for (const [id,c] of cursors) if (performance.now()-c.updated>6000) { c.element.remove(); cursors.delete(id); } },1000);
window.addEventListener('pagehide',() => { clearInterval(flushTimer);clearInterval(cursorTimer);board.destroy();connection.destroy(); },{once:true});
