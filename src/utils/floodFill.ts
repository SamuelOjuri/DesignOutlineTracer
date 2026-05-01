import { Point } from "@/types/roof";

/**
 * Flood fill with edge-aware boundary detection for roof plan PDFs.
 * Rebuilt for performance: no barrier-bridging, clean scanline fill.
 */

const DEFAULT_COLOR_TOLERANCE = 150;
const DEFAULT_EDGE_THRESHOLD = 60;

export interface FloodFillResult {
  filledImageData: ImageData;
  boundaryPoints: Point[];
  filledPixelCount: number;
  filledMask: Uint8Array;
}

/**
 * Build an edge-strength map using separable box filters.
 * Returns Uint8Array where higher values = stronger edges.
 */
export function buildEdgeMap(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const size = width * height;
  const bright = new Float32Array(size);
  const map = new Uint8Array(size);

  // Brightness
  for (let i = 0; i < size; i++) {
    const idx = i * 4;
    bright[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  // Separable box blur (radius 2) for average brightness
  const r = 2;
  const tempH = new Float32Array(size);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0, count = 0;
    for (let x = 0; x <= r && x < width; x++) { sum += bright[row + x]; count++; }
    for (let x = 0; x < width; x++) {
      tempH[row + x] = sum / count;
      const rx = x + r + 1;
      if (rx < width) { sum += bright[row + rx]; count++; }
      const lx = x - r;
      if (lx >= 0) { sum -= bright[row + lx]; count--; }
    }
  }

  // Vertical pass
  const avgBright = new Float32Array(size);
  for (let x = 0; x < width; x++) {
    let sum = 0, count = 0;
    for (let y = 0; y <= r && y < height; y++) { sum += tempH[y * width + x]; count++; }
    for (let y = 0; y < height; y++) {
      avgBright[y * width + x] = sum / count;
      const ry = y + r + 1;
      if (ry < height) { sum += tempH[ry * width + x]; count++; }
      const ly = y - r;
      if (ly >= 0) { sum -= tempH[ly * width + x]; count--; }
    }
  }

  // Edge = how much darker than surroundings
  for (let i = 0; i < size; i++) {
    const contrast = avgBright[i] - bright[i];
    map[i] = contrast > 0 ? Math.min(255, Math.round(contrast)) : 0;
  }

  // Line-continuity boost for candidate edge pixels
  const boosted = new Uint8Array(map);
  const dirs: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const ci = y * width + x;
      if (map[ci] < 15) continue;
      let bestContinuity = 0;
      for (const [ddx, ddy] of dirs) {
        let lineScore = 0;
        for (const sign of [-1, 1]) {
          for (let step = 1; step <= 2; step++) {
            const ni = (y + ddy * sign * step) * width + (x + ddx * sign * step);
            if (ni >= 0 && ni < size) lineScore += map[ni];
          }
        }
        if (lineScore > bestContinuity) bestContinuity = lineScore;
      }
      if (bestContinuity > 80) {
        boosted[ci] = Math.min(255, map[ci] + (bestContinuity >> 2));
      }
    }
  }

  return boosted;
}

/**
 * Scanline-based flood fill. No barrier bridging — clean and fast.
 */
