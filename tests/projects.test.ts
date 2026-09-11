import { describe, expect, it } from 'vitest';
import { exportProject, importProject, type ProjectFile } from '../client/projects';
import { createDocument } from '../shared/document';

describe('editable project files', () => {
  it('round-trips versioned document data and embedded image bytes', async () => {
    const project: ProjectFile = {
      version: 1, document: createDocument('doc-1', 'Imported'),
      assets: [{ id: 'asset-1', mimeType: 'image/png', width: 1, height: 1, bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]).buffer }],
    };
    const parsed = await importProject(await exportProject(project));
    expect(parsed.document).toEqual(project.document);
    expect([...new Uint8Array(parsed.assets[0]!.bytes)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('rejects unsupported project versions and oversized assets', async () => {
    await expect(importProject(JSON.stringify({ version: 99, document: createDocument('doc-1'), assets: [] }))).rejects.toThrow(/version/i);
    await expect(importProject(JSON.stringify({ version: 1, document: createDocument('doc-1'), assets: [{ id: 'asset-1', mimeType: 'image/png', width: 1, height: 1, bytes: 'A'.repeat(8 * 1024 * 1024) }] }))).rejects.toThrow(/asset|size/i);
  });
});
