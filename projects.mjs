import { FPS, MAX_DURATION, MAX_PIXEL_SIZE, validPixels, sequenceSize, formatRatio, sequenceDuration, contentDuration } from './sequences.mjs';

export const catalogKey = 'framecut-projects-v1';
export const compositionType = 'application/x-framecut-composition';
const $ = id => document.getElementById(id);

export function readCatalog(value) {
  if (value?.schema !== 1 || !Array.isArray(value.projects)) return { schema:1, active:null, projects:[] };
  return {
    ...value,
    projects:value.projects.filter(entry=>entry?.id && Array.isArray(entry.main?.clips) &&
      Array.isArray(entry.main.titles) && Array.isArray(entry.compositions))
  };
}

export function migrateProjectImports(catalog, assets, luts, createRecoveredProject) {
  if (catalog.importsScoped === true) return;
  const claimedMedia = new Set();
  const claimedLuts = new Set();
  for (const entry of catalog.projects) {
    const media = new Set(entry.mediaIds || []);
    const profiles = new Set(entry.lutIds || []);
    for (const sequence of [entry.main,...entry.compositions.map(item=>item.sequence)]) {
      for (const key of Object.keys(sequence.assignments || {})) media.add(key);
      for (const clip of [...sequence.clips,...(sequence.overlays || []),...(sequence.sounds || [])]) {
        if (clip.asset) media.add(clip.asset);
        if (clip.lut) profiles.add(clip.lut);
      }
    }
    for (const wall of entry.led?.walls || []) if (wall.asset && !wall.sequence) media.add(wall.asset);
    for (const key of entry.removedAssets || []) media.add(key);
    entry.mediaIds = [...media].filter(key=>!assets.get(key)?.composition);
    entry.lutIds = [...profiles];
    entry.mediaIds.forEach(key=>claimedMedia.add(key));
    entry.lutIds.forEach(key=>claimedLuts.add(key));
  }
  const unclaimed = [...assets.values()].filter(asset=>!asset.composition && !claimedMedia.has(asset.id)).map(asset=>asset.id);
  const unclaimedLuts = [...luts.keys()].filter(key=>!claimedLuts.has(key));
  if (unclaimed.length || unclaimedLuts.length) {
    const entry = catalog.projects.length===1 ? catalog.projects[0] : createRecoveredProject();
    entry.mediaIds.push(...unclaimed);
    entry.lutIds.push(...unclaimedLuts);
    if (!catalog.projects.includes(entry)) catalog.projects.push(entry);
  }
  catalog.importsScoped = true;
}

function element(tag, className, content) {
  const control = document.createElement(tag);
  if (className) control.className = className;
  if (content !== undefined) control.textContent = content;
  return control;
}

function button(label, action, style='secondary') {
  const control = element('button', style, label);
  control.type = 'button';
  control.onclick = action;
  return control;
}

