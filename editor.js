import { canvasSize, fittedVideoSize, hasVideoFraming, looks, points, presets, properties, resizeMotion, titlePositionOffset, valueAt, videoFit, videoFitModes, videoStretch } from '/motion.mjs';
import { customGradientStops, extrusionOffsets, fontFamilies, maxExtrusionDepth, readSrt, retimeTitle, textListEntrances, textListExits, textListMotion, textPresets, titleMaterials, titleTiming, titleType, titleVerticalAnchor, typographyText, visibleText, wrapText, writeSrt } from '/text.mjs';
import { soundPresets, soundSettings, soundWave } from '/sound.mjs';
import { paintParticles, particlePresets, particleSettings } from '/graphics.mjs';
import { setupUpdates } from '/updates-ui.mjs';
import { changesLockedClips, clipMix, clipsIn, gainDb, protectedTrack, trackOf, trackSettings } from '/tracks.mjs';
import { contentDuration, exportRange, exportWindow, MAX_DURATION, sequenceDuration, sequenceSize } from '/sequences.mjs';
import { catalogKey, compositionType, migrateProjectImports, projectControls, readCatalog } from '/projects.mjs';
import { createLedWorkspace } from '/led.mjs';
import { backgroundKey, keyPresets, sampledKey } from '/keying.mjs';
import { createKeyPreview, readColorSample } from '/key-preview.mjs';
import '/layout.mjs';
const $ = id => document.getElementById(id);
const fps = 30;
const mixed = Symbol('mixed');
const installedFonts = new Set(Object.keys(fontFamilies));
const mediaDragType = 'application/x-framecut-asset';
const importedAudioDragType = 'application/x-framecut-audio-asset';
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
const newSequence = values => ({ ...structuredClone(defaults), ...values });
let project = newSequence();
let catalog = readCatalog(null);
let legacy;
try {
  catalog = readCatalog(JSON.parse(localStorage.getItem(catalogKey)));
  legacy = JSON.parse(localStorage.getItem(storageKey));
} catch {
  // Recovery can also load an update checkpoint if browser storage is empty.
}
if (!catalog.projects.length && !legacy && window.framecutDesktop?.updates) {
  try {
    const backup=JSON.parse(await window.framecutDesktop.updates.restore());
    catalog = readCatalog(backup?.catalog);
    legacy = backup;
  } catch { /* Start normally if a recovery checkpoint cannot be read. */ }
}
if (!catalog.projects.length && Array.isArray(legacy?.clips) && Array.isArray(legacy?.titles)) {
  const main = newSequence(legacy);
  delete main.catalog;
  let position = 0;
  for (const clip of main.clips) {
    clip.start ??= position;
    position = clip.start + clip.len;
  }
  catalog.projects.push({ id:crypto.randomUUID(), main, compositions:[], updated:Date.now() });
}
let entry = null;
let sequenceKey = 'main';
let syncingCompositions = 0;
let pendingEdits = 0;
const sequenceViews = new Map();
const compositionJobs = new Map();

let timeline = [];
let captionOrder=[];
let videoEnd = 0;
let duration = 0;
let cursor = 0;
let zoom = Number(zoomInput.value);
let selected = null;
let selectedGroup = new Set();
let selectionAnchor = null;
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
let page = 'projects';
let folder = 'all';
let sourceAsset = null;
let previewQuality = 'auto';
let videoImporting = false;
let importToast;
let saveFeedback;
const proxyFallbacks=new Set();
let qualityRequest=0;
let effectCategory = 'Motion';
let trackingSource = null;
let trackingBox = null;
let trackingArea = null;
let tracked = null;
let picking = false;
let samplingKey = null;
let matteClip = null;
let keyDraft = null;
let objectRemovalAvailable = false;
let transcriptionAvailable = false;
let transcribing = false;
let speechLanguage = 'auto';
let looping = false;
let soundContext;
let auditionNode;
const audioPlayers = new Map();
let placingText=false;
let positioningTitles=false;
let cancelTitleDrag;
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
const compositionViews = new Map();

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
    if (entry) {
      if (sequenceKey === 'main') entry.main = project;
      else entry.compositions.find(item=>item.id===sequenceKey).sequence = project;
      entry.updated = Date.now();
    }
    localStorage.setItem(catalogKey, JSON.stringify(catalog));
    if (entry) {
      try { localStorage.setItem(storageKey, JSON.stringify(project)); }
      catch { /* The project library already contains the saved timeline. */ }
    }
    $('save-state').textContent = 'Saved locally';
    return true;
  } catch {
    $('save-state').textContent = 'Browser storage unavailable';
    return false;
  }
}

function saveProject() {
  if (!entry || page==='projects') return;
  document.activeElement?.blur();
  if (!persist()) return;
  $('save-project').textContent = '✓ Saved';
  $('save-state').textContent = `${entry.main.name} saved locally`;
  clearTimeout(saveFeedback);
  saveFeedback = setTimeout(()=>{
    $('save-project').textContent = 'Save';
    if ($('save-state').textContent===`${entry.main.name} saved locally`) $('save-state').textContent = 'Saved locally';
  },2400);
}

$('save-project').onclick = saveProject;

setupUpdates(()=>{
  document.activeElement?.blur();
  pause();
  if(!persist()) throw new Error('Framecut could not save the current project. The app is still open.');
  return JSON.stringify({ ...project, catalog });
});

function hasPendingTask() {
  return exporting || importing || transcribing || looping || pendingEdits || syncingCompositions;
}

function busySwitch() {
  if (!hasPendingTask()) return false;
  const message = 'Wait for the current task to finish before switching timelines.';
  if (page === 'projects') $('projects-status').textContent = message;
  else notify(message);
  return true;
}

function saveView() {
  if (!entry) return;
  sequenceViews.set(`${entry.id}:${sequenceKey}`, { cursor, left:scroll.scrollLeft, zoom, undo:[...undo], redo:[...redo] });
}

function activateSequence(key) {
  const next = key === 'main' ? entry.main : entry.compositions.find(item=>item.id===key)?.sequence;
  if (!next) return;
  pause();
  stopTextPlacement();
  cancelPicking();
  hideTimelineMenu();
  sequenceKey = key;
  project = next;
  if (key==='main') refreshCompositionLinks();
  project.titleLayers = Math.max(project.titleLayers, ...project.titles.filter(clip=>clip.style!=='caption').map(clip=>clip.track||1));
  const view = sequenceViews.get(`${entry.id}:${key}`);
  cursor = view?.cursor ?? 0;
  zoom = view?.zoom ?? 70;
  zoomInput.value = zoom;
  undo.splice(0, undo.length, ...(view?.undo ?? []));
  redo.splice(0, redo.length, ...(view?.redo ?? []));
  selected = null;
  selectedGroup.clear();
  selectionAnchor = null;
  selectedTrack = null;
  activeClip = null;
  trackingBox = null;
  trackingSource = null;
  tracked = null;
  $('tracking-box').hidden = true;
  catalog.active = entry.id;
  persist();
  controls.renderSequences();
  switchPage('edit');
  setTimelineScroll(view?.left ?? 0);
}

function openProject(key) {
  if (busySwitch()) return false;
  const next = catalog.projects.find(item=>item.id===key);
  if (!next) return false;
  saveView();
  clearTimeout(saveFeedback);
  clearTimeout(importToast);
  $('save-project').textContent = 'Save';
  $('global-import-status').hidden = true;
  timelineClipboard = null;
  folder = 'all';
  sourceAsset = null;
  $('source-video').removeAttribute('src');
  $('source-video').load();
  $('source-audio').removeAttribute('src');
  $('source-audio').load();
  $('source-info').textContent = 'Select footage to preview it.';
  $('source-actions').replaceChildren();
  $('media-search').value = '';
  $('footage-tray-search').value = '';
  $('media-status').hidden = true;
  $('projects-status').textContent = '';
  entry = next;
  refreshFootageTray();
  if (mediaLoaded) notify('Ready');
  activateSequence('main');
  return true;
}

function openSequence(key) {
  if (busySwitch()) return false;
  if (key === sequenceKey) { switchPage('edit'); return true; }
  saveView();
  activateSequence(key);
  return true;
}

function createProjectSequence(values, composition = false) {
  if (busySwitch()) return false;
  if (composition) {
    const key = id();
    entry.compositions.push({ id:key, sequence:newSequence(values) });
    controls.drawer(false);
    return openSequence(key);
  }
  const next = newProject(values);
  catalog.projects.push(next);
  return openProject(next.id);
}

function newProject(values) {
  return { id:id(), main:newSequence(values), compositions:[], mediaIds:[], lutIds:[], updated:Date.now() };
}

function editSequence(values) {
  if (!change(()=>Object.assign(project,values))) return false;
  controls.renderSequences();
  return true;
}

function deleteComposition(key) {
  const item = entry?.compositions.find(composition=>composition.id===key);
  if (!item) throw new Error('This composition is unavailable.');
  if (hasPendingTask()) throw new Error('Wait for the current task to finish before deleting this composition.');
  const withoutComposition = sequence => {
    const clips = sequence.clips.filter(clip=>clip.composition!==key);
    const overlays = sequence.overlays.filter(clip=>clip.composition!==key);
    return clips.length===sequence.clips.length && overlays.length===sequence.overlays.length ? sequence : { ...sequence, clips, overlays };
  };
  const otherCompositions = entry.compositions.filter(composition=>composition!==item);
  const sequences = [{ id:'main', sequence:entry.main },...otherCompositions];
  const nextSequences = new Map();
  for (const sequence of sequences) {
    const next = withoutComposition(sequence.sequence);
    if (next!==sequence.sequence && changesLockedClips(sequence.sequence,next)) {
      const name = sequence.id==='main' ? 'Main' : sequence.sequence.name;
      throw new Error(`Unlock the affected tracks on ${name} to delete this composition.`);
    }
    nextSequences.set(sequence.id,next);
  }

  const previousEntry = { ...entry };
  const previousProject = project;
  const previousKey = sequenceKey;
  entry.main = nextSequences.get('main');
  entry.compositions = otherCompositions.map(composition=>({ ...composition, sequence:nextSequences.get(composition.id) }));
  if (entry.led?.walls?.some(wall=>wall.sequence===key)) {
    entry.led = { ...entry.led, walls:entry.led.walls.map(wall=>wall.sequence===key ? { ...wall, sequence:null, asset:null } : wall) };
  }
  if (sequenceKey===key) sequenceKey = 'main';
  project = nextSequences.get(sequenceKey);
  if (!persist()) {
    Object.assign(entry,previousEntry);
    project = previousProject;
    sequenceKey = previousKey;
    throw new Error('Framecut could not save the project. The composition is still available.');
  }

  sequenceViews.delete(`${entry.id}:${key}`);
  for (const { id } of sequences) {
    const view = previousKey===id ? { undo, redo } : sequenceViews.get(`${entry.id}:${id}`);
    if (view) for (const stack of [view.undo,view.redo]) {
      stack.splice(0,stack.length,...stack.map(withoutComposition));
    }
  }
  if (timelineClipboard?.clip?.composition===key) timelineClipboard = null;
  if (timelineClipboard?.group) {
    const group = timelineClipboard.group.filter(clip=>clip.composition!==key);
    timelineClipboard = group.length ? { group } : null;
  }
  bin.delete(compositionAssetKey(key));
  if (previousKey===key) activateSequence('main');
  else {
    controls.renderSequences();
    renderTimeline();
  }
  notify(`Deleted ${item.sequence.name}`);
}

const controls = projectControls({
  entries:()=>catalog.projects,
  current:()=>({ entry, selected:sequenceKey }),
  assets:bin,
  open:openProject,
  create:createProjectSequence,
  edit:editSequence,
  openSequence,
  addComposition:key=>void placeComposition(key),
  deleteComposition,
  timecode
});

async function materialize(item, sequence = item.sequence) {
  const payload = { ...sequence, markIn:null, markOut:null, folders:undefined, assignments:undefined, gradeReference:undefined, canvasMargins:undefined };
  const body = JSON.stringify(payload);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const revision = Array.from(new Uint8Array(digest), value=>value.toString(16).padStart(2,'0')).join('');
  if (item.render?.revision === revision && bin.has(item.render.asset)) return bin.get(item.render.asset);
  if (!compositionJobs.has(revision)) compositionJobs.set(revision,(async()=>{
    let job = await jsonPost('/api/compositions',payload);
    while (job.status === 'rendering') {
      await new Promise(resolve=>setTimeout(resolve,350));
      job = await api(`/api/exports/${job.id}`);
    }
    if (job.status !== 'ready') throw new Error(job.error || 'Composition could not be rendered.');
    bin.set(job.asset.id,job.asset);
    return job.asset;
  })().finally(()=>compositionJobs.delete(revision)));
  const asset = await compositionJobs.get(revision);
  item.render = { revision, asset:asset.id };
  persist();
  return asset;
}

const compositionAssetKey = key => `comp-${key}`;
function registerComposition(item) {
  const [width,height] = sequenceSize(item.sequence);
  const asset = { id:compositionAssetKey(item.id), name:item.sequence.name, composition:true,
    kind:'video', frames:Math.max(1,sequenceDuration(item.sequence,contentDuration(item.sequence))), width, height, audio:null };
  bin.set(asset.id,asset);
  return asset;
}

function refreshCompositionLinks() {
  const available = new Map(entry.compositions.map(item=>[item.id,registerComposition(item)]));
  for (const lane of [project.clips, ...Array.from({length:project.layers},(_,i)=>project.overlays.filter(clip=>clip.track===i+1))]) {
    const nextStarts = new Map();
    const ordered = [...lane].sort((a,b)=>a.start-b.start);
    for (let i=ordered.length-1;i>=0;i--) {
      const clip = ordered[i];
      nextStarts.set(clip,clip.start===ordered[i+1]?.start ? nextStarts.get(ordered[i+1]) : ordered[i+1]?.start ?? Infinity);
    }
    for (const clip of lane) {
      const asset = available.get(clip.composition);
      if (!asset) continue;
      const sourceLength = bin.get(clip.asset)?.frames;
      const previousLength = clip.len;
      const fullLength = clip.in === 0 && (clip.compositionFollow ?? previousLength === sourceLength);
      const next = nextStarts.get(clip);
      clip.in = Math.min(clip.in,asset.frames-1);
      clip.len = Math.min(fullLength ? asset.frames : previousLength,asset.frames-clip.in,next-clip.start);
      clip.compositionFollow = fullLength;
      clip.asset = asset.id;
    }
  }
}

async function resolveCompositionClips(sequence, window) {
  const resolved = new Map();
  const resolveLane = async clips => {
    const lane = [];
    for (const clip of clips) {
      if (!isLiveComposition(clip)) { lane.push(clip); continue; }
      if (window && (clip.start>=window.end || clip.start+clip.len<=window.start)) continue;
      const item = entry.compositions.find(composition=>composition.id===clip.composition);
      if (!item) throw new Error('Remove the unavailable linked composition before rendering.');
      if (!resolved.has(item.id)) {
        const length = sequenceDuration(item.sequence,contentDuration(item.sequence));
        const input = length ? item.sequence : { ...item.sequence, fixedFrames:1 };
        resolved.set(item.id,await materialize(item,input));
      }
      const asset = resolved.get(item.id);
      lane.push({ ...clip, asset:asset.id });
    }
    return lane;
  };
  return { ...sequence, clips:await resolveLane(sequence.clips), overlays:await resolveLane(sequence.overlays) };
}

function placeComposition(key, at, track = 0) {
  if (!entry || busySwitch()) return;
  const item = entry.compositions.find(composition=>composition.id===key);
  if (!item) return;
  if (sequenceKey !== 'main' && !openSequence('main')) return;
  if (!guardTrack(`video:${track}`)) return;
  const start = at ?? cursor;
  const asset = registerComposition(item);
  const clip = track ? insertOverlay(asset.id,track,start,false,key) : insertVideo(asset.id,project.clips.length,start,key);
  if (clip) {
    controls.drawer(false);
    notify(`Added ${item.sequence.name} to Main`);
  }
}

const led = createLedWorkspace({
  assets:()=>projectMedia().filter(asset=>asset.kind!=='audio'),
  sequences:()=>entry ? [{id:'main',sequence:entry.main},...entry.compositions] : [],
  scene:()=>entry.led ??= { walls:[], camera:{ pitch:-10, yaw:18, zoom:1 } },
  url:asset=>programUrl({asset:asset.id},'auto'),
  save:persist,
  async renderSequence(key) {
    if (busySwitch()) throw new Error('Wait for the current task to finish.');
    if (key === 'main' && sequenceKey !== 'main') {
      if (!openSequence('main')) throw new Error('Open Main to preview it on a wall.');
      switchPage('led');
    }
    const item = key==='main' ? entry : entry.compositions.find(composition=>composition.id===key);
    syncingCompositions++;
    try {
      return await materialize(item,key==='main'?await resolveCompositionClips(entry.main):item.sequence);
    } finally { syncingCompositions--; }
  }
});

function change(update) {
  pause();
  const before = structuredClone(project);
  const previousSelection = selected;
  const previousGroup = new Set(selectedGroup);
  const previousAnchor = selectionAnchor;
  update();
  if (previousSelection!==selected) {
    selectedGroup.clear();
    selectionAnchor = selected;
  }
  const previousClips = new Map([...before.clips, ...before.overlays].filter(clip=>clip.composition).map(clip=>[clip.id,clip]));
  for (const clip of [...project.clips, ...project.overlays]) {
    if (!clip.composition) continue;
    const previous = previousClips.get(clip.id);
    if (previous && (previous.in !== clip.in || previous.len !== clip.len)) clip.compositionFollow = false;
  }
  if (changesLockedClips(before,project) ||
      (before.timelineLocked && ['layers','audioLayers','titleLayers'].some(key=>before[key]!==project[key]))) {
    project=before;
    selected=previousSelection;
    selectedGroup=previousGroup;
    selectionAnchor=previousAnchor;
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
    masterMuted:project.masterMuted, masterGainDb:project.masterGainDb, canvasMargins:project.canvasMargins };
  if (project.timelineLocked || changesLockedClips(project,next)) {
    notify('Unlock the affected tracks to change edit history.');
    return;
  }
  pause();
  to.push(project);
  from.pop();
  project = next;
  if (sequenceKey==='main') refreshCompositionLinks();
  persist();
  renderTimeline();
}

