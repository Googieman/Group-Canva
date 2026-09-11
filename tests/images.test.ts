import { describe, expect, it } from 'vitest';
import { validateImageBytes } from '../client/images';

describe('local image validation', () => {
  it('validates media signatures and PNG intrinsic dimensions before decoding', () => {
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    new DataView(png.buffer).setUint32(16, 2);
    new DataView(png.buffer).setUint32(20, 3);
    expect(validateImageBytes('image/png', png.buffer, 2, 3)).toBe(true);
    expect(validateImageBytes('image/png', png.buffer, 3, 2)).toBe(false);
    expect(validateImageBytes('image/jpeg', new Uint8Array([255, 216, 255]).buffer, 2, 3)).toBe(true);
    expect(validateImageBytes('image/webp', new TextEncoder().encode('RIFFxxxxWEBP').buffer, 2, 3)).toBe(true);
  });
});
