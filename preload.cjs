const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('framecutDesktop', {
  importVideo: file => {
    const path = webUtils.getPathForFile(file);
    return path ? ipcRenderer.invoke('framecut:import-video', path) : null;
  },
  updates: {
    status:()=>ipcRenderer.invoke('framecut:update-status'),
    check:()=>ipcRenderer.invoke('framecut:update-check'),
    download:()=>ipcRenderer.invoke('framecut:update-download'),
    install:project=>ipcRenderer.invoke('framecut:update-install',project),
    restore:()=>ipcRenderer.invoke('framecut:update-restore'),
    listen:callback=>{ipcRenderer.on('framecut:update-state',(_event,state)=>callback(state));}
  },
  saveRender: id => ipcRenderer.invoke('framecut:save-render', id),
  saveSubtitles: (name,srt) => ipcRenderer.invoke('framecut:save-subtitles',name,srt)
});
