import { validateDocument, type CanvasDocument } from '../shared/document';
import type { StoredAsset } from './storage';

export const PROJECT_VERSION = 1 as const;
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 4096;
export const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;

export interface ProjectFile {
  version: typeof PROJECT_VERSION;
  document: CanvasDocument;
  assets: StoredAsset[];
}

interface WireProject {
  version: number;
  document: unknown;
  assets: Array<{ id: string; mimeType: string; width: number; height: number; bytes: string }>;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const array = new Uint8Array(bytes);
  let value = '';
  for (let index = 0; index < array.length; index += 0x8000) value += String.fromCharCode(...array.subarray(index, index + 0x8000));
  return btoa(value);
}

function base64ToBytes(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw new Error('Project contains invalid asset data.');
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

export function validAsset(asset: unknown): asset is StoredAsset {
  if (!asset || typeof asset !== 'object') return false;
  const value = asset as Partial<StoredAsset>;
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.id) || !['image/png', 'image/jpeg', 'image/webp'].includes(value.mimeType as string)) return false;
  if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width! < 1 || value.height! < 1 || value.width! > MAX_IMAGE_SIDE || value.height! > MAX_IMAGE_SIDE || value.width! * value.height! > MAX_IMAGE_PIXELS || !(value.bytes instanceof ArrayBuffer) || value.bytes.byteLength > MAX_ASSET_BYTES) return false;
  const bytes = new Uint8Array(value.bytes);
  if (value.mimeType === 'image/png' && (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) || new DataView(value.bytes).getUint32(16) !== value.width || new DataView(value.bytes).getUint32(20) !== value.height)) return false;
  if (value.mimeType === 'image/jpeg' && (bytes.length < 2 || bytes[0] !== 255 || bytes[1] !== 216)) return false;
  if (value.mimeType === 'image/webp' && (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP')) return false;
  return true;
}

function validateProject(project: unknown): asserts project is ProjectFile {
  if (!project || typeof project !== 'object') throw new Error('Project must be a JSON object.');
  const value = project as Partial<ProjectFile>;
  if (value.version !== PROJECT_VERSION) throw new Error('Unsupported project version. Update Group Canvas before importing this file.');
  const documentResult = validateDocument(value.document);
  if (!documentResult.ok) throw new Error(documentResult.error);
  if (!Array.isArray(value.assets) || value.assets.length > 10_000) throw new Error('Project asset list is invalid.');
  const ids = new Set<string>();
  let total = 0;
  for (const asset of value.assets) {
    if (!validAsset(asset) || ids.has(asset.id)) throw new Error('Project contains invalid or duplicate asset data.');
    ids.add(asset.id); total += asset.bytes.byteLength;
    if (total > MAX_TOTAL_ASSET_BYTES) throw new Error('Project asset size limit exceeded.');
  }
  for (const assetId of value.document!.assetIds) if (!ids.has(assetId)) throw new Error('Project references a missing asset.');
}

export async function exportProject(project: ProjectFile): Promise<Blob> {
  validateProject(project);
  const wire: WireProject = { version: PROJECT_VERSION, document: project.document, assets: project.assets.map(asset => ({ ...asset, bytes: bytesToBase64(asset.bytes) })) };
  return new Blob([JSON.stringify(wire)], { type: 'application/json' });
}

export async function importProject(input: Blob | string | ArrayBuffer): Promise<ProjectFile> {
  const source = typeof input === 'string' ? input : input instanceof Blob ? await input.text() : new TextDecoder().decode(input);
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new Error('This file is not a valid Group Canvas project.'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Project must be a JSON object.');
  const wire = parsed as Partial<WireProject>;
  if (wire.version !== PROJECT_VERSION) throw new Error('Unsupported project version. Update Group Canvas before importing this file.');
  if (!Array.isArray(wire.assets)) throw new Error('Project asset list is invalid.');
  const assets = wire.assets.map(asset => ({ id: asset.id, mimeType: asset.mimeType, width: asset.width, height: asset.height, bytes: base64ToBytes(asset.bytes) })) as unknown as StoredAsset[];
  const project = { version: PROJECT_VERSION, document: wire.document, assets } as unknown as ProjectFile;
  validateProject(project);
  return structuredClone(project);
}