function sortedTitles() {
  return [...project.titles].sort((a, b) => a.start - b.start);
}

function removedAsset(key) {
  return entry?.removedAssets?.includes(key) ?? false;
}

function projectAsset(key) {
  const asset = entry?.mediaIds?.includes(key) ? bin.get(key) : null;
  return asset?.composition ? null : asset;
}

function projectMedia(includeRemoved = false) {
  const removed = new Set(includeRemoved ? [] : entry?.removedAssets);
  return (entry?.mediaIds || []).map(key=>bin.get(key)).filter(asset=>asset && !asset.composition && !removed.has(asset.id));
}

function addProjectAsset(asset) {
  bin.set(asset.id,asset);
  const media = entry.mediaIds ??= [];
  if (media.includes(asset.id)) return;
  media.push(asset.id);
  persist();
  refreshFootageTray();
}

function addProjectLut(lut) {
  lutLibrary.set(lut.id,lut);
  const luts = entry.lutIds ??= [];
  if (luts.includes(lut.id)) return;
  luts.push(lut.id);
  persist();
}

function setAssetRemoved(key, remove) {
  const asset = projectAsset(key);
  if (!asset) return;
  const removed = new Set(entry.removedAssets || []);
  if (remove) removed.add(key);
  else removed.delete(key);
  entry.removedAssets = [...removed];
  if (sourceAsset===key) sourceAsset = null;
  if (folder==='removed' && !removed.size) folder = 'all';
  persist();
  renderBin();
  refreshFootageTray();
  renderSource();
  reportImport(remove ? `Removed ${asset.name} from Footage` : `Restored ${asset.name} to Footage`);
}

function mediaThumbnail(asset, tag = 'div') {
  const thumbnail = node(tag,'thumbnail');
  if (asset.kind==='audio') thumbnail.append(node('span','audio-thumbnail','♫'));
  else {
    const image = node('img');
    image.src = diskURL(asset.id,'thumb.jpg');
    image.alt = '';
    image.loading = 'lazy';
    image.draggable = false;
    thumbnail.append(image);
  }
  thumbnail.append(node('time','',timecode(asset.frames).slice(3,8)));
  return thumbnail;
}

function enableMediaDrag(element,asset) {
  element.draggable = true;
  element.ondragstart = event => {
    const type = asset.kind==='audio' ? importedAudioDragType : mediaDragType;
    event.dataTransfer.setData(type,asset.id);
    event.dataTransfer.effectAllowed = 'copy';
  };
  element.ondragend = () => { $('drop-marker').hidden = true; };
}

function refreshFootageTray() {
  if ($('footage-tray-content').hidden) return;
  const list = $('footage-tray-items');
  const search = $('footage-tray-search').value.trim().toLowerCase();
  const media = projectMedia().reverse().filter(asset=>asset.name.toLowerCase().includes(search));
  list.replaceChildren();
  for (const asset of media) {
    const card = button('',()=>{
      const [type,track] = (selectedTrack || '').split(':');
      if (asset.kind==='audio') insertSound(asset,type==='audio'?Number(track):undefined);
      else if (type==='video' && Number(track)) insertOverlay(asset.id,Number(track));
      else insertVideo(asset.id,project.clips.length,cursor);
    });
    card.className = 'tray-asset';
    card.title = asset.name;
    card.setAttribute('aria-label',`Add ${asset.name} from Footage tray`);
    card.append(mediaThumbnail(asset),node('span','asset-name',asset.name));
    enableMediaDrag(card,asset);
    list.append(card);
  }
  if (!media.length) list.append(node('p','subtle',search?'No matching footage.':'Import media to drag it onto the timeline.'));
}

function renderBin() {
  renderFolders();
  const search = $('media-search').value.trim().toLowerCase();
  const available = projectMedia(folder==='removed');
  const shown = available.filter(asset =>
    (folder==='removed' ? removedAsset(asset.id) : folder==='all' || (project.assignments[asset.id] || '')===folder)
    && asset.name.toLowerCase().includes(search));
  const sort = $('media-sort').value;
  if (sort === 'name') shown.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'duration') shown.sort((a, b) => b.frames - a.frames);
  else shown.reverse();
  $('media-count').textContent = `${shown.length} ${shown.length === 1 ? 'clip' : 'clips'}`;
  $('bin').replaceChildren();
  if (!shown.length) {
    const empty = node('div', 'media-empty');
    empty.append(node('b', '', available.length ? 'No footage here' : 'Import your footage'), document.createElement('br'),
      search ? 'Try another search' : 'Drop video files here');
    $('bin').append(empty);
  }
  for (const asset of shown) {
    const removed = removedAsset(asset.id);
    const card = node('article', 'asset');
    card.classList.toggle('active-asset', asset.id === sourceAsset);
    if (!removed && asset.kind!=='audio') enableMediaDrag(card,asset);
    card.oncontextmenu = event => {
      event.preventDefault();
      const menu = $('timeline-menu');
      const action = button(removed?'Restore to Footage':'Remove from Footage',()=>{
        hideTimelineMenu();
        setAssetRemoved(asset.id,!removed);
      });
      action.setAttribute('role','menuitem');
      menu.replaceChildren(action);
      showTimelineMenu(event);
    };
    const thumbnail = mediaThumbnail(asset,'button');
    thumbnail.type = 'button';
    thumbnail.setAttribute('aria-label', `Preview ${asset.name}`);
    thumbnail.onclick = () => { sourceAsset = asset.id; renderSource(); renderBin(); };
    const bottom = node('div', 'asset-bottom');
    const name = node('span', 'asset-name', asset.name);
    name.title = asset.name;
    const add = button('＋', () => {
      switchPage(asset.kind==='audio'?'sound':'edit');
      if (asset.kind==='audio') insertSound(asset);
      else insertVideo(asset.id, project.clips.length);
    });
    add.title = `Append ${asset.name} to timeline`;
    add.setAttribute('aria-label', add.title);
    const remove = button(removed?'↶':'×',()=>setAssetRemoved(asset.id,!removed));
    remove.title = removed?`Restore ${asset.name} to Footage`:`Remove ${asset.name} from Footage`;
    remove.setAttribute('aria-label',remove.title);
    bottom.append(name);
    if (!removed) bottom.append(add);
    bottom.append(remove);
    card.append(thumbnail, bottom);
    $('bin').append(card);
  }
}

async function importFiles(files) {
  if (!entry || importing || !mediaLoaded || !files.length) return;
  importing = true;
  videoImporting = true;
  $('import').disabled = true;
  let added = 0;
  const errors = [];
  for (const file of files) {
    reportImport(`Importing ${file.name}…`);
    updateProgress($('import-progress'),{progress:null});
    try {
      const extension = file.name.split('.').at(-1).toLowerCase();
      if (extension==='srt' || extension==='txt') {
        if (!guardTrack('caption:5')) throw new Error('Unlock the caption track to import subtitles.');
        if (file.size>1_000_000) throw new Error('Choose a subtitle or script file under 1 MB.');
        const content = await file.text();
        if (extension==='srt') addCues(readSrt(content));
        else addCues(content.replace(/\r\n?/g,'\n').split('\n').map(line=>cleanText(line)).filter(Boolean)
          .map((text,index)=>({start:index*3*fps,len:3*fps,text})),cursor);
      } else if (extension==='cube') {
        const lut = await api('/api/luts',{method:'POST',headers:{'X-Framecut':'1','X-Filename':encodeURIComponent(file.name)},body:file});
        addProjectLut(lut);
        const clip = selection();
        if (clip?.asset && clip.kind!=='audio' && !protectedTrack(project,trackOf(clip))) change(()=>{ clip.lut=lut.id; });
      } else if (extension==='obj') {
        if (file.size>950000) throw new Error('Choose an OBJ file smaller than 950 KB.');
        const asset = await jsonPost('/api/graphics',{kind:'mesh',mesh:await file.text(),name:file.name});
        addProjectAsset(asset);
        if (page==='effects') {
          const track = Math.max(1,project.layers);
          const last = project.overlays.filter(clip=>clip.track===track);
          const next = last.some(clip=>cursor<clip.start+clip.len && cursor+asset.frames>clip.start) ? Math.min(8,track+1) : track;
          if (!protectedTrack(project,`video:${next}`)) insertOverlay(asset.id,next,cursor,true);
        }
      } else {
        const asset = await (window.framecutDesktop?.importVideo?.(file) || api('/api/media', {
          method:'POST', headers:{'X-Framecut':'1','X-Filename':encodeURIComponent(file.name),'X-File-Size':String(file.size)},body:file
        }));
        sourceAsset = asset.id;
        if (folder==='removed') folder = 'all';
        if (folder && folder!=='all') project.assignments[asset.id] = folder;
        addProjectAsset(asset);
      }
      added++;
      renderBin();
      if (page==='footage') renderSource();
    } catch (error) {
      errors.push(`${file.name} — ${error.message.split('\n')[0]}`);
    }
  }
  importing = false;
  videoImporting = false;
  $('import').disabled = false;
  updateProgress($('import-progress'),null);
  if (page==='led') led.open(entry.id);
  else if (page!=='footage') renderTimeline();
  reportImport([`Imported ${added} of ${files.length}`, ...errors].join(' · '));
  const toast = $('global-import-status');
  toast.textContent = $('media-status').textContent;
  toast.hidden = false;
  clearTimeout(importToast);
  importToast = setTimeout(()=>{ toast.hidden=true; },errors.length?10000:4200);
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
  const folders = [['all','All footage'], ['', 'Unfiled'], ...project.folders.map(item => [item.id, item.name])];
  if (entry?.removedAssets?.length) folders.push(['removed','Removed footage']);
  for (const [key, name] of folders) {
    const entry = button(name, () => {
      folder = key;
      if (sourceAsset && removedAsset(sourceAsset)!==(key==='removed')) sourceAsset = null;
      renderBin();
      renderSource();
    });
    entry.className = 'folder-item';
    entry.setAttribute('aria-current', key === folder);
    if (key !== 'all' && key !== 'removed') {
      entry.addEventListener('dragover', event => { if (hasAsset(event)) event.preventDefault(); });
      entry.addEventListener('drop', event => {
        if (!hasAsset(event)) return;
        event.preventDefault();
        moveAsset(event.dataTransfer.getData(mediaDragType), key);
      });
    }
    list.append(entry);
  }
}

function moveAsset(assetId, to) {
  if (!projectAsset(assetId)) return;
  if (to) project.assignments[assetId] = to;
  else delete project.assignments[assetId];
  persist();
  renderBin();
  renderSource();
}

function renderSource() {
  const asset = projectAsset(sourceAsset);
  const video = $('source-video');
  const audio = $('source-audio');
  const isAudio = asset?.kind==='audio';
  video.hidden = !asset || isAudio;
  audio.hidden = !isAudio;
  if (video.hidden) video.pause();
  if (audio.hidden) audio.pause();
  $('resize-source').hidden = video.hidden;
  $('source-folder-field').hidden = !asset;
  if (!asset) {
    $('source-info').textContent = 'Select footage to preview it.';
    $('source-actions').replaceChildren();
    return;
  }
  if (isAudio) {
    const url = diskURL(asset.id,'audio.wav');
    if (audio.getAttribute('src')!==url) audio.src = url;
  } else {
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
  }
  $('source-info').textContent = `${asset.name} · ${timecode(asset.frames)}`;
  const select = $('source-folder');
  select.replaceChildren();
  for (const [key, name] of [['', 'Unfiled'], ...project.folders.map(item => [item.id, item.name])]) select.add(new Option(name, key));
  select.value = project.assignments[asset.id] || '';
  if (removedAsset(asset.id)) {
    $('source-folder-field').hidden = true;
    $('source-actions').replaceChildren(button('Restore to Footage',()=>setAssetRemoved(asset.id,false)));
  } else if (isAudio) $('source-actions').replaceChildren(button('Add audio to timeline',()=>{ switchPage('sound'); insertSound(asset); }));
  else $('source-actions').replaceChildren(
    button('Add to timeline', () => { switchPage('edit'); insertVideo(asset.id, project.clips.length); }),
    button('Add as layer', () => { switchPage('edit'); insertOverlay(asset.id); })
  );
}

function stillSource(id) { return sourceAsset===id; }