export function floodFill(
  imageData: ImageData,
  startX: number,
  startY: number,
  fillColor: [number, number, number, number] = [255, 0, 0, 100],
  existingMask?: Uint8Array,
  sensitivity: number = 50,
  preserveInteriorHoles: boolean = false
): FloodFillResult {
  const { width, height, data } = imageData;
  const size = width * height;

  const sensRatio = sensitivity / 50;
  const colorTolerance = DEFAULT_COLOR_TOLERANCE * sensRatio;
  const edgeThreshold = Math.max(15, DEFAULT_EDGE_THRESHOLD + (sensitivity - 50) * 1.0);

  const startIdx = (startY * width + startX) * 4;
  const targetR = data[startIdx];
  const targetG = data[startIdx + 1];
  const targetB = data[startIdx + 2];

  const combinedMask = existingMask ? new Uint8Array(existingMask) : new Uint8Array(size);

  if (existingMask && existingMask[startY * width + startX]) {
    const result = new ImageData(new Uint8ClampedArray(data), width, height);
    return {
      filledImageData: result,
      boundaryPoints: extractBoundary(existingMask, width, height),
      filledPixelCount: 0,
      filledMask: existingMask,
    };
  }

  const edgeMap = buildEdgeMap(data, width, height);
  const visited = new Uint8Array(size);
  let newFilledCount = 0;

  // Scanline flood fill
  const stack = new Int32Array(Math.min(size * 2, 4_000_000));
  let stackPtr = 0;
  stack[stackPtr++] = startX;
  stack[stackPtr++] = startY;

  function canFill(pixelIdx: number): boolean {
    if (combinedMask[pixelIdx]) return true;
    if (edgeMap[pixelIdx] > edgeThreshold) return false;
    const idx = pixelIdx * 4;
    const dist = Math.abs(data[idx] - targetR) + Math.abs(data[idx + 1] - targetG) + Math.abs(data[idx + 2] - targetB);
    if (dist > colorTolerance) {
      if (edgeMap[pixelIdx] > edgeThreshold * 0.75) return false;
      if (dist > colorTolerance * 2.5) return false;
    }
    return true;
  }

  function addSeeds(left: number, right: number, y: number) {
    if (y < 0 || y >= height) return;
    let inRange = false;
    for (let x = left; x <= right; x++) {
      const pi = y * width + x;
      if (!visited[pi] && canFill(pi)) {
        if (!inRange && stackPtr + 2 < stack.length) {
          stack[stackPtr++] = x;
          stack[stackPtr++] = y;
          inRange = true;
        }
      } else {
        inRange = false;
      }
    }
  }

  while (stackPtr > 0) {
    const sy = stack[--stackPtr];
    const sx = stack[--stackPtr];
    if (sy < 0 || sy >= height) continue;

    const seedIdx = sy * width + sx;
    if (visited[seedIdx]) continue;
    if (!canFill(seedIdx)) continue;

    let left = sx, right = sx;
    while (left > 0 && !visited[sy * width + left - 1] && canFill(sy * width + left - 1)) left--;
    while (right < width - 1 && !visited[sy * width + right + 1] && canFill(sy * width + right + 1)) right++;

    for (let x = left; x <= right; x++) {
      const pi = sy * width + x;
      if (visited[pi]) continue;
      visited[pi] = 1;
      if (!combinedMask[pi]) { combinedMask[pi] = 1; newFilledCount++; }
    }

    addSeeds(left, right, sy - 1);
    addSeeds(left, right, sy + 1);
  }

  if (!preserveInteriorHoles) {
    morphologicalCloseSeparable(combinedMask, width, height, 6);
    fillSmallHoles(combinedMask, width, height, newFilledCount * 0.3);
  }

  // Build result image
  const result = new ImageData(new Uint8ClampedArray(data), width, height);
  const resultData = result.data;
  for (let i = 0; i < size; i++) {
    if (combinedMask[i]) {
      const idx = i * 4;
      resultData[idx] = fillColor[0];
      resultData[idx + 1] = fillColor[1];
      resultData[idx + 2] = fillColor[2];
      resultData[idx + 3] = fillColor[3];
    }
  }

  const boundaryPoints = extractBoundary(combinedMask, width, height);

  return { filledImageData: result, boundaryPoints, filledPixelCount: newFilledCount, filledMask: combinedMask };
}

/**
 * Pre-segment the image into labeled regions for rectangle-drag selection.
 * Simple connected component labeling — no barrier merging.
 */
