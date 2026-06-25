const { app, BrowserWindow, ipcMain, Menu, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const pty = require('node-pty');

// Keep every live PTY keyed by the id the renderer assigned it.
const ptys = new Map();
let mainWindow = null;

const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

// Absolute path so it resolves under a packaged app's minimal PATH.
const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((p) => fs.existsSync(p)) || 'lsof';

// Resolve a shell's current working directory from its PID, without touching
// the user's shell config. `lsof` reports the cwd file descriptor for the
// process; event-driven (called on tab-switch / quit), never polled.
function getCwd(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(null);
    execFile(LSOF, ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const line = stdout.split('\n').find((l) => l.startsWith('n'));
      resolve(line ? line.slice(1).trim() : null);
    });
  });
}

// Application menu. Defining our own removes Electron's default View > Zoom
// (CmdOrCtrl +/-/0 used to zoom the whole window); here those keys are routed
// to the renderer as terminal font-size changes instead.
function buildMenu(win) {
  const send = (action) => win.webContents.send('menu:action', action);
  const template = [
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => send('copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => send('paste') },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => send('selectall') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+P', click: () => send('palette') },
        { label: 'Saved Commands…', accelerator: 'CmdOrCtrl+Shift+K', click: () => send('snippets') },
        { type: 'separator' },
        { label: 'New Terminal', accelerator: 'CmdOrCtrl+T', click: () => send('new') },
        { label: 'Close Terminal', accelerator: 'CmdOrCtrl+W', click: () => send('close') },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('reopen') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('toggle-sidebar') },
        { type: 'separator' },
        { label: 'Split Right', accelerator: 'CmdOrCtrl+D', click: () => send('split-right') },
        { label: 'Split Down', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('split-down') },
        { type: 'separator' },
        { label: 'Increase Font Size', accelerator: 'CmdOrCtrl+Plus', click: () => send('font-in') },
        { label: 'Increase Font Size ', accelerator: 'CmdOrCtrl+=', visible: false, acceleratorWorksWhenHidden: true, click: () => send('font-in') },
        { label: 'Decrease Font Size', accelerator: 'CmdOrCtrl+-', click: () => send('font-out') },
        { label: 'Reset Font Size', accelerator: 'CmdOrCtrl+0', click: () => send('font-reset') },
        { type: 'separator' },
        { label: 'Clear', accelerator: 'CmdOrCtrl+K', click: () => send('clear') },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
        { type: 'separator' },
        { label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => win.webContents.toggleDevTools() },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: 'hiddenInset', // native mac traffic lights, no big title bar
    backgroundColor: '#0d0d0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;

  // Keep the music window docked to the corner and grouped with the app.
  win.on('move', followYt);
  win.on('resize', followYt);
  win.on('minimize', () => { if (ytWin && !ytWin.isDestroyed()) ytWin.hide(); });
  win.on('restore', () => { if (ytWin && !ytWin.isDestroyed()) ytWin.show(); });

  // The app loads from file:// (no real origin), so YouTube's embed rejects it
  // with "Error 153". Give requests to YouTube a valid Referer/Origin so the
  // focus-music embed plays.
  win.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.youtube.com/*', '*://*.ytimg.com/*', '*://*.googlevideo.com/*', '*://*.google.com/*'] },
    (details, callback) => {
      details.requestHeaders.Referer = 'https://www.youtube.com/';
      details.requestHeaders.Origin = 'https://www.youtube.com';
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  win.loadFile(path.join(__dirname, 'index.html'));
  buildMenu(win);

  // Lock zoom so trackpad pinch / accidental zoom can't scale the UI.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setVisualZoomLevelLimits(1, 1);
    win.webContents.setZoomFactor(1);
  });

  const send = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // --- PTY lifecycle, driven entirely by the renderer ---

  ipcMain.on('pty:create', (_evt, { id, cols, rows, cwd }) => {
    if (ptys.has(id)) return;

    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: (cwd && cwd.length && fs.existsSync(cwd)) ? cwd : os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    proc.onData((data) => send('pty:data', { id, data }));
    proc.onExit(({ exitCode }) => {
      ptys.delete(id);
      send('pty:exit', { id, exitCode });
    });

    ptys.set(id, proc);
  });

  ipcMain.on('pty:input', (_evt, { id, data }) => {
    const proc = ptys.get(id);
    if (proc) proc.write(data);
  });

  ipcMain.on('pty:resize', (_evt, { id, cols, rows }) => {
    const proc = ptys.get(id);
    if (proc && cols > 0 && rows > 0) {
      try { proc.resize(cols, rows); } catch (_) { /* race on close */ }
    }
  });

  ipcMain.on('pty:kill', (_evt, { id }) => {
    const proc = ptys.get(id);
    if (proc) {
      try { proc.kill(); } catch (_) { /* already gone */ }
      ptys.delete(id);
    }
  });

  win.on('closed', () => {
    for (const proc of ptys.values()) {
      try { proc.kill(); } catch (_) {}
    }
    ptys.clear();
  });
}

