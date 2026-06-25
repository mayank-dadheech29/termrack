const { contextBridge, ipcRenderer, webUtils } = require('electron');

// A narrow, safe bridge. The renderer never touches Node or ipcRenderer directly.
contextBridge.exposeInMainWorld('term', {
  create: (id, cols, rows, cwd) => ipcRenderer.send('pty:create', { id, cols, rows, cwd }),
  input: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('pty:kill', { id }),
  cwd: (id) => ipcRenderer.invoke('pty:cwd', { id }),
  flushed: () => ipcRenderer.send('app:flushed'),
  clipboardWrite: (text) => ipcRenderer.send('clip:write', text),
  clipboardRead: () => ipcRenderer.invoke('clip:read'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ''; } },

  onData: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('pty:data', handler);
    return () => ipcRenderer.removeListener('pty:data', handler);
  },
  onExit: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('pty:exit', handler);
    return () => ipcRenderer.removeListener('pty:exit', handler);
  },
  onMenu: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('menu:action', handler);
    return () => ipcRenderer.removeListener('menu:action', handler);
  },
  onFlush: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('app:flush', handler);
    return () => ipcRenderer.removeListener('app:flush', handler);
  },
});