export function buildRegionMap(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  edgeMap: Uint8Array,
  sensitivity: number = 45
): { regionLabels: Int32Array; regionSeeds: Map<number, { x: number; y: number }> } {
  const size = width * height;
  const sensRatio = sensitivity / 50;
  const colorTolerance = DEFAULT_COLOR_TOLERANCE * sensRatio;
  const edgeThreshold = Math.max(15, DEFAULT_EDGE_THRESHOLD + (sensitivity - 50) * 1.0);

  const labels = new Int32Array(size);
  let nextId = 1;
  const regionSeeds = new Map<number, { x: number; y: number }>();
  const minRegionSize = 50;

  const stack = new Int32Array(Math.min(size * 2, 4_000_000));

  for (let startY = 0; startY < height; startY++) {
    for (let startX = 0; startX < width; startX++) {
      const startPixel = startY * width + startX;
      if (labels[startPixel] !== 0) continue;
      if (edgeMap[startPixel] > edgeThreshold) { labels[startPixel] = -1; continue; }

      const startIdx = startPixel * 4;
      const targetR = data[startIdx];
      const targetG = data[startIdx + 1];
      const targetB = data[startIdx + 2];

      const regionId = nextId++;
      let count = 0;
      let stackPtr = 0;
      stack[stackPtr++] = startX;
      stack[stackPtr++] = startY;

      while (stackPtr > 0) {
        const sy = stack[--stackPtr];
        const sx = stack[--stackPtr];
        if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
        const pi = sy * width + sx;
        if (labels[pi] !== 0) continue;
        if (edgeMap[pi] > edgeThreshold) { labels[pi] = -1; continue; }

        const idx = pi * 4;
        const dist = Math.abs(data[idx] - targetR) + Math.abs(data[idx + 1] - targetG) + Math.abs(data[idx + 2] - targetB);
        if (dist > colorTolerance) {
          if (edgeMap[pi] > edgeThreshold * 0.75 || dist > colorTolerance * 2.5) {
            labels[pi] = -1;
            continue;
          }
        }

        labels[pi] = regionId;
        count++;

        if (stackPtr + 8 < stack.length) {
          stack[stackPtr++] = sx + 1; stack[stackPtr++] = sy;
          stack[stackPtr++] = sx - 1; stack[stackPtr++] = sy;
          stack[stackPtr++] = sx;     stack[stackPtr++] = sy + 1;
          stack[stackPtr++] = sx;     stack[stackPtr++] = sy - 1;
        }
      }

      if (count >= minRegionSize) {
        regionSeeds.set(regionId, { x: startX, y: startY });
      }
    }
  }

  return { regionLabels: labels, regionSeeds };
}

/**
 * Lightweight preview-only flood fill. Uses pre-cached edge map,
 * skips morphological closing and hole filling.
 */
export function floodFillPreview(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  cachedEdgeMap: Uint8Array,
  existingMask?: Uint8Array,
  sensitivity: number = 50
): { filledMask: Uint8Array; filledPixelCount: number } {
  const size = width * height;
  const sensRatio = sensitivity / 50;
  const colorTolerance = DEFAULT_COLOR_TOLERANCE * sensRatio;
  const edgeThreshold = Math.max(15, DEFAULT_EDGE_THRESHOLD + (sensitivity - 50) * 1.0);

  const startPixel = startY * width + startX;
  if (existingMask && existingMask[startPixel]) {
    return { filledMask: existingMask, filledPixelCount: 0 };
  }

  const startIdx = startPixel * 4;
  const targetR = data[startIdx];
  const targetG = data[startIdx + 1];
  const targetB = data[startIdx + 2];

  const combinedMask = existingMask ? new Uint8Array(existingMask) : new Uint8Array(size);
  const visited = new Uint8Array(size);
  let newFilledCount = 0;

  const stack = new Int32Array(Math.min(size * 2, 2_000_000));
  let stackPtr = 0;
  stack[stackPtr++] = startX;
  stack[stackPtr++] = startY;

  function canFill(pixelIdx: number): boolean {
    if (combinedMask[pixelIdx]) return true;
    if (cachedEdgeMap[pixelIdx] > edgeThreshold) return false;
    const idx = pixelIdx * 4;
    const dist = Math.abs(data[idx] - targetR) + Math.abs(data[idx + 1] - targetG) + Math.abs(data[idx + 2] - targetB);
    if (dist > colorTolerance) {
      if (cachedEdgeMap[pixelIdx] > edgeThreshold * 0.75) return false;
      if (dist > colorTolerance * 2.5) return false;
    }
    return true;
  }

  while (stackPtr > 0) {
    const sy = stack[--stackPtr];
    const sx = stack[--stackPtr];
    if (sy < 0 || sy >= height) continue;

    const seedIdx = sy * width + sx;
    if (visited[seedIdx]) continue;
    if (!canFill(seedIdx)) continue;

    let left = sx, right = sx;
    while (left > 0 && !visited[sy * width + left - 1] && canFill(sy * width + left - 1)) left--;
    while (right < width - 1 && !visited[sy * width + right + 1] && canFill(sy * width + right + 1)) right++;

    for (let x = left; x <= right; x++) {
      const pi = sy * width + x;
      if (visited[pi]) continue;
      visited[pi] = 1;
      if (!combinedMask[pi]) { combinedMask[pi] = 1; newFilledCount++; }
    }

    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= height) continue;
      let inRange = false;
      for (let x = left; x <= right; x++) {
        const pi = ny * width + x;
        if (!visited[pi] && canFill(pi)) {
          if (!inRange && stackPtr + 2 < stack.length) {
            stack[stackPtr++] = x;
            stack[stackPtr++] = ny;
            inRange = true;
          }
        } else {
          inRange = false;
        }
      }
    }
  }

  return { filledMask: combinedMask, filledPixelCount: newFilledCount };
}