// Renderer asks for a session's live cwd (on tab-switch and at quit).
ipcMain.handle('pty:cwd', async (_evt, { id }) => {
  const proc = ptys.get(id);
  return proc ? getCwd(proc.pid) : null;
});

// Clipboard bridge (the sandboxed renderer can't touch the clipboard directly).
ipcMain.on('clip:write', (_evt, text) => { if (typeof text === 'string') clipboard.writeText(text); });
ipcMain.handle('clip:read', () => clipboard.readText());

// Focus-music YouTube playback. Embeds fail for videos whose owners disabled
// embedding, so we play the real youtube.com page in a child window (reliable
// video; a BrowserView only painted after a manual resize). It's parented to the
// main window, so it groups with the app, floats above it, and closes with it —
// and as a real window it's natively draggable, resizable, and minimizable.
let ytWin = null;
let ytSide = 'br'; // tl | tr | bl | br — which corner of the app to dock to
const YT_W = 400;
const YT_H = 232;
const YT_GAP = 20;
function ytCorner() {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: undefined, y: undefined };
  const b = mainWindow.getBounds();
  let w = YT_W;
  let h = YT_H;
  if (ytWin && !ytWin.isDestroyed()) { const s = ytWin.getSize(); w = s[0]; h = s[1]; }
  const left = Math.round(b.x + YT_GAP);
  const right = Math.round(b.x + b.width - w - YT_GAP);
  const top = Math.round(b.y + YT_GAP);
  const bottom = Math.round(b.y + b.height - h - YT_GAP);
  switch (ytSide) {
    case 'tl': return { x: left, y: top };
    case 'tr': return { x: right, y: top };
    case 'bl': return { x: left, y: bottom };
    default: return { x: right, y: bottom };
  }
}
function followYt() {
  if (ytWin && !ytWin.isDestroyed() && mainWindow && !mainWindow.isDestroyed()) {
    const p = ytCorner();
    ytWin.setPosition(p.x, p.y);
  }
}
ipcMain.on('yt:open', (_evt, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  if (ytWin && !ytWin.isDestroyed()) { ytWin.loadURL(url); ytWin.show(); return; }
  const pos = ytCorner();
  ytWin = new BrowserWindow({
    width: YT_W,
    height: YT_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    resizable: true,
    fullscreenable: false,
    minWidth: 280,
    minHeight: 160,
    roundedCorners: true,
    backgroundColor: '#000000',
    parent: mainWindow || undefined,
    webPreferences: { sandbox: true },
  });
  ytWin.loadURL(url);

  // Block fullscreen: a frameless CHILD window going fullscreen moves to its own
  // macOS Space, orphaning the parent terminal (black screen / crash). Neuter the
  // page's fullscreen API and bounce out if it ever slips through.
  ytWin.webContents.on('dom-ready', () => {
    ytWin.webContents.executeJavaScript(
      "(()=>{try{const noop=function(){return Promise.reject(new Error('fs off'));};"
      + "Element.prototype.requestFullscreen=noop;"
      + "if(Element.prototype.webkitRequestFullscreen)Element.prototype.webkitRequestFullscreen=function(){};"
      + "if(Element.prototype.webkitRequestFullScreen)Element.prototype.webkitRequestFullScreen=function(){};"
      + "}catch(e){}})()",
    ).catch(() => {});
  });
  ytWin.webContents.on('enter-html-full-screen', () => {
    try { ytWin.setFullScreen(false); } catch (_) {}
    ytWin.webContents.executeJavaScript('document.exitFullscreen && document.exitFullscreen()').catch(() => {});
  });

  // Keep it pinned to the corner even after the user resizes it.
  ytWin.on('resize', () => { if (mainWindow && !mainWindow.isDestroyed()) followYt(); });
  ytWin.on('closed', () => {
    ytWin = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('yt:closed');
  });
});
ipcMain.on('yt:close', () => { if (ytWin && !ytWin.isDestroyed()) ytWin.close(); });
ipcMain.on('yt:corner', (_evt, side) => {
  if (['tl', 'tr', 'bl', 'br'].includes(side)) { ytSide = side; followYt(); }
});
ipcMain.on('yt:hide', () => { if (ytWin && !ytWin.isDestroyed()) ytWin.hide(); });
ipcMain.on('yt:show', () => { if (ytWin && !ytWin.isDestroyed()) { ytWin.show(); followYt(); } });
ipcMain.on('yt:size', (_evt, s) => {
  if (ytWin && !ytWin.isDestroyed() && s) {
    ytWin.setSize(Math.max(280, s.w | 0), Math.max(160, s.h | 0));
    followYt();
  }
});

// On quit, give the renderer a chance to capture every tab's cwd and persist
// the layout before we tear the PTYs down. Fall back to quitting if it stalls.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
  e.preventDefault();
  mainWindow.webContents.send('app:flush');
  setTimeout(() => { quitting = true; app.quit(); }, 1000);
});
ipcMain.on('app:flushed', () => { quitting = true; app.quit(); });

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
