export const MAX_PNG_SIDE = 4096;
export const MAX_PNG_PIXELS = 16 * 1024 * 1024;

export function exportDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_PNG_SIDE / Math.max(1, width), MAX_PNG_SIDE / Math.max(1, height), Math.sqrt(MAX_PNG_PIXELS / Math.max(1, width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export function canvasToPng(canvas: HTMLCanvasElement, background = '#fffdf8'): Promise<Blob> {
  const size = exportDimensions(canvas.width, canvas.height);
  const output = document.createElement('canvas'); output.width = size.width; output.height = size.height;
  const context = output.getContext('2d'); if (!context) return Promise.reject(new Error('PNG export is unavailable.'));
  context.fillStyle = background; context.fillRect(0, 0, size.width, size.height); context.drawImage(canvas, 0, 0, size.width, size.height);
  return new Promise((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export is unavailable.')), 'image/png'));
}

