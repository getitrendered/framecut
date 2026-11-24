import { canvasSize, looks, points, presets, properties, resizeMotion, valueAt } from '/motion.mjs';
import { fontFamilies, readSrt, textPresets, titleType, typographyText, visibleText, wrapText, writeSrt } from '/text.mjs';
import { soundPresets, soundSettings, soundWave } from '/sound.mjs';
import { paintParticles, particlePresets, particleSettings } from '/graphics.mjs';
import { setupUpdates } from '/updates-ui.mjs';
import { changesLockedClips, clipMix, gainDb, protectedTrack, trackOf, trackSettings } from '/tracks.mjs';
import '/layout.mjs';
const $ = id => document.getElementById(id);
const fps = 30;
const storageKey = 'framecut-project-v1';
const defaults = { name: 'Untitled project', resolution: '1080', aspect: 'landscape', format: 'mp4', quality: 'high',
  clips: [], titles: [], overlays: [], layers: 0, titleLayers:1, folders: [], assignments: {}, gradeReference: null, sounds:[], audioLayers:0 };
const bin = new Map();
const lutLibrary = new Map();
const undo = [];
const redo = [];
const players = [$('video'), $('next-video')];
const space = $('track-space');
const scroll = $('scroll');
const timelinePan = $('timeline-pan');
const zoomInput = $('zoom');
const minZoom = Number(zoomInput.min);
const maxZoom = Number(zoomInput.max);
let project = structuredClone(defaults);
let hasSavedProject = false;
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (saved && Array.isArray(saved.clips) && Array.isArray(saved.titles)) {
    project = { ...defaults, ...saved };
    hasSavedProject = true;
  }
} catch {
  // The empty project remains available when browser storage cannot be read.
}
if(!hasSavedProject && window.framecutDesktop?.updates){
  try {
    const backup=JSON.parse(await window.framecutDesktop.updates.restore());
    if(backup && Array.isArray(backup.clips) && Array.isArray(backup.titles)) {
      project={...defaults,...backup};
      localStorage.setItem(storageKey,JSON.stringify(project));
    }
  } catch { /* Start normally if a recovery checkpoint cannot be read. */ }
}
let legacyPosition=0;
for(const clip of project.clips) {
  clip.start ??= legacyPosition;
  legacyPosition=clip.start+clip.len;
}
project.titleLayers=Math.max(project.titleLayers,...project.titles.filter(clip=>clip.style!=='caption').map(clip=>clip.track||1));

let timeline = [];
let captionOrder=[];
let videoEnd = 0;
let duration = 0;
let cursor = 0;
let zoom = Number(zoomInput.value);
let selected = null;
let selectedTrack = null;
let timelineClipboard = null;
let active = players[0];
let activeClip = null;
let playing = false;
let raf = 0;
let blackSince = 0;
let blackFrame = 0;
let drag = null;
let importing = false;
let exporting = false;
let mediaLoaded = false;
let page = 'footage';
let folder = 'all';
let sourceAsset = null;
let previewQuality = 'auto';
let videoImporting = false;
const proxyFallbacks=new Set();
let qualityRequest=0;
let effectCategory = 'Motion';
let trackingSource = null;
let trackingBox = null;
let trackingArea = null;
let tracked = null;
let picking = false;
let objectRemovalAvailable = false;
let transcriptionAvailable = false;
let transcribing = false;
let speechLanguage = 'auto';
let audioImporting = false;
let looping = false;
let soundContext;
let auditionNode;
const audioPlayers = new Map();
let placingText=false;
const previewAnimations=new WeakMap();
const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)');
const previewObserver=new IntersectionObserver(entries=>{
  for(const entry of entries){
    const animation=previewAnimations.get(entry.target);
    if(!animation) continue;
    if(entry.isIntersecting && !reduceMotion.matches) animation.play();
    else animation.pause();
  }
},{threshold:.2});
const overlayPlayers = new Map();

const id = () => crypto.randomUUID();
const clamp = (n, min, max) => Math.max(min, Math.min(n, max));
const pixels = frame => frame * zoom / fps;
const seconds = frame => frame / fps;
const frameAt = clientX => Math.round((clientX - space.getBoundingClientRect().left) * fps / zoom);
const diskURL = (asset, file) => `/media/${asset}/${file}`;
const notify = message => {
  $('status').textContent = message;
  $('task-list').textContent = message;
};

function timecode(frame) {
  const n = Math.max(0, Math.floor(frame));
  return [Math.floor(n / 108000), Math.floor(n / 1800) % 60, Math.floor(n / 30) % 60, n % 30]
    .map(x => String(x).padStart(2, '0')).join(':');
}

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content) element.textContent = content;
  return element;
}

function button(label, action, disabled = false) {
  const element = node('button', 'secondary', label);
  element.type = 'button';
  element.disabled = disabled;
  element.onclick = action;
  return element;
}

async function api(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error);
  return payload;
}

function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(project));
    $('save-state').textContent = 'Saved locally';
    return true;
  } catch {
    $('save-state').textContent = 'Browser storage unavailable';
    return false;
  }
}

setupUpdates(()=>{
  document.activeElement?.blur();
  pause();
  if(!persist()) throw new Error('Framecut could not save the current project. The app is still open.');
  return JSON.stringify(project);
});

function change(update) {
  pause();
  const before = structuredClone(project);
  const previousSelection = selected;
  update();
  if (changesLockedClips(before,project) ||
      (before.timelineLocked && ['layers','audioLayers','titleLayers','aspect'].some(key=>before[key]!==project[key]))) {
    project=before;
    selected=previousSelection;
    renderTimeline();
    notify(before.timelineLocked?'The timeline is locked.':'Unlock the track to make this edit.');
    return false;
  }
  if (JSON.stringify(before) !== JSON.stringify(project)) {
    undo.push(before);
    if (undo.length > 80) undo.shift();
    redo.length = 0;
    persist();
  }
  renderTimeline();
  return true;
}

function history(from, to) {
  if (!from.length) return;
  const next = { ...from.at(-1), timelineLocked:project.timelineLocked, trackSettings:project.trackSettings,
    masterMuted:project.masterMuted, masterGainDb:project.masterGainDb };
  if (project.timelineLocked || changesLockedClips(project,next)) {
    notify('Unlock the affected tracks to change edit history.');
    return;
  }
  pause();
  to.push(project);
  from.pop();
  project = next;
  persist();
  renderTimeline();
}

function sortedTitles() {
  return [...project.titles].sort((a, b) => a.start - b.start);
}

function renderBin() {
  renderFolders();
  const search = $('media-search').value.trim().toLowerCase();
  const shown = [...bin.values()].filter(asset => asset.kind !== 'audio' && (folder === 'all' || (project.assignments[asset.id] || '') === folder)
    && asset.name.toLowerCase().includes(search));
  const sort = $('media-sort').value;
  if (sort === 'name') shown.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'duration') shown.sort((a, b) => b.frames - a.frames);
  else shown.reverse();
  $('media-count').textContent = `${shown.length} ${shown.length === 1 ? 'clip' : 'clips'}`;
  $('bin').replaceChildren();
  if (!shown.length) {
    const empty = node('div', 'media-empty');
    empty.append(node('b', '', bin.size ? 'No footage here' : 'Import your footage'), document.createElement('br'),
      search ? 'Try another search' : 'Drop video files here');
    $('bin').append(empty);
  }
  for (const asset of shown) {
    const card = node('article', 'asset');
    card.classList.toggle('active-asset', asset.id === sourceAsset);
    card.draggable = true;
    card.addEventListener('dragstart', event => {
      event.dataTransfer.setData('application/x-framecut-asset', asset.id);
      event.dataTransfer.effectAllowed = 'copy';
    });
    card.addEventListener('dragend', () => { $('drop-marker').hidden = true; });
    const thumbnail = node('button', 'thumbnail');
    thumbnail.type = 'button';
    thumbnail.setAttribute('aria-label', `Preview ${asset.name}`);
    thumbnail.onclick = () => { sourceAsset = asset.id; renderSource(); renderBin(); };
    const img = node('img');
    img.src = diskURL(asset.id, 'thumb.jpg');
    img.alt = '';
    img.loading = 'lazy';
    img.draggable = false;
    thumbnail.append(img, node('time', '', timecode(asset.frames).slice(3, 8)));
    const bottom = node('div', 'asset-bottom');
    const name = node('span', 'asset-name', asset.name);
    name.title = asset.name;
    const add = button('＋', () => { switchPage('edit'); insertVideo(asset.id, project.clips.length); });
    add.title = `Append ${asset.name} to timeline`;
    add.setAttribute('aria-label', add.title);
    bottom.append(name, add);
    card.append(thumbnail, bottom);
    $('bin').append(card);
  }
}

async function importVideos(files) {
  if (importing || !mediaLoaded || !files.length) return;
  importing = true;
  videoImporting = true;
  $('import').disabled = true;
  let added = 0;
  const errors = [];
  for (const file of files) {
    reportImport(`Importing ${file.name}…`);
    updateProgress($('import-progress'),{progress:null});
    try {
      const native = window.framecutDesktop?.importVideo?.(file);
      const asset = await Promise.resolve(native).then(result => result || api('/api/media', {
        method: 'POST', headers: { 'X-Framecut': '1', 'X-Filename': encodeURIComponent(file.name), 'X-File-Size': String(file.size) }, body: file
      }));
      bin.set(asset.id, asset);
      if (folder && folder !== 'all') {
        project.assignments[asset.id] = folder;
        persist();
      }
      added++;
      renderBin();
    } catch (error) {
      errors.push(`${file.name} — ${error.message.split('\n')[0]}`);
    }
  }
  importing = false;
  videoImporting = false;
  $('import').disabled = false;
  updateProgress($('import-progress'),null);
  reportImport([`Imported ${added} of ${files.length}`, ...errors].join(' · '));
}

function reportImport(message) {
  notify(message);
  const status = $('media-status');
  status.textContent = message;
  status.hidden = false;
}

function renderFolders() {
  const list = $('folder-list');
  list.replaceChildren();
  for (const [key, name] of [['all','All footage'], ['', 'Unfiled'], ...project.folders.map(item => [item.id, item.name])]) {
    const entry = button(name, () => { folder = key; renderBin(); });
    entry.className = 'folder-item';
    entry.setAttribute('aria-current', key === folder);
    if (key !== 'all') {
      entry.addEventListener('dragover', event => { if (hasAsset(event)) event.preventDefault(); });
      entry.addEventListener('drop', event => {
        if (!hasAsset(event)) return;
        event.preventDefault();
        moveAsset(event.dataTransfer.getData('application/x-framecut-asset'), key);
      });
    }
    list.append(entry);
  }
}

function moveAsset(assetId, to) {
  if (!bin.has(assetId)) return;
  if (to) project.assignments[assetId] = to;
  else delete project.assignments[assetId];
  persist();
  renderBin();
  renderSource();
}

function renderSource() {
  const asset = bin.get(sourceAsset);
  const video = $('source-video');
  video.hidden = !asset;
  $('resize-source').hidden = !asset;
  $('source-folder-field').hidden = !asset;
  if (!asset) return;
  const url = programUrl({asset:asset.id},'auto');
  video.poster = diskURL(asset.id,'thumb.jpg');
  if (video.getAttribute('src') !== url) video.src = url;
  const label = `${asset.name} · ${timecode(asset.frames)}`;
  $('source-info').textContent = label;
  video.onwaiting=()=>{ if(!video.readyState && stillSource(asset.id)) $('source-info').textContent=label+' · Loading playback…'; };
  video.onloadeddata=()=>{ if(stillSource(asset.id)) $('source-info').textContent=label; };
  video.onerror=()=>{
    if(!stillSource(asset.id)) return;
    if(asset.nativeMime && !proxyFallbacks.has(asset.id)){
      proxyFallbacks.add(asset.id);
      $('source-info').textContent=label+' · Preparing compatible playback…';
      video.src=programUrl({asset:asset.id},'auto');
    } else $('source-info').textContent=label+' · Playback failed. Check Tasks for details.';
  };
  const select = $('source-folder');
  select.replaceChildren();
  for (const [key, name] of [['', 'Unfiled'], ...project.folders.map(item => [item.id, item.name])]) select.add(new Option(name, key));
  select.value = project.assignments[asset.id] || '';
  $('source-actions').replaceChildren(
    button('Add to timeline', () => { switchPage('edit'); insertVideo(asset.id, project.clips.length); }),
    button('Add as layer', () => { switchPage('edit'); insertOverlay(asset.id); })
  );
}

function stillSource(id) { return sourceAsset===id; }