export function projectControls({ entries, current, assets, open, create, edit, openSequence, addComposition, timecode }) {
  let applySettings;
  const dialog = $('sequence-dialog');
  const dimensions = () => [$('canvas-width').valueAsNumber, $('canvas-height').valueAsNumber];
  const updateSize = () => {
    const [width, height] = dimensions();
    const valid = validPixels(width) && validPixels(height);
    const preset = `${width}x${height}`;
    $('canvas-preset').value = [...$('canvas-preset').options].some(option=>option.value===preset) ? preset : 'custom';
    $('canvas-ratio').textContent = valid ? `${formatRatio(width, height)} aspect ratio · ${FPS} fps` : '';
    $('canvas-double').disabled = !valid || Math.max(width, height) * 2 > MAX_PIXEL_SIZE;
  };
  const updateMode = () => {
    const fixed = $('sequence-length-mode').value === 'fixed';
    $('sequence-length-field').hidden = !fixed;
    $('sequence-length').disabled = !fixed;
    $('sequence-length').required = fixed;
  };
  function settings(title, label, sequence, apply) {
    applySettings = apply;
    $('sequence-dialog-title').textContent = title;
    $('sequence-submit').textContent = label;
    $('sequence-form-status').textContent = '';
    $('sequence-name').value = sequence.name;
    const [width, height] = sequenceSize(sequence);
    $('canvas-width').value = width;
    $('canvas-height').value = height;
    $('sequence-length-mode').value = sequence.fixedFrames ? 'fixed' : 'auto';
    $('sequence-length').value = sequence.fixedFrames ? (sequence.fixedFrames / FPS).toFixed(5) : 10;
    updateSize();
    updateMode();
    dialog.showModal();
    $('sequence-name').select();
  }
  $('sequence-close').onclick = () => dialog.close();
  $('canvas-width').oninput = updateSize;
  $('canvas-height').oninput = updateSize;
  $('sequence-length-mode').onchange = updateMode;
  $('canvas-double').onclick = () => {
    const [width, height] = dimensions();
    $('canvas-width').value = width * 2;
    $('canvas-height').value = height * 2;
    updateSize();
  };
  $('canvas-preset').onchange = event => {
    if (event.target.value === 'custom') return $('canvas-width').focus();
    [$('canvas-width').value, $('canvas-height').value] = event.target.value.split('x');
    updateSize();
  };
  $('sequence-form').onsubmit = event => {
    event.preventDefault();
    const name = $('sequence-name').value.trim();
    const [width, height] = dimensions();
    const fixedFrames = $('sequence-length-mode').value === 'fixed' ? Math.round($('sequence-length').valueAsNumber * FPS) : null;
    if (!name || !validPixels(width) || !validPixels(height) ||
        (fixedFrames !== null && (!Number.isSafeInteger(fixedFrames) || fixedFrames < 1 || fixedFrames > MAX_DURATION))) {
      $('sequence-form-status').textContent = 'Enter a name and valid dimensions and duration.';
      return;
    }
    if (applySettings({ name, width, height, fixedFrames, aspect:height>width?'portrait':height===width?'square':'landscape' }) !== false) dialog.close();
  };

  function renderHome() {
    const search = $('project-search').value.trim().toLowerCase();
    const all = entries();
    const projects = all.filter(entry=>entry.main.name.toLowerCase().includes(search)).sort((a,b)=>b.updated-a.updated);
    $('project-count').textContent = `${projects.length} ${projects.length===1?'project':'projects'}`;
    const list = $('project-list');
    list.replaceChildren();
    if (!projects.length) {
      const empty = element('div', 'projects-empty');
      empty.append(element('h2', '', all.length ? 'No matching projects' : 'Start your first project'));
      empty.append(all.length ? element('p', 'subtle', 'Try a different project name.') :
        button('Create a project', () => $('project-create').click(), 'primary'));
      list.append(empty);
    }
    for (const entry of projects) {
      const sequence = entry.main;
      const card = button('', () => open(entry.id), 'project-card');
      const cover = element('span', 'project-cover');
      const clip = [...sequence.clips, ...(sequence.overlays || [])].find(item=>assets.has(item.asset));
      if (clip) {
        const image = element('img');
        image.src = `/media/${clip.asset}/thumb.jpg`;
        image.alt = '';
        image.loading = 'lazy';
        cover.append(image);
      } else {
        cover.append(element('span', 'project-frame', '▷'));
      }
      const info = element('span', 'project-card-info');
      const [width, height] = sequenceSize(sequence);
      const duration = timecode(sequenceDuration(sequence, contentDuration(sequence)));
      const heading = element('strong', '', sequence.name);
      const details = element('span', 'subtle', `${width} × ${height} · ${duration}`);
      const date = new Intl.DateTimeFormat(undefined, {dateStyle:'medium'}).format(entry.updated);
      info.append(heading, details, element('span', 'project-date', date));
      card.append(cover, info);
      card.setAttribute('aria-label', `Open ${sequence.name}`);
      list.append(card);
    }
  }
  function drawer(show) {
    $('composition-drawer').hidden = !show;
    $('compositions-open').setAttribute('aria-expanded', String(show));
    if (show) renderSequences();
  }
  function renderSequences() {
    const { entry, selected } = current();
    const tabs = $('sequence-tabs');
    const list = $('composition-list');
    tabs.replaceChildren();
    list.replaceChildren();
    if (!entry) return;
    const renderTab = (name, key) => {
      const tab = button(name, () => openSequence(key), 'sequence-tab');
      tab.title = name;
      tab.dataset.sequence = key;
      tab.setAttribute('aria-pressed', String(selected===key));
      tabs.append(tab);
    };
    renderTab('Main', 'main');
    for (const item of entry.compositions) {
      renderTab(item.sequence.name, item.id);
      const row = element('article', 'composition-row');
      const openButton = button(item.sequence.name, () => { openSequence(item.id); drawer(false); }, 'composition-select');
      openButton.classList.toggle('current', selected===item.id);
      const [w,h] = sequenceSize(item.sequence);
      const length = sequenceDuration(item.sequence, contentDuration(item.sequence));
      openButton.append(element('span', 'subtle', `${w} × ${h} · ${timecode(length)}`));
      row.append(openButton, button('＋', () => addComposition(item.id), 'icon'));
      row.lastChild.title = 'Add composition to Main';
      row.lastChild.setAttribute('aria-label', `Add ${item.sequence.name} to Main`);
      row.lastChild.disabled = !length;
      row.draggable = length > 0;
      row.ondragstart = event => {
        event.dataTransfer.setData(compositionType, item.id);
        event.dataTransfer.effectAllowed = 'copy';
      };
      list.append(row);
    }
    if (!entry.compositions.length) list.append(element('p', 'drawer-empty subtle', 'Create a composition to edit it on its own timeline.'));
  }
  $('project-search').oninput = renderHome;
  $('project-create').onclick = () => settings('New project', 'Create project', {name:'Untitled project'}, create);
  $('sequence-settings').onclick = () => {
    const { entry, selected } = current();
    if (entry) settings(selected==='main'?'Project settings':'Composition settings', 'Save settings',
      selected==='main'?entry.main:entry.compositions.find(item=>item.id===selected).sequence, edit);
  };
  $('composition-create').onclick = () => {
    const { entry } = current();
    const [width, height] = sequenceSize(entry.main);
    settings('New composition', 'Create composition', { name:`Composition ${entry.compositions.length+1}`, width, height },
      values => create(values, true));
  };
  $('compositions-open').onclick = () => drawer($('composition-drawer').hidden);
  $('compositions-close').onclick = () => drawer(false);
  document.addEventListener('keydown', event => {
    if (event.key==='Escape' && !dialog.open && !$('composition-drawer').hidden) drawer(false);
  });
  return { renderHome, renderSequences, drawer };
}
