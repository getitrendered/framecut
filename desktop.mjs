import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUpdater, startWindowsUpdate } from './updater.mjs';
import { hasActiveTasks } from './activity.mjs';

const editor = 'framecut://editor/';
const icon = fileURLToPath(new URL('framecut.ico', import.meta.url));
const appId = 'com.framecut.editor';
let window;
let backend;
let checkTimer;

protocol.registerSchemesAsPrivileged([{
  scheme: 'framecut',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}]);
app.setAppUserModelId(appId);
const profile = app.commandLine.getSwitchValue('user-data-dir');
if (profile) {
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}

function executable(name) {
  const relative = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', `${name}.exe`);
  const programFiles = process.env.ProgramFiles && join(process.env.ProgramFiles, 'FFmpeg', 'bin', `${name}.exe`);
  try {
    const paths = execFileSync('where.exe', [`${name}.exe`], { encoding: 'utf8', windowsHide: true });
    return paths.trim().split(/\r?\n/)[0];
  } catch {
    return [relative, programFiles].find(path => path && existsSync(path)) || name;
  }
}

async function start() {
  const token = randomBytes(32).toString('hex');
  process.env.FRAMECUT_PORT = '0';
  process.env.FRAMECUT_DESKTOP_TOKEN = token;
  process.env.FRAMECUT_DATA = join(app.getPath('userData'), 'Library');
  process.env.FRAMECUT_FFMPEG = executable('ffmpeg');
  process.env.FRAMECUT_FFPROBE = executable('ffprobe');
  backend = await import('./server.mjs');
  const origin = await backend.ready;

  protocol.handle('framecut', request => {
    const url = new URL(request.url);
    if (url.host !== 'editor' || url.username || url.password) return new Response(null, { status: 404 });
    const headers = new Headers({ 'X-Framecut-Desktop': token });
    for (const name of ['content-type', 'range', 'x-filename', 'x-framecut','x-file-size']) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    }
    return fetch(origin + url.pathname + url.search, {
      method: request.method, headers,
      body: request.body ?? undefined, duplex: 'half', signal: request.signal, redirect: 'error'
    }).catch(() => new Response(JSON.stringify({ error: 'Framecut could not complete the local request.' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    }));
  });

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    title: 'Framecut',
    width: 1450, height: 920, minWidth: 650, minHeight: 500,
    backgroundColor: '#101316', icon, show: false,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: fileURLToPath(new URL('preload.cjs', import.meta.url))
    }
  });
  if (process.platform === 'win32') {
    window.setAppDetails({
      appId,
      appIconPath: icon,
      relaunchCommand: `"${process.execPath}"`,
      relaunchDisplayName: 'Framecut'
    });
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (target.origin === 'https://www.dji.com' && target.pathname.startsWith('/downloads')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  await configureUpdates();
  ipcMain.handle('framecut:import-video', (event, path) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== editor) {
      throw new Error('The import request must come from the editor window.');
    }
    return backend.importMediaPath(path);
  });
  ipcMain.handle('framecut:save-render', async (event, id) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== editor) {
      throw new Error('The save request must come from the editor window.');
    }
    const render = backend.getRender(id);
    if (!render) throw new Error('Render the video before saving it.');
    const format = render.format.toUpperCase();
    const result = await dialog.showSaveDialog(window, {
      title: `Save ${format}`,
      defaultPath: join(app.getPath('videos'), render.filename),
      filters: [{ name: `${format} video`, extensions: [render.format] }]
    });
    if (result.canceled) return null;
    await copyFile(render.path, result.filePath);
    return result.filePath;
  });
  ipcMain.handle('framecut:save-subtitles',async(event,name,srt)=>{
    if(event.sender!==window.webContents || event.senderFrame?.url!==editor) throw new Error('The save request must come from the editor.');
    if(typeof srt!=='string' || srt.length>1_000_000) throw new Error('The subtitle file is too large.');
    const file=String(name || 'Captions').replace(/[^a-zA-Z0-9 _-]/g,'').trim().slice(0,80) || 'Captions';
    const result=await dialog.showSaveDialog(window,{title:'Save subtitles',defaultPath:join(app.getPath('videos'),file+'.srt'),
      filters:[{name:'SubRip subtitles',extensions:['srt']}]});
    if(result.canceled) return null;
    await writeFile(result.filePath,srt,'utf8');
    return result.filePath;
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(editor);
}

async function configureUpdates() {
  const config=JSON.parse(await readFile(new URL('./update-config.json',import.meta.url),'utf8'));
  const manifest=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8'));
  const profile=app.getPath('userData');
  const cache=join(profile,'Updates');
  const statusFile=join(cache,'update-result.json');
  const checkpoint=join(cache,'project-before-update.json');
  const previous=await readFile(statusFile,'utf8')
    .then(raw=>JSON.parse(raw.replace(/^\uFEFF/,''))).catch(()=>null);
  const updater=createUpdater({
    repository:config.repository, privateRepo:config.private, currentVersion:app.getVersion(), runtimeId:manifest.runtimeId, cache,
    broadcast(state){
      if(window && !window.isDestroyed()) window.webContents.send('framecut:update-state',{...state,previous});
    }
  });
  function register(channel,action){
    ipcMain.handle(channel,(event,...args)=>{
      if(event.sender!==window.webContents || event.senderFrame?.url!==editor) throw new Error('Open Framecut to manage updates.');
      return action(...args);
    });
  }
  register('framecut:update-status',()=>({...updater.snapshot(),previous}));
  register('framecut:update-check',()=>updater.check());
  register('framecut:update-download',()=>updater.download());
  register('framecut:update-restore',()=>readFile(checkpoint,'utf8').catch(()=>null));
  let restarting=false;
  register('framecut:update-install',async raw=>{
    const verified=updater.verifiedInstaller();
    if(!verified || restarting) throw new Error('Download the update before restarting.');
    if(hasActiveTasks()) throw new Error('Wait for active tasks to finish before restarting.');
    if(typeof raw!=='string' || raw.length>8_000_000) throw new Error('Framecut could not save the update checkpoint.');
    const project=JSON.parse(raw);
    if(!project || !Array.isArray(project.clips) || !Array.isArray(project.titles)) throw new Error('Framecut could not save the current project.');
    restarting=true;
    try{
      await mkdir(cache,{recursive:true});
      await writeFile(checkpoint+'.tmp',raw,'utf8');
      await rename(checkpoint+'.tmp',checkpoint);
      window.webContents.session.flushStorageData();
      if(hasActiveTasks()) throw new Error('Wait for active tasks to finish before restarting.');
      await startWindowsUpdate({installer:verified,executable:process.execPath,profile,statusFile});
      setImmediate(()=>app.quit());
    } catch(error) {
      restarting=false;
      throw error;
    }
  });
  const firstCheck=setTimeout(()=>void updater.check(),4000);
  firstCheck.unref();
  checkTimer=setInterval(()=>void updater.check(),30*60*1000);
  checkTimer.unref();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {clearInterval(checkTimer); backend?.stop();});
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('Framecut could not start', error.message);
    app.quit();
  });
}