/**
 * Erase a connected region from the mask using flood fill.
 */
export function eraseFill(
  mask: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
  imageData?: ImageData,
  sensitivity: number = 40
): void {
  const startIdx = startY * width + startX;
  if (!mask[startIdx]) return;

  const data = imageData?.data;
  const size = width * height;
  const visited = new Uint8Array(size);

  let startR = 255, startG = 255, startB = 255;
  if (data) {
    const si = startIdx * 4;
    startR = data[si]; startG = data[si + 1]; startB = data[si + 2];
  }

  const stack = new Int32Array(Math.min(size * 2, 4_000_000));
  let ptr = 0;
  stack[ptr++] = startX;
  stack[ptr++] = startY;

  while (ptr > 0) {
    const y = stack[--ptr];
    const x = stack[--ptr];
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const idx = y * width + x;
    if (visited[idx]) continue;
    visited[idx] = 1;
    if (!mask[idx]) continue;

    if (data) {
      const pi = idx * 4;
      const r = data[pi], g = data[pi + 1], b = data[pi + 2];
      const dist = Math.abs(r - startR) + Math.abs(g - startG) + Math.abs(b - startB);
      if (dist > sensitivity) {
        const pixBright = 0.299 * r + 0.587 * g + 0.114 * b;
        let totalBright = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny2 = y + dy;
            if (nx >= 0 && nx < width && ny2 >= 0 && ny2 < height) {
              const ni = (ny2 * width + nx) * 4;
              totalBright += 0.299 * data[ni] + 0.587 * data[ni + 1] + 0.114 * data[ni + 2];
              count++;
            }
          }
        }
        if (count > 0 && (totalBright / count - pixBright) > sensitivity / 2) continue;
        if (dist > sensitivity * 2) continue;
      }
    }

    mask[idx] = 0;
    if (ptr + 8 < stack.length) {
      stack[ptr++] = x + 1; stack[ptr++] = y;
      stack[ptr++] = x - 1; stack[ptr++] = y;
      stack[ptr++] = x;     stack[ptr++] = y + 1;
      stack[ptr++] = x;     stack[ptr++] = y - 1;
    }
  }
}

/**
 * Extract multiple separate outlines from disconnected filled regions.
 * For outline generation, thin internal separator lines are bridged so
 * adjacent filled roof areas can produce a single outer roof boundary.
 */
