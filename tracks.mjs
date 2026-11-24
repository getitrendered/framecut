export function trackOf(clip) {
  if (clip.kind === 'audio') return `audio:${clip.track}`;
  if (clip.asset) return `video:${clip.track || 0}`;
  if (clip.style === 'caption') return 'caption:5';
  return `title:${clip.track || 1}`;
}

export function trackSettings(project, key) {
  return project.trackSettings?.[key] || {};
}

export function gainDb(value) {
  return Number.isFinite(value) ? Math.max(-60, Math.min(0, value)) : 0;
}

export function clipMix(project, clip) {
  const track = trackSettings(project,trackOf(clip));
  return {
    muted:Boolean(clip.muted || track.muted || project.masterMuted),
    gain:gainDb(clip.gainDb)+gainDb(track.gainDb)+gainDb(project.masterGainDb)
  };
}

export function clipsIn(project) {
  return [...project.clips,...project.overlays,...project.titles,...project.sounds];
}

export function protectedTrack(project, key) {
  return Boolean(project.timelineLocked || trackSettings(project,key).locked);
}

export function changesLockedClips(before, after) {
  const previous = new Map(clipsIn(before).map(clip=>[clip.id,clip]));
  for (const clip of clipsIn(after)) {
    const old = previous.get(clip.id);
    previous.delete(clip.id);
    if (JSON.stringify(old) !== JSON.stringify(clip) &&
      (protectedTrack(before,trackOf(clip)) || (old && protectedTrack(before,trackOf(old))))) return true;
  }
  return [...previous.values()].some(clip=>protectedTrack(before,trackOf(clip)));
}
