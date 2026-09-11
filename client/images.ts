import { MAX_ASSET_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, validAsset } from './projects';
import type { StoredAsset } from './storage';

export function validateImageBytes(mimeType: string, bytes: ArrayBuffer, width: number, height: number): boolean {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS || bytes.byteLength > MAX_ASSET_BYTES) return false;
  const data = new Uint8Array(bytes);
  if (mimeType === 'image/png') return data.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => data[index] === byte) && new DataView(bytes).getUint32(16) === width && new DataView(bytes).getUint32(20) === height;
  if (mimeType === 'image/jpeg') return data.length >= 2 && data[0] === 255 && data[1] === 216;
  if (mimeType === 'image/webp') return data.length >= 12 && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP';
  return false;
}

export async function readImageFile(file: File): Promise<{ asset: StoredAsset; source: CanvasImageSource }> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image. SVG and remote images are not supported.');
  if (file.size > MAX_ASSET_BYTES) throw new Error('Images must be 5 MiB or smaller.');
  const bytes = await file.arrayBuffer();
  if (file.type === 'image/png' && !validateImageBytes(file.type, bytes, new DataView(bytes).byteLength >= 24 ? new DataView(bytes).getUint32(16) : 0, new DataView(bytes).byteLength >= 24 ? new DataView(bytes).getUint32(20) : 0)) throw new Error('This image has an invalid PNG signature.');
  const source = typeof createImageBitmap === 'function' ? await createImageBitmap(file) : await loadImage(file);
  const asset: StoredAsset = { id: `asset-${crypto.randomUUID()}`, mimeType: file.type as StoredAsset['mimeType'], width: source.width, height: source.height, bytes };
  if (!validateImageBytes(asset.mimeType, bytes, asset.width, asset.height) || !validAsset(asset)) { if ('close' in source && typeof source.close === 'function') source.close(); throw new Error('Image dimensions or data exceed the project limits.'); }
  return { asset, source };
}

export async function decodeImageAsset(asset: Pick<StoredAsset, 'mimeType' | 'bytes'>): Promise<CanvasImageSource> {
  const blob = new Blob([asset.bytes], { type: asset.mimeType });
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  return loadImage(blob);
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const image = new Image(); const url = URL.createObjectURL(file); image.onload = () => { URL.revokeObjectURL(url); resolve(image); }; image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This image could not be decoded.')); }; image.src = url; });
}
