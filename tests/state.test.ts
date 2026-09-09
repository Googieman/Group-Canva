import { describe, expect, it } from 'vitest';
import { DrawingState } from '../client/state';
import type { DrawingEvent, Snapshot, Stroke } from '../shared/protocol';
const stroke: Stroke = { id:'s1',userId:'u1',tool:'brush',color:'#000000',width:4,points:[{x:1,y:2}],order:1,completed:false,completionOrder:null,active:true };
const snapshot = (revision=0,epoch='a'): Snapshot => ({ epoch,revision,roomId:'playground',selfId:'u1',strokes:[],redoIds:[],users:[] });
const begin = (revision=1): DrawingEvent => ({ epoch:'a',revision,change:{type:'stroke:begin',stroke} });
describe('authoritative client state', () => {
  it('buffers events during hydration and ignores snapshot-covered duplicates', () => {
    const state = new DrawingState(); state.receive(begin());
    expect(state.hydrate(snapshot())).toBe(true);
    expect(state.strokes).toHaveLength(1); expect(state.revision).toBe(1);
    expect(state.receive(begin())).toBe('ignored'); expect(state.strokes).toHaveLength(1);
  });
  it('requires another snapshot on gaps without applying partial future history', () => {
    const state = new DrawingState(); state.hydrate(snapshot());
    expect(state.receive(begin(2))).toBe('resync'); expect(state.ready).toBe(false);
    expect(state.strokes).toHaveLength(0);
    expect(state.hydrate({...snapshot(2),strokes:[stroke]})).toBe(true);
    expect(state.strokes).toHaveLength(1);
  });
  it('resets epochs and discards disconnected buffers', () => {
    const state = new DrawingState(); state.hydrate(snapshot()); state.receive(begin());
    expect(state.receive({ ...begin(2),epoch:'b' })).toBe('resync');
    state.disconnect(); state.hydrate(snapshot(0,'b'));
    expect(state.strokes).toEqual([]); expect(state.epoch).toBe('b');
  });
  it('applies global undo/redo in original visual order and clears redo on completion', () => {
    const state = new DrawingState(); state.hydrate(snapshot()); state.receive(begin());
    const send=(change:DrawingEvent['change']) => state.receive({epoch:'a',revision:state.revision+1,change});
    send({type:'stroke:end',id:'s1',completionOrder:1});
    expect(state.canUndo).toBe(true);
    send({type:'history:undo',id:'s1'}); expect(state.canRedo).toBe(true); expect(state.strokes[0].active).toBe(false);
    send({type:'history:redo',id:'s1'}); expect(state.strokes[0].order).toBe(1);
    send({type:'history:undo',id:'s1'});
    send({type:'stroke:begin',stroke:{...stroke,id:'s2',order:2}});
    send({type:'stroke:end',id:'s2',completionOrder:2});
    expect(state.canRedo).toBe(false); expect(state.strokes.map(s=>s.id)).toEqual(['s2']);
  });
  it('rejects a mismatched point offset and recovers from snapshot', () => {
    const state = new DrawingState(); state.hydrate(snapshot()); state.receive(begin());
    expect(state.receive({epoch:'a',revision:2,change:{type:'stroke:points',id:'s1',offset:7,points:[{x:2,y:3}]}})).toBe('resync');
    expect(state.strokes[0].points).toHaveLength(1);
  });
  it('does not mutate snapshots or previous stroke objects when points append', () => {
    const state = new DrawingState(); const snap={...snapshot(1),strokes:[stroke]}; state.hydrate(snap);
    const old=state.strokes[0]; state.receive({epoch:'a',revision:2,change:{type:'stroke:points',id:'s1',offset:1,points:[{x:3,y:4}]}});
    expect(stroke.points).toHaveLength(1); expect(old.points).toHaveLength(1); expect(state.strokes[0].points).toHaveLength(2);
  });
});
