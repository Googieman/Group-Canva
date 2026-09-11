import { afterEach, describe, expect, it } from 'vitest';
import { CanvasStorage, type LocalFile } from '../client/storage';
import { createDocument } from '../shared/document';

describe('local canvas storage', () => {
  let stores: CanvasStorage[] = [];
  afterEach(() => { stores = []; });

  it('saves, lists, reopens, and duplicates a local file', async () => {
    const storage = new CanvasStorage({ forceMemory: true }); stores.push(storage);
    const file: LocalFile = { id: 'file-1', title: 'Idea', createdAt: 1, updatedAt: 2, document: createDocument('doc-1', 'Idea'), assets: [{ id: 'asset-1', mimeType: 'image/png', width: 1, height: 1, bytes: new Uint8Array([1, 2, 3]).buffer }], revision: 0, roomEpoch: null, camera: { x: 0, y: 0, zoom: 1 } };
    await storage.saveFile(file);
    expect((await storage.listFiles()).map(item => item.title)).toEqual(['Idea']);
    expect(await storage.getFile('file-1')).toEqual(file);
    const duplicate = await storage.duplicateFile('file-1', 'file-2');
    expect(duplicate.id).toBe('file-2');
    expect(duplicate.document.id).not.toBe(file.document.id);
    expect((await storage.listFiles()).map(item => item.id)).toEqual(['file-2', 'file-1']);
  });

  it('keeps the previous valid snapshot when a save fails', async () => {
    const storage = new CanvasStorage({ forceMemory: true }); stores.push(storage);
    const original: LocalFile = { id: 'file-1', title: 'Original', createdAt: 1, updatedAt: 2, document: createDocument('doc-1', 'Original'), assets: [], revision: 0, roomEpoch: null, camera: { x: 0, y: 0, zoom: 1 } };
    await storage.saveFile(original);
    storage.failNextSaveForTests();
    await expect(storage.saveFile({ ...original, title: 'Broken' })).rejects.toThrow();
    expect((await storage.getFile('file-1'))?.title).toBe('Original');
  });

  it('allows only one local writer for a file and releases it safely', async () => {
    const firstStorage = new CanvasStorage({ forceMemory: true });
    const secondStorage = new CanvasStorage({ forceMemory: true });
    const first = await firstStorage.claimWriter('file-1');
    const second = await secondStorage.claimWriter('file-1');
    expect(first.readOnly).toBe(false);
    expect(second.readOnly).toBe(true);
    first.release();
    await new Promise(resolve => setTimeout(resolve, 0));
    const third = await secondStorage.claimWriter('file-1');
    expect(third.readOnly).toBe(false);
    expect(first.reason).toBe('');
    expect(second.reason).toBe('Read-only · another tab is editing');
    third.release();
  });
});
