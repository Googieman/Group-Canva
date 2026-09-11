import { describe, expect, it } from 'vitest';
import { constrainDrag, hitTestObject } from '../client/objects';
import type { CanvasObject } from '../shared/document';

const rectangle: CanvasObject = { id:'r',type:'shape',order:1,version:1,translation:{x:20,y:30},shape:'rectangle',width:100,height:60,strokeColor:'#000000',strokeWidth:4,fill:null };

describe('canvas object geometry', () => {
  it('hits shapes from the topmost visual object down', () => {
    expect(hitTestObject({ x: 50, y: 50 }, rectangle, 0)).toBe(true);
    expect(hitTestObject({ x: 200, y: 50 }, rectangle, 0)).toBe(false);
  });

  it('constrains rectangles to squares and lines to 45 degree increments', () => {
    expect(constrainDrag({ x: 10, y: 20 }, { x: 80, y: 60 }, 'rectangle', true)).toEqual({ x: 10, y: 20, width: 70, height: 70 });
    expect(constrainDrag({ x: 10, y: 20 }, { x: 80, y: 53 }, 'line', true)).toEqual({ x: 10, y: 20, width: 70, height: 70 });
  });
});
