import { describe, expect, it } from 'vitest';
import { exportDimensions } from '../client/export';

describe('PNG export bounds', () => {
  it('keeps normal exports at source size', () => {
    expect(exportDimensions(1600, 900)).toEqual({ width: 1600, height: 900 });
  });
  it('scales oversized content under both side and pixel limits', () => {
    const size = exportDimensions(10_000, 8_000);
    expect(size.width).toBeLessThanOrEqual(4096);
    expect(size.height).toBeLessThanOrEqual(4096);
    expect(size.width * size.height).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});
