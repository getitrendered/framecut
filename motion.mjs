const dimensions = { 480:[854,480], 720:[1280,720], 1080:[1920,1080], dci:[2048,1080], 1440:[2560,1440], 2160:[3840,2160] };

export function canvasSize(resolution, aspect) {
  const [width,height] = Object.hasOwn(dimensions,resolution) ? dimensions[resolution] : dimensions[1080];
  if (aspect === 'portrait') return [height, Math.round(height * 8 / 9) * 2];
  if (aspect === 'square') return [height,height];
  return [width,height];
}

export const properties = {
  x: ['X position (%)', -100, 100, 0],
  y: ['Y position (%)', -100, 100, 0],
  scale: ['Scale (%)', 5, 300, 100],
  rotation: ['Rotation (°)', -360, 360, 0],
  opacity: ['Opacity (%)', 0, 100, 100],
  brightness: ['Brightness (%)', 0, 200, 100],
  contrast: ['Contrast (%)', 0, 200, 100],
  saturation: ['Saturation (%)', 0, 300, 100],
  left: ['Mask left (%)', 0, 100, 0],
  right: ['Mask right (%)', 0, 100, 0],
  top: ['Mask top (%)', 0, 100, 0],
  bottom: ['Mask bottom (%)', 0, 100, 0]
};

export const presets = [
  ['Fade in', 'Titles & motion', { opacity: [[0, 0], [.25, 100]] }],
  ['Fade out', 'Titles & motion', { opacity: [[.75, 100], [1, 0]] }],
  ['Pop in', 'Titles & motion', { scale: [[0, 55], [.16, 113], [.28, 100]], opacity: [[0, 0], [.1, 100]] }],
  ['Pop out', 'Titles & motion', { scale: [[.76, 100], [.87, 112], [1, 50]], opacity: [[.86, 100], [1, 0]] }],
  ['Slide from left', 'Titles & motion', { x: [[0, -100], [.3, 0]] }],
  ['Slide from right', 'Titles & motion', { x: [[0, 100], [.3, 0]] }],
  ['Rise', 'Titles & motion', { y: [[0, 35], [.3, 0]], opacity: [[0, 0], [.22, 100]] }],
  ['Drop in', 'Titles & motion', { y: [[0, -35], [.2, 4], [.34, 0]], opacity: [[0, 0], [.15, 100]] }],
  ['Drift left', 'Titles & motion', { x: [[0, 5], [1, -5]], scale: [[0, 111]] }],
  ['Drift right', 'Titles & motion', { x: [[0, -5], [1, 5]], scale: [[0, 111]] }],
  ['Push in', 'Titles & motion', { scale: [[0, 100], [1, 128]] }],
  ['Pull back', 'Titles & motion', { scale: [[0, 128], [1, 100]] }],
  ['Tilt in', 'Titles & motion', { rotation: [[0, -12], [.32, 0]], opacity: [[0, 0], [.25, 100]] }],
  ['Spin in', 'Titles & motion', { rotation: [[0, -180], [.4, 0]], scale: [[0, 35], [.4, 100]] }],
  ['Pulse', 'Titles & motion', { scale: [[0, 100], [.25, 113], [.5, 100], [.75, 113], [1, 100]] }],
  ['Sway', 'Titles & motion', { rotation: [[0, 0], [.25, -6], [.75, 6], [1, 0]] }],
  ['Dip to black', 'Transitions', { opacity: [[0, 0], [.15, 100], [.85, 100], [1, 0]] }],
  ['Wipe right', 'Transitions', { right: [[0, 100], [.3, 0]] }],
  ['Wipe left', 'Transitions', { left: [[0, 100], [.3, 0]] }],
  ['Reveal downward', 'Transitions', { bottom: [[0, 100], [.3, 0]] }]
];

export const looks = [
  ['Monochrome', { saturation: 0, contrast: 113 }],
  ['Muted film', { saturation: 68, contrast: 116, brightness: 97 }],
  ['High contrast', { contrast: 138, saturation: 108 }],
  ['Soft lift', { brightness: 108, contrast: 89, saturation: 91 }],
  ['Vivid', { saturation: 135, contrast: 110 }],
  ['Low key', { brightness: 84, contrast: 119, saturation: 91 }]
];

export function points(clip, key) {
  const row = properties[key];
  const raw = clip.motion?.[key];
  if (!Array.isArray(raw)) return [[0, row[3]]];
  const keyed = new Map();
  for (const pair of raw.slice(0, 128)) {
    if (!Array.isArray(pair)) continue;
    const [frame, value] = pair;
    if (!Number.isSafeInteger(frame) || frame < 0 || !Number.isFinite(value)) continue;
    keyed.set(frame, Math.max(row[1], Math.min(row[2], value)));
  }
  return keyed.size ? [...keyed].sort((a, b) => a[0] - b[0]) : [[0, row[3]]];
}

export function valueAt(clip, key, frame) {
  const keys = points(clip, key);
  if (frame <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [end, to] = keys[i];
    if (frame > end) continue;
    const [start, from] = keys[i - 1];
    return from + (to - from) * (frame - start) / (end - start);
  }
  return keys.at(-1)[1];
}

export function expression(clip, key, frame) {
  const keys = points(clip, key);
  if (keys.length === 1) return String(keys[0][1]);
  let result = String(keys.at(-1)[1]);
  for (let i = keys.length - 1; i > 0; i--) {
    const [end, to] = keys[i];
    const [start, from] = keys[i - 1];
    result = `if(lt(${frame},${end}),${from}+(${to - from})*clip((${frame}-${start})/${end - start},0,1),${result})`;
  }
  return result;
}

export function resizeMotion(clip, shift, len) {
  const motion = {};
  for (const key of Object.keys(clip.motion || {})) {
    if (!Object.hasOwn(properties, key)) continue;
    const keys = points(clip, key);
    const range = keys.filter(([at]) => at > shift && at < shift + len - 1)
      .map(([at, value]) => [at - shift, value]);
    motion[key] = [[0, valueAt(clip, key, shift)], ...range];
    if (len > 1 && keys.length > 1) motion[key].push([len - 1, valueAt(clip, key, shift + len - 1)]);
  }
  return motion;
}
