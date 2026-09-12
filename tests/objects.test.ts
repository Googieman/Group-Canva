import { describe, expect, it } from 'vitest';
import { constrainDrag, hitTestObject, shapesHitByEraser } from '../client/objects';
import { renderDocumentObject } from '../client/canvas';
import type { CanvasObject } from '../shared/document';

const rectangle: CanvasObject = { id:'r',type:'shape',order:1,version:1,translation:{x:20,y:30},shape:'rectangle',width:100,height:60,strokeColor:'#000000',strokeWidth:4,fill:null };

describe('canvas object geometry', () => {
  it('finds shapes crossed by an eraser stroke, including between sampled points', () => {
    expect(
      shapesHitByEraser(
        [
          { x: 0, y: 60 },
          { x: 140, y: 60 },
        ],
        8,
        [rectangle],
      ),
    ).toEqual(['r']);
  });

  it('hits shapes from the topmost visual object down', () => {
    expect(hitTestObject({ x: 50, y: 50 }, rectangle, 0)).toBe(true);
    expect(hitTestObject({ x: 200, y: 50 }, rectangle, 0)).toBe(false);
  });

  it('constrains rectangles to squares and lines to 45 degree increments', () => {
    expect(constrainDrag({ x: 10, y: 20 }, { x: 80, y: 60 }, 'rectangle', true)).toEqual({ x: 10, y: 20, width: 70, height: 70 });
    expect(constrainDrag({ x: 10, y: 20 }, { x: 80, y: 53 }, 'line', true)).toEqual({ x: 10, y: 20, width: 70, height: 70 });
  });

  it('preserves negative drag direction for line and arrow endpoints', () => {
    expect(constrainDrag({ x: 100, y: 120 }, { x: 40, y: 50 }, 'line', false)).toEqual({
      x: 100, y: 120, width: -60, height: -70,
    });
    expect(constrainDrag({ x: 100, y: 120 }, { x: 40, y: 50 }, 'arrow', true)).toEqual({
      x: 100, y: 120, width: -70, height: -70,
    });
  });

  it('hit-tests translated ink and line endpoints', () => {
    const ink: CanvasObject = {
      id: 'ink', type: 'ink', order: 1, version: 1, translation: { x: 100, y: 80 },
      userId: 'u', tool: 'brush', color: '#000000', width: 8, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      completed: true, completionOrder: 1, active: true,
    };
    const line: CanvasObject = {
      id: 'line', type: 'shape', order: 2, version: 1, translation: { x: 100, y: 120 },
      shape: 'line', width: -60, height: -70, strokeColor: '#000000', strokeWidth: 4, fill: null,
    };
    expect(hitTestObject({ x: 150, y: 80 }, ink, 0)).toBe(true);
    expect(hitTestObject({ x: 70, y: 85 }, line, 0)).toBe(true);
  });

  it('renders multiline text through the shared document object renderer', () => {
    const calls: Array<[string, number, number]> = [];
    const context = {
      globalCompositeOperation: 'source-over', fillStyle: '', font: '', textBaseline: '',
      fillText(text: string, x: number, y: number) { calls.push([text, x, y]); },
    } as unknown as CanvasRenderingContext2D;
    const text: CanvasObject = {
      id: 'text', type: 'text', order: 1, version: 1, translation: { x: 20, y: 30 },
      text: 'first line\nsecond line', width: 240, fontSize: 20, color: '#000000', lineHeight: 1.25,
    };
    renderDocumentObject(context, text, new Map(), true);
    expect(calls).toEqual([['first line', 20, 30], ['second line', 20, 55]]);
  });
});
