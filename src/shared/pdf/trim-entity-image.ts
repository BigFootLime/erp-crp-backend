import { PNG } from "pngjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 25_000_000;

type Band = { start: number; end: number; ink: number };

function strongestBand(counts: number[], significance: number, mergeGap: number): Band | null {
  const active = counts
    .map((count, index) => ({ count, index }))
    .filter(({ count }) => count >= significance);
  if (!active.length) return null;

  const bands: Band[] = [];
  let current: Band = { start: active[0].index, end: active[0].index, ink: active[0].count };
  for (const item of active.slice(1)) {
    if (item.index - current.end <= mergeGap) {
      current.end = item.index;
      current.ink += item.count;
    } else {
      bands.push(current);
      current = { start: item.index, end: item.index, ink: item.count };
    }
  }
  bands.push(current);
  return bands.reduce((best, band) => (band.ink > best.ink ? band : best));
}

/**
 * Crops uniform/transparent borders from a PNG used as an entity logo.
 * The original GED bytes remain immutable; this only normalises the render
 * copy. A strongest-band heuristic ignores isolated export watermarks.
 */
export function trimEntityImageForRender(bytes: Buffer): Buffer {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return bytes;

  try {
    const encodedWidth = bytes.readUInt32BE(16);
    const encodedHeight = bytes.readUInt32BE(20);
    if (!encodedWidth || !encodedHeight || encodedWidth * encodedHeight > MAX_PIXELS) return bytes;

    const image = PNG.sync.read(bytes);
    const { width, height, data } = image;
    const cornerOffsets = [0, (width - 1) * 4, (height - 1) * width * 4, (height * width - 1) * 4];
    const background = cornerOffsets.reduce(
      (value, offset) => ({
        r: value.r + data[offset],
        g: value.g + data[offset + 1],
        b: value.b + data[offset + 2],
        a: value.a + data[offset + 3],
      }),
      { r: 0, g: 0, b: 0, a: 0 }
    );
    background.r /= 4;
    background.g /= 4;
    background.b /= 4;
    background.a /= 4;

    const foreground = (offset: number) => {
      const alpha = data[offset + 3];
      if (alpha <= 16) return false;
      if (background.a <= 16) return true;
      return Math.max(
        Math.abs(data[offset] - background.r),
        Math.abs(data[offset + 1] - background.g),
        Math.abs(data[offset + 2] - background.b),
        Math.abs(alpha - background.a)
      ) > 24;
    };

    const rowCounts = Array<number>(height).fill(0);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (foreground((y * width + x) * 4)) rowCounts[y] += 1;
      }
    }
    const rowBand = strongestBand(
      rowCounts,
      Math.max(2, Math.floor(width * 0.001)),
      Math.max(4, Math.floor(height * 0.03))
    );
    if (!rowBand) return bytes;

    const columnCounts = Array<number>(width).fill(0);
    for (let y = rowBand.start; y <= rowBand.end; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (foreground((y * width + x) * 4)) columnCounts[x] += 1;
      }
    }
    const activeColumns = columnCounts
      .map((count, index) => ({ count, index }))
      .filter(({ count }) => count >= Math.max(2, Math.floor((rowBand.end - rowBand.start + 1) * 0.002)));
    if (!activeColumns.length) return bytes;

    const rawLeft = activeColumns[0].index;
    const rawRight = activeColumns[activeColumns.length - 1].index;
    const paddingX = Math.max(4, Math.floor((rawRight - rawLeft + 1) * 0.04));
    const paddingY = Math.max(4, Math.floor((rowBand.end - rowBand.start + 1) * 0.04));
    const left = Math.max(0, rawLeft - paddingX);
    const right = Math.min(width - 1, rawRight + paddingX);
    const top = Math.max(0, rowBand.start - paddingY);
    const bottom = Math.min(height - 1, rowBand.end + paddingY);
    const croppedWidth = right - left + 1;
    const croppedHeight = bottom - top + 1;
    if (croppedWidth >= width * 0.92 && croppedHeight >= height * 0.92) return bytes;

    const cropped = new PNG({ width: croppedWidth, height: croppedHeight });
    for (let row = 0; row < croppedHeight; row += 1) {
      const sourceStart = ((top + row) * width + left) * 4;
      data.copy(cropped.data, row * croppedWidth * 4, sourceStart, sourceStart + croppedWidth * 4);
    }
    return PNG.sync.write(cropped);
  } catch {
    return bytes;
  }
}
