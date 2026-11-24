export function setupUpdates(prepareProject) {
  const api = window.framecutDesktop?.updates;
  if (!api) return;
  const element = id => document.getElementById(id);
  const panel = element('updates-dialog');
  const open = element('updates-open');
  const check = element('updates-check');
  const download = element('updates-download');
  const install = element('updates-install');
  const progress = element('updates-progress');
  const status = element('updates-status');
  const notes = element('updates-notes');
  let announced;
  let restarting = false;

  function paint(state) {
    if (restarting) return;
    const available = ['available','downloading','downloaded'].includes(state.phase);
    const downloading = state.phase === 'downloading';
    open.classList.toggle('update-available',available);
    open.textContent = available ? (downloading ? `Update ${state.progress}%` : 'New update') : 'Updates';
    check.disabled = state.phase === 'checking' || downloading;
    check.hidden = available;
    download.hidden = state.phase !== 'available';
    install.hidden = state.phase !== 'downloaded';
    install.disabled = false;
    progress.hidden = !downloading;
    if (downloading) progress.value = state.progress;
    element('updates-version').textContent = available
      ? `Framecut ${state.currentVersion} → ${state.version}` : `Installed version ${state.currentVersion}`;
    notes.hidden = !available;
    notes.textContent = available ? (state.notes || 'This release has no notes.') : '';
    status.textContent = state.error || ({
      checking:'Checking GitHub…', current:state.previous?.ok ? `Updated to Framecut ${state.previous.version}.` : 'Framecut is up to date.',
      available:state.title, downloading:`Downloading from GitHub · ${state.progress}%`,
      downloaded:'Update verified. Save and Restart will keep your current project and install it.'
    })[state.phase] || (state.previous && !state.previous.ok ? state.previous.error : '');
    if(state.phase==='available' && announced!==state.version){
      announced=state.version;
      if(!panel.open) panel.showModal();
    }
  }

  async function call(action) {
    try { paint(await action()); }
    catch(error) { status.textContent=error.message; }
  }

  open.hidden=false;
  open.onclick=()=>{ if(!panel.open) panel.showModal(); void call(api.status); };
  element('updates-close').onclick=()=>panel.close();
  check.onclick=()=>void call(api.check);
  download.onclick=()=>void call(api.download);
  install.onclick=async()=>{
    if(restarting)return;
    restarting=true;
    install.disabled=true;
    status.textContent='Saving project and restarting…';
    try { await api.install(prepareProject()); }
    catch(error) {
      restarting=false;
      install.disabled=false;
      status.textContent=error.message;
    }
  };
  api.listen(paint);
  void call(api.status);
}
