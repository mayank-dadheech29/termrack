const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const os = require('os');
const pty = require('node-pty');

// Keep every live PTY keyed by the id the renderer assigned it.
const ptys = new Map();

const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

// Application menu. Defining our own removes Electron's default View > Zoom
// (CmdOrCtrl +/-/0 used to zoom the whole window); here those keys are routed
// to the renderer as terminal font-size changes instead.
function buildMenu(win) {
  const send = (action) => win.webContents.send('menu:action', action);
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' }, // Copy / Paste / Select All work in the terminal
    {
      label: 'View',
      submenu: [
        { label: 'New Terminal', accelerator: 'CmdOrCtrl+T', click: () => send('new') },
        { label: 'Close Terminal', accelerator: 'CmdOrCtrl+W', click: () => send('close') },
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
      cwd: cwd && cwd.length ? cwd : os.homedir(),
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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