export function extractMultipleOutlines(mask: Uint8Array, width: number, height: number): Point[][] {
  const outlineMask = createOutlineMergeMask(mask, width, height);
  const size = width * height;
  const visited = new Uint8Array(size);
  const outlines: Point[][] = [];
  const stack = new Int32Array(size);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!outlineMask[idx] || visited[idx]) continue;

      const componentPixels: number[] = [];
      let ptr = 0;
      stack[ptr++] = idx;
      visited[idx] = 1;

      while (ptr > 0) {
        const ci = stack[--ptr];
        componentPixels.push(ci);
        const cx = ci % width;
        const cy = Math.floor(ci / width);

        const neighbors = [ci + 1, ci - 1, ci + width, ci - width];
        const valid = [cx < width - 1, cx > 0, cy < height - 1, cy > 0];

        for (let i = 0; i < 4; i++) {
          if (!valid[i]) continue;
          const ni = neighbors[i];
          if (visited[ni] || !outlineMask[ni]) continue;
          visited[ni] = 1;
          stack[ptr++] = ni;
        }
      }

      if (componentPixels.length > 500) {
        const componentMask = new Uint8Array(size);
        for (const pixelIndex of componentPixels) componentMask[pixelIndex] = 1;
        const boundary = extractBoundary(componentMask, width, height);
        if (boundary.length > 2) outlines.push(boundary);
      }
    }
  }

  return outlines;
}

/**
 * Extract interior holes (penetrations) from the filled mask.
 * Returns polygons for unfilled regions completely surrounded by filled pixels.
 */
export function extractInteriorHoles(mask: Uint8Array, width: number, height: number, minHoleSize: number = 200): Point[][] {
  // Use the same merged/dilated mask as outline extraction so thin gaps
  // around penetrations are sealed and holes are properly detected as interior.
  const mergedMask = createOutlineMergeMask(mask, width, height);
  const size = width * height;
  const visited = new Uint8Array(size);
  const holes: Point[][] = [];
  const stack = new Int32Array(size);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mergedMask[idx] || visited[idx]) continue;

      // Flood fill the empty region
      const region: number[] = [];
      let touchesBorder = false;
      let ptr = 0;
      stack[ptr++] = idx;
      visited[idx] = 1;

      while (ptr > 0) {
        const ci = stack[--ptr];
        region.push(ci);
        const cx = ci % width;
        const cy = Math.floor(ci / width);

        if (cx === 0 || cx === width - 1 || cy === 0 || cy === height - 1) touchesBorder = true;

        const neighbors = [ci + 1, ci - 1, ci + width, ci - width];
        const valid = [cx < width - 1, cx > 0, cy < height - 1, cy > 0];

        for (let i = 0; i < 4; i++) {
          if (!valid[i]) continue;
          const ni = neighbors[i];
          if (visited[ni] || mergedMask[ni]) continue;
          visited[ni] = 1;
          stack[ptr++] = ni;
        }
      }

      // Interior hole: doesn't touch border and is big enough
      if (!touchesBorder && region.length >= minHoleSize) {
        const holeMask = new Uint8Array(size);
        for (const ri of region) holeMask[ri] = 1;
        const boundary = extractBoundary(holeMask, width, height);
        if (boundary.length > 2) holes.push(boundary);
      }
    }
  }

  return holes;
}

// --- Internal helpers ---

function createOutlineMergeMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const merged = new Uint8Array(mask);
  // Bridge thin gaps between adjacent filled areas
  bridgeThinGaps(merged, width, height, 10, "horizontal");
  bridgeThinGaps(merged, width, height, 10, "vertical");
  // Dilate to merge nearby components more aggressively
  dilate(merged, width, height, 5);
  // Fill small internal holes left by bridging
  fillSmallHoles(merged, width, height, 1500);
  return merged;
}

function dilate(mask: Uint8Array, width: number, height: number, radius: number): void {
  const size = width * height;
  const temp = new Uint8Array(size);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x <= radius && x < width; x++) count += mask[row + x];
    for (let x = 0; x < width; x++) {
      temp[row + x] = count > 0 ? 1 : 0;
      const rx = x + radius + 1;
      if (rx < width) count += mask[row + rx];
      const lx = x - radius;
      if (lx >= 0) count -= mask[row + lx];
    }
  }

  // Vertical pass
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y <= radius && y < height; y++) count += temp[y * width + x];
    for (let y = 0; y < height; y++) {
      mask[y * width + x] = count > 0 ? 1 : 0;
      const ry = y + radius + 1;
      if (ry < height) count += temp[ry * width + x];
      const ly = y - radius;
      if (ly >= 0) count -= temp[ly * width + x];
    }
  }
}