function switchPage(next) {
  page = next;
  if(next==='footage') selectedTrack=null;
  stopTextPlacement();
  if (next !== 'effects') cancelPicking();
  $('workspace-root').dataset.page = next;
  for (const tab of $('app-nav').querySelectorAll('[data-page]')) {
    if (tab.dataset.page === next) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (next === 'footage') { pause(); renderBin(); renderSource(); }
  else { $('source-video').pause(); renderTimeline(); }
}

function insertOverlay(assetId, track = project.layers || 1, start = cursor, graphic = false) {
  const asset = bin.get(assetId);
  if (!asset || !guardTrack(`video:${track}`)) return;
  const clip = { id: id(), asset: assetId, track, in: 0, len: asset.frames, start: 0, motion: { scale: [[0, graphic ? 100 : 60]] }, muted: true };
  clip.start = freeStart(project.overlays.filter(item => item.track === track), Math.max(0, start), clip.len);
  change(() => {
    project.layers = Math.max(project.layers, track);
    project.overlays.push(clip);
    selected = clip.id;
  });
  setPosition(clip.start);
  return clip;
}

function freeStart(items, start, len, ignore) {
  for (const other of [...items].sort((a, b) => a.start - b.start)) {
    if (other.id === ignore || other.start + other.len <= start) continue;
    if (start + len <= other.start) break;
    start = other.start + other.len;
  }
  return start;
}

function insertVideo(assetId, index, dropStart) {
  const asset = bin.get(assetId);
  if (!asset || !guardTrack('video:0')) return;
  const at=dropStart ?? (index<timeline.length ? timeline[index].start : videoEnd);
  const clip = { id: id(), asset: asset.id, in: 0, len: asset.frames, start:freeStart(project.clips,Math.max(0,at),asset.frames) };
  change(() => {
    project.clips.splice(index, 0, clip);
    selected = clip.id;
  });
  setPosition(clip.start);
  revealCursor();
}

function addTitle(preset, caption=false) {
  const len = 3 * fps;
  const active = selection();
  const track = caption ? 5 : active && !active.asset && active.style !== 'caption' ? active.track || 1 : project.titleLayers;
  if(!guardTrack(caption?'caption:5':`title:${track}`)) return;
  const clip = { id: id(), track, text: caption ? 'Your caption' : 'Your title', style:caption ? 'caption' : 'center',
    ...preset, start:freeStart(project.titles.filter(item => (item.track || 1) === track),cursor,len), len };
  change(() => {
    project.titles.push(clip);
    selected = clip.id;
  });
  setPosition(clip.start);
  revealCursor();
  $('title-text')?.select();
}

function selection() {
  return [...project.clips, ...project.overlays, ...project.titles, ...project.sounds].find(clip => clip.id === selected);
}

function clipList(clip) {
  return clip.kind === 'audio' ? project.sounds : clip.asset ? (clip.track ? project.overlays : project.clips) : project.titles;
}

function select(id) {
  selected = id;
  const clip=selection();
  if(clip) selectTrack(trackOf(clip));
  for (const clip of space.querySelectorAll('.clip')) {
    clip.classList.toggle('selected', clip.dataset.id === id);
  }
  renderInspector();
  renderKeyLanes();
  renderTools();
  refreshTrackControls();
  updateButtons();
}

function selectTrack(key) {
  selectedTrack=key;
  for (const element of document.querySelectorAll('[data-track-key]')) {
    const active=element.dataset.trackKey===key;
    element.classList.toggle('active-track',active);
    if(element.matches('.track-select')) element.setAttribute('aria-pressed',String(active));
  }
}

function guardTrack(key) {
  if(!protectedTrack(project,key)) return true;
  notify(project.timelineLocked?'The timeline is locked.':'Unlock the track to make this edit.');
  return false;
}

function removeClip(ripple = false) {
  const clip = selection();
  if (!clip || !guardTrack(trackOf(clip))) return;
  change(() => {
    const list = clipList(clip);
    if(ripple) {
      const peers=layerItems(clip).filter(item=>item.id!==clip.id && item.start>=clip.start+clip.len);
      const first=Math.min(Infinity,...peers.map(item=>item.start));
      if(Number.isFinite(first)) {
        const delta=first-clip.start;
        for(const peer of peers) peer.start-=delta;
      }
    }
    list.splice(list.indexOf(clip), 1);
    selected = null;
  });
}

function copyTimelineClip(cut = false) {
  const clip = selection();
  if (!clip) return;
  if(cut && !guardTrack(trackOf(clip))) return;
  timelineClipboard = { clip: structuredClone(clip), cut };
  if (cut) removeClip();
  notify(cut ? 'Clip cut. Paste at the playhead.' : 'Clip copied. Paste at the playhead.');
}

function pasteTimelineClip(at = cursor) {
  if (!timelineClipboard?.clip) return;
  const clip = structuredClone(timelineClipboard.clip);
  if(selectedTrack){
    const [type,number]=selectedTrack.split(':');
    if(trackOf(clip).split(':')[0] !== type) {
      notify('Select a compatible track to paste this clip.');
      return;
    }
    clip.track=Number(number);
  }
  if(!guardTrack(trackOf(clip))) return;
  const originalExists = [...project.clips, ...project.overlays, ...project.sounds, ...project.titles]
    .some(item => item.id === clip.id);
  if (!timelineClipboard.cut || originalExists) {
    clip.id = id();
    delete clip.extractedFrom;
  }
  clip.start = freeStart(layerItems(clip), Math.max(0, at), clip.len);
  if(!change(() => {
    clipList(clip).push(clip);
    if (clip.kind === 'audio') project.audioLayers = Math.max(project.audioLayers, clip.track);
    else if (clip.asset && clip.track) project.layers = Math.max(project.layers, clip.track);
    else if (!clip.asset && clip.style !== 'caption') project.titleLayers = Math.max(project.titleLayers, clip.track || 1);
    selected = clip.id;
  })) return;
  selectTrack(trackOf(clip));
  timelineClipboard.cut = false;
  setPosition(clip.start);
  revealCursor();
  notify(clip.start === at ? 'Clip pasted.' : 'Clip pasted at the next open position on its track.');
}

function copyFootage(cut) {
  const asset = bin.get(sourceAsset);
  if (!asset) return false;
  timelineClipboard = { asset:asset.id, move:cut };
  reportImport(cut ? 'Footage ready to move. Open a folder and paste.' : 'Footage copied. Open Edit and paste into the timeline.');
  return true;
}

function copyKeyframe(dot, cut) {
  const clip = selection();
  const { property, frame } = dot.dataset;
  const at = Number(frame);
  const keyframes = clip?.motion?.[property];
  if (!keyframes?.some(([position]) => position === at)) return false;
  if(cut && !guardTrack(trackOf(clip))) return true;
  timelineClipboard = { keyframe:{ property, value:valueAt(clip,property,at) } };
  if (cut) change(() => { clip.motion[property] = keyframes.filter(([position]) => position !== at); });
  notify(cut ? 'Keyframe cut.' : 'Keyframe copied.');
  return true;
}

function pasteEditorItem() {
  if (!timelineClipboard) return false;
  if (page === 'footage') {
    if (!timelineClipboard.move || !bin.has(timelineClipboard.asset)) return false;
    if (folder === 'all') {
      reportImport('Select a destination folder, then paste.');
      return true;
    }
    moveAsset(timelineClipboard.asset, folder);
    timelineClipboard.move = false;
    reportImport('Footage moved.');
    return true;
  }
  if (timelineClipboard.clip) {
    pasteTimelineClip();
    return true;
  }
  if (bin.has(timelineClipboard.asset)) {
    if (timelineClipboard.move) {
      notify('Paste cut footage into a folder in Footage.');
      return true;
    }
    if(selectedTrack && !selectedTrack.startsWith('video:')){
      notify('Select a video track to paste footage.');
      return true;
    }
    const layer=Number(selectedTrack?.split(':')[1] || 0);
    if(guardTrack(`video:${layer}`)){
      if(layer) insertOverlay(timelineClipboard.asset,layer,cursor);
      else insertVideo(timelineClipboard.asset,project.clips.length,cursor);
      notify('Footage pasted into the timeline.');
    }
    return true;
  }
  const clip = selection();
  const keyframe = timelineClipboard.keyframe;
  if (!keyframe || page !== 'animation' || !clip || clip.kind === 'audio') return false;
  if(!guardTrack(trackOf(clip))) return true;
  const {property,value} = keyframe;
  const at = cursor - clipStart(clip);
  if (at < 0 || at >= clip.len) {
    notify('Move the playhead inside the selected clip to paste the keyframe.');
    return true;
  }
  change(() => {
    clip.motion ||= {};
    const others = (clip.motion[property] || []).filter(([frame]) => frame !== at);
    clip.motion[property] = [...others,[at,value]].sort((a,b) => a[0]-b[0]);
  });
  notify('Keyframe pasted at the playhead.');
  return true;
}

function splitPosition() {
  const clip = selection();
  return (clip && (!clip.asset || clip.track) ? [clip] : timeline).find(item => (!clip || clip.id === item.id)
    && !protectedTrack(project,trackOf(item)) && cursor > item.start && cursor < item.start + item.len);
}

function splitClip() {
  const item = splitPosition();
  if (!item) return;
  const list = clipList(item);
  const index = list.findIndex(clip => clip.id === item.id);
  const clip = list[index];
  const offset = cursor - item.start;
  change(() => {
    const right = { ...clip, id: id(), len: clip.len - offset, motion: resizeMotion(clip, offset, clip.len - offset) };
    if (clip.asset) right.in = clip.in + offset;
    right.start = cursor;
    clip.motion = resizeMotion(clip, 0, offset);
    clip.len = offset;
    list.splice(index + 1, 0, right);
    selected = right.id;
  });
}

function field(label, element) {
  const wrapper = node('label', 'property');
  if(!element.hasAttribute('aria-label')) element.setAttribute('aria-label',label);
  wrapper.append(node('span', '', label), element);
  return wrapper;
}

function timeField(label, frames, low, high, update) {
  const input = node('input');
  input.type = 'number';
  input.min = seconds(low);
  input.max = seconds(high);
  input.step = 'any';
  input.value = seconds(frames).toFixed(3);
  input.onchange = () => {
    if (!Number.isFinite(input.valueAsNumber)) {
      input.value = seconds(frames).toFixed(3);
      return;
    }
    const value = clamp(Math.round(input.valueAsNumber * fps), low, high);
    change(() => update(value));
  };
  return field(label, input);
}

function renderInspector() {
  const panel = $('inspector');
  const openGroups=new Set([...panel.querySelectorAll('details[open] summary')].map(summary=>summary.textContent));
  panel.replaceChildren();
  const clip = selection();
  if (!clip) {
    panel.append(node('p', 'subtle', 'Select a video or title on the timeline to edit its properties.'));
    return;
  }
  if (clip.kind === 'audio') {
    renderAudioInspector(panel,clip);
  } else if (clip.asset) {
    const asset = bin.get(clip.asset);
    if (!asset) {
      panel.append(node('p', 'subtle', 'Source unavailable. Reimport the video or remove this clip.'));
      return;
    }
    panel.append(node('h2', 'inspector-name', asset.name));
    const timing = node('div', 'property-line');
    const remaining = laneNeighbors(clip).next - clip.start;
    timing.append(timeField('Source in (s)', clip.in, Math.max(0, clip.in + clip.len - remaining), clip.in + clip.len - 1, value => {
      const len = clip.len + clip.in - value;
      clip.motion = resizeMotion(clip, value - clip.in, len);
      clip.len = len;
      clip.in = value;
    }), timeField('Source out (s)', clip.in + clip.len, clip.in + 1, Math.min(asset.frames, clip.in + remaining), value => {
      clip.len = value - clip.in;
    }));
    const index = timeline.findIndex(item=>item.id===clip.id);
    const actions = node('div', 'inline-actions');
    if (!clip.track) actions.append(button('← Earlier', () => moveVideo(clip.id, index - 1), index === 0),
      button('Later →', () => moveVideo(clip.id, index + 1), index === timeline.length - 1));
    else {
      actions.append(button(clip.muted ? 'Unmute layer' : 'Mute layer', () => change(() => { clip.muted = !clip.muted; })));
      panel.append(timeField('Timeline start (s)', clip.start, 0, duration + 3600 * fps, value => {
        clip.start = freeStart(layerItems(clip), value, clip.len, clip.id);
      }));
    }
    if (asset.audio !== null) {
      const extracted=project.sounds.some(sound=>sound.extractedFrom===clip.id);
      actions.append(button('Extract audio', () => extractAudio(clip), extracted),
        button(clip.muted ? 'Unmute original audio' : 'Mute original audio', () => change(() => { clip.muted = !clip.muted; })));
    }
    if (page==='edit' && !asset.alpha) {
      actions.append(button('Find closest loop',()=>void findClosestLoop(clip),clip.len<30 || looping));
      if(asset.loop) {
        let minutes=60;
        panel.append(numberControl('Repeat duration (minutes)',minutes,.1,180,.1,value=>{minutes=value;}),
          button('Export repeated loop',()=>void repeatFoundLoop(asset,minutes),looping));
      }
    }
    panel.append(timing, node('p', 'subtle', `Duration ${timecode(clip.len)}`), actions);
  } else {
    const text = node('textarea','title-input');
    text.id = 'title-text';
    text.maxLength = 900;
    text.rows=4;
    text.value = clip.text;
    text.onchange = () => change(() => { clip.text = cleanText(text.value) || clip.text; });
    const style = node('select');
    for (const [value, label] of clip.style==='caption' ? [['caption','Caption']] : [['center', 'Centered'], ['lower', 'Lower third']]) {
      const option = node('option', '', label);
      option.value = value;
      style.add(option);
    }
    style.value = clip.style;
    style.onchange = () => change(() => { clip.style = style.value; });
    const maxEnd = laneNeighbors(clip).next;
    const maxFrame = Math.max(duration + 3600 * fps, clip.start + clip.len);
    const timing = node('div', 'property-line');
    timing.append(timeField('Start (s)', clip.start, 0, maxFrame, value => {
      clip.start = freeStart(layerItems(clip), value, clip.len, clip.id);
    }), timeField('Duration (s)', clip.len, 1, Math.min(maxEnd, maxFrame) - clip.start, value => {
      clip.len = value;
    }));
    const layer = node('select');
    for (let number=1;number<=Math.max(project.titleLayers,clip.track||1);number++) layer.add(new Option('Titles ' + number, number));
    layer.value = clip.track || 1;
    layer.onchange = () => change(() => {
      clip.track = Number(layer.value);
      clip.start = freeStart(layerItems(clip), clip.start, clip.len, clip.id);
    });
    panel.append(field(clip.style==='caption' ? 'Caption' : 'Text', text),field('Position',style));
    if(clip.style!=='caption') panel.append(field('Title layer',layer));
    panel.append(timing);
    if(page==='text') renderTypography(panel,clip,openGroups);
    else panel.append(button('Open Text & Subtitles',()=>switchPage('text')));
  }
  if (clip.kind!=='audio' && (page === 'animation' || page === 'color')) {
    const keys = page === 'color' ? ['brightness', 'contrast', 'saturation'] : Object.keys(properties);
    panel.append(node('h2', '', page === 'color' ? 'Color controls' : 'Keyframes'));
    for (const key of keys) panel.append(keyControl(clip, key));
  }
}

async function findClosestLoop(clip) {
  if(looping) return;
  const {asset,in:sourceIn,len}=clip;
  looping=true;
  renderInspector();
  notify('Comparing the source’s beginning and ending frames…');
  try {
    const result=await jsonPost('/api/loop',{asset,in:sourceIn,len});
    bin.set(result.asset.id,result.asset);
    sourceAsset=result.asset.id;
    const source=[...project.clips,...project.overlays].find(item=>item.id===clip.id);
    if(source && !project.timelineLocked && source.asset===asset && source.in===sourceIn && source.len===len){
      const start=source.start+result.start-source.in;
      const end=start+result.asset.frames;
      const first=(source.track||0)+1;
      const candidates=Array.from({length:Math.max(0,9-first)},(_,index)=>first+index);
      const layer=[...candidates].reverse().find(number=>!protectedTrack(project,`video:${number}`) &&
        project.overlays.every(item=>item.track!==number || item.start>=end || item.start+item.len<=start) &&
        (number<=project.layers || number===Math.max(first,project.layers+1)));
      if(layer && insertOverlay(result.asset.id,layer,start,true)){
        selectTrack(`video:${layer}`);
        revealCursor();
        notify(`Closest loop placed on Video ${layer+1} · source ${timecode(result.start)}–${timecode(result.end)}`);
        return;
      }
    }
    renderTools();
    notify('Closest loop saved to Footage. Unlock or free a video layer to place it above the source.');
  } catch(error){ notify(error.message); }
  finally { looping=false; renderInspector(); }
}

async function repeatFoundLoop(asset,minutes) {
  if(looping) return;
  looping=true;
  notify('Repeating the loop without re-encoding…');
  try {
    const job=await jsonPost('/api/repeat-loop',{asset:asset.id,minutes});
    if(window.framecutDesktop) {
      const saved=await window.framecutDesktop.saveRender(job.id);
      notify(saved?'Repeated loop saved':'Repeated loop ready');
    } else {
      const link=node('a'); link.href=`/api/exports/${job.id}/download`; link.click();
      notify('Repeated loop ready to download');
    }
  } catch(error){ notify(error.message); }
  finally { looping=false; }
}

function layerItems(clip) {
  return clip.kind==='audio' ? project.sounds.filter(item=>item.track===clip.track) : clip.asset ? (clip.track ? project.overlays.filter(item => item.track === clip.track) : project.clips)
    : project.titles.filter(item => (item.track || 1) === (clip.track || 1));
}

function cleanText(text) { return text.replace(/\r\n?/g,'\n').replace(/\t/g,' ').replace(/[^\P{Cc}\n]/gu,'').trim().slice(0,900); }

function choice(label, options, value, update) {
  const input=node('select');
  for(const [key,name] of options) input.add(new Option(name,key));
  input.value=String(value);
  input.onchange=()=>update(input.value);
  return field(label,input);
}

function numberControl(label, value, min, max, step, update) {
  const input=node('input');
  input.type='number'; input.min=min; input.max=max; input.step=step; input.value=value;
  input.onchange=()=>{
    if(!Number.isFinite(input.valueAsNumber)){ input.value=value; return; }
    update(clamp(input.valueAsNumber,min,max));
  };
  return field(label,input);
}

function colorControl(label, value, update) {
  const input=node('input'); input.type='color'; input.value=value;
  input.onchange=()=>update(input.value);
  return field(label,input);
}

function group(label, ...children) {
  const details=node('details','property-group');
  const grid=node('div','property-line');
  grid.append(...children);
  details.append(node('summary','',label),grid);
  return details;
}

function renderTypography(panel, clip,openGroups) {
  const type=titleType(clip);
  const set=(key,value)=>change(()=>{ (clip.type ||= {})[key]=value; });
  const n=(key,label,min,max,step=1)=>numberControl(label,type[key],min,max,step,value=>set(key,value));
  const c=(key,label)=>colorControl(label,type[key],value=>set(key,value));
  const font=group('Typography',
    choice('Font',Object.keys(fontFamilies).map(name=>[name,name]),type.family,v=>set('family',v)),
    choice('Weight & style',[[0,'Regular'],[1,'Bold'],[2,'Italic'],[3,'Bold italic']],type.weight,v=>set('weight',Number(v))),
    n('size','Size (% of frame)',1.5,20,.1),n('leading','Line height',.8,2.6,.05),
    choice('Alignment',[['left','Left'],['center','Center'],['right','Right']],type.align,v=>set('align',v)),
    n('tracking','Letter spacing',0,3),choice('Letter case',[['normal','As written'],['upper','Uppercase'],['lower','Lowercase']],type.case,v=>set('case',v)),c('fill','Text color'));
  font.open=true;
  panel.append(font,
    group('Background & outline',c('background','Background color'),n('boxOpacity','Background opacity (%)',0,100),
      n('padding','Background padding',0,60),c('outlineColor','Outline color'),n('outline','Outline width',0,18)),
    group('Soft shadow & depth',n('shadow','Shadow opacity (%)',0,100),n('blur','Shadow blur',0,48),
      n('shadowX','Shadow offset X',-60,60),n('shadowY','Shadow offset Y',-60,60),
      n('depth','3D extrusion depth',0,14),c('depthColor','Extrusion color')));
  for(const details of panel.querySelectorAll('details')) if(openGroups.has(details.firstElementChild.textContent)) details.open=true;
}

function addCues(cues, offset=0) {
  if(!guardTrack('caption:5')) return;
  const imported=[];
  for(const cue of cues) {
    const text=cleanText(cue.text);
    const start=cue.start+offset;
    if(!text || project.titles.some(item=>item.style==='caption' && item.start===start && item.len===cue.len && item.text===text)) continue;
    imported.push({id:id(),track:5,style:'caption',start,len:cue.len,text});
  }
  if(!imported.length){ notify('No new captions found'); return; }
  change(()=>{ project.titles.push(...imported); selected=imported[0].id; });
  setPosition(imported[0].start);
  notify(`Added ${imported.length} ${imported.length===1 ? 'caption' : 'captions'}`);
}

async function autoCaptions() {
  if(transcribing || !transcriptionAvailable) return;
  const snapshot=structuredClone(project);
  transcribing=true;
  renderTools();
  notify('Transcribing timeline dialogue on this PC…');
  try {
    const result=await jsonPost('/api/transcribe',{ ...snapshot,language:speechLanguage });
    const now=JSON.stringify([project.clips,project.overlays,project.sounds]);
    if(now!==JSON.stringify([snapshot.clips,snapshot.overlays,snapshot.sounds])) { notify('The audio edit changed. Generate captions again for the current cut.'); return; }
    addCues(readSrt(result.srt).map(cue=>({...cue,len:Math.min(cue.len,result.endFrame-cue.start)})).filter(cue=>cue.len>0));
  } catch(error) { notify(error.message); }
  finally { transcribing=false; renderTools(); }
}

async function saveSubtitles() {
  const captions=project.titles.filter(clip=>clip.style==='caption');
  if(!captions.length) return;
  const srt=writeSrt(captions);
  try {
    if(window.framecutDesktop) {
      const result=await window.framecutDesktop.saveSubtitles(project.name,srt);
      if(result) notify('Saved subtitle file');
    } else {
      const url=URL.createObjectURL(new Blob([srt],{type:'application/x-subrip'}));
      const a=node('a'); a.href=url; a.download='captions.srt'; a.click();
      setTimeout(()=>URL.revokeObjectURL(url),5000);
    }
  } catch(error){ notify(error.message); }
}

function extractAudio(clip) {
  if(!guardTrack(trackOf(clip))) return;
  if(project.sounds.some(sound=>sound.extractedFrom===clip.id) || bin.get(clip.asset)?.audio==null) return;
  const start=clipStart(clip);
  const track=freeAudioTrack(start,clip.len);
  if(!track) return notify('No free audio tracks at this cut');
  const sound={id:id(),kind:'audio',asset:clip.asset,track,start,in:clip.in,len:clip.len,dialogue:true,extractedFrom:clip.id};
  change(()=>{
    project.audioLayers=Math.max(project.audioLayers,track);
    project.sounds.push(sound);
    clip.muted=true;
    selected=sound.id;
  });
  setPosition(start);
  notify('Audio extracted at the cut. Original audio muted.');
}

function freeAudioTrack(start,len) {
  for(let track=1;track<=12;track++) {
    if(!protectedTrack(project,`audio:${track}`) && !project.sounds.some(clip=>clip.track===track && clip.start<start+len && clip.start+clip.len>start)) return track;
  }
  return 0;
}

function insertSound(asset, track, start=cursor) {
  start=Math.max(0,start);
  track ||= freeAudioTrack(start,asset.frames);
  if(!track) return notify('No free audio tracks at the playhead');
  if(!guardTrack(`audio:${track}`)) return;
  const clip={id:id(),kind:'audio',asset:asset.id,track,in:0,start:freeStart(project.sounds.filter(item=>item.track===track),start,asset.frames),len:asset.frames,
    dialogue:false,gainDb:0,fadeIn:0,fadeOut:0};
  change(()=>{ project.sounds.push(clip); project.audioLayers=Math.max(track,project.audioLayers); selected=clip.id; });
  setPosition(clip.start);
  revealCursor();
}

function renderAudioInspector(panel,clip) {
  const asset=bin.get(clip.asset);
  if(!asset) { panel.append(node('p','subtle','Audio source unavailable.')); return; }
  panel.append(node('h2','inspector-name',asset.name));
  const timing=node('div','property-line');
  const available=laneNeighbors(clip).next-clip.start;
  timing.append(timeField('Audio start (s)',clip.start,0,duration+3600*fps,value=>{ clip.start=freeStart(layerItems(clip),value,clip.len,clip.id); }),
    timeField('Source in (s)',clip.in,Math.max(0,clip.in+clip.len-available),clip.in+clip.len-1,value=>{ clip.len+=clip.in-value; clip.in=value; }),
    timeField('Source out (s)',clip.in+clip.len,clip.in+1,Math.min(asset.frames,clip.in+available),value=>{ clip.len=value-clip.in; }),
    numberControl('Volume (dB)',clip.gainDb || 0,-60,0,1,value=>change(()=>{ clip.gainDb=value; })),
    timeField('Fade in (s)',clip.fadeIn || 0,0,clip.len,value=>{ clip.fadeIn=value; }),
    timeField('Fade out (s)',clip.fadeOut || 0,0,clip.len,value=>{ clip.fadeOut=value; }));
  const tracks=[];
  for(let number=1;number<=Math.max(3,project.audioLayers);number++) tracks.push([number,`Audio ${number}`]);
  panel.append(timing,choice('Audio track',tracks,clip.track,value=>change(()=>{
    clip.track=Number(value); project.audioLayers=Math.max(project.audioLayers,clip.track);
    clip.start=freeStart(layerItems(clip),clip.start,clip.len,clip.id);
  })),choice('Role',[['effects','Sound design'],['dialogue','Dialogue']],clip.dialogue ? 'dialogue' : 'effects',
    value=>change(()=>{ clip.dialogue=value==='dialogue'; })),
    button(clip.muted?'Unmute audio':'Mute audio',()=>change(()=>{clip.muted=!clip.muted;})));
}

async function buildSound(settings,track,start=cursor) {
  notify('Creating sound…');
  try {
    let asset=Object.hasOwn(soundPresets,settings.preset) ? [...bin.values()].find(item=>item.preset===settings.preset) : null;
    if(!asset){ asset=await jsonPost('/api/sound',settings); if(settings.preset) asset.preset=settings.preset; bin.set(asset.id,asset); }
    insertSound(asset,track,start);
    notify(`Added ${asset.name}`);
  } catch(error){ notify(error.message); }
}

async function audition(settings) {
  try {
    soundContext ||= new AudioContext({sampleRate:48000});
    await soundContext.resume();
    if(auditionNode) { auditionNode.stop(); auditionNode=null; }
    const samples=soundWave(soundSettings(settings),soundContext.sampleRate);
    const buffer=soundContext.createBuffer(1,samples.length,soundContext.sampleRate);
    buffer.copyToChannel(samples,0);
    const source=soundContext.createBufferSource();
    source.buffer=buffer;
    source.connect(soundContext.destination);
    source.onended=()=>{ if(auditionNode===source) auditionNode=null; };
    auditionNode=source;
    source.start();
  } catch(error){ notify(error.message); }
}

function renderSoundTools(tools) {
  const mixer = node('div','track-mixer');
  mixer.id='track-mixer';
  tools.append(node('h2','','Track mixer'),mixer);
  renderMixer(mixer);
  const library=node('div','sound-library');
  for(const [key,[name]] of Object.entries(soundPresets)) {
    const row=node('div','sound-row');
    const tone=button(name,()=>void buildSound({preset:key}));
    tone.classList.add('effect-card');
    tone.draggable=true;
    tone.ondragstart=event=>{ event.dataTransfer.setData('application/x-framecut-sound',key); event.dataTransfer.effectAllowed='copy'; };
    const test=button('▷',()=>void audition({preset:key}));
    test.title=`Audition ${name}`; test.setAttribute('aria-label',test.title);
    row.append(tone,test); library.append(row);
  }
  const custom={ name:'Custom sound',wave:'sine',len:.45,from:560,to:220,decay:2,noise:.15 };
  const name=node('input'); name.value=custom.name; name.maxLength=64; name.onchange=()=>{custom.name=name.value;};
  const n=(key,label,min,max,step)=>numberControl(label,custom[key],min,max,step,value=>{custom[key]=value;});
  const designer=group('Create a sound',field('Name',name),
    choice('Waveform',[['sine','Sine'],['triangle','Triangle'],['square','Square'],['noise','Noise']],custom.wave,value=>{custom.wave=value;}),
    n('len','Duration (s)',.04,4,.01),n('from','Start pitch (Hz)',25,3500,1),
    n('to','End pitch (Hz)',25,3500,1),n('decay','Decay',.2,8,.1),n('noise','Noise mix',0,1,.05),
    button('Preview sound',()=>void audition(custom)),button('Create & add',()=>void buildSound(custom)));
  const picker=node('select','tool-select');
  picker.setAttribute('aria-label','Imported audio');
  picker.add(new Option('Choose imported audio…',''));
  for(const item of bin.values()) if(item.kind==='audio') picker.add(new Option(item.name,item.id));
  const add=button('Add audio to timeline',()=>{ const asset=bin.get(picker.value); if(asset) insertSound(asset); },true);
  picker.onchange=()=>{add.disabled=!picker.value;};
  tools.append(button('Import audio files',()=>$('audio-file').click()),picker,add,designer,node('h2','','Sound library'),library);
}

function saveMix(key, values) {
  if(key==='master'){
    if(values.muted!==undefined) project.masterMuted=values.muted;
    if(values.gainDb!==undefined) project.masterGainDb=values.gainDb;
  } else {
    project.trackSettings ||= {};
    project.trackSettings[key]={...trackSettings(project,key),...values};
  }
  persist();
}

function audioStrip(key,label) {
  const strip=node('div','mixer-strip');
  const master=key==='master';
  const settings=master?{muted:project.masterMuted,gainDb:project.masterGainDb}:trackSettings(project,key);
  const mute=button('M',()=>{
    const muted=master?!project.masterMuted:!trackSettings(project,key).muted;
    saveMix(key,{muted});
    mute.setAttribute('aria-pressed',String(muted));
    refreshTrackControls();
    display(cursor);
  });
  mute.setAttribute('aria-label',`Mute ${label} in mixer`);
  mute.setAttribute('aria-pressed',String(Boolean(settings.muted)));
  const value=node('output','mixer-value',`${gainDb(settings.gainDb)} dB`);
  const fader=node('input');
  fader.type='range'; fader.min='-60'; fader.max='0'; fader.step='1';
  fader.value=gainDb(settings.gainDb);
  fader.setAttribute('aria-label',`${label} level`);
  fader.oninput=()=>{
    saveMix(key,{gainDb:Number(fader.value)});
    value.textContent=`${fader.value} dB`;
    display(cursor);
  };
  strip.append(node('strong','',label),mute,fader,value);
  return strip;
}

function renderMixer(panel=$('track-mixer')) {
  if(!panel) return;
  const strips=[audioStrip('master','Master')];
  for(let index=0; index<=project.layers; index++) strips.push(audioStrip(`video:${index}`,`Video ${index+1}`));
  for(let index=1; index<=Math.max(3,project.audioLayers); index++) strips.push(audioStrip(`audio:${index}`,`Audio ${index}`));
  panel.replaceChildren(...strips);
}

function laneNeighbors(clip) {
  const items = layerItems(clip).filter(item => item.id !== clip.id);
  return {
    previous: Math.max(0, ...items.filter(item => item.start < clip.start).map(item => item.start + item.len)),
    next: Math.min(Infinity, ...items.filter(item => item.start > clip.start).map(item => item.start))
  };
}

function clipStart(clip) {
  return clip.start ?? timeline.find(item => item.id === clip.id)?.start ?? 0;
}

function keyControl(clip, key) {
  const [label, min, max] = properties[key];
  const at = clamp(cursor - clipStart(clip), 0, clip.len - 1);
  const checkbox = node('div', 'key-control');
  const input = node('input');
  input.type = 'number';
  input.min = min; input.max = max; input.step = 'any';
  input.value = Math.round(valueAt(clip, key, at) * 10) / 10;
  input.dataset.key = key;
  const has = frame => clip.motion?.[key]?.some(([time]) => time === frame);
  function write(value, keyframe) {
    if (!Number.isFinite(value)) return;
    const local = clamp(cursor - clipStart(clip), 0, clip.len - 1);
    const time = keyframe ? local : 0;
    change(() => {
      clip.motion ||= {};
      const previous = (clip.motion[key] || []).filter(([frame]) => frame !== time);
      clip.motion[key] = [...previous, [time, clamp(value, min, max)]].sort((a,b) => a[0] - b[0]);
    });
  }
  input.onchange = () => write(input.valueAsNumber, page === 'animation' || points(clip, key).length > 1);
  const add = button('◆', () => write(input.valueAsNumber, true));
  add.className = 'icon';
  add.classList.toggle('keyed', Boolean(has(at)));
  add.title = 'Set ' + label + ' at playhead';
  add.setAttribute('aria-label', add.title);
  add.dataset.keyAdd = key;
  const remove = button('−', () => {
    const frame = clamp(cursor - clipStart(clip), 0, clip.len - 1);
    change(() => { clip.motion[key] = clip.motion[key].filter(([time]) => time !== frame); });
  }, !has(at));
  remove.className = 'icon';
  remove.title = 'Remove ' + label + ' keyframe';
  remove.setAttribute('aria-label', remove.title);
  remove.dataset.keyRemove = key;
  checkbox.append(field(label, input), add, remove);
  return checkbox;
}

function updateKeyControls() {
  const clip = selection();
  if (!clip || clip.kind==='audio' || (page !== 'animation' && page !== 'color')) return;
  const frame = clamp(cursor - clipStart(clip), 0, clip.len - 1);
  for (const input of $('inspector').querySelectorAll('[data-key]')) {
    const key = input.dataset.key;
    if (document.activeElement !== input) input.value = Math.round(valueAt(clip, key, frame) * 10) / 10;
    const keyed = Boolean(clip.motion?.[key]?.some(([at]) => at === frame));
    input.parentElement.parentElement.querySelector('[data-key-add]').classList.toggle('keyed', keyed);
    input.parentElement.parentElement.querySelector('[data-key-remove]').disabled = !keyed;
  }
}

function applyEffect(name, clip = selection()) {
  if (!clip) return notify('Select a clip or drag the preset onto one.');
  if(!guardTrack(trackOf(clip))) return;
  const preset = presets.find(row => row[0] === name);
  const look = looks.find(row => row[0] === name);
  if (name === 'Typewriter' && clip.asset) return notify('Drop Typewriter onto a title.');
  if (!preset && !look && name !== 'Typewriter') return;
  change(() => {
    clip.motion ||= {};
    if (preset) {
      for (const [key, pairs] of Object.entries(preset[2])) {
        clip.motion[key] = pairs.map(([at, value]) => [Math.round(at * (clip.len - 1)), value]);
      }
    }
    if (look) {
      for (const [key, value] of Object.entries(look[1])) clip.motion[key] = [[0, value]];
      clip.gradeLabel = look[0];
    }
    if (name === 'Typewriter') clip.typewriter = true;
  });
  notify(`Applied ${name}`);
}

function jsonPost(url, payload) {
  return api(url, { method:'POST', headers:{ 'X-Framecut':'1', 'Content-Type':'application/json' }, body:JSON.stringify(payload) });
}

async function grade(clip, match) {
  if (!clip?.asset) return;
  notify(match ? 'Matching shot to reference…' : 'Analyzing shot…');
  try {
    const stats = await jsonPost('/api/analyze', { asset:clip.asset, in:clip.in, len:clip.len, lut:clip.lut });
    if (match === 'reference') {
      const properties = ['brightness','contrast','saturation'];
      const corrections = properties.map(key => valueAt(clip,key,0) / 100);
      project.gradeReference = { mean: ((stats.mean * corrections[0] - .5) * corrections[1]) + .5,
        deviation: stats.deviation * corrections[0] * corrections[1],
        chroma: stats.chroma * corrections[0] * corrections[1] * corrections[2], id:clip.id };
      notify('Reference grade captured');
      persist();
      renderTools();
      return;
    }
    const target = match ? project.gradeReference : { mean:.48, deviation:.22, chroma:.23 };
    if (!target || !selection() || ![...project.clips,...project.overlays].includes(clip)) return;
    change(() => assignGrade(clip,stats,target,match ? 'Reference match' : 'Auto grade'));
    notify(`Applied ${clip.gradeLabel}`);
  } catch (error) { notify(error.message); }
}

function assignGrade(clip, stats, target, name) {
  const contrast = clamp(target.deviation / Math.max(.05, stats.deviation), .65, 1.5);
  const brightness = clamp(((target.mean - .5) / contrast + .5) / Math.max(.06,stats.mean), .65, 1.55);
  const saturation = clamp(target.chroma / Math.max(.045, stats.chroma * brightness * contrast), .55, 1.55);
  clip.motion ||= {};
  Object.assign(clip.motion, { brightness:[[0,brightness*100]], contrast:[[0,contrast*100]], saturation:[[0,saturation*100]] });
  clip.gradeLabel = name;
}

async function matchTimeline() {
  if (importing || !project.gradeReference) return;
  importing = true;
  const target = project.gradeReference;
  const shots = [...project.clips,...project.overlays].filter(item => bin.has(item.asset) && !bin.get(item.asset).alpha && item.id !== target.id);
  const matched = [];
  let failed = 0;
  try {
    for (const [index,shot] of shots.entries()) {
      notify(`Matching shot ${index+1} of ${shots.length}…`);
      try {
        const stats = await jsonPost('/api/analyze',{asset:shot.asset,in:shot.in,len:shot.len,lut:shot.lut});
        if ([...project.clips,...project.overlays].includes(shot)) matched.push([shot,stats]);
      } catch { failed++; }
    }
    if (matched.length) change(() => {
      for (const [shot,stats] of matched) assignGrade(shot,stats,target,'Reference match');
    });
    notify(`Matched ${matched.length} shots${failed ? ` · ${failed} could not be analyzed` : ''}`);
  } finally { importing = false; }
}

function renderTools() {
  const tools = $('tools');
  const previous=new Map([...tools.querySelectorAll('details')].map(details=>[details.firstElementChild?.textContent,details.open]));
  for(const card of tools.querySelectorAll('.preview-preset')) {
    previewObserver.unobserve(card);
    previewAnimations.get(card)?.cancel();
  }
  tools.replaceChildren();
  const clip = selection();
  if (page === 'edit') {
    const asset = node('select','tool-select');
    asset.setAttribute('aria-label','Footage to add');
    asset.add(new Option('Choose footage…',''));
    for (const item of bin.values()) if(item.kind!=='audio') asset.add(new Option(item.name,item.id));
    const add = button('Add to video track', () => insertVideo(asset.value,project.clips.length), true);
    const layer = button('Add on top layer', () => insertOverlay(asset.value), true);
    asset.onchange = () => { add.disabled = layer.disabled = !asset.value; };
    tools.append(asset,add,layer);
  } else if (page === 'text') {
    const cards=node('div','effect-list');
    for(const name of Object.keys(textPresets)) cards.append(button(name,()=>addTitle(structuredClone(textPresets[name]))));
    const language=node('select','tool-select');
    language.setAttribute('aria-label','Spoken language');
    for(const [value,name] of [['auto','Detect language'],['en','English'],['hi','Hindi'],['ta','Tamil'],['te','Telugu'],['bn','Bengali'],['ml','Malayalam'],['ur','Urdu'],['es','Spanish'],['fr','French'],['de','German'],['it','Italian'],['pt','Portuguese'],['ja','Japanese'],['ko','Korean'],['zh','Chinese'],['ar','Arabic'],['ru','Russian']]) language.add(new Option(name,value));
    language.value=speechLanguage;
    language.onchange=()=>{speechLanguage=language.value;};
    const animations=node('div','effect-list');
    for(const name of ['Typewriter',...presets.filter(row=>row[1]==='Titles & motion').map(row=>row[0])]) animations.append(presetCard(name,true));
    const animation=group('Text animations',animations);
    animation.classList.add('text-animations');
    animation.open=previous.get('Text animations') ?? true;
    tools.append(button('Add text',()=>addTitle()),button('Add caption',()=>addTitle(undefined,true)),
      button('Import SRT or script',()=>$('subtitle-file').click()),
      button('Save SRT',()=>void saveSubtitles(),!project.titles.some(item=>item.style==='caption')),
      language,button(transcribing?'Transcribing…':'Auto-detect subtitles',()=>void autoCaptions(),!transcriptionAvailable || transcribing || !duration));
    if(!transcriptionAvailable) tools.append(node('p','subtle','The offline speech model is unavailable in this build.'));
    tools.append(node('h2','','Academic templates'),cards,animation);
  } else if (page === 'sound') {
    renderSoundTools(tools);
  } else if (page === 'effects') {
    const categories = node('select', 'tool-select');
    for (const category of ['Motion','Transitions','Filters','3D & particles','Video tools']) categories.add(new Option(category));
    categories.value = effectCategory;
    categories.onchange = () => { effectCategory = categories.value; if (effectCategory !== 'Video tools') cancelPicking(); renderTools(); };
    tools.append(categories);
    if (effectCategory === 'Video tools') {
      tools.append(button('Upscale selected footage', () => void upscale(clip), !clip?.asset),
        node('p', 'subtle', 'Upscale creates a new clip using Lanczos scaling.'),
        node('h2','','Motion tracking'),
        button('Draw region in preview', () => beginPicking(clip), !clip?.asset || Boolean(clip.track)),
        button('Track motion', () => void trackMotion(), !trackingBox || trackingSource !== clip?.id));
      if (tracked?.points?.length) {
        const target = node('select','tool-select');
        target.add(new Option('Layer or title to follow', ''));
        for (const item of [...project.overlays,...project.titles]) target.add(new Option(item.text || bin.get(item.asset)?.name || 'Video layer', item.id));
        const attach = button('Apply tracking to layer', () => attachMotion(target.value),true);
        target.onchange = () => { attach.disabled = !target.value; };
        tools.append(target,attach);
      }
      tools.append(node('p','subtle','Track a textured region from the start of a base clip. Add a graphic on a video layer to attach it.'));
      if (objectRemovalAvailable) {
        const follow = node('input');
        follow.type = 'checkbox';
        follow.id = 'propainter-follow';
        const check = node('label','check-row');
        check.append(follow,'Follow moving object');
        tools.append(node('h2','','Remove object'),check,
          button('Remove marked object', () => void removeMarkedObject(clip,follow.checked), !trackingBox || trackingSource !== clip?.id || importing),
          node('p','subtle','Uses local ProPainter on shots up to three seconds. Adds a processed copy to Footage. Noncommercial use.'));
      }
      return;
    }
    if (effectCategory === '3D & particles') {
      tools.append(button('Add rotating cube', () => void addGraphic('cube')),
        button('Import .obj model', () => $('model-file').click()),
        button('Add sparks', () => void addGraphic('sparks')),
        button('Add fire', () => void addGraphic('fire')),
        particleLab(),node('p','subtle','Animate the resulting layer or attach a tracking path from Video tools.'));
      return;
    }
    const cards = node('div', 'effect-list');
    const names = effectCategory === 'Filters' ? looks.map(row => row[0])
      : presets.filter(row => row[1] === (effectCategory==='Motion' ? 'Titles & motion' : effectCategory)).map(row => row[0]);
    for (const name of names) cards.append(presetCard(name));
    tools.append(cards);
  } else if (page === 'animation') {
    tools.append(node('p', 'subtle', 'Select a clip and move the playhead. Edit a value or press ◆ to set a keyframe. Drag diamonds to retime.'));
  } else if (page === 'color') {
    const select = node('select','tool-select');
    select.add(new Option('No LUT', ''));
    for (const lut of lutLibrary.values()) select.add(new Option(lut.name, lut.id));
    select.value = clip?.lut || '';
    select.disabled = !clip?.asset;
    select.onchange = () => change(() => { clip.lut = select.value; });
    const links = node('div','inline-actions');
    for (const [label,url] of [
      ['DJI Mini 4 Pro','https://www.dji.com/downloads/softwares/mini-4-pro-dlog-to-rec709'],
      ['DJI Pocket 3','https://www.dji.com/downloads/softwares/osmo-pocket-3-dlog-to-rec709'],
      ['DJI Mavic 3','https://www.dji.com/downloads/products/mavic-3'],
      ['More DJI LUTs','https://www.dji.com/downloads']
    ]) {
      const link = node('a','subtle',label);
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      links.append(link);
    }
    tools.append(node('h2','','Camera LUT'), select, button('Import .cube LUT', () => $('lut-file').click()), links,
      node('p','subtle','Choose the LUT for your camera and recording profile. Unzip DJI downloads before importing.'),
      button('Auto grade', () => void grade(clip, false), !clip?.asset),
      button('Use shot as reference', () => void grade(clip, 'reference'), !clip?.asset),
      button('Match reference', () => void grade(clip, true), !clip?.asset || !project.gradeReference),
      button('Match timeline to reference', () => void matchTimeline(), !project.gradeReference));
    if (clip) {
      const label = node('input');
      label.placeholder = 'Grade label';
      label.maxLength = 50;
      label.value = clip.gradeLabel || '';
      label.onchange = () => change(() => { clip.gradeLabel = label.value.trim(); });
      tools.append(field('Grade label', label));
    }
  }
}

function presetCard(name,textOnly=false) {
  const card=button(name,()=>{
    if(textOnly && (!selection() || selection().asset)) return notify('Select a title or caption first');
    applyEffect(name);
  });
  card.classList.add('effect-card');
  fillPresetPreview(card,name,textOnly);
  card.draggable=true;
  card.ondragstart=event=>{
    event.dataTransfer.setData(textOnly?'application/x-framecut-text-effect':'application/x-framecut-effect',name);
    event.dataTransfer.effectAllowed='copy';
  };
  return card;
}

function fillPresetPreview(card,name,textOnly) {
  card.classList.add('preview-preset');
  card.setAttribute('aria-label',name);
  const viewport=node('span','effect-viewport');
  viewport.setAttribute('aria-hidden','true');
  const preset=presets.find(row=>row[0]===name);
  const isTransition=preset?.[1]==='Transitions';
  const typewriter=name==='Typewriter';
  const look=looks.find(row=>row[0]===name);
  const sample=node('span',textOnly?'effect-sample-text':look?'effect-sample-swatches':'effect-sample-rect',textOnly?'Sample title':'');
  if(isTransition) viewport.classList.add(name==='Dip to black'?'demo-dip':'demo-transition');
  viewport.append(sample);
  card.replaceChildren(viewport,node('span','effect-name',name));
  if(look){
    const [,{brightness=100,contrast=100,saturation=100}]=look;
    sample.style.filter=`brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
    return;
  }
  let keys;
  if(typewriter){
    keys=[{offset:0,clipPath:'inset(0 100% 0 0)',easing:'steps(12,end)'},
      {offset:.68,clipPath:'inset(0 0 0 0)'},{offset:1,clipPath:'inset(0 0 0 0)'}];
  } else if(preset){
    const offsets=[...new Set([0,1,...Object.values(preset[2]).flatMap(values=>values.map(([at])=>at))])].sort((a,b)=>a-b);
    const clip={motion:Object.fromEntries(Object.entries(preset[2]).map(([key,pairs])=>[key,pairs.map(([at,value])=>[Math.round(at*1000),value])]))};
    keys=offsets.map(offset=>{
      const v=key=>valueAt(clip,key,Math.round(offset*1000));
      return {offset:offset*.78,transform:`translate(${v('x')}cqw,${v('y')}cqh) rotate(${v('rotation')}deg) scale(${v('scale')/100})`,
        opacity:v('opacity')/100,clipPath:`inset(${v('top')}% ${v('right')}% ${v('bottom')}% ${v('left')}%)`};
    });
    keys.push({...keys.at(-1),offset:1});
  } else return;
  const animation=sample.animate(keys,{duration:2100,iterations:Infinity,fill:'both'});
  animation.pause();
  animation.currentTime=reduceMotion.matches?840:0;
  previewAnimations.set(card,animation);
  previewObserver.observe(card);
  const replay=()=>{animation.currentTime=0;animation.play();};
  card.onpointerenter=replay;
  card.onfocus=replay;
  if(reduceMotion.matches) card.onpointerleave=()=>{animation.pause();animation.currentTime=840;};
}

function particleLab() {
  const details=node('details','property-group particle-designer');
  details.append(node('summary','','Particle designer'));
  let kind='sparks';
  let settings=particleSettings(kind);
  const canvas=node('canvas','particle-preview');
  canvas.width=480;canvas.height=270;
  const ctx=canvas.getContext('2d');
  const pixels=ctx.createImageData(480,270);
  const controls=node('div','property-line');
  const descriptor=choice('Emitter',Object.entries(particlePresets).map(([key,[name]])=>[key,name]),kind,value=>{
    kind=value;settings=particleSettings(value);render();
  });
  function render(){
    const n=(key,label,min,max,step=1)=>numberControl(label,settings[key],min,max,step,value=>{settings[key]=value;});
    controls.replaceChildren(descriptor,
      n('quantity','Quantity',4,260),n('size','Particle size',1,34,.5),n('speed','Speed',.1,3,.05),
      n('life','Life (s)',.15,3,.05),n('spread','Spread',4,100),n('duration','Duration (s)',.5,12,.1),
      n('direction','Direction (°)',-180,180),n('gravity','Gravity',-100,100),n('turbulence','Turbulence',0,100),
      n('opacity','Opacity (%)',5,100),n('seed','Random seed',1,9999),n('originX','Origin X (%)',0,100),
      n('originY','Origin Y (%)',0,100),colorControl('Color',settings.color,value=>{settings.color=value;}),
      button('Create particle layer',()=>void addGraphic(kind,undefined,{...settings})));
  }
  let next=0;
  const draw=now=>{
    if(!details.isConnected || !details.open) return;
    if(now>=next){
      pixels.data.fill(0);paintParticles(pixels.data,kind,Math.floor(now/33)%3600,settings);
      ctx.putImageData(pixels,0,0);next=now+50;
    }
    requestAnimationFrame(draw);
  };
  details.ontoggle=()=>{if(details.open) requestAnimationFrame(draw);};
  details.append(canvas,controls); render();
  return details;
}

async function addGraphic(kind, file, settings) {
  if (importing) return;
  importing = true;
  const start = cursor;
  notify('Rendering a transparent graphic…');
  try {
    if (file && file.size > 950000) throw new Error('Choose an OBJ file smaller than 950 KB.');
    const asset = await jsonPost('/api/graphics',{kind, mesh:file ? await file.text() : undefined,name:file?.name,settings});
    bin.set(asset.id,asset);
    renderBin();
    const last = project.overlays.filter(clip => clip.track === project.layers);
    const track = last.some(clip => start < clip.start + clip.len && start + asset.frames > clip.start) ? Math.min(8,project.layers+1) : project.layers || 1;
    insertOverlay(asset.id,track,start,true);
    notify(`Added ${asset.name}`);
  } catch (error) { notify(error.message); }
  finally { importing = false; }
}

function fittedArea(clip) {
  const ratio = active.videoWidth && active.videoHeight ? active.videoWidth / active.videoHeight :
    (bin.get(clip.asset)?.width || 1920)/(bin.get(clip.asset)?.height || 1080);
  const screen = $('stage').clientWidth / $('stage').clientHeight;
  const w = Math.min(1,ratio/screen), h = Math.min(1,screen/ratio);
  return { x:(1-w)/2,y:(1-h)/2,w,h };
}

function showTrackingBox(box) {
  const overlay = $('tracking-box');
  overlay.hidden = !box;
  if (!box) return;
  const area = trackingArea || { x:0,y:0,w:1,h:1 };
  overlay.style.left = `${(area.x+box.x*area.w)*100}%`;
  overlay.style.top = `${(area.y+box.y*area.h)*100}%`;
  overlay.style.width = `${box.w*area.w*100}%`;
  overlay.style.height = `${box.h*area.h*100}%`;
}

function cancelPicking() {
  picking = false;
  $('stage').classList.remove('track-picking');
  showTrackingBox(null);
}

function beginPicking(clip) {
  if (!clip?.asset || clip.track) return;
  setPosition(clipStart(clip));
  trackingSource = clip.id;
  trackingBox = null;
  picking = true;
  $('stage').classList.add('track-picking');
  notify('Drag a box around a textured region in the preview');
}

$('stage').onpointerdown = event => {
  if(placingText && event.button===0) {
    const rect=$('stage').getBoundingClientRect();
    const x=clamp(((event.clientX-rect.left)/rect.width-.5)*100,-44,44);
    const y=clamp(((event.clientY-rect.top)/rect.height-.5)*100,-42,42);
    stopTextPlacement();
    addTitle({motion:{x:[[0,x]],y:[[0,y]]}});
    return;
  }
  const clip = selection();
  if (!picking || !clip || clip.id !== trackingSource) return;
  const stage = $('stage');
  const rect = stage.getBoundingClientRect();
  trackingArea = fittedArea(clip);
  const at = event => [
    clamp(((event.clientX-rect.left)/rect.width-trackingArea.x)/trackingArea.w,0,1),
    clamp(((event.clientY-rect.top)/rect.height-trackingArea.y)/trackingArea.h,0,1)
  ];
  const [x,y] = at(event);
  stage.setPointerCapture(event.pointerId);
  const update = move => {
    const [a,b] = at(move);
    trackingBox = { x:Math.min(x,a),y:Math.min(y,b),w:Math.abs(a-x),h:Math.abs(b-y) };
    showTrackingBox(trackingBox);
  };
  stage.onpointermove = update;
  stage.onpointerup = end => {
    update(end);
    stage.onpointermove = stage.onpointerup = null;
    picking = false;
    stage.classList.remove('track-picking');
    renderTools();
    notify('Tracking region set');
  };
};

function stopTextPlacement() {
  placingText=false;
  $('stage').classList.remove('placing-text');
  $('place-text').setAttribute('aria-pressed','false');
}

$('place-text').onclick=()=>{
  if(placingText){stopTextPlacement();return;}
  cancelPicking();
  pause();
  placingText=true;
  $('stage').classList.add('placing-text');
  $('place-text').setAttribute('aria-pressed','true');
  notify('Click the preview where you want to place text');
};

function dropTitleTarget(event) {
  const title=event.target.closest('[data-preview-title]')?.dataset.previewTitle;
  return title ? project.titles.find(item=>item.id===title) : null;
}

$('stage').ondragover=event=>{
  if(Array.from(event.dataTransfer.types).includes('application/x-framecut-text-effect') && dropTitleTarget(event)){
    event.preventDefault();
    event.dataTransfer.dropEffect='copy';
  }
};
$('stage').ondrop=event=>{
  const preset=event.dataTransfer.getData('application/x-framecut-text-effect');
  const title=dropTitleTarget(event);
  if(!preset || !title) return;
  event.preventDefault();
  select(title.id);
  applyEffect(preset,title);
};

async function trackMotion() {
  const clip = selection();
  if (!clip || trackingSource !== clip.id || !trackingBox) return;
  notify('Tracking motion…');
  try {
    const points = await jsonPost('/api/track',{asset:clip.asset,in:clip.in,len:clip.len,box:trackingBox});
    tracked = { source:clip.id, points, area:{...trackingArea} };
    renderTools();
    notify(`Tracked ${points.length} samples. Choose a layer to follow.`);
  } catch (error) { notify(error.message); }
}

function attachMotion(id) {
  const item = [...project.overlays,...project.titles].find(clip => clip.id === id);
  const source = project.clips.find(clip => clip.id === tracked?.source);
  if (!item || !source) return notify('Select a tracked shot and a layer.');
  const duration = Math.min(item.len,source.len);
  const samples = tracked.points.filter(([at]) => at < duration);
  const {x,y,w,h} = tracked.area;
  const start = clipStart(source);
  if (!samples.length || layerItems(item).some(peer => peer.id !== id && peer.start < start+duration && peer.start+peer.len > start)) return notify('Choose a free layer to place the tracking result.');
  change(() => {
    item.start = start;
    item.len = duration;
    item.motion ||= {};
    item.motion.x = samples.map(([at,px])=>[at,(x+px*w-.5)*100]);
    item.motion.y = samples.map(([at,,py])=>[at,(y+py*h-.5)*100]);
    selected = id;
  });
  notify('Tracking added to X and Y keyframes');
}

async function removeMarkedObject(clip, follow) {
  if (!clip?.asset || clip.id !== trackingSource || !trackingBox || importing) return;
  importing = true;
  renderTools();
  notify('Removing object locally…');
  try {
    const asset = await jsonPost('/api/remove-object',{ asset:clip.asset, in:clip.in, len:clip.len, box:trackingBox, follow });
    bin.set(asset.id,asset);
    sourceAsset = asset.id;
    notify(`Added ${asset.name} to Footage`);
  } catch (error) { notify(error.message); }
  finally { importing = false; renderTools(); }
}

async function upscale(clip) {
  if (!clip?.asset || importing) return;
  importing = true;
  notify('Upscaling selected footage to 2× resolution…');
  try {
    const asset = await jsonPost('/api/upscale', { asset:clip.asset, in:clip.in, len:clip.len });
    bin.set(asset.id, asset);
    renderBin();
    notify(`Added ${asset.name} to Footage`);
  } catch (error) { notify(error.message); }
  finally { importing = false; }
}

function ruler() {
  const width = Math.max(scroll.clientWidth, pixels(duration) + 100);
  space.style.width = `${width}px`;
  timelinePan.style.width = `${scroll.clientWidth}px`;
  $('timeline-pan-content').style.width = `${width}px`;
  timelinePan.scrollLeft = scroll.scrollLeft;
  space.style.setProperty('--frame-width', `${pixels(1)}px`);
  const interval = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(n => n * zoom >= 58 && width / (n * zoom) < 600) || Math.ceil(width / zoom / 600);
  space.style.setProperty('--tick', `${interval * zoom}px`);
  const ticks = document.createDocumentFragment();
  for (let s = 0; s * zoom <= width - 8; s += interval) {
    const tick = node('span', 'tick', timecode(s * fps).slice(s >= 3600 ? 0 : 3, interval < 1 ? 11 : 8));
    tick.style.left = `${s * zoom}px`;
    ticks.append(tick);
  }
  $('ruler').replaceChildren(ticks);
}

scroll.addEventListener('scroll', () => {
  if (timelinePan.scrollLeft !== scroll.scrollLeft) timelinePan.scrollLeft = scroll.scrollLeft;
});
function setTimelineScroll(left) {
  scroll.scrollLeft = left;
  timelinePan.scrollLeft = scroll.scrollLeft;
}
timelinePan.addEventListener('scroll', () => {
  if (scroll.scrollLeft !== timelinePan.scrollLeft) scroll.scrollLeft = timelinePan.scrollLeft;
});

function makeClip(clip, video) {
  const audio=clip.kind==='audio';
  const asset = (video || audio) && bin.get(clip.asset);
  const label = audio ? asset?.name || 'Missing audio' : video ? asset?.name || 'Missing video' : clip.text;
  const block = node('div', `clip ${audio ? 'audio-clip' : video ? 'video-clip' : 'title-clip'}`);
  if(clip.style==='caption') block.classList.add('caption-clip');
  block.classList.toggle('selected', clip.id === selected);
  block.dataset.id = clip.id;
  block.tabIndex = 0;
  block.setAttribute('role', 'button');
  block.setAttribute('aria-label', `${label}, ${timecode(clip.start)}`);
  block.title = `${label} · ${timecode(clip.len)}`;
  block.style.left = `calc(${clip.start} * var(--frame-width))`;
  block.style.width = `max(2px, calc(${clip.len} * var(--frame-width) - 1px))`;
  block.dataset.frames = clip.len;
  block.classList.toggle('narrow-clip', pixels(clip.len) < 18);
  if (asset && video) {
    const film = node('div', 'clip-film');
    film.style.backgroundImage = `url("${diskURL(asset.id, 'thumb.jpg')}")`;
    block.append(film);
  }
  block.append(node('span', 'clip-label', label));
  for (const side of ['left', 'right']) {
    const handle = node('span', `trim ${side}`);
    handle.dataset.trim = side;
    handle.title = `Trim ${side === 'left' ? 'start' : 'end'}`;
    block.append(handle);
  }
  block.addEventListener('focus', () => select(clip.id));
  block.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      setPosition(clip.start);
      event.preventDefault();
    }
  });
  block.addEventListener('pointerdown', event => startClipDrag(event, clip, block, video || audio));
  block.ondragover = event => {
    const types=Array.from(event.dataTransfer.types);
    if (audio || !(types.includes('application/x-framecut-effect') || !video && types.includes('application/x-framecut-text-effect'))) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  block.ondrop = event => {
    const effect = event.dataTransfer.getData('application/x-framecut-effect') ||
      (!video && event.dataTransfer.getData('application/x-framecut-text-effect'));
    if (!effect || audio) return;
    event.preventDefault();
    event.stopPropagation();
    select(clip.id);
    applyEffect(effect);
  };
  return block;
}

function trackLabel(text, className = '') {
  return node('div', className, text);
}

function addTrackLabel(text, type, number, className='') {
  const key=`${type}:${number}`;
  const row=trackLabel('',className);
  row.dataset.trackKey=key;
  const name=button(text,()=>{
    select(null);
    selectTrack(key);
  });
  name.className='track-select';
  name.dataset.trackKey=key;
  name.setAttribute('aria-label',`Select ${text}`);
  const lock=button('🔒',()=>{
    const locked=!trackSettings(project,key).locked;
    saveMix(key,{locked});
    refreshTrackControls();
    updateButtons();
  });
  lock.dataset.trackLock=key;
  lock.setAttribute('aria-label',`Lock ${text}`);
  const mute=button(type==='title'||type==='caption'?'H':'M',()=>{
    saveMix(key,{muted:!trackSettings(project,key).muted});
    refreshTrackControls();
    renderMixer();
    display(cursor);
  });
  mute.dataset.trackMute=key;
  mute.setAttribute('aria-label',`${type==='title'||type==='caption'?'Hide':'Mute'} ${text}`);
  mute.title=type==='video'?'Mute track audio':mute.getAttribute('aria-label');
  lock.title='Lock track against editing';
  row.append(name,lock,mute);
  return row;
}

function refreshTrackControls() {
  const locked=Boolean(project.timelineLocked);
  $('timeline-lock').textContent=locked?'Unlock timeline':'Lock timeline';
  $('timeline-lock').setAttribute('aria-pressed',String(locked));
  space.classList.toggle('timeline-locked',locked);
  for(const target of document.querySelectorAll('[data-track-lock], [data-track-mute]')){
    const key=target.dataset.trackLock || target.dataset.trackMute;
    const active=Boolean(trackSettings(project,key)[target.dataset.trackLock?'locked':'muted']);
    target.setAttribute('aria-pressed',String(active));
  }
  for(const lane of space.querySelectorAll('[data-type][data-layer]')){
    const key=`${lane.dataset.type}:${lane.dataset.layer}`;
    lane.dataset.trackKey=key;
    const settings=trackSettings(project,key);
    lane.classList.toggle('locked-track',Boolean(settings.locked));
    lane.classList.toggle('muted-track',Boolean(settings.muted));
  }
  selectTrack(selectedTrack);
  for(const control of $('inspector').querySelectorAll('input,select,textarea')){
    const clip=selection();
    if(clip && protectedTrack(project,trackOf(clip)) && !control.disabled){
      control.disabled=true;
      control.dataset.trackProtected='yes';
    } else if(control.dataset.trackProtected && !(clip && protectedTrack(project,trackOf(clip)))){
      control.disabled=false;
      delete control.dataset.trackProtected;
    }
  }
}

function renderKeyLanes() {
  for (const label of $('track-labels').querySelectorAll('.track-key')) label.remove();
  $('key-lanes').replaceChildren();
  const clip = selection();
  if (!clip || page !== 'animation') return;
  for (const key of Object.keys(properties)) {
    if (!clip.motion?.[key]?.length) continue;
    $('track-labels').append(trackLabel(properties[key][0].replace(/ \(.+\)/,''), 'track-key'));
    const lane = node('div', 'lane key-lane');
    const start = clipStart(clip);
    for (const [frame] of points(clip,key).filter(([at]) => at < clip.len)) {
      const dot = button('◆', () => {});
      dot.className = 'key-dot';
      dot.dataset.property = key;
      dot.dataset.frame = frame;
      dot.style.left = `calc(${start + frame} * var(--frame-width))`;
      dot.title = `${properties[key][0]} at ${timecode(start + frame)}`;
      dot.onpointerdown = event => {
        event.stopPropagation();
        event.preventDefault();
        dot.focus({ preventScroll:true });
        const initial = event.clientX;
        dot.setPointerCapture(event.pointerId);
        dot.onpointermove = move => {
          if(protectedTrack(project,trackOf(clip))) return;
          if (Math.abs(move.clientX - initial) > 3) {
            const position = clamp(frameAt(move.clientX), start, start + clip.len - 1);
            dot.style.left = `calc(${position} * var(--frame-width))`;
          }
        };
        dot.onpointerup = end => {
          end.stopPropagation();
          const at = Math.abs(end.clientX - initial) <= 3 ? frame : clamp(frameAt(end.clientX) - start, 0, clip.len - 1);
          if(protectedTrack(project,trackOf(clip))) { setPosition(start+frame); return; }
          if (at !== frame) {
            const value = valueAt(clip,key,frame);
            change(() => {
              clip.motion[key] = [...clip.motion[key].filter(([time]) => time !== frame && time !== at), [at,value]].sort((a,b) => a[0]-b[0]);
            });
          } else dot.style.left = `calc(${start + frame} * var(--frame-width))`;
          setPosition(start + at);
        };
      };
      lane.append(dot);
    }
    $('key-lanes').append(lane);
  }
}

function renderTimeline() {
  timeline = [...project.clips].sort((a,b)=>a.start-b.start);
  videoEnd = Math.max(0,...timeline.map(clip=>clip.start+clip.len));
  const titles = sortedTitles();
  captionOrder=titles.filter(title=>title.style==='caption');
  duration = Math.max(videoEnd, ...[...titles,...project.overlays,...project.sounds].map(clip=>clip.start+clip.len));
  if (!selection()) selected = null;
  $('project').value = project.name;
  $('resolution').value = project.resolution;
  $('aspect').value = project.aspect;
  $('export-format').value = project.format;
  $('export-quality').value = project.quality;
  const [width, height] = canvasSize(project.resolution,project.aspect);
  $('stage').style.setProperty('--ratio', width / height);
  $('preview-format').textContent = `${width} × ${height} / ${fps} fps`;
  $('export-summary').textContent = `${width} × ${height} · ${fps} fps · Stereo`;
  const labels = $('track-labels');
  labels.replaceChildren(trackLabel('TIME'));
  $('title-track').replaceChildren();
  $('overlay-tracks').replaceChildren();
  const topTitle=Math.max(project.titleLayers,...titles.filter(clip=>clip.style!=='caption').map(clip=>clip.track||1));
  const titleTracks=Array.from({length:topTitle},(_,i)=>topTitle-i);
  if(titles.some(clip=>clip.style==='caption')) titleTracks.unshift(5);
  for (const number of titleTracks) {
    labels.append(addTrackLabel(number===5 ? 'Captions' : `Titles ${number}`,number===5?'caption':'title',number));
    const lane = node('div', 'lane titles');
    lane.dataset.layer = number;
    lane.dataset.type = number===5?'caption':'title';
    lane.append(...titles.filter(clip => (clip.track || 1) === number).map(clip => makeClip(clip, false)));
    $('title-track').append(lane);
  }
  for (let number = project.layers; number >= 1; number--) {
    labels.append(addTrackLabel(`Video ${number + 1}`,'video',number,'track-video'));
    const lane = node('div', 'lane videos overlay-lane');
    lane.dataset.layer = number;
    lane.dataset.type = 'video';
    lane.append(...project.overlays.filter(clip => clip.track === number).map(clip => makeClip(clip, true)));
    lane.ondragover = event => { if (hasAsset(event)) event.preventDefault(); };
    lane.ondrop = event => {
      if (!hasAsset(event)) return;
      event.preventDefault();
      insertOverlay(event.dataTransfer.getData('application/x-framecut-asset'), number, frameAt(event.clientX));
    };
    $('overlay-tracks').append(lane);
  }
  labels.append(addTrackLabel('Video 1','video',0,'track-video'));
  $('video-track').dataset.type='video';
  $('video-track').dataset.layer=0;
  $('video-track').replaceChildren(...timeline.map(clip => makeClip(clip, true)));
  if (!timeline.length) $('video-track').append(node('span', 'lane-hint', 'Drop videos here or add from Media'));
  $('audio-track-add').hidden=page!=='sound';
  $('audio-tracks').replaceChildren();
  for(let number=1;number<=Math.max(page==='sound'?3:0,project.audioLayers);number++) {
    labels.append(addTrackLabel(`Audio ${number}`,'audio',number,'track-audio'));
    const lane=node('div','lane audio-lane');
    lane.dataset.type='audio'; lane.dataset.layer=number;
    lane.setAttribute('aria-label',`Audio ${number}`);
    lane.append(...project.sounds.filter(clip=>clip.track===number).map(clip=>makeClip(clip,false)));
    lane.ondragover=event=>{
      if(Array.from(event.dataTransfer.types).includes('application/x-framecut-sound')) { event.preventDefault(); event.dataTransfer.dropEffect='copy'; }
    };
    lane.ondrop=event=>{
      const preset=event.dataTransfer.getData('application/x-framecut-sound');
      if(!Object.hasOwn(soundPresets,preset)) return;
      event.preventDefault();
      void buildSound({preset},number,frameAt(event.clientX));
    };
    $('audio-tracks').append(lane);
  }
  ruler();
  renderInspector();
  renderTools();
  renderKeyLanes();
  refreshTrackControls();
  setPosition(cursor);
}

function updateButtons() {
  $('play').disabled = duration === 0;
  $('export').disabled = duration === 0 || !mediaLoaded;
  $('split').disabled = !splitPosition();
  $('delete').disabled = !selection() || protectedTrack(project,trackOf(selection()));
  $('undo').disabled = !undo.length || Boolean(project.timelineLocked);
  $('redo').disabled = !redo.length || Boolean(project.timelineLocked);
  $('track-add').disabled = Boolean(project.timelineLocked);
  $('audio-track-add').disabled = Boolean(project.timelineLocked);
  $('title-add').disabled = Boolean(project.timelineLocked);
}

function mediaPosition(el, t) {
  if (el.readyState >= 1) {
    if (Math.abs(el.currentTime - t) > 0.001) el.currentTime = t;
  } else {
    el.pendingSeek = t;
  }
}

function programUrl(clip,quality) {
  const asset=bin.get(clip.asset);
  if(asset?.nativeMime && !clip.lut && ['auto','full'].includes(quality)){
    if(!proxyFallbacks.has(clip.asset)) return diskURL(clip.asset,`p-${quality}.${asset.nativeMime.split('/')[1]}`);
    quality='half';
  }
  return diskURL(clip.asset,`p-${quality}${clip.lut ? '-' + clip.lut : ''}.${asset?.alpha ? 'webm' : 'mp4'}`);
}

function setSource(el, clip, frame) {
  const key = programUrl(clip,previewQuality);
  if (el.dataset.key !== key) {
    el.dataset.asset = clip.asset;
    el.dataset.key = key;
    el.src = key;
  }
  mediaPosition(el, seconds(clip.in + frame - clip.start));
}

for (const el of players) {
  el.addEventListener('loadedmetadata', () => {
    if (el.pendingSeek !== undefined) {
      mediaPosition(el, el.pendingSeek);
      delete el.pendingSeek;
    }
  });
  el.addEventListener('error', () => {
    if (el === active && activeClip) {
      if(bin.get(activeClip.asset)?.nativeMime && !activeClip.lut && ['auto','full'].includes(previewQuality) && !proxyFallbacks.has(activeClip.asset)){
        proxyFallbacks.add(activeClip.asset);
        setSource(el,activeClip,cursor);
        if(playing) el.play().catch(()=>{});
        notify('Preparing compatible playback…');
        return;
      }
      pause();
      notify('Preview unavailable. Check the source video in Media.');
    }
  });
}

function showVideo(item, frame, force) {
  if (!item || !bin.has(item.asset)) {
    if (activeClip) active.pause();
    activeClip = null;
    active.hidden = true;
    return;
  }
  let spare = players.find(el => el !== active);
  if (activeClip?.id !== item.id) {
    active.pause();
    if (spare.dataset.asset === item.asset && (active.dataset.asset !== item.asset || activeClip)) {
      active.hidden = true;
      [active, spare] = [spare, active];
    }
    activeClip = item;
    setSource(active, item, frame);
    if (playing) active.play().catch(() => {});
  } else if (force) {
    activeClip = item;
    setSource(active, item, frame);
  }
  active.hidden = false;
  const next = timeline[timeline.indexOf(item) + 1];
  if (next && bin.has(next.asset) &&
      (spare.dataset.asset !== next.asset || spare.preloadClip !== next.id)) {
    spare.preloadClip = next.id;
    setSource(spare, next, next.start);
  }
}

function display(frame, seek = false) {
  const item = timeline.find(item => frame >= item.start && frame < item.start + item.len);
  showVideo(item, frame, seek);
  if (item) { styleMotion(active, item, frame - item.start); setAudioLevel(active,item); }
  displayOverlays(frame, seek);
  displaySounds(frame,seek);
  const titleNodes = [];
  const visible=project.titles.filter(title => frame >= title.start && frame < title.start + title.len && title.style!=='caption' && !trackSettings(project,trackOf(title)).muted);
  let left=0,right=captionOrder.length;
  while(left<right){
    const middle=(left+right)>>>1;
    if(captionOrder[middle].start<=frame) left=middle+1;
    else right=middle;
  }
  const lastCaption=captionOrder[left-1];
  if(lastCaption && frame<lastCaption.start+lastCaption.len && !trackSettings(project,'caption:5').muted) visible.push(lastCaption);
  for (const title of visible.sort((a,b) => (a.track || 1) - (b.track || 1))) {
    const layer = node('div','program-title-layer');
    const label = node('div', 'preview-title');
    label.dataset.previewTitle=title.id;
    const offset = frame - title.start;
    styleTitle(label,title,offset);
    layer.append(label);
    styleMotion(layer, title, offset);
    titleNodes.push(layer);
  }
  $('preview-titles').replaceChildren(...titleNodes);
  $('preview-empty').hidden = duration > 0;
  $('playhead').style.left = `${pixels(frame)}px`;
  $('timecode').textContent = timecode(frame);
  $('duration').textContent = timecode(duration);
  updateButtons();
  updateKeyControls();
}

function styleTitle(label,title,offset) {
  const type=titleType(title);
  const size=$('stage').clientHeight*type.size/100;
  const columns=Math.max(12,Math.floor($('stage').clientWidth*.84/Math.max(1,size*(.56+type.tracking*.08))));
  const wrapped=wrapText(title.text,columns);
  label.textContent=typographyText(visibleText({...title,text:wrapped},offset),type);
  const longest=Math.max(1,...wrapped.split('\n').map(row=>[...row].length));
  label.style.fontSize=`min(${type.size}cqh, ${86/(longest*(.56+type.tracking*.08))}cqw)`;
  label.style.fontFamily=`"${type.family}", sans-serif`;
  label.style.fontWeight=type.weight%2?'700':'400';
  label.style.fontStyle=type.weight>=2?'italic':'normal';
  label.style.lineHeight=type.leading;
  label.style.textAlign=type.align;
  label.style.color=type.fill;
  label.style.left=type.align==='left'?'7.5%':type.align==='right'?'92.5%':'50%';
  label.style.top=title.style==='caption'?'91%':title.style==='lower'?'87%':'50%';
  label.style.translate=`${type.align==='left'?'0':type.align==='right'?'-100%':'-50%'} ${title.style==='center'?'-50%':'-100%'}`;
  const units=value=>`${value*100/1080}cqh`;
  label.style.background=type.background+Math.round(type.boxOpacity*2.55).toString(16).padStart(2,'0');
  label.style.padding=type.boxOpacity?units(type.padding):'0';
  label.style.webkitTextStroke=`${units(type.outline)} ${type.outlineColor}`;
  const shadow=[];
  for(let i=1;i<=type.depth;i++) shadow.push(`${units(i)} ${units(i)} 0 ${type.depthColor}`);
  if(type.shadow) shadow.push(`${units(type.shadowX)} ${units(type.shadowY)} ${units(type.blur)} rgb(0 0 0 / ${type.shadow}%)`);
  label.style.textShadow=shadow.join(',') || 'none';
}

function displaySounds(frame,seek) {
  const visible=project.sounds.filter(clip=>bin.has(clip.asset) && !clip.muted && frame>=clip.start && frame<clip.start+clip.len);
  for(const [id,el] of audioPlayers) {
    if(visible.some(clip=>clip.id===id)) continue;
    el.pause(); audioPlayers.delete(id);
  }
  for(const clip of visible) {
    let el=audioPlayers.get(clip.id);
    const fresh=!el;
    if(fresh){
      el=new Audio(diskURL(clip.asset,'audio.wav'));
      el.preload='auto';
      el.addEventListener('loadedmetadata',()=>{
        if(el.pendingSeek!==undefined){mediaPosition(el,el.pendingSeek);delete el.pendingSeek;}
      });
      audioPlayers.set(clip.id,el);
    }
    const local=frame-clip.start;
    const target=seconds(clip.in+local);
    if(fresh || seek || Math.abs(el.currentTime-target)>.14) mediaPosition(el,target);
    const fadeIn=clip.fadeIn? Math.min(1,local/clip.fadeIn):1;
    const fadeOut=clip.fadeOut?clamp((clip.len-local)/clip.fadeOut,0,1):1;
    setAudioLevel(el,clip,fadeIn*fadeOut);
    if(playing && el.paused) el.play().catch(()=>{});
  }
}

function setAudioLevel(element, clip, envelope=1) {
  const mix=clipMix(project,clip);
  element.muted=mix.muted;
  element.volume=clamp(10**(mix.gain/20)*envelope,0,1);
}

function styleMotion(el, clip, local) {
  const value = key => valueAt(clip,key,local);
  const scale = value('scale') / 100;
  el.style.transform = `translate(${value('x')}cqw, ${value('y')}cqh) rotate(${value('rotation')}deg) scale(${scale})`;
  el.style.opacity = value('opacity') / 100;
  el.style.filter = `brightness(${value('brightness')}%) contrast(${value('contrast')}%) saturate(${value('saturation')}%)`;
  el.style.clipPath = `inset(${value('top')}% ${value('right')}% ${value('bottom')}% ${value('left')}%)`;
}

function displayOverlays(frame, seek) {
  const visible = project.overlays.filter(clip => bin.has(clip.asset) && frame >= clip.start && frame < clip.start + clip.len)
    .sort((a,b) => a.track - b.track);
  for (const [id, el] of overlayPlayers) {
    if (visible.some(clip => clip.id === id)) continue;
    el.pause();
    el.remove();
    overlayPlayers.delete(id);
  }
  for (const clip of visible) {
    let el = overlayPlayers.get(clip.id);
    const fresh = !el;
    if (fresh) {
      el = node('video');
      el.playsInline = true;
      el.preload = 'auto';
      el.addEventListener('loadedmetadata', () => {
        if (el.pendingSeek !== undefined) { mediaPosition(el,el.pendingSeek); delete el.pendingSeek; }
      });
      $('preview-overlays').append(el);
      overlayPlayers.set(clip.id,el);
    }
    el.style.zIndex = clip.track;
    setAudioLevel(el,clip);
    if (fresh || seek) setSource(el, clip, frame);
    else if (Math.abs(el.currentTime - seconds(clip.in + frame - clip.start)) > .16) mediaPosition(el,seconds(clip.in + frame - clip.start));
    if (playing && el.paused) el.play().catch(() => {});
    styleMotion(el, clip, frame - clip.start);
  }
}

function pause() {
  playing = false;
  cancelAnimationFrame(raf);
  for (const el of [...players, ...overlayPlayers.values(), ...audioPlayers.values()]) el.pause();
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', 'Play');
}

function setPosition(frame) {
  pause();
  cursor = clamp(frame, 0, Math.max(0, duration - 1));
  display(cursor, true);
}

function revealCursor() {
  const x = pixels(cursor);
  if (x < scroll.scrollLeft || x + 15 > scroll.scrollLeft + scroll.clientWidth) {
    setTimelineScroll(Math.max(0, x - 30));
  }
}

function tick(now) {
  if (!playing) return;
  const previousX = pixels(cursor);
  const follow = previousX >= scroll.scrollLeft && previousX <= scroll.scrollLeft + scroll.clientWidth;
  if (activeClip) {
    if (active.readyState >= 2 && !active.seeking) {
      const sourceFrame = Math.floor(active.currentTime * fps + .04);
      const next = activeClip.start + Math.max(0, sourceFrame - activeClip.in);
      const end = activeClip.start + activeClip.len;
      cursor = active.ended ? end : clamp(next, activeClip.start, end);
      if (cursor === end) { blackSince=now; blackFrame=cursor; }
    }
  } else {
    cursor = blackFrame + Math.floor((now - blackSince) * fps / 1000);
  }
  if (cursor >= duration) {
    setPosition(duration - 1);
    return;
  }
  display(cursor);
  if (follow) revealCursor();
  raf = requestAnimationFrame(tick);
}

function togglePlay() {
  if (!duration) return;
  if (playing) {
    pause();
    return;
  }
  if (cursor >= duration - 1) setPosition(0);
  playing = true;
  blackSince = performance.now();
  blackFrame = cursor;
  $('play').textContent = 'Ⅱ';
  $('play').setAttribute('aria-label', 'Pause');
  if (activeClip) active.play().catch(() => {});
  raf = requestAnimationFrame(tick);
}

function moveVideo(id, index) {
  const old = timeline.findIndex(clip => clip.id === id);
  if (old < 0 || old === index || !timeline[index]) return;
  const clip=timeline[old];
  const other=timeline[index];
  const first=old<index?clip:other;
  const second=old<index?other:clip;
  const gap=second.start-first.start-first.len;
  const start=first.start;
  change(() => {
    second.start=start;
    first.start=start+second.len+gap;
  });
  setPosition(clip.start);
  revealCursor();
}

function insertion(frame, ignore) {
  const candidates = timeline.filter(item => item.id !== ignore);
  const index = candidates.findIndex(item => frame < item.start + item.len / 2);
  return {
    index: index < 0 ? candidates.length : index,
    position: index < 0 ? videoEnd : candidates[index].start
  };
}

function markDrop(frame) {
  $('drop-marker').style.left = `${pixels(frame)}px`;
  $('drop-marker').hidden = false;
}

function startClipDrag(event, item, block, video) {
  if (event.button !== 0) return;
  const trim = event.target.dataset.trim;
  if (video && !bin.has(item.asset) && trim) return;
  event.preventDefault();
  pause();
  select(item.id);
  if(protectedTrack(project,trackOf(item))){
    setPosition(item.start);
    return;
  }
  drag = { x: event.clientX, y: event.clientY, frame: frameAt(event.clientX), item, video, trim, block, moved: false };
  space.setPointerCapture(event.pointerId);
}

function dragClip(event) {
  if (!drag) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.x,event.clientY - drag.y) < 4) return;
  drag.moved = true;
  const { item, trim, video, block } = drag;
  block.classList.add('dragging');
  const point = frameAt(event.clientX);
  const delta = point - drag.frame;
  let { start, len } = item;
  let source = item.in;
  const type=item.kind==='audio'?'audio':video?'video':item.style==='caption'?'caption':'title';
  if (!trim) {
    const lane = document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-layer]');
    const target = lane?.dataset.type === type && !protectedTrack(project,`${type}:${lane.dataset.layer}`)
      ? Number(lane.dataset.layer) : item.track || (type==='video'?0:1);
    drag.track = target;
    const peers=layerItems({...item,track:target});
    const desired=Math.max(0,item.start+delta);
    const snapped=snapPoint(desired,len,item.id,event.shiftKey);
    start=fitClip(peers,snapped,len,item.id);
    if(type==='video') drag.videoTrack=target;
  } else if (video) {
    const limits = laneNeighbors(item);
    if (trim === 'left') {
      const edge=snapPoint(item.start+delta,0,item.id,event.shiftKey);
      source = clamp(item.in+edge-item.start,Math.max(0,item.in+limits.previous-item.start),item.in+item.len-1);
      len = item.len + item.in - source;
      start += source - item.in;
    } else {
      const edge=snapPoint(item.start+item.len+delta,0,item.id,event.shiftKey);
      len = clamp(edge-item.start, 1, Math.min(bin.get(item.asset).frames - item.in, limits.next - item.start));
    }
  } else {
    const limits = laneNeighbors(item);
    if (trim === 'left') {
      start = clamp(snapPoint(item.start+delta,0,item.id,event.shiftKey), limits.previous, item.start + item.len - 1);
      len = item.len + item.start - start;
    } else {
      len = clamp(snapPoint(item.start+item.len+delta,0,item.id,event.shiftKey)-start, 1, limits.next - start);
    }
  }
  drag.changes = video ? { in: source, len } : { start, len };
  if (video) drag.changes.start = start;
  if (!trim && drag.track) drag.changes.track = drag.track;
  if (!trim && drag.track!==undefined && drag.track !== (item.track || (type==='video'?0:1))) {
    const lane = space.querySelector(`[data-type="${type}"][data-layer="${drag.track}"]`);
    if (lane) block.style.translate = `0 ${lane.getBoundingClientRect().top - block.parentElement.getBoundingClientRect().top}px`;
  } else block.style.translate = '';
  block.style.left = `${pixels(start)}px`;
  block.style.width = `${Math.max(2, pixels(len) - 1)}px`;
}

function endClipDrag(cancel = false) {
  if (!drag) return;
  const { item, changes, moved, trim,videoTrack } = drag;
  drag = null;
  $('drop-marker').hidden = true;
  if (cancel) return renderTimeline();
  if (changes) {
    change(() => {
      const clip = selection();
      if (trim === 'left') clip.motion = resizeMotion(clip, clip.asset ? changes.in - clip.in : changes.start - clip.start, changes.len);
      if(videoTrack!==undefined && videoTrack!==(clip.track||0)){
        const previous=clipList(clip);
        previous.splice(previous.indexOf(clip),1);
        clip.track=videoTrack;
        clipList(clip).push(clip);
      }
      Object.assign(clip, changes);
    });
  } else if (!moved) {
    setPosition(item.start);
  }
}

function snapPoint(start,len,ignore,bypass) {
  $('drop-marker').hidden=true;
  if(bypass) return start;
  const threshold=Math.max(1,9*fps/zoom);
  const edges=[0,cursor];
  for(const clip of [...project.clips,...project.overlays,...project.titles,...project.sounds]) {
    if(clip.id!==ignore) edges.push(clip.start,clip.start+clip.len);
  }
  let best=threshold+.001, result=start, target;
  for(const edge of edges) for(const offset of len?[0,len]:[0]) {
    const distance=Math.abs(edge-start-offset);
    if(distance<best){ best=distance; result=edge-offset; target=edge; }
  }
  if(target!==undefined) markDrop(target);
  return Math.max(0,result);
}

function fitClip(peers,desired,len,ignore) {
  const list=peers.filter(item=>item.id!==ignore).sort((a,b)=>a.start-b.start);
  let end=0, best=Infinity, result=desired;
  for(const interval of [...list,{start:Infinity,len:0}]) {
    if(interval.start-end>=len){
      const fit=clamp(desired,end,interval.start-len);
      if(Math.abs(desired-fit)<best){best=Math.abs(desired-fit);result=fit;}
    }
    end=Math.max(end,interval.start+interval.len);
  }
  return result;
}

let scrubPointerX=0;
let scrubFrame=0;
let scrubLast=0;
function scrollWhileScrubbing(now) {
  scrubFrame=0;
  if(!space.dataset.scrub) return;
  const view=scroll.getBoundingClientRect();
  const zone=Math.min(45,view.width/4);
  let speed=0;
  if(scrubPointerX<view.left+zone) speed=-Math.min(1350,(view.left+zone-scrubPointerX)*16);
  else if(scrubPointerX>view.right-zone) speed=Math.min(1350,(scrubPointerX-view.right+zone)*16);
  const elapsed=scrubLast?Math.min(.04,(now-scrubLast)/1000):1/60;
  scrubLast=now;
  if(speed){
    const left=scroll.scrollLeft;
    const delta=speed*elapsed;
    setTimelineScroll(left+(delta<0?Math.min(-1,delta):Math.max(1,delta)));
    if(scroll.scrollLeft!==left) setPosition(frameAt(clamp(scrubPointerX,view.left,view.right)));
  }
  scrubFrame=requestAnimationFrame(scrollWhileScrubbing);
}

function endScrub() {
  delete space.dataset.scrub;
  cancelAnimationFrame(scrubFrame);
  scrubFrame=scrubLast=0;
}

space.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target.closest('.clip')) return;
  space.setPointerCapture(event.pointerId);
  space.dataset.scrub = 'yes';
  scrubPointerX=event.clientX;
  if (!event.target.closest('.playhead')) {
    select(null);
    const lane=event.target.closest('[data-track-key]');
    if(lane) selectTrack(lane.dataset.trackKey);
  }
  setPosition(frameAt(event.clientX));
  scrubFrame=requestAnimationFrame(scrollWhileScrubbing);
});

function updateProgress(bar,task) {
  bar.hidden=!task;
  if(task?.progress!=null) bar.value=task.progress;
  else bar.removeAttribute('value');
}

function taskDetail(task) {
  if(task.state==='ready') return 'Complete';
  if(task.state==='error') return task.error || 'Failed';
  const percent=task.progress==null?'':` · ${task.progress}%`;
  const eta=task.eta>=1 ? ` · about ${task.eta>=60 ? Math.ceil(task.eta/60)+' min' : task.eta+' sec'} left in this step` : '';
  return task.stage+percent+eta;
}

let taskSignature='';
async function refreshActivity() {
  let hasWork=false;
  try {
    const tasks=await api('/api/tasks');
    const active=tasks.filter(task=>task.state==='working');
    const now=active[0];
    hasWork=Boolean(now);
    const pendingImport=active.find(task=>task.label.startsWith('Import '));
    updateProgress($('activity-progress'),now);
    updateProgress($('workspace-progress'),now);
    updateProgress($('import-progress'),videoImporting?(pendingImport || {progress:null}):null);
    if(videoImporting && pendingImport) $('media-status').textContent=`${pendingImport.label} · ${taskDetail(pendingImport)}`;
    $('activity-label').textContent=now?(now.progress==null?`Working (${active.length})`:`Tasks · ${now.progress}%`):'Tasks';
    $('activity-toggle').title=now?taskDetail(now):'Show background tasks';
    const signature=JSON.stringify(tasks);
    if(signature!==taskSignature){
      taskSignature=signature;
      const list=$('activity-list');
      list.replaceChildren();
      for(const task of tasks){
        const row=node('div','activity-row');
        row.append(node('strong','',task.label),node('span','subtle',taskDetail(task)));
        if(task.state==='working'){
          const bar=node('progress');
          bar.max=100;
          bar.setAttribute('aria-label',task.stage);
          updateProgress(bar,task);
          row.append(bar);
        }
        list.append(row);
      }
      if(!tasks.length) list.append(node('p','subtle','No background tasks yet.'));
    }
  } catch { /* Startup and shutdown can interrupt polling. */ }
  setTimeout(refreshActivity,hasWork||videoImporting?350:900);
}

$('activity-toggle').onclick=()=>{
  const drawer=$('activity-drawer');
  drawer.hidden=!drawer.hidden;
  $('activity-toggle').setAttribute('aria-expanded',String(!drawer.hidden));
};
$('activity-close').onclick=()=>{
  $('activity-drawer').hidden=true;
  $('activity-toggle').setAttribute('aria-expanded','false');
};
void refreshActivity();
space.addEventListener('pointermove', event => {
  if (drag) dragClip(event);
  else if (space.dataset.scrub) {
    scrubPointerX=event.clientX;
    const view=scroll.getBoundingClientRect();
    setPosition(frameAt(clamp(scrubPointerX,view.left,view.right)));
  }
});
space.addEventListener('pointerup', event => {
  endScrub();
  if(drag?.moved) dragClip(event);
  endClipDrag();
});
space.addEventListener('pointercancel', () => {
  endScrub();
  endClipDrag(true);
});
space.addEventListener('lostpointercapture',endScrub);

function hideTimelineMenu() { $('timeline-menu').hidden=true; }
space.addEventListener('contextmenu',event=>{
  event.preventDefault();
  const menu=$('timeline-menu');
  const element=event.target.closest('.clip');
  const lane=event.target.closest('[data-layer]');
  const at=clamp(frameAt(event.clientX),0,Math.max(0,duration-1));
  menu.replaceChildren();
  function action(label,run,disabled=false){
    const item=button(label,()=>{ hideTimelineMenu(); run(); },disabled);
    item.setAttribute('role','menuitem');
    menu.append(item);
  }
  if(element){
    select(element.dataset.id);
    setPosition(at);
    const clip=selection();
    const locked=protectedTrack(project,trackOf(clip));
    action('Cut (Ctrl+X)',()=>copyTimelineClip(true),locked);
    action('Copy (Ctrl+C)',()=>copyTimelineClip());
    action('Paste (Ctrl+V)',()=>{setPosition(at);pasteEditorItem();},!timelineClipboard);
    action('Split at playhead',splitClip,!splitPosition());
    action('Delete · leave gap',()=>removeClip(false),locked);
    action('Ripple delete · close gap',()=>removeClip(true),locked);
    if(clip.asset && clip.kind!=='audio' && bin.get(clip.asset)?.audio!=null) action('Extract audio',()=>extractAudio(clip),locked||project.sounds.some(item=>item.extractedFrom===clip.id));
  } else if(lane){
    selectTrack(lane.dataset.trackKey);
    action('Paste (Ctrl+V)',()=>{setPosition(at);pasteEditorItem();},!timelineClipboard);
    const number=Number(lane.dataset.layer);
    const peers=lane.dataset.type==='video' ? (number?project.overlays.filter(item=>item.track===number):project.clips)
      : lane.dataset.type==='audio' ? project.sounds.filter(item=>item.track===number)
        : project.titles.filter(item=>(item.track||1)===number);
    const following=peers.filter(item=>item.start>=at);
    const end=Math.min(Infinity,...following.map(item=>item.start));
    const beginning=Math.max(0,...peers.filter(item=>item.start+item.len<=at).map(item=>item.start+item.len));
    action('Ripple delete gap',()=>change(()=>{ for(const clip of following) clip.start-=end-beginning; }),protectedTrack(project,lane.dataset.trackKey)||!Number.isFinite(end)||end<=beginning);
  }
  if(!menu.childElementCount) return hideTimelineMenu();
  menu.hidden=false;
  menu.style.left=`${Math.min(event.clientX,innerWidth-menu.offsetWidth-5)}px`;
  menu.style.top=`${Math.min(event.clientY,innerHeight-menu.offsetHeight-5)}px`;
});
document.addEventListener('pointerdown',event=>{ if(!event.target.closest('#timeline-menu')) hideTimelineMenu(); });
document.addEventListener('keydown',event=>{ if(event.key==='Escape') hideTimelineMenu(); });

const hasFiles = event => Array.from(event.dataTransfer.types).includes('Files');
const hasAsset = event => Array.from(event.dataTransfer.types).includes('application/x-framecut-asset');
const library = document.querySelector('.library');
library.addEventListener('dragover', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  library.classList.add('drop-target');
});
library.addEventListener('dragleave', event => {
  if (!library.contains(event.relatedTarget)) library.classList.remove('drop-target');
});
library.addEventListener('drop', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  library.classList.remove('drop-target');
  void importVideos([...event.dataTransfer.files]);
});
$('video-track').addEventListener('dragover', event => {
  if (!hasAsset(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  markDrop(insertion(frameAt(event.clientX)).position);
});
$('video-track').addEventListener('dragleave', event => {
  if (!$('video-track').contains(event.relatedTarget)) $('drop-marker').hidden = true;
});
$('video-track').addEventListener('drop', event => {
  if (!hasAsset(event)) return;
  event.preventDefault();
  $('drop-marker').hidden = true;
  insertVideo(event.dataTransfer.getData('application/x-framecut-asset'), project.clips.length,snapPoint(frameAt(event.clientX),0,null,event.shiftKey));
});
document.addEventListener('dragover', event => { if (hasFiles(event)) event.preventDefault(); });
document.addEventListener('drop', event => { if (hasFiles(event)) event.preventDefault(); });

function setZoom(value, anchor) {
  const next = clamp(value,minZoom,maxZoom);
  if (next === zoom) return;
  const anchoredFrame = anchor === undefined ? null : (scroll.scrollLeft + anchor) * fps / zoom;
  zoom = next;
  zoomInput.value = String(Math.round(zoom));
  ruler();
  $('playhead').style.left = `${pixels(cursor)}px`;
  for (const clip of space.querySelectorAll('.clip')) {
    clip.classList.toggle('narrow-clip', pixels(Number(clip.dataset.frames)) < 18);
  }
  if (anchoredFrame === null) revealCursor();
  else setTimelineScroll(pixels(anchoredFrame) - anchor);
}

zoomInput.oninput = event => setZoom(Number(event.target.value));
$('fit').onclick = () => {
  const value = Math.floor((scroll.clientWidth - 100) * fps / Math.max(duration, 1));
  setZoom(value);
};
let wheelFrame = 0;
let wheelDelta = 0;
let wheelAnchor = 0;
scroll.closest('.timeline').addEventListener('wheel', event => {
  if (!event.target.closest('.timeline-grid, .timeline-pan-row')) return;
  const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? scroll.clientWidth : 1;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) return;
  if (!event.shiftKey) {
    event.preventDefault();
    if (wheelFrame) {
      cancelAnimationFrame(wheelFrame);
      wheelFrame = wheelDelta = 0;
    }
    setTimelineScroll(scroll.scrollLeft + delta * unit);
    return;
  }
  event.preventDefault();
  if (drag || space.dataset.scrub) return;
  wheelDelta += delta * unit;
  wheelAnchor = clamp(event.clientX - scroll.getBoundingClientRect().left, 0, scroll.clientWidth);
  if (wheelFrame) return;
  wheelFrame = requestAnimationFrame(() => {
    const factor = Math.exp(clamp(-wheelDelta * .002, -1.5, 1.5));
    wheelFrame = wheelDelta = 0;
    setZoom(zoom * factor, wheelAnchor);
  });
}, { passive:false });
new ResizeObserver(ruler).observe(scroll);
$('import').onclick = () => $('files').click();
$('files').onchange = event => {
  const files = [...event.target.files];
  event.target.value = '';
  void importVideos(files);
};
$('project').onchange = event => {
  const name = event.target.value.trim() || defaults.name;
  change(() => { project.name = name; });
};
$('first').onclick = () => { setPosition(0); revealCursor(); };
$('back').onclick = () => { setPosition(cursor - 1); revealCursor(); };
$('forward').onclick = () => { setPosition(cursor + 1); revealCursor(); };
$('last').onclick = () => { setPosition(duration - 1); revealCursor(); };
$('play').onclick = togglePlay;
$('undo').onclick = () => history(undo, redo);
$('redo').onclick = () => history(redo, undo);
$('split').onclick = splitClip;
$('delete').onclick = () => removeClip();
$('title-add').onclick = () => addTitle();
$('timeline-lock').onclick=()=>{
  project.timelineLocked=!project.timelineLocked;
  persist();
  refreshTrackControls();
  updateButtons();
  notify(project.timelineLocked?'Timeline locked.':'Timeline unlocked.');
};
$('track-add').onchange = event => {
  const type=event.target.value;
  change(()=>{
    if(type==='video') project.layers=Math.min(8,project.layers+1);
    if(type==='title') project.titleLayers=Math.min(4,project.titleLayers+1);
    if(type==='audio') project.audioLayers=Math.min(12,Math.max(page==='sound'?3:0,project.audioLayers)+1);
  });
  event.target.value='';
};
$('audio-track-add').onclick = () => change(() => { project.audioLayers = Math.min(12,Math.max(3,project.audioLayers)+1); });
$('app-nav').onclick = event => {
  const tab = event.target.closest('[data-page]');
  if (tab) switchPage(tab.dataset.page);
};
$('preview-quality').onchange = async event => {
  const request=++qualityRequest;
  const quality=event.target.value;
  const visible=[timeline.find(clip=>cursor>=clip.start && cursor<clip.start+clip.len),
    ...project.overlays.filter(clip=>cursor>=clip.start && cursor<clip.start+clip.len)].filter(Boolean);
  if(quality!==previewQuality && visible.length) notify(`Preparing ${quality} preview…`);
  try {
    await Promise.all(visible.map(async clip=>{
      const response=await fetch(programUrl(clip,quality),{method:'HEAD'});
      if(!response.ok) throw new Error('Could not prepare that preview quality.');
    }));
    if(request!==qualityRequest) return;
    const resume=playing;
    previewQuality=quality;
    setPosition(cursor);
    if(resume) togglePlay();
    notify(`${quality[0].toUpperCase()+quality.slice(1)} preview ready`);
  } catch(error){
    if(request===qualityRequest){$('preview-quality').value=previewQuality;notify(error.message);}
  }
};
$('aspect').onchange = event => change(() => { project.aspect = event.target.value; });
$('media-search').oninput = renderBin;
$('media-sort').onchange = renderBin;
$('source-folder').onchange = event => moveAsset(sourceAsset, event.target.value);
$('new-folder').onclick = () => {
  $('folder-form').hidden = !$('folder-form').hidden;
  if (!$('folder-form').hidden) $('folder-name').focus();
};
$('folder-form').onsubmit = event => {
  event.preventDefault();
  const name = $('folder-name').value.trim();
  if (!name) return;
  const newFolder = { id:id(), name };
  project.folders.push(newFolder);
  folder = newFolder.id;
  $('folder-name').value = '';
  $('folder-form').hidden = true;
  persist();
  renderBin();
  renderSource();
};
$('lut-file').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const clip = selection();
  try {
    const lut = await api('/api/luts', { method:'POST', headers:{ 'X-Framecut':'1','X-Filename':encodeURIComponent(file.name) },body:file });
    lutLibrary.set(lut.id,lut);
    if (clip?.asset && selection() === clip) change(() => { clip.lut = lut.id; });
    else renderTools();
    notify(`Imported ${lut.name}`);
  } catch (error) { notify(error.message); }
};
$('model-file').onchange = event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (file) void addGraphic('mesh',file);
};
$('subtitle-file').onchange = async event => {
  const file=event.target.files[0];
  event.target.value='';
  if(!file) return;
  if(file.size>1_000_000) return notify('Choose a subtitle or script file under 1 MB');
  try {
    const content=await file.text();
    if(file.name.toLowerCase().endsWith('.srt')) addCues(readSrt(content));
    else {
      const lines=content.replace(/\r\n?/g,'\n').split('\n').map(cleanText).filter(Boolean);
      addCues(lines.map((text,index)=>({start:index*3*fps,len:3*fps,text})),cursor);
    }
  } catch(error){ notify(error.message); }
};
$('audio-file').onchange = async event => {
  const files=[...event.target.files];
  event.target.value='';
  if(audioImporting || !files.length) return;
  audioImporting=true;
  let count=0;
  const errors=[];
  for(const file of files) {
    notify(`Importing ${file.name}…`);
    try {
      const asset=await api('/api/audio',{method:'POST',headers:{'X-Framecut':'1','X-Filename':encodeURIComponent(file.name),'X-File-Size':String(file.size)},body:file});
      bin.set(asset.id,asset); count++;
    } catch(error){ errors.push(`${file.name}: ${error.message.split('\n')[0]}`); }
  }
  audioImporting=false;
  renderTools();
  notify([`Imported ${count} audio ${count===1?'file':'files'}`,...errors].join(' · '));
};

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.target.isContentEditable ||
      event.target.closest('input,select,textarea,dialog') || document.querySelector('dialog[open]')) return;
  const key = event.key.toLowerCase();
  if (event.ctrlKey && !event.altKey && !event.shiftKey && ['c','x','v'].includes(key)) {
    if (event.repeat) { event.preventDefault(); return; }
    const dot = page === 'animation' ? event.target.closest('.key-dot') : null;
    let handled = false;
    if (key === 'v') handled = pasteEditorItem();
    else if (page === 'footage') handled = copyFootage(key === 'x');
    else if (dot) handled = copyKeyframe(dot,key === 'x');
    else if (selection()) { copyTimelineClip(key === 'x'); handled = true; }
    if (handled) event.preventDefault();
  } else if (event.ctrlKey && ['z', 'y'].includes(key)) {
    event.preventDefault();
    if (event.key.toLowerCase() === 'y' || event.shiftKey) history(redo, undo);
    else history(undo, redo);
  } else if (event.key === ' ' && !event.target.closest('button,a')) {
    event.preventDefault();
    togglePlay();
  } else if (event.key === 'Delete') {
    event.preventDefault();
    removeClip(event.shiftKey);
  } else if (event.key.toLowerCase() === 's' && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    splitClip();
  } else if (event.key.toLowerCase()==='t' && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    if(page==='footage') switchPage('edit');
    addTitle();
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    setPosition(cursor + (event.key === 'ArrowLeft' ? -1 : 1));
    revealCursor();
  }
});
document.addEventListener('keydown',event=>{if(event.key==='Escape') stopTextPlacement();});

$('export').onclick = () => {
  pause();
  $('export-dialog').showModal();
};
$('close-dialog').onclick = () => $('export-dialog').close();
$('resolution').onchange = event => {
  change(() => { project.resolution = event.target.value; });
};
$('export-format').onchange = event => change(() => { project.format = event.target.value; });
$('export-quality').onchange = event => change(() => { project.quality = event.target.value; });
$('export-form').onsubmit = async event => {
  event.preventDefault();
  if (exporting) return;
  exporting = true;
  $('render').disabled = true;
  $('resolution').disabled = true;
  $('download').hidden = true;
  $('progress').hidden = false;
  $('progress').value = 0;
  $('export-status').textContent = 'Preparing render…';
  notify('Rendering video…');
  try {
    let job = await api('/api/exports', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Framecut': '1' },
      body: JSON.stringify(project)
    });
    while (job.status === 'rendering') {
      await new Promise(resolve => setTimeout(resolve, 500));
      job = await api(`/api/exports/${job.id}`);
      $('progress').value = job.progress;
      $('export-status').textContent = `Rendering · ${job.progress}%`;
    }
    if (job.status === 'error') throw new Error(job.error);
    $('export-status').textContent = `${job.filename} is ready.`;
    const download = $('download');
    download.href = `/api/exports/${job.id}/download`;
    if (window.framecutDesktop) {
      download.textContent = `Save ${job.filename.split('.').at(-1).toUpperCase()}…`;
      download.onclick = async event => {
        event.preventDefault();
        if (download.saving) return;
        download.saving = true;
        try {
          const saved = await window.framecutDesktop.saveRender(job.id);
          if (saved) {
            $('export-status').textContent = `Saved to ${saved}`;
            notify('Video saved');
          }
        } catch (error) {
          $('export-status').textContent = error.message;
        } finally {
          download.saving = false;
        }
      };
    }
    download.hidden = false;
    notify(window.framecutDesktop ? 'Export ready to save' : 'Export ready to download');
  } catch (error) {
    $('export-status').textContent = error.message;
    notify('Export failed');
  } finally {
    exporting = false;
    $('render').disabled = false;
    $('resolution').disabled = false;
  }
};

$('import').disabled = true;
try {
  for (const asset of await api('/api/media')) bin.set(asset.id, asset);
  for (const lut of await api('/api/luts')) lutLibrary.set(lut.id, lut);
  const tools=await api('/api/tools');
  objectRemovalAvailable=tools.objectRemoval;
  transcriptionAvailable=tools.transcription;
  mediaLoaded = true;
  $('import').disabled = false;
} catch (error) {
  notify(`Could not load Media — ${error.message}`);
}
renderBin();
renderTimeline();
switchPage('footage');