function switchPage(next) {
  finishSelectionBox(null,true);
  if (next === 'projects' && busySwitch()) return;
  if (next !== 'projects' && !entry) return;
  if (page === 'led' && next !== 'led') led.suspend();
  page = next;
  if(next==='footage') selectedTrack=null;
  stopTextPlacement();
  if (next !== 'effects') cancelPicking();
  $('workspace-root').dataset.page = next;
  $('workspace-root').hidden = next === 'projects' || next === 'led';
  $('app-nav').hidden = next === 'projects';
  $('projects-home').hidden = next !== 'projects';
  $('led-workspace').hidden = next !== 'led';
  $('sequence-settings').hidden = next === 'led';
  $('export').hidden = next === 'projects' || next === 'led';
  $('import').hidden = next === 'projects';
  $('save-project').hidden = next === 'projects';
  if (next!=='footage') $('source-audio').pause();
  if (next === 'projects' || next === 'led' || next === 'footage') controls.drawer(false);
  for (const tab of $('app-nav').querySelectorAll('[data-page]')) {
    if (tab.dataset.page === next) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (next === 'projects' || next === 'led') {
    pause();
    $('source-video').pause();
    if (next === 'projects') {
      $('projects-status').textContent = '';
      controls.renderHome();
    } else led.open(entry.id);
  } else if (next === 'footage') { pause(); renderBin(); renderSource(); }
  else { $('source-video').pause(); renderTimeline(); }
}

function insertOverlay(assetId, track = project.layers || 1, start = cursor, graphic = false, composition) {
  const asset = composition ? bin.get(assetId) : projectAsset(assetId);
  if (!asset || !guardTrack(`video:${track}`)) return;
  const clip = { id: id(), asset: assetId, track, in: 0, len: asset.frames, start: 0, motion: { scale: [[0, graphic || composition ? 100 : 60]] }, muted: !composition };
  if (composition) Object.assign(clip,{ composition, compositionFollow:true });
  clip.start = freeStart(project.overlays.filter(item => item.track === track), Math.max(0, start), clip.len);
  change(() => {
    project.layers = Math.max(project.layers, track);
    project.overlays.push(clip);
    selected = clip.id;
  });
  selectTrack(trackOf(clip));
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

function insertVideo(assetId, index, dropStart, composition) {
  const asset = composition ? bin.get(assetId) : projectAsset(assetId);
  if (!asset || !guardTrack('video:0')) return;
  const at=dropStart ?? (index<timeline.length ? timeline[index].start : videoEnd);
  const clip = { id: id(), asset: asset.id, in: 0, len: asset.frames, start:freeStart(project.clips,Math.max(0,at),asset.frames) };
  if (composition) Object.assign(clip,{ composition, compositionFollow:true });
  change(() => {
    project.clips.splice(index, 0, clip);
    selected = clip.id;
  });
  selectTrack(trackOf(clip));
  setPosition(clip.start);
  revealCursor();
  return clip;
}

function addTitle(preset, caption=false, onCanvas=false) {
  const len = onCanvas && project.fixedFrames ? Math.min(3*fps,project.fixedFrames-cursor) : 3*fps;
  if (len<1) return;
  const active = selection();
  let track = caption ? 5 : active && !active.asset && active.style !== 'caption' ? active.track || 1 : project.titleLayers;
  const at = layer=>freeStart(project.titles.filter(item=>(item.track || 1)===layer),cursor,len);
  if (onCanvas && (protectedTrack(project,`title:${track}`) || at(track)!==cursor)) {
    const layers = Array.from({length:4},(_,i)=>i+1);
    track = layers.find(layer=>!protectedTrack(project,`title:${layer}`) && at(layer)===cursor);
    if (!track) return notify('Free or unlock a title layer at the playhead to add text here.');
  }
  if(!guardTrack(caption?'caption:5':`title:${track}`)) return;
  const clip = { id: id(), track, text: caption ? 'Your caption' : 'Your title', style:caption ? 'caption' : 'center',
    ...preset, start:at(track), len };
  change(() => {
    if (onCanvas) project.titleLayers = Math.max(project.titleLayers,track);
    project.titles.push(clip);
    selected = clip.id;
  });
  setPosition(clip.start);
  revealCursor();
  $('title-text')?.select();
}

let fontOptions;
const inspectorFont = node('select');
inspectorFont.dataset.titleFont = '';

function fillFontMenu(menu,value,inherit=false) {
  if (!fontOptions) {
    fontOptions = document.createDocumentFragment();
    for (const family of [...installedFonts].sort((a,b)=>a.localeCompare(b))) {
      fontOptions.append(new Option(family,family));
    }
  }
  if (menu.fontOptions !== fontOptions) {
    menu.replaceChildren();
    if (inherit) menu.add(new Option('From title style',''));
    menu.append(fontOptions.cloneNode(true));
    menu.fontOptions = fontOptions;
  }
  if (menu.firstElementChild?.hasAttribute('data-mixed-value')) menu.firstElementChild.remove();
  const unavailable = menu.lastElementChild;
  if (unavailable?.hasAttribute('data-unavailable-font')) unavailable.remove();
  if (value===mixed) addMixedOption(menu);
  else if (value && !installedFonts.has(value)) {
    const option = new Option(value+' (unavailable)',value);
    option.dataset.unavailableFont = '';
    menu.add(option);
  }
  menu.value = value===mixed ? '' : value;
}

function fillMaterialMenu(menu, value, inherit = false) {
  if (inherit) menu.add(new Option('From title style','inherit'));
  if (value===mixed) addMixedOption(menu);
  menu.add(new Option('Solid color','solid'));
  menu.add(new Option('Custom gradient','custom'));
  const groups = new Map();
  for (const [key,material] of Object.entries(titleMaterials)) {
    if (!groups.has(material.group)) {
      const group = node('optgroup');
      group.label = material.group;
      groups.set(material.group,group);
      menu.append(group);
    }
    groups.get(material.group).append(new Option(material.label,key));
  }
  menu.value = value===mixed ? '' : value;
}

function setupTextList() {
  const dialog = $('text-list-dialog');
  const form = $('text-list-form');
  const input = $('text-list-input');
  const numbers = $('text-list-numbers');
  const track = $('text-list-track');
  const style = $('text-list-style');
  const font = $('text-list-font');
  const material = $('text-list-material');
  const fill = $('text-list-fill');
  const outline = $('text-list-outline');
  const outlineColor = $('text-list-outline-color');
  const gradientAngle = $('text-list-gradient-angle');
  const gradientColors = ['start','middle','end'].map(name=>$('text-list-gradient-'+name));
  const depth = $('text-list-depth');
  const depthAngle = $('text-list-depth-angle');
  const depthColor = $('text-list-depth-color');
  const enter = $('text-list-enter');
  const exit = $('text-list-exit');
  const enterTime = $('text-list-enter-time');
  const holdTime = $('text-list-hold');
  const exitTime = $('text-list-exit-time');
  const status = $('text-list-status');
  const play = $('text-list-play');
  const sample = $('text-list-preview-title');
  const sampleLayer = $('text-list-preview-layer');
  const stage = $('text-list-stage');
  const add = $('text-list-add');
  const line = clip=>clip.text.replaceAll('\n',' ');
  const timingFields = {entrance:enter,exit,enterFrames:enterTime,holdFrames:holdTime,exitFrames:exitTime};
  fillFontMenu(font,'',true);
  fillMaterialMenu(material,'inherit',true);
  for (const [select,options] of [[enter,textListEntrances],[exit,textListExits]]) {
    for (const [value,[label]] of Object.entries(options)) select.add(new Option(label,value));
    select.value = 'fade';
  }
  let styleSource;
  let editing;
  let draft;
  const dirty = new Set();
  let lineCount = 0;
  let animation = 0;
  let previewItems = [];
  let customFill = false;
  let customOutlineColor = false;
  let customDepthColor = false;
  fill.oninput = () => { customFill = true; material.value = 'solid'; dirty.add(material.id); };
  outlineColor.oninput = () => { customOutlineColor = true; };
  depthColor.oninput = () => { customDepthColor = true; };

  function styleFor(base) {
    const matchStyle = style.value==='selected' && styleSource;
    const type = editing ? {...base.type} : matchStyle ? {...styleSource.type} : {};
    const apply = (...fields)=>!editing || fields.some(field=>dirty.has(field.id));
    if (apply(font) && installedFonts.has(font.value)) type.family = font.value;
    const preset = titleMaterials[material.value];
    if (apply(material) && material.value==='solid') Object.assign(type,{fill:fill.value,gradient:null,material:null});
    if (apply(material,gradientAngle,...gradientColors) && (preset || material.value==='custom')) {
      const stops = preset?.stops || (editing && !apply(material,...gradientColors) ? type.gradient?.stops : null) ||
        gradientColors.map((input,index)=>[index/2,input.value]);
      const angle = gradientAngle.valueAsNumber;
      Object.assign(type,{gradient:{stops,angle:Number.isFinite(angle)?angle:preset?.angle ?? 180},material:preset?material.value:null});
      if (preset && apply(material) && !dirty.has(depthColor.id) && (editing || !customDepthColor)) type.depthColor = preset.side;
    }
    for (const [key,input] of [['depth',depth],['depthAngle',depthAngle],['outline',outline]]) {
      if (apply(input) && Number.isFinite(input.valueAsNumber)) type[key] = input.valueAsNumber;
    }
    if (apply(depthColor) && customDepthColor) type.depthColor = depthColor.value;
    if (apply(outlineColor) && customOutlineColor) type.outlineColor = outlineColor.value;
    return {style:editing && !apply(style) ? base.style : matchStyle ? (editing ? base.style : styleSource.style) : style.value,
      ...(Object.keys(type).length ? {type} : {})};
  }

  function plan() {
    const values = {
      entrance:enter.value, exit:exit.value,
      enterFrames:enterTime.disabled ? 0 : Math.round(enterTime.valueAsNumber*fps),
      holdFrames:Math.round(holdTime.valueAsNumber*fps),
      exitFrames:exitTime.disabled ? 0 : Math.round(exitTime.valueAsNumber*fps)
    };
    const lines = input.value.split('\n');
    const items = lines.map(line=>cleanText(line,901)).filter(Boolean);
    const timing = editing ? Object.fromEntries(Object.entries(values).filter(([key])=>dirty.has(timingFields[key].id))) : values;
    const validFields = Object.values(timing).every(value=>typeof value==='string' || Number.isSafeInteger(value) && value>=0 && value<=MAX_DURATION);
    const len = values.enterFrames+values.holdFrames+values.exitFrames;
    const template = { ...styleFor(styleSource),len,motion:validFields && !editing ? textListMotion(values) : {},textTiming:values };
    let planned = [];
    if (validFields && items.length<=500) {
      if (editing) {
        const available = new Map();
        for (const clip of editing) {
          const key = line(clip);
          if (!available.has(key)) available.set(key,[]);
          available.get(key).push(clip);
        }
        const matched = items.map(text=>available.get(text)?.shift());
        const remaining = editing.filter(clip=>!matched.includes(clip));
        planned = items.map((text,i)=>{
          const existing = matched[i] || remaining.shift();
          const base = existing || {...editing[0],id:undefined};
          return { ...retimeTitle(base,timing),...styleFor(base),text:matched[i]?.text ?? text };
        });
      } else planned = items.map(text=>({...template,text}));
    }
    const layer = Number(track.value);
    const total = planned.reduce((sum,clip)=>sum+clip.len,0);
    const ignored = new Set(editing?.map(clip=>clip.id));
    const peers = project.titles.filter(item=>item.style!=='caption' && (item.track || 1)===layer && !ignored.has(item.id));
    const start = editing ? editing[0].start : total ? freeStart(peers,cursor,total) : cursor;
    let error = '';
    if (!validFields || (!editing && len<1) || planned.some(clip=>clip.len<1)) error = 'Enter at least one frame of total duration.';
    else if (items.length>500) error = 'Add up to 500 titles at a time.';
    else if (items.some(text=>text.length>900)) error = 'Keep each title to 900 characters or fewer.';
    else if (!layer || protectedTrack(project,`title:${layer}`)) error = 'Choose an unlocked title layer.';
    else if (editing && peers.some(clip=>clip.start<start+total && clip.start+clip.len>start)) error = 'This list would overlap another title. Shorten the timing or choose another layer.';
    else if (start+total>(project.fixedFrames || MAX_DURATION)) error = project.fixedFrames ?
      `The list runs past the fixed end at ${timecode(project.fixedFrames)}. Shorten the timing or change the timeline duration.` :
      'The list would extend the timeline past 24 hours.';
    return { timing,template,items,planned,lineCount:lines.length,layer,total,start,error };
  }

  function showPreview(frame) {
    const title = previewItems.find(clip=>{ if (frame<clip.len) return true; frame-=clip.len; return false; });
    sampleLayer.hidden = !title;
    if (!title) return;
    const local = frame;
    styleTitle(sample,title,local,stage);
    styleMotion(sampleLayer,title,local);
  }

  function stopPreview() {
    cancelAnimationFrame(animation);
    animation = 0;
    play.textContent = 'Play preview';
  }

  function update() {
    enterTime.disabled = enter.value==='cut';
    exitTime.disabled = exit.value==='cut';
    const sequence = plan();
    const example = sequence.planned[0] || sequence.template;
    const type = titleType(example);
    if (!customFill) fill.value = type.fill;
    if (!customOutlineColor) outlineColor.value = type.outlineColor;
    outline.placeholder = String(type.outline);
    $('text-list-gradient-field').hidden = material.value==='solid' || material.value==='inherit';
    $('text-list-gradient-colors').hidden = material.value!=='custom';
    gradientAngle.placeholder = String(titleMaterials[material.value]?.angle ?? 180);
    depth.placeholder = String(type.depth);
    depthAngle.placeholder = String(type.depthAngle);
    if (!customDepthColor) depthColor.value = type.depthColor;
    if (lineCount!==sequence.lineCount) {
      lineCount = sequence.lineCount;
      numbers.textContent = Array.from({length:Math.min(501,lineCount)},(_,i)=>i+1).join('\n');
    }
    numbers.scrollTop = input.scrollTop;
    const count = sequence.items.length;
    add.disabled = !count || Boolean(sequence.error);
    status.toggleAttribute('data-error',Boolean(sequence.error));
    status.textContent = sequence.error || (count ? `${count} ${count===1?'title':'titles'} · ${timecode(sequence.total)} · Starts at ${timecode(sequence.start)}` : 'Enter titles to build a sequence.');
    stopPreview();
    previewItems = count ? sequence.planned.slice(0,2).filter(clip=>clip.len>0) :
      Number.isInteger(example.len) && example.len>0 ? ['Your first title','Your next title'].map(text=>({...example,text})) : [];
    play.disabled = !previewItems.length;
    showPreview(Math.min(example.textTiming?.enterFrames || 0,(previewItems[0]?.len ?? 1)-1));
  }
  play.onclick = () => {
    if (animation) {
      update();
      return;
    }
    let started;
    const total = previewItems.reduce((sum,clip)=>sum+clip.len,0);
    play.textContent = 'Stop preview';
    const tick = now => {
      started ??= now;
      const frame = Math.floor((now-started)*fps/1000);
      if (frame>=total || !dialog.open) return update();
      showPreview(frame);
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
  };
  input.onscroll = () => { numbers.scrollTop = input.scrollTop; };
  form.addEventListener('input',event=>{ dirty.add(event.target.id); update(); });
  $('text-list-close').onclick = () => dialog.close();
  dialog.addEventListener('close',()=>{
    stopPreview();
    if (!editing) return;
    for (const [control,value] of draft.fields) control.value=value;
    ({customFill,customOutlineColor,customDepthColor}=draft);
    editing = draft = null;
  });
  form.onsubmit = event => {
    event.preventDefault();
    const { items,planned,layer,start,error } = plan();
    if (error || !items.length) return update();
    if (editing?.some(clip=>!guardTrack(trackOf(clip)))) return;
    const replaced = new Set(editing?.map(clip=>clip.id));
    const list = editing?.[0].textListId || id();
    let position = start;
    const clips = planned.map(clip=>{
      const next = {...structuredClone(clip),id:clip.id || id(),textListId:list,track:layer,start:position};
      position+=clip.len;
      return next;
    });
    if (!change(()=>{
      project.titleLayers = Math.max(project.titleLayers,layer);
      if (editing) project.titles = project.titles.filter(clip=>!replaced.has(clip.id));
      project.titles.push(...clips);
      selected = clips[0].id;
    })) return;
    selectItems(new Set(clips.map(clip=>clip.id)));
    const wasEditing = Boolean(editing);
    dialog.close();
    if (!wasEditing) input.value = '';
    setPosition(start);
    revealCursor();
    notify(wasEditing ? 'Text List updated' : `Added ${clips.length} ${clips.length===1?'title':'titles'} from Text List`);
  };

  return (list=null) => {
    if (dialog.open || list?.some(clip=>!guardTrack(trackOf(clip)))) return;
    pause();
    const [width,height] = sequenceSize(project);
    stage.style.setProperty('--text-list-ratio',width/height);
    const clip = list?.[0] || selection();
    styleSource = clip && !clip.asset && clip.style!=='caption' ? clip : null;
    style.querySelector('[value=selected]').hidden = !styleSource;
    if (!styleSource && style.value==='selected') style.value = 'center';
    const [kind,number] = (selectedTrack || '').split(':');
    const preferred = list?.[0].track || (kind==='title' ? Number(number) : styleSource?.track || project.titleLayers);
    track.replaceChildren();
    for (let layer=1;layer<=project.titleLayers;layer++) {
      const settings = trackSettings(project,`title:${layer}`);
      const option = new Option((settings.name || `Titles ${layer}`)+(settings.locked?' (locked)':settings.muted?' (hidden)':''),layer);
      option.disabled = Boolean(settings.locked);
      track.add(option);
    }
    if (project.titleLayers<4) track.add(new Option('New title layer',project.titleLayers+1));
    track.value = [...track.options].find(option=>Number(option.value)===preferred && !option.disabled)?.value ??
      [...track.options].find(option=>!option.disabled)?.value ?? '';
    $('text-list-heading').textContent = list ? 'Edit Text List' : 'Text List';
    add.textContent = list ? 'Save Text List' : 'Add to timeline';
    if (list) {
      draft = {fields:[...form.querySelectorAll('input,select,textarea')].map(control=>[control,control.value]),customFill,customOutlineColor,customDepthColor};
      editing = list;
      customFill = customOutlineColor = customDepthColor = false;
      input.value = list.map(line).join('\n');
      style.value = 'selected';
      const type = titleType(clip);
      fillFontMenu(font,type.family,true);
      material.value = type.material || (type.gradient?'custom':'solid');
      fill.value = type.fill;
      outline.value = type.outline;
      outlineColor.value = type.outlineColor;
      depth.value = type.depth;
      depthAngle.value = type.depthAngle;
      depthColor.value = type.depthColor;
      gradientAngle.value = type.gradient?.angle ?? '';
      for (const [i,control] of gradientColors.entries()) control.value = type.gradient?.stops[i]?.[1] || customGradientStops[i][1];
      const timing = titleTiming(clip) || {entrance:'cut',exit:'cut',enterFrames:0,holdFrames:clip.len,exitFrames:0};
      enter.value = timing.entrance;
      exit.value = timing.exit;
      for (const [key,control] of [['enterFrames',enterTime],['holdFrames',holdTime],['exitFrames',exitTime]]) control.value = timing[key]/fps;
    }
    dirty.clear();
    dialog.showModal();
    update();
    input.focus();
  };
}

const openTextList = setupTextList();

function selection() {
  return clipsIn(project).find(clip => clip.id === selected);
}

const isSelected = key => selected===key || selectedGroup.has(key);
const selectedClips = () => clipsIn(project).filter(clip=>isSelected(clip.id));
const selectedTitles = () => project.titles.filter(clip=>isSelected(clip.id));
const textListsByTitle = new Map();
const expandedTextLists = new Set();
const collapsedList = key => {
  const list = textListsByTitle.get(key);
  return list && !expandedTextLists.has(list[0].textListId) ? list : null;
};

function selectItems(keys, primary = keys.values().next().value ?? null) {
  selected = selectionAnchor = primary;
  selectedGroup = new Set(keys);
  selectedGroup.delete(primary);
  refreshSelection();
}

function selectedTextList(titles) {
  const list = textListsByTitle.get(titles[0]?.id);
  return list?.length===titles.length && titles.every(title=>list.includes(title)) ? list : null;
}

function canGroupTitles(titles) {
  return titles.length>1 && titles.every((title,i)=>typeof title.text==='string' && title.style!=='caption' && !title.textListId &&
    (!i || (title.track || 1)===(titles[i-1].track || 1) && title.start===titles[i-1].start+titles[i-1].len));
}

function setTextListExpanded(list, expanded) {
  const key = list[0].textListId;
  if (expanded) expandedTextLists.add(key);
  else expandedTextLists.delete(key);
  renderTimeline();
  if (!expanded && list.some(clip=>isSelected(clip.id))) select(list[0].id);
}

function groupAsTextList(titles) {
  if (!canGroupTitles(titles)) return;
  const key = id();
  if (editTitles(titles,clip=>{ clip.textListId=key; })) openTextList(titles);
}

function selectAllTitles() {
  const [first,...others] = sortedTitles();
  if (!first) return;
  selected = selectionAnchor = first.id;
  selectedGroup = new Set(others.map(clip=>clip.id));
  refreshSelection();
}

function clipList(clip) {
  return clip.kind === 'audio' ? project.sounds : clip.asset ? (clip.track ? project.overlays : project.clips) : project.titles;
}

function select(key, {toggle=false, range=false, preserve=false} = {}) {
  const items = clipsIn(project);
  const list = collapsedList(key);
  if (list && !range) {
    const keys = new Set(preserve || toggle ? selectedClips().map(clip=>clip.id) : []);
    const remove = toggle && list.every(clip=>keys.has(clip.id));
    for (const clip of list) {
      if (remove) keys.delete(clip.id);
      else keys.add(clip.id);
    }
    selectItems(keys,remove ? keys.values().next().value ?? null : key);
    return;
  }
  if (toggle && key) {
    const keys = new Set(selectedClips().map(item=>item.id));
    if (!keys.delete(key)) keys.add(key);
    selected = keys.has(key) ? key : keys.has(selected) ? selected : [...keys].at(-1) ?? null;
    selectedGroup = keys;
    selectionAnchor = selected;
  } else if (range && key) {
    const start = items.find(item=>item.id===selectionAnchor);
    const end = items.find(item=>item.id===key);
    if (start && end && trackOf(start)===trackOf(end)) {
      const [low,high] = [start.start,end.start].sort((a,b)=>a-b);
      selectedGroup = new Set(items.filter(item=>trackOf(item)===trackOf(end) && item.start>=low && item.start<=high).map(item=>item.id));
      selected = key;
    } else {
      selectedGroup.add(selected);
      selected = key;
      selectionAnchor = key;
    }
  } else if (preserve && isSelected(key)) {
    selectedGroup.add(selected);
    selected = key;
  } else {
    selectedGroup.clear();
    selected = key;
    selectionAnchor = key;
  }
  for (const id of [...selectedGroup,selected]) for (const clip of collapsedList(id) || []) selectedGroup.add(clip.id);
  selectedGroup.delete(selected);
  selectedGroup.delete(null);
  refreshSelection();
}

function drawClipSelection(preview) {
  for (const clip of space.querySelectorAll('.clip')) {
    const keys = clip.textListTitles?.map(item=>item.id) || [clip.dataset.id];
    const active = keys.some(key=>preview ? preview.has(key) : isSelected(key));
    clip.classList.toggle('selected',active);
    if (!preview) clip.setAttribute('aria-pressed',String(active));
  }
}

function refreshSelection() {
  stopTitlePosition();
  const clip=selection();
  if (samplingKey && samplingKey!==clip?.id) stopBackgroundSample();
  const clearMatte = matteClip && matteClip!==clip?.id;
  if (clearMatte) matteClip=null;
  if (keyDraft && keyDraft.id!==clip?.id) keyDraft=null;
  if(clip) selectTrack(trackOf(clip));
  drawClipSelection();
  renderInspector();
  renderKeyLanes();
  renderTools();
  refreshTrackControls();
  updateButtons();
  for (const label of $('preview-titles').querySelectorAll('[data-preview-title]')) {
    label.classList.toggle('canvas-selected',isSelected(label.dataset.previewTitle));
  }
  if (clearMatte) display(cursor);
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
  const group = selectedClips();
  if (!clip || group.some(item=>!guardTrack(trackOf(item)))) return;
  change(() => {
    if (ripple && (group.length===1 || selectedTextList(group))) {
      const start = Math.min(...group.map(item=>item.start));
      const end = Math.max(...group.map(item=>item.start+item.len));
      const peers=layerItems(clip).filter(item=>item.start>=end);
      const first=Math.min(Infinity,...peers.map(item=>item.start));
      if(Number.isFinite(first)) {
        const delta=first-start;
        for(const peer of peers) peer.start-=delta;
      }
    }
    for (const item of group) {
      const lane = clipList(item);
      lane.splice(lane.indexOf(item),1);
    }
    selected = null;
  });
}

function copyTimelineClip(cut = false) {
  const clip = selection();
  if (!clip) return;
  const group = selectedClips();
  if(cut && group.some(item=>!guardTrack(trackOf(item)))) return;
  timelineClipboard = group.length===1 ? { clip:structuredClone(clip),cut } : { group:structuredClone(group) };
  if (cut) removeClip();
  notify(`${group.length===1?'Clip':group.length+' clips'} ${cut?'cut':'copied'}. Paste at the playhead.`);
}

function pasteGroup(items, at, copies=1) {
  if (sequenceKey!=='main' && items.some(item=>item.composition)) {
    notify('Paste linked compositions on Main.');
    return false;
  }
  if (items.some(item=>!guardTrack(trackOf(item)))) return false;
  const origin = Math.min(...items.map(item=>item.start));
  const period = Math.max(...items.map(item=>item.start+item.len))-origin;
  if (items.length*copies>2000) { notify('Select fewer clips or enter fewer copies.'); return false; }
  const occupied = new Map();
  for (const item of clipsIn(project)) {
    const key = trackOf(item);
    if (!occupied.has(key)) occupied.set(key,[]);
    occupied.get(key).push(item);
  }
  let start = Math.max(0,at);
  const added = [];
  for (let repeat=0;repeat<copies;repeat++) {
    const base = start;
    do {
      at = start;
      for (const clip of items) {
        const offset = clip.start-origin;
        const left = start+offset;
        for (const peer of occupied.get(trackOf(clip)) || []) {
          const end = peer.start+peer.len;
          if (left<end && left+clip.len>peer.start) start=Math.max(start,end-offset);
        }
      }
    } while (start>at);
    if (repeat===0 && start!==base && copies>1) notify('Placing the copies in the first available space.');
    const listCopies = new Map();
    for (const clip of items) {
      const duplicate = { ...structuredClone(clip),id:id(),start:start+clip.start-origin };
      if (clip.textListId) {
        if (!listCopies.has(clip.textListId)) listCopies.set(clip.textListId,id());
        duplicate.textListId = listCopies.get(clip.textListId);
      }
      delete duplicate.extractedFrom;
      added.push(duplicate);
    }
    start += period;
  }
  if (!change(()=>{
    for (const clip of added) {
      clipList(clip).push(clip);
      if (clip.kind==='audio') project.audioLayers = Math.max(project.audioLayers,clip.track);
      else if (clip.asset && clip.track) project.layers = Math.max(project.layers,clip.track);
      else if (!clip.asset && clip.style!=='caption') project.titleLayers = Math.max(project.titleLayers,clip.track || 1);
    }
    selected = added[0].id;
  })) return false;
  selectedGroup = new Set(added.map(item=>item.id).filter(key=>key!==selected));
  renderTimeline();
  setPosition(added[0].start);
  revealCursor();
  notify(`Added ${added.length} ${added.length===1?'clip':'clips'}`);
  return true;
}

function pasteTimelineClip(at = cursor) {
  if (!timelineClipboard?.clip) return;
  const clip = structuredClone(timelineClipboard.clip);
  if (clip.composition && sequenceKey!=='main') return notify('Paste linked compositions on Main.');
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
    if (clip.textListId) clip.textListId = id();
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
  const asset = projectAsset(sourceAsset);
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
    if (!timelineClipboard.move || !projectAsset(timelineClipboard.asset)) return false;
    if (folder === 'all') {
      reportImport('Select a destination folder, then paste.');
      return true;
    }
    moveAsset(timelineClipboard.asset, folder);
    timelineClipboard.move = false;
    reportImport('Footage moved.');
    return true;
  }
  if (timelineClipboard.group) {
    pasteGroup(timelineClipboard.group,cursor);
    return true;
  }
  if (timelineClipboard.clip) {
    pasteTimelineClip();
    return true;
  }
  if (projectAsset(timelineClipboard.asset)) {
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
  if (selectedGroup.size) return;
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
  const batchScroll = panel.querySelector('[data-title-batch]') ? panel.scrollTop : 0;
  const openGroups=new Set([...panel.querySelectorAll('details[open] summary')].map(summary=>summary.textContent));
  const transformOpen = panel.querySelector('.video-transform')?.open ?? true;
  panel.replaceChildren();
  const clip = selection();
  if (!clip) {
    panel.append(node('p', 'subtle', 'Select a video or title on the timeline to edit its properties.'));
    return;
  }
  const titles = selectedGroup.size ? selectedTitles() : [];
  if (titles.length>1) {
    panel.append(node('h2','',`${titles.length} text clips selected`));
    const hint = node('p','subtle','Unlock the selected text tracks to edit them together.');
    hint.dataset.titleBatchLock = '';
    hint.hidden = true;
    const batch = node('fieldset','title-batch');
    batch.dataset.titleBatch = '';
    renderTextListActions(batch,titles);
    renderTitleTiming(batch,titles);
    renderTitlePosition(batch,titles);
    renderTypography(batch,titles,openGroups);
    panel.append(hint,batch);
    panel.scrollTop = batchScroll;
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
    const linked = clip.asset===compositionAssetKey(clip.composition);
    if (linked) panel.append(button('Open composition',()=>openSequence(clip.composition)));
    else panel.append(backgroundKeyControls(clip,openGroups.has('Background key')));
    panel.append(videoTransformControls(clip,transformOpen));
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
    if (page==='edit' && !asset.alpha && !linked) {
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
    panel.append(field(clip.style==='caption' ? 'Caption' : 'Text',text));
    renderTextListActions(panel,[clip]);
    renderTitleTiming(panel,[clip]);
    renderTitlePosition(panel,[clip]);
    if(clip.style!=='caption') panel.append(field('Title layer',layer));
    panel.append(timing);
    if(page==='text') renderTypography(panel,[clip],openGroups);
    else panel.append(button('Open Text & Subtitles',()=>switchPage('text')));
  }
  if (clip.kind!=='audio' && (page === 'animation' || page === 'color')) {
    const keys = page === 'color' ? ['brightness', 'contrast', 'saturation'] : Object.keys(properties);
    panel.append(node('h2', '', page === 'color' ? 'Color controls' : 'Keyframes'));
    for (const key of keys) {
      if (clip.asset && (key==='reveal' || (page==='animation' && videoTransformKeys.includes(key)))) continue;
      panel.append(keyControl(clip,key));
    }
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
    addProjectAsset(result.asset);
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

function cleanText(text, limit=900) { return text.replace(/\r\n?/g,'\n').replace(/\t/g,' ').replace(/[^\P{Cc}\n]/gu,'').trim().slice(0,limit); }

function addMixedOption(input) {
  const option = new Option('Mixed','');
  option.disabled = true;
  option.dataset.mixedValue = '';
  input.add(option,0);
}

function commonValue(items, read) {
  const first = read(items[0]);
  return items.every(item=>read(item)===first) ? first : mixed;
}

function choice(label, options, value, update) {
  const input=node('select');
  if (value===mixed) addMixedOption(input);
  for(const [key,name] of options) input.add(new Option(name,key));
  input.value=value===mixed?'':String(value);
  input.onchange=()=>update(input.value);
  return field(label,input);
}

function numberControl(label, value, min, max, step, update) {
  const input=node('input');
  input.type='number'; input.min=min; input.max=max; input.step=step; input.value=value===mixed?'':value;
  if (value===mixed) input.placeholder = 'Mixed';
  input.onchange=()=>{
    if(!Number.isFinite(input.valueAsNumber)){ input.value=value===mixed?'':value; return; }
    update(clamp(input.valueAsNumber,min,max));
  };
  return field(label,input);
}

function colorControl(label, value, update) {
  const input=node('input'); input.type='color'; input.value=value===mixed?'#ffffff':value;
  input.onchange=()=>update(input.value);
  const control = field(label,input);
  if (value!==mixed) return control;
  control.firstElementChild.textContent += ' · Mixed';
  const apply = button('Apply',()=>update(input.value));
  apply.setAttribute('aria-label',`Apply ${label.toLowerCase()} to selection`);
  const pair = node('div','mixed-color-control');
  pair.append(control,apply);
  return pair;
}

function group(label, ...children) {
  const details=node('details','property-group');
  const grid=node('div','property-line');
  grid.append(...children);
  details.append(node('summary','',label),grid);
  return details;
}

function writeBackgroundKey(clip,key) {
  if (!guardTrack(trackOf(clip))) return;
  keyDraft = null;
  if (!key) matteClip = null;
  change(()=>{ if (key) clip.backgroundKey = key; else delete clip.backgroundKey; });
}

function backgroundKeyControls(clip,open) {
  const active = backgroundKey(clip.backgroundKey);
  const key = active || keyPresets.green;
  const presets = node('div','key-options');
  for (const [label,name] of [['Green','green'],['Blue','blue'],['Black','black']]) {
    const control = button(label,()=>writeBackgroundKey(clip,{...keyPresets[name]}));
    control.dataset.keyEdit = '';
    presets.append(control);
  }
  const sample = button('Sample background',()=>beginBackgroundSample(clip));
  sample.dataset.keyEdit = '';
  sample.title = 'Click the background in the Preview canvas';
  const controls = [choice('Key mode',[['off','Off'],['chroma','Chroma key · color'],['luma','Luma key · dark background']],active?.mode || 'off',mode=>{
    writeBackgroundKey(clip,mode==='off'?null:mode==='luma'?{...keyPresets.black}:{...keyPresets.green});
  }),sample,presets];
  if (active) {
    controls.push(colorControl('Sampled background color',key.color,color=>writeBackgroundKey(clip,{...key,color})),
      keySlider('Tolerance','tolerance',key,clip,65),keySlider('Edge softness','softness',key,clip,50));
    if (key.mode==='chroma') controls.push(keySlider('Spill suppression','spill',key,clip,100));
    const show = node('input');
    show.type = 'checkbox';
    show.checked = matteClip===clip.id;
    show.onchange = ()=>{
      matteClip = show.checked ? clip.id : null;
      if (cursor<clip.start || cursor>=clip.start+clip.len) setPosition(clip.start);
      else display(cursor);
    };
    const check = node('label','check-row');
    check.append(show,' Show matte');
    controls.push(check);
  }
  const details = group('Background key',...controls);
  details.classList.add('background-key-controls');
  details.open = open || Boolean(active) || page==='effects' && effectCategory==='Keying';
  return details;
}

function keySlider(label,property,key,clip,max) {
  const slider = node('input');
  slider.type='range'; slider.min=0; slider.max=max; slider.value=Math.round(key[property]*100);
  const control = field(label,slider);
  const amount = node('output','',`${slider.value}%`);
  control.append(amount);
  slider.oninput = ()=>{
    if (!guardTrack(trackOf(clip))) return;
    amount.textContent = `${slider.value}%`;
    keyDraft = { id:clip.id,key:{...key,[property]:Number(slider.value)/100} };
    display(cursor);
  };
  slider.onchange = ()=>writeBackgroundKey(clip,{...key,[property]:Number(slider.value)/100});
  return control;
}

function editTitles(titles, update) {
  if (titles.some(clip=>!guardTrack(trackOf(clip)))) return;
  return change(()=>{ for (const clip of titles) update(clip); });
}

function renderTextListActions(panel,titles) {
  const list = selectedTextList(titles) || (titles.length===1 ? textListsByTitle.get(titles[0].id) : null);
  const locked = titles.some(clip=>protectedTrack(project,trackOf(clip)));
  if (list) {
    const expanded = expandedTextLists.has(list[0].textListId);
    const actions = node('div','inline-actions');
    const edit = button('Edit Text List…',()=>openTextList(list),locked);
    edit.dataset.editTextList = '';
    actions.append(edit,
      button(expanded?'Collapse Text List':'Show individual titles',()=>setTextListExpanded(list,!expanded)));
    panel.append(actions);
  } else {
    const ordered = [...titles].sort((a,b)=>a.start-b.start);
    if (canGroupTitles(ordered)) panel.append(button('Group as Text List…',()=>groupAsTextList(ordered),locked));
  }
}

function renderTitleTiming(panel,titles) {
  const original = titles.map(title=>titleTiming(title) || { holdFrames:title.len });
  const form = node('form','title-timing-form');
  const controls = new Map();
  const changed = new Set();
  for (const [effect,frames,presets,label] of [
    ['entrance','enterFrames',textListEntrances,'Animate in'],['exit','exitFrames',textListExits,'Animate out']
  ]) {
    const select = node('select');
    const known = commonValue(original,value=>value[effect]);
    if (!known || known===mixed) addMixedOption(select);
    for (const [key,[name]] of Object.entries(presets)) select.add(new Option(name,key));
    if (typeof known==='string') select.value = known;
    controls.set(effect,select);
    select.oninput = () => {
      changed.add(effect);
      const input = controls.get(frames);
      input.disabled = select.value==='cut';
      if (!input.disabled && known==='cut' && Number(input.value)===0) input.value = '0.4';
    };
    form.append(field(label,select));
    const input = timingNumber(frames);
    input.disabled = known==='cut';
    form.append(field(effect==='entrance'?'In duration (s)':'Out duration (s)',input));
  }
  form.append(field('Hold duration (s)',timingNumber('holdFrames')));
  const submit = button('Apply timing',()=>{});
  submit.type = 'submit';
  const status = node('output','subtle');
  status.setAttribute('role','status');
  form.append(submit,status);
  form.onsubmit = event=>{
    event.preventDefault();
    if (titles.some(clip=>!guardTrack(trackOf(clip)))) return;
    const edits = Object.fromEntries([...changed].filter(key=>!controls.get(key).disabled).map(key=>{
      const input = controls.get(key);
      return [key,input.tagName==='SELECT' ? input.value : Math.round(input.valueAsNumber*fps)];
    }).filter(([,value])=>typeof value==='string' || Number.isFinite(value)));
    if (!Object.keys(edits).length) return;
    const next = new Map(titles.map(clip=>[clip.id,retimeTitle(clip,edits)]));
    if ([...next.values()].some(clip=>clip.len<1)) { status.textContent = 'Give each title at least one frame.'; return; }
    const affected = new Set(titles.map(trackOf));
    for (const lane of affected) {
      let end = 0, previous;
      for (const clip of sortedTitles().filter(clip=>trackOf(clip)===lane)) {
        const update = next.get(clip.id);
        if (update && previous && next.has(previous.id) && clip.start===previous.start+previous.len) update.start = end;
        const item = update || clip;
        const stop = item.start+item.len;
        if ((item.start<end && (update || next.has(previous?.id))) || (update && stop>(project.fixedFrames || MAX_DURATION))) {
          status.textContent = 'This timing would overlap another title or run past the timeline end.';
          return;
        }
        end = stop;
        previous = clip;
      }
    }
    if (editTitles(titles,clip=>Object.assign(clip,next.get(clip.id)))) notify('Title animation and timing updated');
  };
  const section = node('details','property-group title-timing');
  section.open = true;
  section.append(node('summary','','Animation & timing'),form);
  panel.append(section);

  function timingNumber(key) {
    const input = node('input');
    input.type='number'; input.min=0; input.max=MAX_DURATION/fps; input.step='any';
    const frames = commonValue(original,value=>value[key]);
    if (Number.isFinite(frames)) input.value=frames/fps;
    else input.placeholder='Mixed';
    input.oninput=()=>changed.add(key);
    controls.set(key,input);
    return input;
  }
}

function titleAnchor(clip,axis,type=titleType(clip)) {
  if (axis==='y') return clip.style==='caption'?91:clip.style==='lower'?87:50;
  const {align} = type;
  return align==='left'?7.5:align==='right'?92.5:50;
}

function titleRestPosition(clip,axis) {
  const keys = points(clip,axis);
  const constant = keys.every(([,value])=>value===keys[0][1]) ? keys[0][1] : 0;
  return titleAnchor(clip,axis)+constant;
}

function titlePosition(clip,axis) {
  return Number((titleRestPosition(clip,axis)+titlePositionOffset(clip,axis)).toFixed(4));
}

function offsetForTitlePosition(clip,axis,value) {
  return Number((clamp(value,0,100)-titleRestPosition(clip,axis)).toFixed(4));
}

function setTitlePosition(clip,axis,value) {
  (clip.position ||= {})[axis] = offsetForTitlePosition(clip,axis,value);
}

const alignmentPanel = $('preview-alignment');
const alignmentButtons = [...alignmentPanel.querySelectorAll('[data-align-x],[data-align-y]')];
const marginInputs = {x:$('preview-margin-x'),y:$('preview-margin-y')};
const showMargins = $('preview-show-margins');
const marginsGuide = $('preview-margins');

function canvasMargins() {
  return { x:5,y:5,visible:false,...project.canvasMargins };
}

function refreshCanvasAlignment() {
  const titles = selectedTitles();
  const disabled = !titles.length || titles.some(clip=>protectedTrack(project,trackOf(clip)));
  for (const control of alignmentButtons) control.disabled = disabled;
  const margins = canvasMargins();
  for (const axis of ['x','y']) {
    marginInputs[axis].value = margins[axis];
    marginsGuide.style.setProperty(`--margin-${axis}`,`${margins[axis]}%`);
  }
  showMargins.checked = margins.visible;
  marginsGuide.hidden = !margins.visible;
}

for (const axis of ['x','y']) marginInputs[axis].onchange = () => {
  const value = marginInputs[axis].valueAsNumber;
  if (Number.isFinite(value)) {
    project.canvasMargins = { ...canvasMargins(), [axis]:clamp(value,0,45), visible:true };
    persist();
  }
  refreshCanvasAlignment();
};
showMargins.onchange = () => {
  project.canvasMargins = { ...canvasMargins(), visible:showMargins.checked };
  persist();
  refreshCanvasAlignment();
};
for (const control of alignmentButtons) control.onclick = () => {
  const titles = selectedTitles();
  if (!titles.length) return;
  const { x, y } = canvasMargins();
  const { alignX,alignY } = control.dataset;
  if (alignX) editTitles(titles,clip=>{
    (clip.type ||= {}).align = alignX;
    setTitlePosition(clip,'x',{left:x,center:50,right:100-x}[alignX]);
  });
  else editTitles(titles,clip=>{
    clip.verticalAlign = alignY;
    setTitlePosition(clip,'y',{top:y,middle:50,bottom:100-y}[alignY]);
  });
};
document.addEventListener('pointerdown',event=>{
  if (alignmentPanel.open && !alignmentPanel.contains(event.target)) alignmentPanel.open = false;
});

function renderTitlePosition(panel,titles) {
  const coordinate = (axis,label) => numberControl(label,commonValue(titles,clip=>titlePosition(clip,axis)),
    0,100,'any',value=>editTitles(titles,clip=>setTitlePosition(clip,axis,value)));
  const position = group('Text position',coordinate('x','Horizontal position (%)'),coordinate('y','Vertical position (%)'));
  position.open = true;
  const grid = position.lastElementChild;
  if (titles.every(clip=>clip.style!=='caption')) {
    grid.prepend(choice('Position',[['center','Centered'],['lower','Lower third']],commonValue(titles,clip=>clip.style),
      value=>editTitles(titles,clip=>{ clip.style=value; })));
  }
  const place = button('Position in preview',()=>beginTitlePosition(titles));
  place.dataset.positionInPreview = '';
  place.setAttribute('aria-pressed',String(positioningTitles));
  const moves = node('div','title-nudges');
  moves.setAttribute('role','group');
  moves.setAttribute('aria-label','Nudge text position');
  for (const [label,arrow,axis,amount] of [
    ['Move text left','←','x',-1],['Move text up','↑','y',-1],['Move text down','↓','y',1],['Move text right','→','x',1]
  ]) {
    const move = button(arrow,()=>editTitles(titles,clip=>setTitlePosition(clip,axis,titlePosition(clip,axis)+amount)));
    move.dataset.titleNudge = '';
    move.title = label;
    move.setAttribute('aria-label',label);
    moves.append(move);
  }
  grid.append(place,moves);
  panel.append(position);
}

function renderTypography(panel,titles,openGroups) {
  const styles = titles.map(titleType);
  const read = key=>commonValue(styles,style=>style[key]);
  const apply = update=>editTitles(titles,clip=>update(clip.type ||= {},titleType(clip)));
  const set = (key,value)=>apply(type=>{ type[key]=value; });
  const n=(key,label,min,max,step=1)=>numberControl(label,read(key),min,max,step,value=>set(key,value));
  const c=(key,label)=>colorControl(label,read(key),value=>set(key,value));
  const menu = inspectorFont;
  fillFontMenu(menu,read('family'));
  menu.onchange = () => {
    const focused = document.activeElement===menu;
    set('family',menu.value);
    if (focused && menu.isConnected) menu.focus({preventScroll:true});
  };
  const font=group('Typography',
    field('Font',menu),
    choice('Weight & style',[[0,'Regular'],[1,'Bold'],[2,'Italic'],[3,'Bold italic']],read('weight'),v=>set('weight',Number(v))),
    n('size','Size (% of frame)',1.5,20,.1),n('leading','Line height',.8,2.6,.05),
    choice('Alignment',[['left','Left'],['center','Center'],['right','Right']],read('align'),v=>set('align',v)),
    n('tracking','Letter spacing',0,3),choice('Letter case',[['normal','As written'],['upper','Uppercase'],['lower','Lowercase']],read('case'),v=>set('case',v)));
  font.open=true;
  const materials = node('select');
  const material = commonValue(styles,type=>type.material || (type.gradient?'custom':'solid'));
  fillMaterialMenu(materials,material);
  materials.onchange = () => {
    const preset = titleMaterials[materials.value];
    apply((raw,type)=>{
      if (preset) Object.assign(raw,{material:materials.value,gradient:{stops:preset.stops,angle:preset.angle},depthColor:preset.side});
      else Object.assign(raw,{material:null,gradient:materials.value==='solid'?null:type.gradient || {stops:customGradientStops,angle:180}});
    });
  };
  const colors = [field('Face material',materials)];
  if (styles.every(type=>!type.gradient)) colors.push(c('fill','Text color'));
  else if (styles.every(type=>type.gradient)) {
    colors.push(numberControl('Gradient angle (°)',commonValue(styles,type=>type.gradient.angle),0,360,1,
      angle=>apply((raw,type)=>{ raw.gradient={...type.gradient,angle}; })));
    const stops = styles[0].gradient.stops;
    if (material==='custom' && styles.every(type=>type.gradient.stops.length===stops.length &&
      type.gradient.stops.every(([at],index)=>at===stops[index][0]))) {
      for (const [index,[at]] of stops.entries()) {
        colors.push(colorControl(`Color stop ${index+1}`,commonValue(styles,type=>type.gradient.stops[index][1]),
          value=>apply((raw,type)=>{ raw.gradient={...type.gradient,stops:type.gradient.stops.map((stop,i)=>i===index?[at,value]:stop)}; })));
      }
    }
  }
  panel.append(font,group('Color & materials',...colors),
    group('Background & outline',c('background','Background color'),n('boxOpacity','Background opacity (%)',0,100),
      n('padding','Background padding',0,60),c('outlineColor','Outline color'),n('outline','Outline width',0,18)),
    group('Soft shadow & depth',n('shadow','Shadow opacity (%)',0,100),n('blur','Shadow blur',0,48),
      n('shadowX','Shadow offset X',-60,60),n('shadowY','Shadow offset Y',-60,60),
      n('depth','Extrusion depth (px)',0,maxExtrusionDepth),n('depthAngle','Extrusion angle (°)',0,360),c('depthColor','Extrusion color')));
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
    const result=await jsonPost('/api/transcribe',{ ...await resolveCompositionClips(snapshot),language:speechLanguage });
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
  selectTrack(trackOf(clip));
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
    if(!asset){ asset=await jsonPost('/api/sound',settings); if(settings.preset) asset.preset=settings.preset; }
    addProjectAsset(asset);
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
  for(const item of projectMedia()) if(item.kind==='audio') picker.add(new Option(item.name,item.id));
  const add=button('Add audio to timeline',()=>{ const asset=projectAsset(picker.value); if(asset) insertSound(asset); },true);
  picker.onchange=()=>{add.disabled=!picker.value;};
  tools.append(picker,add,designer,node('h2','','Sound library'),library);
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
  for(let index=0; index<=project.layers; index++) strips.push(audioStrip(`video:${index}`,trackSettings(project,`video:${index}`).name || `Video ${index+1}`));
  for(let index=1; index<=Math.max(3,project.audioLayers); index++) strips.push(audioStrip(`audio:${index}`,trackSettings(project,`audio:${index}`).name || `Audio ${index}`));
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

const videoTransformKeys = ['scale','rotation','x','y','opacity'];

function hasTransformEdits(clip) {
  return hasVideoFraming(clip) || videoTransformKeys.some(key=>clip.motion?.[key]?.length);
}

function writeMotionValue(clip, key, value, keyframe, framing = false) {
  if (!Number.isFinite(value)) return;
  const [,min,max] = properties[key];
  const time = keyframe ? clamp(cursor-clipStart(clip),0,clip.len-1) : 0;
  change(() => {
    if (framing && key!=='opacity') clip.fit = videoFit(clip);
    clip.motion ||= {};
    const previous = (clip.motion[key] || []).filter(([frame])=>frame!==time);
    clip.motion[key] = [...previous,[time,clamp(value,min,max)]].sort((a,b)=>a[0]-b[0]);
  });
}

function videoTransformControls(clip, open) {
  const details = node('details','property-group video-transform');
  const controls = node('div','property-line');
  details.open = open;
  const fit = choice('Video fit',Object.entries(videoFitModes),videoFit(clip),value=>change(()=>{
    clip.fit = value;
  }));
  fit.classList.add('transform-wide');
  const motionField = key => {
    if (page==='animation') {
      const control = keyControl(clip,key,true);
      control.classList.add('transform-wide');
      return control;
    }
    const [label,min,max] = properties[key];
    const local = clamp(cursor-clipStart(clip),0,clip.len-1);
    const control = numberControl(label,Math.round(valueAt(clip,key,local)*10)/10,min,max,'any',value=>{
      writeMotionValue(clip,key,value,points(clip,key).length>1,true);
    });
    control.querySelector('input').dataset.transformKey = key;
    return control;
  };
  const stretch = (key,label) => numberControl(label,videoStretch(clip[key]),5,300,'any',value=>change(()=>{
    clip[key] = value;
  }));
  controls.append(fit,motionField('scale'),motionField('rotation'),
    stretch('stretchWidth','Stretch width (%)'),stretch('stretchHeight','Stretch height (%)'),
    ...videoTransformKeys.slice(2).map(motionField));
  const reset = button('Reset transform',()=>change(()=>{
    delete clip.fit;
    delete clip.stretchWidth;
    delete clip.stretchHeight;
    for (const key of videoTransformKeys) if (clip.motion) delete clip.motion[key];
  }),protectedTrack(project,trackOf(clip)) || !hasTransformEdits(clip));
  reset.classList.add('transform-wide');
  reset.dataset.transformReset = '';
  controls.append(reset);
  details.append(node('summary','', 'Transform'),controls);
  return details;
}

function keyControl(clip, key, framing = false) {
  const [label, min, max] = properties[key];
  const at = clamp(cursor - clipStart(clip), 0, clip.len - 1);
  const checkbox = node('div', 'key-control');
  const input = node('input');
  input.type = 'number';
  input.min = min; input.max = max; input.step = 'any';
  input.value = Math.round(valueAt(clip, key, at) * 10) / 10;
  input.dataset.key = key;
  const has = frame => clip.motion?.[key]?.some(([time]) => time === frame);
  input.onchange = () => writeMotionValue(clip,key,input.valueAsNumber,page==='animation' || points(clip,key).length>1,framing);
  const add = button('◆', () => writeMotionValue(clip,key,input.valueAsNumber,true,framing));
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
  if (!clip || clip.kind==='audio') return;
  const frame = clamp(cursor - clipStart(clip), 0, clip.len - 1);
  for (const input of $('inspector').querySelectorAll('[data-transform-key]')) {
    if (document.activeElement!==input) input.value = Math.round(valueAt(clip,input.dataset.transformKey,frame)*10)/10;
  }
  if (page!=='animation' && page!=='color') return;
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
    if (name === 'Typewriter') {
      delete clip.motion.reveal;
      clip.typewriter = true;
    }
  });
  notify(`Applied ${name}`);
}

async function jsonPost(url, payload) {
  pendingEdits++;
  try { return await api(url, { method:'POST', headers:{ 'X-Framecut':'1', 'Content-Type':'application/json' }, body:JSON.stringify(payload) }); }
  finally { pendingEdits--; }
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
  const shots = [...project.clips,...project.overlays].filter(item => !isLiveComposition(item) && bin.has(item.asset) && !bin.get(item.asset).alpha && item.id !== target.id);
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
    for (const item of projectMedia()) if(item.kind!=='audio') asset.add(new Option(item.name,item.id));
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
    tools.append(button('Text List…',()=>openTextList(),Boolean(project.timelineLocked)),
      button('Add text',()=>addTitle()),button('Add caption',()=>addTitle(undefined,true)),
      button('Select all text clips',selectAllTitles,!project.titles.length),
      button('Save SRT',()=>void saveSubtitles(),!project.titles.some(item=>item.style==='caption')),
      language,button(transcribing?'Transcribing…':'Auto-detect subtitles',()=>void autoCaptions(),!transcriptionAvailable || transcribing || !duration));
    if(!transcriptionAvailable) tools.append(node('p','subtle','The offline speech model is unavailable in this build.'));
    tools.append(node('h2','','Academic templates'),cards,animation);
  } else if (page === 'sound') {
    renderSoundTools(tools);
  } else if (page === 'effects') {
    const categories = node('select', 'tool-select');
    for (const category of ['Motion','Transitions','Filters','3D & particles','Keying','Video tools']) categories.add(new Option(category));
    categories.value = effectCategory;
    categories.onchange = () => { effectCategory = categories.value; if (effectCategory !== 'Video tools') cancelPicking(); renderTools(); renderInspector(); refreshTrackControls(); };
    tools.append(categories);
    if (effectCategory==='Keying') {
      tools.append(node('p','subtle','Select the foreground clip. Use Background key in the Inspector to pick the screen color.'));
      return;
    }
    if (effectCategory === 'Video tools') {
      tools.append(button('Upscale selected footage', () => void upscale(clip), !clip?.asset || Boolean(clip.composition)),
        node('p', 'subtle', 'Upscale creates a new clip using Lanczos scaling.'),
        node('h2','','Motion tracking'),
        button('Draw region in preview', () => beginPicking(clip), !clip?.asset || Boolean(clip.track || clip.composition)),
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
    for (const key of entry?.lutIds || []) {
      const lut = lutLibrary.get(key);
      if (lut) select.add(new Option(lut.name,lut.id));
    }
    select.value = clip?.lut || '';
    select.disabled = !clip?.asset || Boolean(clip.composition);
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
    tools.append(node('h2','','Camera LUT'), select, links,
      node('p','subtle','Choose the LUT for your camera and recording profile. Unzip DJI downloads before importing.'),
      button('Auto grade', () => void grade(clip, false), !clip?.asset || Boolean(clip.composition)),
      button('Use shot as reference', () => void grade(clip, 'reference'), !clip?.asset || Boolean(clip.composition)),
      button('Match reference', () => void grade(clip, true), !clip?.asset || Boolean(clip.composition) || !project.gradeReference),
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
    addProjectAsset(asset);
    renderBin();
    const last = project.overlays.filter(clip => clip.track === project.layers);
    const track = last.some(clip => start < clip.start + clip.len && start + asset.frames > clip.start) ? Math.min(8,project.layers+1) : project.layers || 1;
    insertOverlay(asset.id,track,start,true);
    notify(`Added ${asset.name}`);
  } catch (error) { notify(error.message); }
  finally { importing = false; }
}

function fittedMediaSize(clip, el, sequence=project) {
  const asset = bin.get(clip.asset);
  const ratio = el.readyState && el.videoWidth && el.videoHeight ? el.videoWidth/el.videoHeight :
    (asset?.width || 1920)/(asset?.height || 1080);
  const [width,height] = sequenceSize(sequence);
  const [w,h] = fittedVideoSize(videoFit(clip),ratio,width,height);
  return { w:w/width*videoStretch(clip.stretchWidth)/100,
    h:h/height*videoStretch(clip.stretchHeight)/100, aspect:width/height };
}

function trackingPoint(area, x, y, inverse = false) {
  const angle = area.angle*Math.PI/180*(inverse?-1:1);
  const dx = inverse ? x-area.cx : (x-.5)*area.w;
  const dy = inverse ? y-area.cy : (y-.5)*area.h;
  const u = dx*Math.cos(angle)-dy*Math.sin(angle)/area.aspect;
  const v = dx*Math.sin(angle)*area.aspect+dy*Math.cos(angle);
  return inverse ? [u/area.w+.5,v/area.h+.5] : [u+area.cx,v+area.cy];
}

function showTrackingBox(box) {
  const overlay = $('tracking-box');
  overlay.hidden = !box;
  if (!box) return;
  const area = trackingArea;
  const [x,y] = trackingPoint(area,box.x+box.w/2,box.y+box.h/2);
  overlay.style.left = `${(x-box.w*area.w/2)*100}%`;
  overlay.style.top = `${(y-box.h*area.h/2)*100}%`;
  overlay.style.width = `${box.w*area.w*100}%`;
  overlay.style.height = `${box.h*area.h*100}%`;
  overlay.style.transform = `rotate(${area.angle}deg)`;
}

function cancelPicking() {
  picking = false;
  $('stage').classList.remove('track-picking');
  showTrackingBox(null);
}

function beginPicking(clip) {
  if (!clip?.asset || clip.track) return;
  stopBackgroundSample();
  stopTitlePosition();
  setPosition(clipStart(clip));
  trackingSource = clip.id;
  trackingBox = null;
  picking = true;
  $('stage').classList.add('track-picking');
  notify('Drag a box around a textured region in the preview');
}

function previewPoint(event,rect) {
  return { x:(event.clientX-rect.left)/rect.width*100, y:(event.clientY-rect.top)/rect.height*100 };
}

function stopBackgroundSample() {
  if (!samplingKey) return;
  samplingKey = null;
  $('stage').classList.remove('sampling-background');
  display(cursor);
}

function beginBackgroundSample(clip) {
  if (!guardTrack(trackOf(clip))) return;
  if (samplingKey===clip.id) { stopBackgroundSample(); return; }
  stopTextPlacement();
  cancelPicking();
  samplingKey = clip.id;
  $('stage').classList.add('sampling-background');
  if (cursor<clip.start || cursor>=clip.start+clip.len) { setPosition(clip.start); revealCursor(); }
  else { pause(); display(cursor); }
  notify('Click a clean area of the background in Preview.');
}

function pickBackground(event) {
  const clip = selection();
  const video = clip?.track ? overlayPlayers.get(clip.id) : activeClip?.id===clip?.id ? active : null;
  if (clip?.id!==samplingKey || !video || video.readyState<2 || video.seeking) return notify('Wait for the selected frame to load.');
  const rect = $('stage').getBoundingClientRect();
  const local = cursor-clip.start;
  const {w,h,aspect} = fittedMediaSize(clip,video);
  const scale = valueAt(clip,'scale',local)/100;
  const area = {w:w*scale,h:h*scale,aspect,angle:valueAt(clip,'rotation',local),
    cx:.5+valueAt(clip,'x',local)/100,cy:.5+valueAt(clip,'y',local)/100};
  const [u,v] = trackingPoint(area,(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height,true);
  if (u<0 || u>1 || v<0 || v>1) return notify('Click inside the selected clip in Preview.');
  try {
    const key = sampledKey(readColorSample(video,u,v),backgroundKey(clip.backgroundKey));
    stopBackgroundSample();
    writeBackgroundKey(clip,key);
    notify(`Background sampled · ${key.color}`);
  } catch { notify('Could not read this preview frame. Try another frame.'); }
}

function stopTitlePosition() {
  positioningTitles=false;
  $('stage').classList.remove('positioning-titles');
  $('inspector').querySelector('[data-position-in-preview]')?.setAttribute('aria-pressed','false');
}

function beginTitlePosition(titles) {
  if (positioningTitles) { stopTitlePosition(); return; }
  if (titles.some(clip=>!guardTrack(trackOf(clip)))) return;
  stopTextPlacement();
  cancelPicking();
  pause();
  if (!titles.some(clip=>clip.start<=cursor && cursor<clip.start+clip.len)) {
    setPosition(Math.min(...titles.map(clip=>clip.start)));
    revealCursor();
  }
  positioningTitles=true;
  $('stage').classList.add('positioning-titles');
  $('inspector').querySelector('[data-position-in-preview]')?.setAttribute('aria-pressed','true');
  notify('Click where you want the selected text on the preview');
}

function startTitleDrag(event,title,stage) {
  event.preventDefault();
  pause();
  if (!isSelected(title.id) || event.ctrlKey || event.metaKey) select(title.id,{toggle:event.ctrlKey || event.metaKey});
  if (!isSelected(title.id)) return;
  const titles = selectedTitles();
  if (titles.some(clip=>protectedTrack(project,trackOf(clip)))) return;
  const rect = stage.getBoundingClientRect();
  const initial = previewPoint(event,rect);
  const start = new Map(titles.map(clip=>[clip.id,{x:titlePosition(clip,'x'),y:titlePosition(clip,'y')} ]));
  const visible = [...$('preview-titles').querySelectorAll('[data-preview-title]')]
    .map(label=>({label,clip:titles.find(clip=>clip.id===label.dataset.previewTitle)})).filter(item=>item.clip);
  const listeners = new AbortController();
  const options = {signal:listeners.signal};
  let moved = false;
  let delta;
  const update = move=>{
    if (move.pointerId!==event.pointerId) return;
    if (!moved && Math.hypot(move.clientX-event.clientX,move.clientY-event.clientY)<3) return;
    moved=true;
    const point = previewPoint(move,rect);
    delta = {x:point.x-initial.x,y:point.y-initial.y};
    for (const {label,clip} of visible) {
      const at = start.get(clip.id);
      const position = {x:offsetForTitlePosition(clip,'x',at.x+delta.x),y:offsetForTitlePosition(clip,'y',at.y+delta.y)};
      styleMotion(label.parentElement,{...clip,position},cursor-clip.start);
    }
  };
  const finish = cancelled=>{
    listeners.abort();
    cancelTitleDrag = null;
    stage.classList.remove('dragging-title');
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (!cancelled && moved) editTitles(titles,clip=>{
      const at = start.get(clip.id);
      setTitlePosition(clip,'x',at.x+delta.x);
      setTitlePosition(clip,'y',at.y+delta.y);
    });
    else if (moved) display(cursor);
  };
  cancelTitleDrag = ()=>finish(true);
  stage.setPointerCapture(event.pointerId);
  stage.classList.add('dragging-title');
  stage.addEventListener('pointermove',update,options);
  stage.addEventListener('pointerup',end=>{
    if (end.pointerId!==event.pointerId) return;
    update(end);
    finish(false);
  },options);
  stage.addEventListener('lostpointercapture',end=>{ if (end.pointerId===event.pointerId) finish(true); },options);
}

$('stage').onpointerdown = event => {
  if (event.button!==0 || cancelTitleDrag) return;
  const stage = $('stage');
  if (samplingKey) { event.preventDefault(); pickBackground(event); return; }
  if (placingText) {
    const {x,y} = previewPoint(event,stage.getBoundingClientRect());
    stopTextPlacement();
    addTitle({position:{x:clamp(x,0,100)-50,y:clamp(y,0,100)-50}},false,true);
    return;
  }
  if (positioningTitles) {
    const {x,y} = previewPoint(event,stage.getBoundingClientRect());
    const titles = selectedTitles();
    stopTitlePosition();
    editTitles(titles,clip=>{ setTitlePosition(clip,'x',x); setTitlePosition(clip,'y',y); });
    return;
  }
  const title = dropTitleTarget(event);
  if (!picking && title) return startTitleDrag(event,title,stage);
  const clip = selection();
  if (!picking || !clip || clip.id !== trackingSource) return;
  const rect = stage.getBoundingClientRect();
  const offset = clamp(cursor-clipStart(clip),0,clip.len-1);
  const { w,h,aspect } = fittedMediaSize(clip,active);
  const scale = valueAt(clip,'scale',offset)/100;
  trackingArea = { w:w*scale,h:h*scale,aspect,angle:valueAt(clip,'rotation',offset),
    cx:.5+valueAt(clip,'x',offset)/100,cy:.5+valueAt(clip,'y',offset)/100 };
  const at = event => trackingPoint(trackingArea,(event.clientX-rect.left)/rect.width,
    (event.clientY-rect.top)/rect.height,true).map(value=>clamp(value,0,1));
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
  stopBackgroundSample();
  stopTitlePosition();
  cancelTitleDrag?.();
  placingText=false;
  $('stage').classList.remove('placing-text');
  $('place-text').setAttribute('aria-pressed','false');
}

$('place-text').onclick=()=>{
  if(placingText){stopTextPlacement();return;}
  stopTitlePosition();
  cancelPicking();
  pause();
  placingText=true;
  $('stage').classList.add('placing-text');
  $('place-text').setAttribute('aria-pressed','true');
  notify('Click the preview where you want to place text');
};

function dropTitleTarget(event) {
  const title=event.target.closest('#preview-titles [data-preview-title]')?.dataset.previewTitle;
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
  const start = clipStart(source);
  if (!samples.length || layerItems(item).some(peer => peer.id !== id && peer.start < start+duration && peer.start+peer.len > start)) return notify('Choose a free layer to place the tracking result.');
  change(() => {
    item.start = start;
    item.len = duration;
    item.motion ||= {};
    const positions = samples.map(([at,x,y])=>[at,...trackingPoint(tracked.area,x,y)]);
    item.motion.x = positions.map(([at,x])=>[at,(x-.5)*100]);
    item.motion.y = positions.map(([at,,y])=>[at,(y-.5)*100]);
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
    addProjectAsset(asset);
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
    addProjectAsset(asset);
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
  if (hasRange()) {
    const range = exportRange(project,duration);
    const marker = node('span','range-highlight');
    marker.style.left = `${pixels(range.start)}px`;
    marker.style.width = `${Math.max(2,pixels(range.frames))}px`;
    ticks.prepend(marker);
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

function makeClip(clip, video, textList) {
  const audio=clip.kind==='audio';
  const asset = (video || audio) && bin.get(clip.asset);
  const label = textList ? `Text List · ${textList.length} ${textList.length===1?'title':'titles'}` :
    audio ? asset?.name || 'Missing audio' : video ? asset?.name || 'Missing video' : clip.text;
  const block = node('div', `clip ${audio ? 'audio-clip' : video ? 'video-clip' : 'title-clip'}`);
  if (clip.composition) block.classList.add('composition-clip');
  if(clip.style==='caption') block.classList.add('caption-clip');
  block.classList.toggle('selected', isSelected(clip.id));
  block.dataset.id = clip.id;
  if (textList) {
    block.textListTitles = textList;
    block.classList.add('text-list-clip');
    block.ondblclick = ()=>openTextList(textList);
  }
  block.tabIndex = 0;
  block.setAttribute('role', 'button');
  block.setAttribute('aria-pressed',String(isSelected(clip.id)));
  block.setAttribute('aria-label', `${label}, ${timecode(clip.start)}`);
  block.title = textList ? `${label} · Double-click to edit` : `${label} · ${timecode(clip.len)}`;
  block.style.left = `calc(${clip.start} * var(--frame-width))`;
  block.style.width = `max(2px, calc(${clip.len} * var(--frame-width) - 1px))`;
  block.dataset.frames = clip.len;
  block.classList.toggle('narrow-clip', pixels(clip.len) < 18);
  if (asset && video && !asset.composition) {
    const film = node('div', 'clip-film');
    film.style.backgroundImage = `url("${diskURL(asset.id, 'thumb.jpg')}")`;
    block.append(film);
  }
  block.append(node('span', 'clip-label', label));
  for (const side of textList?.length>1 ? [] : ['left', 'right']) {
    const handle = node('span', `trim ${side}`);
    handle.dataset.trim = side;
    handle.title = `Trim ${side === 'left' ? 'start' : 'end'}`;
    block.append(handle);
  }
  block.addEventListener('focus', () => select(clip.id,{preserve:true}));
  block.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      if (textList) openTextList(textList);
      else setPosition(clip.start);
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
  text = trackSettings(project,key).name || text;
  row.dataset.trackKey=key;
  const name=button(text,()=>{
    select(null);
    selectTrack(key);
  });
  name.className='track-select';
  name.dataset.trackKey=key;
  name.setAttribute('aria-label',`Select ${text}`);
  name.title = text+' · Double-click to rename';
  const rename = () => timelineAction({
    title:'Rename layer',label:'Layer name',value:text,submit:'Rename',
    apply(value) {
      const name = value.trim().slice(0,60);
      if (!name) return false;
      saveMix(key,{name});
      renderTimeline();
      return true;
    }
  });
  name.ondblclick = rename;
  row.oncontextmenu = event => {
    event.preventDefault();
    const menu = $('timeline-menu');
    const item = button('Rename layer',()=>{ hideTimelineMenu(); rename(); });
    item.setAttribute('role','menuitem');
    menu.replaceChildren(item);
    showTimelineMenu(event);
  };
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
    if (target.dataset.trackLock) target.textContent = active ? '🔒' : '🔓';
  }
  for(const lane of space.querySelectorAll('[data-type][data-layer]')){
    const key=`${lane.dataset.type}:${lane.dataset.layer}`;
    lane.dataset.trackKey=key;
    const settings=trackSettings(project,key);
    lane.classList.toggle('locked-track',Boolean(settings.locked));
    lane.classList.toggle('muted-track',Boolean(settings.muted));
  }
  selectTrack(selectedTrack);
  refreshCanvasAlignment();
  const clip = selection();
  const isProtected = clip && protectedTrack(project,trackOf(clip));
  const batch = $('inspector').querySelector('[data-title-batch]');
  if (batch) {
    const locked = selectedTitles().some(title=>protectedTrack(project,trackOf(title)));
    batch.disabled = locked;
    $('inspector').querySelector('[data-title-batch-lock]').hidden = !locked;
    if (locked) stopTitlePosition();
    return;
  }
  for(const control of $('inspector').querySelectorAll('input,select,textarea')){
    if(isProtected && !control.disabled){
      control.disabled=true;
      control.dataset.trackProtected='yes';
    } else if(control.dataset.trackProtected && !isProtected){
      control.disabled=false;
      delete control.dataset.trackProtected;
    }
  }
  const reset = $('inspector').querySelector('[data-transform-reset]');
  if (reset && clip) reset.disabled = isProtected || !hasTransformEdits(clip);
  for (const control of $('inspector').querySelectorAll('[data-title-nudge],[data-position-in-preview]')) control.disabled = Boolean(isProtected);
  const applyTiming = $('inspector').querySelector('.title-timing button');
  if (applyTiming) applyTiming.disabled = Boolean(isProtected);
  const editList = $('inspector').querySelector('[data-edit-text-list]');
  if (editList) editList.disabled = Boolean(isProtected);
  for (const control of $('inspector').querySelectorAll('[data-key-edit]')) control.disabled = Boolean(isProtected);
  if (isProtected) stopBackgroundSample();
  if (isProtected) stopTitlePosition();
}

function renderKeyLanes() {
  for (const label of $('track-labels').querySelectorAll('.track-key')) label.remove();
  $('key-lanes').replaceChildren();
  const clip = selection();
  if (!clip || page !== 'animation' || selectedGroup.size && selectedTitles().length>1) return;
  for (const key of Object.keys(properties)) {
    if (clip.asset && key==='reveal') continue;
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
  textListsByTitle.clear();
  captionOrder=titles.filter(title=>title.style==='caption');
  duration = sequenceDuration(project,contentDuration(project));
  if (selectedGroup.size) {
    const keys = new Set(clipsIn(project).map(clip=>clip.id));
    selectedGroup = new Set([...selectedGroup].filter(key=>keys.has(key)));
  }
  if (!selection()) {
    selected = [...selectedGroup].at(-1) ?? null;
    selectedGroup.delete(selected);
  }
  $('project').value = project.name;
  $('aspect').value = project.width ? 'custom' : project.aspect;
  $('export-format').value = project.format;
  $('export-transparent').checked = Boolean(project.transparent);
  $('export-quality').value = project.quality;
  const [width, height] = sequenceSize(project);
  $('stage').style.setProperty('--ratio', width / height);
  $('preview-format').textContent = `${width} × ${height} / ${fps} fps`;
  updateRangeUI();
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
    const members = titles.filter(clip=>(clip.track || 1)===number);
    for (let i=0;i<members.length;) {
      const first = members[i++];
      if (!first.textListId) { lane.append(makeClip(first,false)); continue; }
      const list = [first];
      while (members[i]?.textListId===first.textListId && members[i].start===list.at(-1).start+list.at(-1).len) list.push(members[i++]);
      for (const member of list) textListsByTitle.set(member.id,list);
      if (expandedTextLists.has(first.textListId)) lane.append(...list.map(clip=>makeClip(clip,false)));
      else lane.append(makeClip({...first,len:list.at(-1).start+list.at(-1).len-first.start},false,list));
    }
    $('title-track').append(lane);
  }
  for (let number = project.layers; number >= 1; number--) {
    labels.append(addTrackLabel(`Video ${number + 1}`,'video',number,'track-video'));
    const lane = node('div', 'lane videos overlay-lane');
    lane.dataset.layer = number;
    lane.dataset.type = 'video';
    lane.append(...project.overlays.filter(clip => clip.track === number).map(clip => makeClip(clip, true)));
    lane.ondragover = event => {
      if (!hasAsset(event) && !hasComposition(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    lane.ondrop = event => {
      if (hasComposition(event)) {
        event.preventDefault();
        void placeComposition(event.dataTransfer.getData(compositionType), frameAt(event.clientX),number);
        return;
      }
      if (!hasAsset(event)) return;
      event.preventDefault();
      const asset = projectAsset(event.dataTransfer.getData(mediaDragType));
      if (asset && !removedAsset(asset.id)) insertOverlay(asset.id,number,assetDropFrame(event,asset));
    };
    $('overlay-tracks').append(lane);
  }
  labels.append(addTrackLabel('Video 1','video',0,'track-video'));
  $('video-track').dataset.type='video';
  $('video-track').dataset.layer=0;
  $('video-track').replaceChildren(...timeline.map(clip => makeClip(clip, true)));
  if (!timeline.length) $('video-track').append(node('span', 'lane-hint', 'Drag video here from the Footage tray'));
  $('audio-track-add').hidden=page!=='sound';
  $('audio-tracks').replaceChildren();
  for(let number=1;number<=Math.max(page==='sound'?3:0,project.audioLayers);number++) {
    labels.append(addTrackLabel(`Audio ${number}`,'audio',number,'track-audio'));
    const lane=node('div','lane audio-lane');
    lane.dataset.type='audio'; lane.dataset.layer=number;
    lane.setAttribute('aria-label',`Audio ${number}`);
    lane.append(...project.sounds.filter(clip=>clip.track===number).map(clip=>makeClip(clip,false)));
    lane.ondragover=event=>{
      if (hasImportedAudio(event) || Array.from(event.dataTransfer.types).includes('application/x-framecut-sound')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    };
    lane.ondrop=event=>{
      if (hasImportedAudio(event)) return dropImportedAudio(event,number);
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
  $('delete').disabled = !selection() || selectedClips().some(item=>protectedTrack(project,trackOf(item)));
  $('undo').disabled = !undo.length || Boolean(project.timelineLocked);
  $('redo').disabled = !redo.length || Boolean(project.timelineLocked);
  $('track-add').disabled = Boolean(project.timelineLocked);
  $('audio-track-add').disabled = Boolean(project.timelineLocked);
  $('title-add').disabled = Boolean(project.timelineLocked);
}

function hasRange() {
  return (Number.isInteger(project.markIn) && project.markIn < duration) ||
    (Number.isInteger(project.markOut) && project.markOut < duration);
}

function setMark(key) {
  if (!duration) return;
  change(()=>{
    project[key] = cursor;
    if (project.markIn > project.markOut && Number.isInteger(project.markOut)) {
      project[key==='markIn'?'markOut':'markIn'] = null;
    }
  });
  notify(`${key==='markIn'?'In':'Out'} set at ${timecode(cursor)}`);
}

function updateRangeUI() {
  const marked = hasRange();
  $('mark-in').disabled = !duration;
  $('mark-out').disabled = !duration;
  $('clear-range').hidden = !marked;
  $('export-use-range').disabled = !marked;
  const range = exportRange(project,duration);
  $('timeline-range').textContent = marked ?
    `${timecode(range.start)} – ${timecode(range.end-1)}` : project.fixedFrames ? `Fixed · ${timecode(duration)}` : '';
  updateExportSummary();
}

function updateExportSummary() {
  const choice = $('resolution').value;
  const dimensions = choice==='canvas' ? sequenceSize(project) : canvasSize(choice,project.aspect);
  const range = $('export-use-range').checked ? exportRange(project,duration).frames : duration;
  const webm = $('export-format').value==='webm';
  $('export-transparency-field').hidden = !webm;
  $('export-summary').textContent = `${dimensions.join(' × ')} · ${fps} fps · ${timecode(range)} · Stereo${webm && $('export-transparent').checked?' · Transparent':''}`;
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
    if (el===active && activeClip) styleVideoMotion(el,activeClip,cursor-activeClip.start);
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
    clearVideoKey(active);
    activeClip = null;
    active.hidden = true;
    return;
  }
  let spare = players.find(el => el !== active);
  if (activeClip?.id !== item.id) {
    active.pause();
    if (spare.dataset.asset === item.asset && (active.dataset.asset !== item.asset || activeClip)) {
      clearVideoKey(active);
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
  if (next && !isLiveComposition(next) && bin.has(next.asset) &&
      (spare.dataset.asset !== next.asset || spare.preloadClip !== next.id)) {
    spare.preloadClip = next.id;
    setSource(spare, next, next.start);
  }
}

function display(frame, seek = false) {
  const item = timeline.find(item => frame >= item.start && frame < item.start + item.len);
  const linked = isLiveComposition(item);
  showVideo(linked ? null : item, frame, seek);
  if (item && !linked) { styleVideoMotion(active, item, frame - item.start); setAudioLevel(active,item); }
  displayCompositionViews(linked ? item : null,frame,seek);
  displayVideoLayers(project.overlays,overlayPlayers,$('preview-overlays'),project,frame,seek);
  displaySounds(frame,seek);
  displayTitles(project,captionOrder,$('stage'),$('preview-titles'),frame);
  $('preview-empty').hidden = duration > 0;
  $('playhead').style.left = `${pixels(frame)}px`;
  $('timecode').textContent = timecode(frame);
  $('duration').textContent = timecode(duration);
  updateButtons();
  updateKeyControls();
}

function displayTitles(sequence,captions,stage,container,frame) {
  const titleNodes = [];
  const visible=sequence.titles.filter(title => frame >= title.start && frame < title.start + title.len && title.style!=='caption' && !trackSettings(sequence,trackOf(title)).muted);
  let left=0,right=captions.length;
  while(left<right){
    const middle=(left+right)>>>1;
    if(captions[middle].start<=frame) left=middle+1;
    else right=middle;
  }
  const lastCaption=captions[left-1];
  if(lastCaption && frame<lastCaption.start+lastCaption.len && !trackSettings(sequence,'caption:5').muted) visible.push(lastCaption);
  for (const title of visible.sort((a,b) => (a.track || 1) - (b.track || 1))) {
    const layer = node('div','program-title-layer');
    const label = node('div', 'preview-title');
    label.dataset.previewTitle=title.id;
    if (sequence===project && isSelected(title.id)) label.classList.add('canvas-selected');
    const offset = frame - title.start;
    styleTitle(label,title,offset,stage);
    layer.append(label);
    styleMotion(layer, title, offset);
    titleNodes.push(layer);
  }
  container.replaceChildren(...titleNodes);
}

function styleTitle(label,title,offset,stage=$('stage')) {
  const type=titleType(title);
  const size=stage.clientHeight*type.size/100;
  const columns=Math.max(12,Math.floor(stage.clientWidth*.84/Math.max(1,size*(.56+type.tracking*.08))));
  const wrapped=wrapText(title.text,columns);
  label.textContent=typographyText(visibleText({...title,text:wrapped},offset),type);
  label.hidden = !label.textContent;
  const longest=Math.max(1,...wrapped.split('\n').map(row=>[...row].length));
  label.style.fontSize=`min(${type.size}cqh, ${86/(longest*(.56+type.tracking*.08))}cqw)`;
  label.style.fontFamily=`${JSON.stringify(type.family)}, "Segoe UI", sans-serif`;
  label.style.fontWeight=type.weight%2?'700':'400';
  label.style.fontStyle=type.weight>=2?'italic':'normal';
  label.style.lineHeight=type.leading;
  label.style.textAlign=type.align;
  label.classList.toggle('gradient-title',Boolean(type.gradient));
  label.style.color=type.gradient?'transparent':type.fill;
  label.style.left=`${titleAnchor(title,'x',type)}%`;
  label.style.top=`${titleAnchor(title,'y',type)}%`;
  label.style.translate=`${type.align==='left'?'0':type.align==='right'?'-100%':'-50%'} ${-100*titleVerticalAnchor(title)}%`;
  const units=value=>`${value*100/1080}cqh`;
  label.style.background=type.background+Math.round(type.boxOpacity*2.55).toString(16).padStart(2,'0');
  label.style.padding=type.boxOpacity?units(type.padding):'0';
  if (type.gradient) {
    label.dataset.titleFace = label.textContent;
    const stops = type.gradient.stops.map(([at,color])=>`${color} ${at*100}%`).join(', ');
    label.style.setProperty('--title-face-gradient',`linear-gradient(${type.gradient.angle}deg, ${stops})`);
    label.style.setProperty('--title-padding',type.boxOpacity?units(type.padding):'0px');
  }
  label.style.webkitTextStroke=`${units(type.outline)} ${type.outlineColor}`;
  const shadow=extrusionOffsets(type).reverse().map(([x,y])=>`${units(x)} ${units(y)} 0 ${type.depthColor}`);
  if(type.shadow) shadow.push(`${units(type.shadowX)} ${units(type.shadowY)} ${units(type.blur)} rgb(0 0 0 / ${type.shadow}%)`);
  label.style.textShadow=shadow.join(',') || 'none';
}

function displaySounds(frame,seek,sequence=project,media=audioPlayers,parentMix) {
  const visible=sequence.sounds.filter(clip=>bin.has(clip.asset) && !clip.muted && frame>=clip.start && frame<clip.start+clip.len);
  for(const [id,el] of media) {
    if(visible.some(clip=>clip.id===id)) continue;
    el.pause(); media.delete(id);
  }
  for(const clip of visible) {
    let el=media.get(clip.id);
    const fresh=!el;
    if(fresh){
      el=new Audio(diskURL(clip.asset,'audio.wav'));
      el.preload='auto';
      el.addEventListener('loadedmetadata',()=>{
        if(el.pendingSeek!==undefined){mediaPosition(el,el.pendingSeek);delete el.pendingSeek;}
      });
      media.set(clip.id,el);
    }
    const local=frame-clip.start;
    const target=seconds(clip.in+local);
    if(fresh || seek || Math.abs(el.currentTime-target)>.14) mediaPosition(el,target);
    const fadeIn=clip.fadeIn? Math.min(1,local/clip.fadeIn):1;
    const fadeOut=clip.fadeOut?clamp((clip.len-local)/clip.fadeOut,0,1):1;
    setAudioLevel(el,clip,fadeIn*fadeOut,sequence,parentMix);
    if(playing && el.paused) el.play().catch(()=>{});
  }
}

function setAudioLevel(element, clip, envelope=1, sequence=project, parentMix) {
  const mix=clipMix(sequence,clip);
  element.muted=mix.muted || Boolean(parentMix?.muted);
  element.volume=clamp(10**((mix.gain+(parentMix?.gain || 0))/20)*envelope,0,1);
}

function styleMotion(el, clip, local) {
  const value = key => valueAt(clip,key,local);
  const scale = value('scale') / 100;
  const x = value('x')+titlePositionOffset(clip,'x');
  const y = value('y')+titlePositionOffset(clip,'y');
  el.style.transform = `translate(${x}cqw, ${y}cqh) rotate(${value('rotation')}deg) scale(${scale})`;
  el.style.opacity = value('opacity') / 100;
  el.style.filter = `brightness(${value('brightness')}%) contrast(${value('contrast')}%) saturate(${value('saturation')}%)`;
  el.style.clipPath = `inset(${value('top')}% ${value('right')}% ${value('bottom')}% ${value('left')}%)`;
}

function styleVideoMotion(el,clip,local,sequence=project) {
  const framing = hasVideoFraming(clip);
  if (el.classList.contains('framed-video')!==framing) el.classList.toggle('framed-video',framing);
  if (framing) {
    const {w,h} = fittedMediaSize(clip,el,sequence);
    el.style.setProperty('--fit-width',`${w*100}cqw`);
    el.style.setProperty('--fit-height',`${h*100}cqh`);
  }
  styleMotion(el,clip,local);
  const key = keyDraft?.id===clip.id ? keyDraft.key : clip.backgroundKey;
  if (samplingKey===clip.id || !key || (key.mode!=='chroma' && key.mode!=='luma')) clearVideoKey(el);
  else {
    el.keyPreview ||= createKeyPreview(el);
    el.keyPreview.update(key,bin.get(clip.asset),matteClip===clip.id,previewQuality);
  }
}

function clearVideoKey(el) {
  el.keyPreview?.destroy();
  delete el.keyPreview;
}

function isLiveComposition(clip) {
  return Boolean(clip?.composition && clip.asset===compositionAssetKey(clip.composition));
}

function displayCompositionViews(base,frame,seek) {
  const visible = project.overlays.filter(clip=>isLiveComposition(clip) && frame>=clip.start && frame<clip.start+clip.len);
  if (base) visible.unshift(base);
  for (const [key,view] of compositionViews) {
    if (visible.some(clip=>clip.id===key)) continue;
    for (const el of view.video.values()) clearVideoKey(el);
    for (const el of [...view.video.values(),...view.audio.values()]) el.pause();
    view.frame.remove();
    compositionViews.delete(key);
  }
  for (const clip of visible) {
    const sequence = entry.compositions.find(item=>item.id===clip.composition)?.sequence;
    if (!sequence) continue;
    let view = compositionViews.get(clip.id);
    if (!view) {
      const frame = node('div','composition-preview');
      const stage = node('div','composition-preview-stage');
      const titles = node('div','composition-preview-titles');
      stage.append(titles);
      frame.append(stage);
      if (clip.track) $('preview-overlays').append(frame);
      else $('stage').insertBefore(frame,$('preview-overlays'));
      view = { frame,stage,titles,video:new Map(),audio:new Map(),captions:sequence.titles.filter(title=>title.style==='caption').sort((a,b)=>a.start-b.start) };
      compositionViews.set(clip.id,view);
    }
    const {w,h} = fittedMediaSize(clip,view.frame);
    view.frame.style.width = `${w*100}%`;
    view.frame.style.height = `${h*100}%`;
    view.frame.style.zIndex = clip.track || 0;
    const local = frame-clip.start;
    styleMotion(view.frame,clip,local);
    const position = clip.in+local;
    const mix = clipMix(project,clip);
    displayVideoLayers([...sequence.clips,...sequence.overlays],view.video,view.stage,sequence,position,seek,mix);
    displaySounds(position,seek,sequence,view.audio,mix);
    displayTitles(sequence,view.captions,view.stage,view.titles,position);
  }
}

function displayVideoLayers(clips,media,container,sequence,frame,seek,parentMix) {
  const visible = clips.filter(clip => !isLiveComposition(clip) && bin.has(clip.asset) && frame >= clip.start && frame < clip.start + clip.len);
  for (const [id, el] of media) {
    if (visible.some(clip => clip.id === id)) continue;
    el.pause();
    clearVideoKey(el);
    el.remove();
    media.delete(id);
  }
  for (const clip of visible) {
    let el = media.get(clip.id);
    const fresh = !el;
    if (fresh) {
      el = node('video');
      el.playsInline = true;
      el.preload = 'auto';
      el.addEventListener('loadedmetadata', () => {
        if (el.pendingSeek !== undefined) { mediaPosition(el,el.pendingSeek); delete el.pendingSeek; }
        const { clip, local, sequence } = el.previewFrame;
        if (media.get(clip.id)===el) styleVideoMotion(el,clip,local,sequence);
      });
      container.append(el);
      media.set(clip.id,el);
    }
    el.style.zIndex = clip.track || 0;
    el.previewFrame = { clip, local:frame-clip.start, sequence };
    setAudioLevel(el,clip,1,sequence,parentMix);
    if (fresh || seek) setSource(el, clip, frame);
    else if (Math.abs(el.currentTime - seconds(clip.in + frame - clip.start)) > .16) mediaPosition(el,seconds(clip.in + frame - clip.start));
    if (playing && el.paused) el.play().catch(() => {});
    styleVideoMotion(el, clip, frame - clip.start,sequence);
  }
}

function pause() {
  playing = false;
  cancelAnimationFrame(raf);
  for (const el of [...players, ...overlayPlayers.values(), ...audioPlayers.values()]) el.pause();
  for (const view of compositionViews.values()) for (const el of [...view.video.values(), ...view.audio.values()]) el.pause();
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
  if (event.ctrlKey || event.metaKey) {
    select(item.id,{toggle:true});
    return;
  }
  const textList = block.textListTitles?.length>1;
  if (textList && !isSelected(item.id) && !event.shiftKey) select(item.id);
  if (textList && event.shiftKey) select(item.id,{range:true});
  const group = selectedClips();
  const movingGroup = (!event.shiftKey || textList) && !trim && group.length>1 && isSelected(item.id);
  if (!event.shiftKey) select(item.id,{preserve:movingGroup});
  if (protectedTrack(project,trackOf(item)) || (movingGroup && group.some(clip=>protectedTrack(project,trackOf(clip))))) {
    if (event.shiftKey) select(item.id,{range:true});
    setPosition(item.start);
    return;
  }
  drag = { x: event.clientX, y: event.clientY, frame: frameAt(event.clientX), item, video, trim, block, moved: false, rangeOnClick:event.shiftKey && !textList };
  if (movingGroup) {
    const keys = new Set(group.map(clip=>clip.id));
    let minimum = -Infinity, maximum = Infinity;
    for (const clip of group) {
      minimum = Math.max(minimum,-clip.start);
      for (const peer of layerItems(clip).filter(peer=>!keys.has(peer.id))) {
        if (peer.start+peer.len<=clip.start) minimum = Math.max(minimum,peer.start+peer.len-clip.start);
        if (peer.start>=clip.start+clip.len) maximum = Math.min(maximum,peer.start-clip.start-clip.len);
      }
    }
    drag.group = {items:group,keys,minimum,maximum,blocks:[...space.querySelectorAll('.clip')].filter(el=>keys.has(el.dataset.id))};
  }
  (block.textListTitles ? block : space).setPointerCapture(event.pointerId);
}

function dragClip(event) {
  if (!drag) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.x,event.clientY - drag.y) < 4) return;
  if (!drag.moved && drag.rangeOnClick) select(drag.item.id);
  drag.moved = true;
  const { item, trim, video, block } = drag;
  block.classList.add('dragging');
  const point = frameAt(event.clientX);
  const delta = point - drag.frame;
  if (drag.group) {
    const { keys,minimum,maximum,blocks } = drag.group;
    drag.group.delta = clamp(snapPoint(item.start+delta,item.len,keys,event.shiftKey)-item.start,minimum,maximum);
    for (const element of blocks) element.style.translate = `${pixels(drag.group.delta)}px 0`;
    return;
  }
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
  const { item, changes, moved, trim,videoTrack,group,rangeOnClick } = drag;
  drag = null;
  $('drop-marker').hidden = true;
  if (cancel) return renderTimeline();
  if (group?.delta) {
    change(()=>{ for (const clip of group.items) clip.start+=group.delta; });
    return;
  }
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
    if (rangeOnClick) select(item.id,{range:true});
    else if (group && !collapsedList(item.id)) select(item.id);
    setPosition(item.start);
  } else if (group) renderTimeline();
}

function snapPoint(start,len,ignore,bypass) {
  $('drop-marker').hidden=true;
  if(bypass) return start;
  const threshold=Math.max(1,9*fps/zoom);
  const edges=[0,cursor];
  for(const clip of [...project.clips,...project.overlays,...project.titles,...project.sounds]) {
    if(clip.id!==ignore && !ignore?.has?.(clip.id)) edges.push(clip.start,clip.start+clip.len);
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
const timelineGrid = scroll.closest('.timeline-grid');
const selectionBox = $('selection-box');
let boxSelection = null;

function edgeScrollDelta(position, low, high, elapsed) {
  const zone = Math.min(45, (high-low)/4);
  const edge = position<low+zone ? position-low-zone : Math.max(0,position-high+zone);
  const delta = clamp(edge*16,-1350,1350)*elapsed;
  return delta ? Math.sign(delta)*Math.max(1,Math.abs(delta)) : 0;
}

function scrollWhileScrubbing(now) {
  scrubFrame=0;
  if(!space.dataset.scrub) return;
  const view=scroll.getBoundingClientRect();
  const elapsed=scrubLast?Math.min(.04,(now-scrubLast)/1000):1/60;
  scrubLast=now;
  const delta=edgeScrollDelta(scrubPointerX,view.left,view.right,elapsed);
  if(delta){
    const left=scroll.scrollLeft;
    setTimelineScroll(left+delta);
    if(scroll.scrollLeft!==left) setPosition(frameAt(clamp(scrubPointerX,view.left,view.right)));
  }
  scrubFrame=requestAnimationFrame(scrollWhileScrubbing);
}

function endScrub() {
  delete space.dataset.scrub;
  cancelAnimationFrame(scrubFrame);
  scrubFrame=scrubLast=0;
}

function boxViewport() {
  const view = scroll.getBoundingClientRect();
  const gridTop = timelineGrid.getBoundingClientRect().top;
  return { left:view.left, right:view.left+scroll.clientWidth, top:Math.max(view.top,gridTop),
    bottom:Math.min(view.bottom,gridTop+timelineGrid.clientHeight) };
}

function drawSelectionBox(box, view) {
  const bounds = space.getBoundingClientRect();
  const x = clamp(box.x,view.left,view.right)-bounds.left;
  const y = clamp(box.y,view.top,view.bottom)-bounds.top;
  const left = Math.min(box.startX,x), top = Math.min(box.startY,y);
  const right = Math.max(box.startX,x), bottom = Math.max(box.startY,y);
  Object.assign(selectionBox.style,{ left:`${left}px`,top:`${top}px`,width:`${Math.max(1,right-left)}px`,height:`${Math.max(1,bottom-top)}px` });
  box.keys = new Set(box.existing);
  for (const clip of box.clips) {
    if (clip.left<right && clip.right>left && clip.top<bottom && clip.bottom>top) box.keys.add(clip.id);
  }
  drawClipSelection(box.keys);
}

function scrollWhileSelecting(now) {
  const box = boxSelection;
  if (!box?.active) return;
  const elapsed = box.last ? Math.min(.04,(now-box.last)/1000) : 1/60;
  box.last = now;
  const view = boxViewport();
  const dx = edgeScrollDelta(box.x,view.left,view.right,elapsed);
  const dy = edgeScrollDelta(box.y,view.top,view.bottom,elapsed);
  if (dx) setTimelineScroll(scroll.scrollLeft+dx);
  if (dy) timelineGrid.scrollTop += dy;
  if (box.dirty || box.left!==scroll.scrollLeft || box.top!==timelineGrid.scrollTop) {
    box.dirty = false;
    box.left = scroll.scrollLeft;
    box.top = timelineGrid.scrollTop;
    drawSelectionBox(box,boxViewport());
  }
  box.raf = requestAnimationFrame(scrollWhileSelecting);
}

function moveSelectionBox(event) {
  const box = boxSelection;
  if (!box || event.pointerId!==box.pointerId) return;
  box.x = event.clientX;
  box.y = event.clientY;
  box.dirty = true;
  if (box.active || Math.hypot(box.x-box.originX,box.y-box.originY)<4) return;
  box.active = true;
  const bounds = space.getBoundingClientRect();
  box.clips = [...space.querySelectorAll('.clip')].map(clip=>{
    const rect = clip.getBoundingClientRect();
    return { id:clip.dataset.id, left:rect.left-bounds.left, right:rect.right-bounds.left,
      top:rect.top-bounds.top, bottom:rect.bottom-bounds.top };
  });
  selectionBox.hidden = false;
  box.raf = requestAnimationFrame(scrollWhileSelecting);
}

function finishSelectionBox(event, cancel = false) {
  const box = boxSelection;
  if (!box || (event && event.pointerId!==box.pointerId)) return;
  if (event && !cancel) moveSelectionBox(event);
  boxSelection = null;
  cancelAnimationFrame(box.raf);
  selectionBox.hidden = true;
  if (space.hasPointerCapture(box.pointerId)) space.releasePointerCapture(box.pointerId);
  if (cancel) return drawClipSelection();
  if (!box.active) {
    if (box.additive) return;
    select(null);
    if (box.track) selectTrack(box.track);
    setPosition(frameAt(box.originX));
    return;
  }
  drawSelectionBox(box,boxViewport());
  const keys = new Set(clipsIn(project).filter(clip=>box.keys.has(clip.id)).map(clip=>clip.id));
  for (const key of [...keys]) for (const member of collapsedList(key) || []) keys.add(member.id);
  selected = keys.has(selected) ? selected : [...keys][0] ?? null;
  keys.delete(selected);
  selectedGroup = keys;
  selectionAnchor = selected;
  refreshSelection();
}

scroll.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary || event.target.closest('.clip, .key-dot')) return;
  space.setPointerCapture(event.pointerId);
  if (!event.target.closest('#ruler, #playhead')) {
    pause();
    const bounds = space.getBoundingClientRect();
    const additive = event.ctrlKey || event.metaKey;
    boxSelection = {
      pointerId:event.pointerId, originX:event.clientX, originY:event.clientY,
      startX:event.clientX-bounds.left, startY:event.clientY-bounds.top,
      track:event.target.closest('[data-track-key]')?.dataset.trackKey,
      additive, existing:additive ? selectedClips().map(clip=>clip.id) : [], raf:0
    };
    return;
  }
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
  if(task.state==='cancelled') return 'Cancelled';
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
          if (task.cancellable) row.append(button('Stop',async event=>{
            event.currentTarget.disabled=true;
            try { await jsonPost(`/api/tasks/${task.id}/cancel`,{}); }
            catch(error) { notify(error.message); }
          }));
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
  if (boxSelection) moveSelectionBox(event);
  else if (drag) dragClip(event);
  else if (space.dataset.scrub) {
    scrubPointerX=event.clientX;
    const view=scroll.getBoundingClientRect();
    setPosition(frameAt(clamp(scrubPointerX,view.left,view.right)));
  }
});
space.addEventListener('pointerup', event => {
  if (boxSelection) return finishSelectionBox(event);
  endScrub();
  if(drag?.moved) dragClip(event);
  endClipDrag();
});
space.addEventListener('pointercancel', event => {
  finishSelectionBox(event,true);
  endScrub();
  endClipDrag(true);
});
space.addEventListener('lostpointercapture',event=>{
  finishSelectionBox(event,true);
  endScrub();
});

function hideTimelineMenu() { $('timeline-menu').hidden=true; }
function showTimelineMenu(event) {
  const menu = $('timeline-menu');
  if (!menu.childElementCount) return hideTimelineMenu();
  menu.hidden = false;
  menu.style.left = `${Math.min(event.clientX,innerWidth-menu.offsetWidth-5)}px`;
  menu.style.top = `${Math.min(event.clientY,innerHeight-menu.offsetHeight-5)}px`;
}

function timelineAction({title,label,value,submit,help='',type='text',apply}) {
  const dialog = $('timeline-action');
  const input = $('timeline-action-value');
  $('timeline-action-title').textContent = title;
  $('timeline-action-label').textContent = label;
  $('timeline-action-submit').textContent = submit;
  $('timeline-action-help').textContent = help;
  input.type = type;
  input.min = 1;
  input.max = 500;
  input.maxLength = 60;
  input.value = value;
  $('timeline-action-form').onsubmit = event => {
    event.preventDefault();
    if (apply(input.value)!==false) dialog.close();
  };
  dialog.showModal();
  input.select();
}
$('timeline-action-close').onclick = () => $('timeline-action').close();

function repeatSelection() {
  const group = selectedClips();
  if (!group.length) return;
  timelineAction({ title:'Make copies',label:'Additional copies',value:10,submit:'Make copies',type:'number',
    help:'Copies follow the selection and keep the original tracks and spacing.',
    apply(value) { return pasteGroup(group,Math.max(...group.map(clip=>clip.start+clip.len)),Number(value)); }
  });
}

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
    select(element.dataset.id,{preserve:true});
    setPosition(at);
    const clip=selection();
    const group = selectedClips();
    const locked = group.some(item=>protectedTrack(project,trackOf(item)));
    action('Cut (Ctrl+X)',()=>copyTimelineClip(true),locked);
    action('Copy (Ctrl+C)',()=>copyTimelineClip());
    action('Paste (Ctrl+V)',()=>{setPosition(at);pasteEditorItem();},!timelineClipboard);
    action('Split at playhead',splitClip,!splitPosition());
    action('Make copies…',repeatSelection,locked);
    const list = textListsByTitle.get(clip.id);
    if (list) {
      const expanded = expandedTextLists.has(list[0].textListId);
      action('Edit Text List…',()=>openTextList(list),locked);
      action(expanded?'Collapse Text List':'Show individual titles',()=>setTextListExpanded(list,!expanded));
    } else if (canGroupTitles([...group].sort((a,b)=>a.start-b.start))) {
      action('Group as Text List…',()=>groupAsTextList([...group].sort((a,b)=>a.start-b.start)),locked);
    }
    action('Delete · leave gap',()=>removeClip(false),locked);
    action('Ripple delete · close gap',()=>removeClip(true),locked || group.length>1 && !selectedTextList(group));
    if (group.length===1 && isLiveComposition(clip)) action('Open composition',()=>openSequence(clip.composition));
    if(group.length===1 && clip.asset && clip.kind!=='audio' && bin.get(clip.asset)?.audio!=null) action('Extract audio',()=>extractAudio(clip),locked||project.sounds.some(item=>item.extractedFrom===clip.id));
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
  showTimelineMenu(event);
});
document.addEventListener('pointerdown',event=>{ if(!event.target.closest('#timeline-menu')) hideTimelineMenu(); });
document.addEventListener('keydown',event=>{
  if (event.key!=='Escape') return;
  finishSelectionBox(null,true);
  hideTimelineMenu();
});

const hasFiles = event => Array.from(event.dataTransfer.types).includes('Files');
const hasAsset = event => Array.from(event.dataTransfer.types).includes(mediaDragType);
const hasImportedAudio = event => Array.from(event.dataTransfer.types).includes(importedAudioDragType);
const hasComposition = event => sequenceKey==='main' && Array.from(event.dataTransfer.types).includes(compositionType);
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
  void importFiles([...event.dataTransfer.files]);
});
$('video-track').addEventListener('dragover', event => {
  if (!hasAsset(event) && !hasComposition(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  markDrop(insertion(frameAt(event.clientX)).position);
});
$('video-track').addEventListener('dragleave', event => {
  if (!$('video-track').contains(event.relatedTarget)) $('drop-marker').hidden = true;
});
$('video-track').addEventListener('drop', event => {
  if (hasComposition(event)) {
    event.preventDefault();
    $('drop-marker').hidden = true;
    void placeComposition(event.dataTransfer.getData(compositionType),snapPoint(frameAt(event.clientX),0,null,event.shiftKey));
    return;
  }
  if (!hasAsset(event)) return;
  event.preventDefault();
  const asset = projectAsset(event.dataTransfer.getData(mediaDragType));
  if (asset && !removedAsset(asset.id)) insertVideo(asset.id,project.clips.length,assetDropFrame(event,asset));
});
function assetDropFrame(event,asset) {
  const frame = snapPoint(frameAt(event.clientX),asset.frames,null,event.shiftKey);
  $('drop-marker').hidden = true;
  return frame;
}
function dropImportedAudio(event,track) {
  event.preventDefault();
  const asset = projectAsset(event.dataTransfer.getData(importedAudioDragType));
  if (asset?.kind!=='audio' || removedAsset(asset.id)) return;
  insertSound(asset,track,assetDropFrame(event,asset));
}
scroll.addEventListener('dragover',event=>{
  if (!hasImportedAudio(event) || event.defaultPrevented) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
scroll.addEventListener('drop',event=>{
  if (hasImportedAudio(event) && !event.defaultPrevented) dropImportedAudio(event);
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
  if (drag || boxSelection || space.dataset.scrub) return;
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
  void importFiles(files);
};
$('project').onchange = event => {
  const name = event.target.value.trim() || defaults.name;
  change(() => { project.name = name; });
  controls.renderSequences();
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
$('projects-open').onclick = () => switchPage('projects');
$('mark-in').onclick = () => setMark('markIn');
$('mark-out').onclick = () => setMark('markOut');
$('clear-range').onclick = () => change(()=>{ project.markIn = null; project.markOut = null; });
$('preview-quality').onchange = async event => {
  const request=++qualityRequest;
  const quality=event.target.value;
  const at = (clips,frame) => clips.filter(clip=>frame>=clip.start && frame<clip.start+clip.len);
  const visible = at([...timeline,...project.overlays],cursor).flatMap(clip=>{
    if (!isLiveComposition(clip)) return [clip];
    const sequence=entry.compositions.find(item=>item.id===clip.composition)?.sequence;
    return sequence ? at([...sequence.clips,...sequence.overlays],clip.in+cursor-clip.start) : [];
  }).filter(clip=>bin.has(clip.asset) && !isLiveComposition(clip));
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
$('aspect').onchange = event => {
  if (event.target.value==='custom') return $('sequence-settings').click();
  change(() => { project.aspect = event.target.value; delete project.width; delete project.height; });
};
$('media-search').oninput = renderBin;
$('media-sort').onchange = renderBin;
$('footage-tray-search').oninput = refreshFootageTray;
$('footage-tray-toggle').onclick = () => {
  const tray = $('footage-tray-content');
  tray.hidden = !tray.hidden;
  $('footage-tray-toggle').setAttribute('aria-expanded',String(!tray.hidden));
  refreshFootageTray();
};
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
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase()==='s' &&
      page!=='projects' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    if (!event.repeat) saveProject();
    return;
  }
  if (page==='projects' || page==='led' || event.defaultPrevented || event.target.isContentEditable ||
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
  } else if ((key==='i' || key==='o') && !event.ctrlKey && !event.metaKey && !event.altKey && page!=='footage') {
    event.preventDefault();
    setMark(key==='i'?'markIn':'markOut');
  } else if (event.key === ' ' && !event.target.closest('button,a')) {
    event.preventDefault();
    togglePlay();
  } else if (event.key === 'Delete') {
    event.preventDefault();
    if (page==='footage') {
      if (sourceAsset && !removedAsset(sourceAsset)) setAssetRemoved(sourceAsset,true);
    } else removeClip(event.shiftKey);
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
document.addEventListener('keydown',event=>{
  if (event.key!=='Escape') return;
  if (alignmentPanel.open) alignmentPanel.open = false;
  stopTextPlacement();
});

$('export').onclick = () => {
  pause();
  $('resolution').value = 'canvas';
  $('export-use-range').checked = true;
  $('export-status').textContent = '';
  $('download').hidden = true;
  $('progress').hidden = true;
  updateExportSummary();
  $('export-dialog').showModal();
};
$('close-dialog').onclick = () => $('export-dialog').close();
$('resolution').onchange = updateExportSummary;
$('export-use-range').onchange = updateExportSummary;
$('export-format').onchange = event => change(() => { project.format = event.target.value; });
$('export-format').addEventListener('change',updateExportSummary);
$('export-transparent').onchange = () => {
  change(()=>{ project.transparent = $('export-transparent').checked; });
  updateExportSummary();
};
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
    const settings = $('resolution').value;
    const useRange = $('export-use-range').checked;
    const snapshot = structuredClone(project);
    if (!useRange) snapshot.markIn = snapshot.markOut = null;
    const fullLength = sequenceDuration(snapshot,contentDuration(snapshot));
    const range = exportRange(snapshot,fullLength);
    if (!range.frames) throw new Error('The export Out point must follow the In point.');
    const output = await resolveCompositionClips(snapshot,exportWindow(range,fullLength));
    // Preserve the original range even if unused groups at the end are skipped.
    if (output.clips.length!==snapshot.clips.length || output.overlays.length!==snapshot.overlays.length) output.fixedFrames = fullLength;
    if (settings!=='canvas') {
      output.resolution = settings;
      delete output.width;
      delete output.height;
    }
    let job = await api('/api/exports', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Framecut': '1' },
      body: JSON.stringify(output)
    });
    while (job.status === 'rendering') {
      await new Promise(resolve => setTimeout(resolve, 500));
      job = await api(`/api/exports/${job.id}`);
      $('progress').value = job.progress;
      $('export-status').textContent = `Rendering · ${job.progress}%`;
    }
    if (job.status !== 'ready') throw new Error(job.error || 'Export cancelled.');
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
    notify(error.message==='Task cancelled.'?'Export cancelled.':'Export failed');
  } finally {
    exporting = false;
    $('render').disabled = false;
    $('resolution').disabled = false;
  }
};

$('import').disabled = true;
void api('/api/fonts').then(names=>{
  const known = new Set([...installedFonts].map(name=>name.toLowerCase()));
  const previousCount = installedFonts.size;
  for (const name of names) {
    if (known.has(name.toLowerCase())) continue;
    installedFonts.add(name);
    known.add(name.toLowerCase());
  }
  if (installedFonts.size === previousCount) return;
  fontOptions = undefined;
  const list = $('text-list-font');
  fillFontMenu(list,list.value,true);
  const inspector = $('inspector').querySelector('[data-title-font]');
  if (inspector) fillFontMenu(inspector,inspector.value || mixed);
}).catch(()=>{ /* The standard fonts remain usable if Windows cannot be scanned. */ });
try {
  for (const asset of await api('/api/media')) bin.set(asset.id, asset);
  for (const lut of await api('/api/luts')) lutLibrary.set(lut.id, lut);
  migrateProjectImports(catalog,bin,lutLibrary,()=>newProject({name:'Recovered imports'}));
  const tools=await api('/api/tools');
  objectRemovalAvailable=tools.objectRemoval;
  transcriptionAvailable=tools.transcription;
  mediaLoaded = true;
  $('import').disabled = false;
} catch (error) {
  notify(`Could not load Media — ${error.message}`);
}
persist();
switchPage('projects');