function bridgeThinGaps(
  mask: Uint8Array,
  width: number,
  height: number,
  maxGap: number,
  axis: "horizontal" | "vertical"
): void {
  if (axis === "horizontal") {
    for (let y = 0; y < height; y++) {
      let x = 0;
      while (x < width) {
        while (x < width && mask[y * width + x] === 0) x++;
        if (x >= width) break;

        let gapStart = x + 1;
        while (gapStart < width && mask[y * width + gapStart] === 1) gapStart++;
        if (gapStart >= width) break;

        let gapEnd = gapStart;
        while (gapEnd < width && mask[y * width + gapEnd] === 0 && gapEnd - gapStart < maxGap) gapEnd++;

        if (gapEnd < width && mask[y * width + gapEnd] === 1 && gapEnd > gapStart && gapEnd - gapStart <= maxGap) {
          for (let fillX = gapStart; fillX < gapEnd; fillX++) {
            mask[y * width + fillX] = 1;
          }
          x = gapEnd;
        } else {
          x = gapEnd;
        }
      }
    }
    return;
  }

  for (let x = 0; x < width; x++) {
    let y = 0;
    while (y < height) {
      while (y < height && mask[y * width + x] === 0) y++;
      if (y >= height) break;

      let gapStart = y + 1;
      while (gapStart < height && mask[gapStart * width + x] === 1) gapStart++;
      if (gapStart >= height) break;

      let gapEnd = gapStart;
      while (gapEnd < height && mask[gapEnd * width + x] === 0 && gapEnd - gapStart < maxGap) gapEnd++;

      if (gapEnd < height && mask[gapEnd * width + x] === 1 && gapEnd > gapStart && gapEnd - gapStart <= maxGap) {
        for (let fillY = gapStart; fillY < gapEnd; fillY++) {
          mask[fillY * width + x] = 1;
        }
        y = gapEnd;
      } else {
        y = gapEnd;
      }
    }
  }
}

function morphologicalCloseSeparable(mask: Uint8Array, width: number, height: number, radius: number): void {
  const size = width * height;
  const temp = new Uint8Array(size);

  // Dilate horizontal
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x <= radius && x < width; x++) count += mask[row + x];
    for (let x = 0; x < width; x++) {
      temp[row + x] = count > 0 ? 1 : 0;
      const rx = x + radius + 1;
      if (rx < width) count += mask[row + rx];
      const lx = x - radius;
      if (lx >= 0) count -= mask[row + lx];
    }
  }

  // Dilate vertical
  const dilated = new Uint8Array(size);
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y <= radius && y < height; y++) count += temp[y * width + x];
    for (let y = 0; y < height; y++) {
      dilated[y * width + x] = count > 0 ? 1 : 0;
      const ry = y + radius + 1;
      if (ry < height) count += temp[ry * width + x];
      const ly = y - radius;
      if (ly >= 0) count -= temp[ly * width + x];
    }
  }

  // Erode horizontal
  const temp2 = new Uint8Array(size);
  const windowSize = 2 * radius + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x <= radius && x < width; x++) count += dilated[row + x];
    let wSize = Math.min(radius + 1, width);
    for (let x = 0; x < width; x++) {
      temp2[row + x] = count === wSize ? 1 : 0;
      const rx = x + radius + 1;
      if (rx < width) { count += dilated[row + rx]; wSize++; }
      const lx = x - radius;
      if (lx >= 0) { count -= dilated[row + lx]; wSize--; }
      if (wSize > windowSize) wSize = windowSize;
    }
  }

  // Erode vertical
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y <= radius && y < height; y++) count += temp2[y * width + x];
    let wSize = Math.min(radius + 1, height);
    for (let y = 0; y < height; y++) {
      mask[y * width + x] = count === wSize ? 1 : 0;
      const ry = y + radius + 1;
      if (ry < height) { count += temp2[ry * width + x]; wSize++; }
      const ly = y - radius;
      if (ly >= 0) { count -= temp2[ly * width + x]; wSize--; }
      if (wSize > windowSize) wSize = windowSize;
    }
  }
}

