import { MAX_ASSET_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, validAsset } from './projects';
import type { StoredAsset } from './storage';

export async function readImageFile(file: File): Promise<{ asset: StoredAsset; source: CanvasImageSource }> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image. SVG and remote images are not supported.');
  if (file.size > MAX_ASSET_BYTES) throw new Error('Images must be 5 MiB or smaller.');
  const bytes = await file.arrayBuffer();
  const source = typeof createImageBitmap === 'function' ? await createImageBitmap(file) : await loadImage(file);
  const asset: StoredAsset = { id: `asset-${crypto.randomUUID()}`, mimeType: file.type as StoredAsset['mimeType'], width: source.width, height: source.height, bytes };
  if (asset.width < 1 || asset.height < 1 || asset.width > MAX_IMAGE_SIDE || asset.height > MAX_IMAGE_SIDE || asset.width * asset.height > MAX_IMAGE_PIXELS || !validAsset(asset)) { if ('close' in source && typeof source.close === 'function') source.close(); throw new Error('Image dimensions or data exceed the project limits.'); }
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
