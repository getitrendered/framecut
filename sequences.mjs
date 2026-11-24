import { canvasSize } from './motion.mjs';

export const FPS = 30;
export const MAX_PIXEL_SIZE = 8192;
export const MAX_DURATION = 24 * 3600 * FPS;
export const validPixels = value => Number.isInteger(value) && value >= 2 && value <= MAX_PIXEL_SIZE;

export function sequenceSize(sequence) {
  if (validPixels(sequence.width) && validPixels(sequence.height)) return [sequence.width, sequence.height];
  return canvasSize(sequence.resolution, sequence.aspect);
}

export function sequenceDuration(sequence, contentEnd) {
  const fixed = sequence.fixedFrames;
  return Number.isInteger(fixed) && fixed > 0 && fixed <= MAX_DURATION ? fixed : contentEnd;
}

export function contentDuration(sequence) {
  let end = 0;
  for (const key of ['clips', 'overlays', 'titles', 'sounds']) {
    let position = 0;
    for (const clip of sequence[key] || []) {
      position = (clip.start ?? position) + clip.len;
      end = Math.max(end, position);
    }
  }
  return end;
}

export function exportRange(sequence, total) {
  const valid = mark => Number.isInteger(mark) && mark >= 0 && mark < total;
  const start = valid(sequence.markIn) ? sequence.markIn : 0;
  const end = valid(sequence.markOut) ? sequence.markOut + 1 : total;
  return { start, end, frames: Math.max(0, end - start) };
}

export function exportWindow(range, total) {
  // Keep neighboring frames around the cut for audio limiter lookahead and release.
  return { start:Math.max(0,range.start-2), end:Math.min(total,range.end+2) };
}

export function formatRatio(width, height) {
  let a = width;
  let b = height;
  while (b) [a, b] = [b, a % b];
  return `${width / a}:${height / a}`;
}