function fillSmallHoles(mask: Uint8Array, width: number, height: number, maxHoleSize: number): void {
  const size = width * height;
  const visited = new Uint8Array(size);
  const stack = new Int32Array(size);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] || visited[idx]) continue;

      const region: number[] = [];
      let touchesBorder = false;
      let ptr = 0;
      stack[ptr++] = idx;
      visited[idx] = 1;

      while (ptr > 0) {
        const ci = stack[--ptr];
        region.push(ci);
        const cx = ci % width;
        const cy = Math.floor(ci / width);

        if (cx === 0 || cx === width - 1 || cy === 0 || cy === height - 1) touchesBorder = true;

        const neighbors = [ci + 1, ci - 1, ci + width, ci - width];
        const valid = [cx < width - 1, cx > 0, cy < height - 1, cy > 0];

        for (let i = 0; i < 4; i++) {
          if (!valid[i]) continue;
          const ni = neighbors[i];
          if (visited[ni] || mask[ni]) continue;
          visited[ni] = 1;
          stack[ptr++] = ni;
        }
      }

      if (!touchesBorder && region.length < maxHoleSize) {
        for (const ri of region) mask[ri] = 1;
      }
    }
  }
}

function extractBoundary(filled: Uint8Array, width: number, height: number): Point[] {
  const edges = extractBoundaryEdges(filled, width, height);
  if (edges.length === 0) return [];

  const boundary = traceBoundaryFromEdges(edges);
  if (boundary.length < 3) return boundary;

  const cornersOnly = simplifyCollinearPoints(boundary);
  const simplified = simplifyClosedBoundary(cornersOnly, 1.25);
  return hasSelfIntersection(simplified) ? cornersOnly : simplified;
}

function extractBoundaryEdges(filled: Uint8Array, width: number, height: number): Array<{ start: Point; end: Point }> {
  const edges: Array<{ start: Point; end: Point }> = [];
  const isFilled = (x: number, y: number) =>
    x >= 0 && x < width && y >= 0 && y < height && filled[y * width + x] === 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isFilled(x, y)) continue;

      if (!isFilled(x, y - 1)) edges.push({ start: { x, y }, end: { x: x + 1, y } });
      if (!isFilled(x + 1, y)) edges.push({ start: { x: x + 1, y }, end: { x: x + 1, y: y + 1 } });
      if (!isFilled(x, y + 1)) edges.push({ start: { x: x + 1, y: y + 1 }, end: { x, y: y + 1 } });
      if (!isFilled(x - 1, y)) edges.push({ start: { x, y: y + 1 }, end: { x, y } });
    }
  }

  return edges;
}

function traceBoundaryFromEdges(edges: Array<{ start: Point; end: Point }>): Point[] {
  const nextByStart = new Map<string, Point[]>();
  const keyOf = (point: Point) => `${point.x},${point.y}`;

  for (const edge of edges) {
    const key = keyOf(edge.start);
    const existing = nextByStart.get(key);
    if (existing) existing.push(edge.end);
    else nextByStart.set(key, [edge.end]);
  }

  let start = edges[0].start;
  for (const edge of edges) {
    if (edge.start.y < start.y || (edge.start.y === start.y && edge.start.x < start.x)) {
      start = edge.start;
    }
  }

  const boundary: Point[] = [];
  const usedEdges = new Set<string>();
  let current = start;
  let previousDirection = { x: 1, y: 0 };
  const maxSteps = edges.length + 1;

  for (let step = 0; step < maxSteps; step++) {
    boundary.push(current);
    const candidates = nextByStart.get(keyOf(current)) ?? [];
    if (candidates.length === 0) break;

    let nextPoint: Point | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      const edgeKey = `${current.x},${current.y}->${candidate.x},${candidate.y}`;
      if (usedEdges.has(edgeKey)) continue;

      const dx = candidate.x - current.x;
      const dy = candidate.y - current.y;
      const score = turnScore(previousDirection, { x: dx, y: dy });
      if (score < bestScore) {
        bestScore = score;
        nextPoint = candidate;
      }
    }

    if (!nextPoint) break;

    usedEdges.add(`${current.x},${current.y}->${nextPoint.x},${nextPoint.y}`);
    previousDirection = { x: nextPoint.x - current.x, y: nextPoint.y - current.y };
    current = nextPoint;

    if (current.x === start.x && current.y === start.y) break;
  }

  if (boundary.length > 1) {
    const last = boundary[boundary.length - 1];
    if (last.x === boundary[0].x && last.y === boundary[0].y) boundary.pop();
  }

  return boundary;
}

function turnScore(previous: Point, next: Point): number {
  const cross = previous.x * next.y - previous.y * next.x;
  const dot = previous.x * next.x + previous.y * next.y;
  if (cross < 0) return 0;
  if (cross === 0 && dot > 0) return 1;
  if (cross > 0) return 2;
  return 3;
}

function hasSelfIntersection(points: Point[]): boolean {
  const count = points.length;
  if (count < 4) return false;

  for (let i = 0; i < count; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % count];

    for (let j = i + 1; j < count; j++) {
      if (Math.abs(i - j) <= 1) continue;
      if (i === 0 && j === count - 1) continue;

      const b1 = points[j];
      const b2 = points[(j + 1) % count];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }

  return false;
}

function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, b1, a2)) return true;
  if (o2 === 0 && onSegment(a1, b2, a2)) return true;
  if (o3 === 0 && onSegment(b1, a1, b2)) return true;
  if (o4 === 0 && onSegment(b1, a2, b2)) return true;
  return false;
}

function orientation(a: Point, b: Point, c: Point): -1 | 0 | 1 {
  const cross = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (cross === 0) return 0;
  return cross > 0 ? 1 : -1;
}

function onSegment(a: Point, b: Point, c: Point): boolean {
  return (
    b.x >= Math.min(a.x, c.x) &&
    b.x <= Math.max(a.x, c.x) &&
    b.y >= Math.min(a.y, c.y) &&
    b.y <= Math.max(a.y, c.y)
  );
}

function simplifyCollinearPoints(points: Point[]): Point[] {
  if (points.length < 3) return points;

  const simplified: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length];
    const curr = points[i];
    const next = points[(i + 1) % points.length];

    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const cross = v1x * v2y - v1y * v2x;

    if (cross !== 0) simplified.push(curr);
  }

  return simplified.length >= 3 ? simplified : points;
}

function simplifyClosedBoundary(points: Point[], epsilon: number): Point[] {
  if (points.length <= 4) return points;

  let splitIndex = 1;
  let maxDistance = -1;
  const anchor = points[0];

  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - anchor.x;
    const dy = points[i].y - anchor.y;
    const dist = dx * dx + dy * dy;
    if (dist > maxDistance) {
      maxDistance = dist;
      splitIndex = i;
    }
  }

  if (splitIndex <= 0 || splitIndex >= points.length - 1) return points;

  const first = douglasPeucker(points.slice(0, splitIndex + 1), epsilon);
  const second = douglasPeucker([points[splitIndex], ...points.slice(splitIndex + 1), points[0]], epsilon);
  const merged = [...first.slice(0, -1), ...second.slice(0, -1)];

  return simplifyCollinearPoints(merged);
}

function douglasPeucker(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;
  let maxDist = 0, maxIdx = 0;
  const start = points[0];
  const end = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], start, end);
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }

  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [start, end];
}

function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return Math.sqrt((point.x - lineStart.x) ** 2 + (point.y - lineStart.y) ** 2);
  return Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x) / len;
}