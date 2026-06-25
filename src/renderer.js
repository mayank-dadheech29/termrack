// Globals from index.html <script> tags:
//   Terminal, FitAddon.FitAddon, WebLinksAddon.WebLinksAddon, SearchAddon.SearchAddon
//   window.term (preload bridge)
//
// Model: a "tab" (sidebar entry) owns a binary tree of "panes"; each pane is a
// real shell. Splitting divides the active pane; the tree renders to nested
// flex containers.

const tabs = new Map();   // tabId -> tab
const panes = new Map();  // paneId -> pane
const closedStack = []; // recently closed tabs & panes, newest last (for ⌘⇧T)
let activeTabId = null;
let counter = 0;
let timerApplyDurations = null; // set by the timer module; lets Settings update it live

const listEl = document.getElementById('session-list');
const termsEl = document.getElementById('terminals');
const emptyEl = document.getElementById('empty-state');

const findbar = document.getElementById('findbar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');

const LS_LAYOUT = 'termrack.layout';

// ---------- Settings (design tokens + terminal/timer options) ----------
const DEFAULT_SETTINGS = {
  theme: 'dark',
  accent: '#4f8cff',
  termFg: null, // override terminal text color (null = use theme)
  termBg: null, // override terminal background color (null = use theme)
  fontFamily: 'Menlo, monospace',
  fontSize: 13,
  scrollback: 10000,
  cursorBlink: true,
  timer: { focus: 25, short: 5, long: 15 },
};
const settings = loadSettings();
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('termrack.settings') || '{}'); } catch (_) {}
  const s = { ...DEFAULT_SETTINGS, ...saved, timer: { ...DEFAULT_SETTINGS.timer, ...(saved.timer || {}) } };
  // One-time migration from the older standalone keys.
  if (!localStorage.getItem('termrack.settings')) {
    const f = parseInt(localStorage.getItem('termrack.font'), 10);
    if (Number.isFinite(f)) s.fontSize = f;
    try {
      const d = JSON.parse(localStorage.getItem('termrack.timer.durations') || 'null');
      if (d) Object.assign(s.timer, d);
    } catch (_) {}
  }
  return s;
}
function saveSettings() { localStorage.setItem('termrack.settings', JSON.stringify(settings)); }

// ---------- Themes ----------
// Each theme provides UI design tokens (CSS vars) + an xterm color set.
// The user's accent color is applied on top of whichever theme is active.
const THEMES = {
  dark: {
    label: 'Dark',
    tokens: { '--bg': '#0d0d0f', '--sidebar-bg': '#161619', '--sidebar-border': '#26262b', '--item-hover': '#1f1f24', '--item-active': '#2b2b33', '--text': '#e6e6e9', '--text-dim': '#8a8a93' },
    xterm: {
      background: '#0d0d0f', foreground: '#e6e6e9', selectionBackground: '#33405e',
      black: '#1c1c20', red: '#ff5f57', green: '#3ecf6b', yellow: '#f5c451',
      blue: '#4f8cff', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdce0',
      brightBlack: '#5c5c66', brightRed: '#ff7b72', brightGreen: '#7ee787',
      brightYellow: '#ffd866', brightBlue: '#79b8ff', brightMagenta: '#d2a8ff',
      brightCyan: '#76e3ea', brightWhite: '#ffffff',
    },
  },
  light: {
    label: 'Light',
    tokens: { '--bg': '#ffffff', '--sidebar-bg': '#f3f3f5', '--sidebar-border': '#e0e0e4', '--item-hover': '#ececef', '--item-active': '#e2e2e8', '--text': '#1c1c20', '--text-dim': '#6b6b73' },
    xterm: {
      background: '#ffffff', foreground: '#24292e', selectionBackground: '#b3d4fc',
      black: '#24292e', red: '#d73a49', green: '#22863a', yellow: '#b08800',
      blue: '#0366d6', magenta: '#6f42c1', cyan: '#1b7c83', white: '#6a737d',
      brightBlack: '#959da5', brightRed: '#cb2431', brightGreen: '#28a745',
      brightYellow: '#dbab09', brightBlue: '#2188ff', brightMagenta: '#8a63d2',
      brightCyan: '#3192aa', brightWhite: '#24292e',
    },
  },
  midnight: {
    label: 'Midnight',
    tokens: { '--bg': '#0a0e1a', '--sidebar-bg': '#0f1422', '--sidebar-border': '#1c2333', '--item-hover': '#161d2e', '--item-active': '#1e2740', '--text': '#dfe6f3', '--text-dim': '#7e89a3' },
    xterm: {
      background: '#0a0e1a', foreground: '#dfe6f3', selectionBackground: '#25406b',
      black: '#1c2333', red: '#ff6b81', green: '#5ad6a0', yellow: '#f5cd6b',
      blue: '#6aa8ff', magenta: '#c891ff', cyan: '#5ec8d8', white: '#dfe6f3',
      brightBlack: '#46506b', brightRed: '#ff8a9b', brightGreen: '#86e8bf',
      brightYellow: '#ffdf94', brightBlue: '#9cc4ff', brightMagenta: '#dcb3ff',
      brightCyan: '#8fe0ec', brightWhite: '#ffffff',
    },
  },
  solarized: {
    label: 'Solarized',
    tokens: { '--bg': '#002b36', '--sidebar-bg': '#073642', '--sidebar-border': '#0d4451', '--item-hover': '#083d49', '--item-active': '#0a4a59', '--text': '#93a1a1', '--text-dim': '#586e75' },
    xterm: {
      background: '#002b36', foreground: '#93a1a1', selectionBackground: '#274642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1',
      brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
      brightCyan: '#94a1a1', brightWhite: '#fdf6e3',
    },
  },
};
function activeTheme() { return THEMES[settings.theme] || THEMES.dark; }
function termTheme() {
  const x = { ...activeTheme().xterm };
  if (settings.termFg) x.foreground = settings.termFg;
  if (settings.termBg) x.background = settings.termBg;
  return { ...x, cursor: settings.accent, cursorAccent: x.background };
}

// Apply design tokens (CSS vars) + accent to the document.
function applyTheme() {
  const t = activeTheme();
  for (const [k, v] of Object.entries(t.tokens)) document.documentElement.style.setProperty(k, v);
  document.documentElement.style.setProperty('--accent', settings.accent);
}
function setTheme(name) {
  if (!THEMES[name]) return;
  settings.theme = name;
  saveSettings();
  applySettings();
}

// Apply every setting to the live UI and all open panes.
function applySettings() {
  applyTheme();
  for (const p of panes.values()) {
    p.term.options.fontFamily = settings.fontFamily;
    p.term.options.fontSize = settings.fontSize;
    p.term.options.scrollback = settings.scrollback;
    p.term.options.cursorBlink = settings.cursorBlink;
    p.term.options.theme = termTheme();
    try { p.fit.fit(); } catch (_) {}
    window.term.resize(p.id, p.term.cols, p.term.rows);
  }
  if (timerApplyDurations) timerApplyDurations();
}
applyTheme(); // set CSS vars at startup (before panes exist)

const SEARCH_OPTS = {
  decorations: {
    matchBackground: '#5b3a00',
    matchOverviewRuler: '#f5c451',
    activeMatchBackground: '#f5c451',
    activeMatchColorOverviewRuler: '#ffd866',
  },
};

function uid() {
  return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

// ---------- Tree helpers ----------
// node: { leaf: paneId }  OR  { dir: 'row'|'col', children: [node, ...] }
function isLeaf(node) { return node && node.leaf !== undefined; }
function countLeaves(node) {
  if (!node) return 0;
  return isLeaf(node) ? 1 : node.children.reduce((n, c) => n + countLeaves(c), 0);
}
function leafIds(node, acc = []) {
  if (!node) return acc;
  if (isLeaf(node)) acc.push(node.leaf);
  else node.children.forEach((c) => leafIds(c, acc));
  return acc;
}
function firstLeafId(node) {
  return isLeaf(node) ? node.leaf : firstLeafId(node.children[0]);
}
function findParent(node, paneId, parent) {
  if (isLeaf(node)) return node.leaf === paneId ? { node, parent } : null;
  for (const child of node.children) {
    const r = findParent(child, paneId, node);
    if (r) return r;
  }
  return null;
}

// Serialize a live pane tree to a plain snapshot (leaves carry their cwd).
function serializeNode(node) {
  if (isLeaf(node)) {
    const p = panes.get(node.leaf);
    return { type: 'leaf', cwd: p ? p.cwd || '' : '' };
  }
  return {
    type: 'split',
    dir: node.dir,
    sizes: (node.sizes || node.children.map(() => 1)).slice(),
    children: node.children.map(serializeNode),
  };
}

// Rebuild a live pane tree from a snapshot, spawning a pane per leaf.
function buildNode(snap, tabId) {
  if (!snap || !snap.children) {
    const p = createPane({ cwd: snap ? snap.cwd || '' : '' });
    p.tabId = tabId;
    return { leaf: p.id };
  }
  return {
    dir: snap.dir === 'col' ? 'col' : 'row',
    sizes: Array.isArray(snap.sizes) ? snap.sizes.slice() : undefined,
    children: snap.children.map((c) => buildNode(c, tabId)),
  };
}

// ---------- Persistence ----------
// Stores tab name/order + each tab's full pane tree (directions, sizes, and
// per-pane cwd). cwds are refreshed on tab-switch and at quit.
function saveLayout() {
  const arr = [...listEl.children].map((li) => {
    const t = tabs.get(li.dataset.id);
    if (!t) return null;
    return { name: t.name, custom: !!t.custom, tree: serializeNode(t.root) };
  }).filter(Boolean);
  localStorage.setItem(LS_LAYOUT, JSON.stringify(arr));
}

async function refreshCwd(pane) {
  if (!pane || !pane.alive) return;
  try {
    const c = await window.term.cwd(pane.id);
    if (c) pane.cwd = c;
  } catch (_) { /* shell gone */ }
}

function activePane() {
  const t = tabs.get(activeTabId);
  return t ? panes.get(t.activePaneId) : null;
}

// ---------- Panes ----------
function createPane(opts) {
  const id = uid();
  const cwd = (opts && opts.cwd) || '';

  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.paneId = id;
  // Attach to the DOM before open() so xterm can measure; renderTab() re-parents
  // it into the right place in the tab's pane tree immediately after.
  termsEl.appendChild(el);

  const term = new Terminal({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    cursorBlink: settings.cursorBlink,
    allowProposedApi: true,
    theme: termTheme(),
    scrollback: settings.scrollback,
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.loadAddon(search);
  term.open(el);

  // Per-pane close button (shown on hover only when the tab is split).
  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close';
  closeBtn.title = 'Close pane (⌘W)';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closePane(id); });
  el.appendChild(closeBtn);

  const pane = { id, term, fit, search, el, alive: true, cwd, tabId: null };
  panes.set(id, pane);

  // Spawn now at a default size; the first fit() emits onResize to correct it.
  window.term.create(id, term.cols || 80, term.rows || 24, cwd);
  term.onData((data) => window.term.input(id, data));
  term.onResize(({ cols, rows }) => window.term.resize(id, cols, rows));

  // Only the active pane is allowed to rename its tab (avoids panes fighting).
  term.onTitleChange((title) => {
    const tab = tabs.get(pane.tabId);
    if (!tab || tab.custom || tab.activePaneId !== id) return;
    if (title && title.trim()) {
      tab.name = title.trim();
      const n = tab.item.querySelector('.name');
      if (n) n.textContent = tab.name;
    }
  });

  // Copy-on-select.
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel && sel.length) window.term.clipboardWrite(sel);
  });

  // Right-click pastes into this pane.
  el.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const text = await window.term.clipboardRead();
    if (text) term.paste(text);
  });

  // Clicking a pane makes it the active one.
  el.addEventListener('mousedown', () => {
    if (pane.tabId) setActivePane(pane.tabId, id);
  });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // ⌘⌫ deletes the whole input line (Ctrl-E then Ctrl-U).
    if (e.metaKey && e.key === 'Backspace') {
      window.term.input(id, '\x05\x15');
      return false;
    }
    // ⌘⌥ + arrows move focus between split panes.
    if (e.metaKey && e.altKey) {
      const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
      if (dir) { focusPaneDir(dir); return false; }
    }
    return true;
  });

  // Keep the find counter live when this is the active pane.
  search.onDidChangeResults((e) => {
    if (activePane() !== pane || findbar.hidden) return;
    findCount.textContent = e && e.resultCount > 0
      ? `${(e.resultIndex ?? -1) + 1}/${e.resultCount}`
      : 'none';
  });

  return pane;
}

// ---------- Tabs ----------
function createTab(opts) {
  const id = uid();
  let name;
  let custom = false;
  if (opts && opts.name) {
    name = opts.name;
    custom = !!opts.custom;
  } else {
    counter += 1;
    name = `Terminal ${counter}`;
  }

  const container = document.createElement('div');
  container.className = 'tab-root';
  container.dataset.id = id;
  termsEl.appendChild(container);

  const item = document.createElement('li');
  item.className = 'session';
  item.dataset.id = id;
  item.draggable = true;
  item.innerHTML = `
    <span class="dot"></span>
    <span class="meta">
      <div class="name"></div>
      <div class="sub">zsh</div>
    </span>
    <button class="close" title="Close">×</button>`;
  item.querySelector('.name').textContent = name;

  // Manual double-click detect (draggable elements suppress native dblclick).
  let lastNameClick = 0;
  item.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) return;
    if (e.target.classList.contains('name')) {
      const now = Date.now();
      if (now - lastNameClick < 350) { lastNameClick = 0; beginRename(tab); return; }
      lastNameClick = now;
    }
    activateTab(id);
  });
  item.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(id);
  });
  wireDrag(item);
  listEl.appendChild(item);

  // Build the pane tree: from a saved tree if present, else a single pane.
  let root;
  if (opts && opts.tree) {
    root = buildNode(opts.tree, id);
  } else {
    const pane = createPane({ cwd: (opts && opts.cwd) || '' });
    pane.tabId = id;
    root = { leaf: pane.id };
  }

  const tab = { id, name, custom, item, container, root, activePaneId: firstLeafId(root) };
  tabs.set(id, tab);

  renderTab(tab);
  activateTab(id);
  return tab;
}

function renderTab(tab) {
  tab.container.innerHTML = '';
  tab.container.appendChild(renderNode(tab.root));
  tab.container.classList.toggle('split-mode', countLeaves(tab.root) > 1);
  updatePaneHighlight(tab);
}

function renderNode(node) {
  if (isLeaf(node)) return panes.get(node.leaf).el;
  const div = document.createElement('div');
  div.className = 'split ' + (node.dir === 'col' ? 'col' : 'row');
  if (!node.sizes || node.sizes.length !== node.children.length) {
    node.sizes = node.children.map(() => 1);
  }
  node.children.forEach((c, i) => {
    const childEl = renderNode(c);
    childEl.style.flex = `${node.sizes[i]} 1 0`;
    div.appendChild(childEl);
    if (i < node.children.length - 1) {
      const divider = document.createElement('div');
      divider.className = 'pane-divider ' + (node.dir === 'col' ? 'col' : 'row');
      attachDividerDrag(divider, node, i);
      div.appendChild(divider);
    }
  });
  return div;
}

// Drag a divider to reweight the two panes it sits between.
function attachDividerDrag(divider, node, i) {
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const tab = tabs.get(activeTabId);
    const dir = node.dir;
    const parentEl = divider.parentElement;
    const childEls = [...parentEl.children].filter((el) => !el.classList.contains('pane-divider'));
    const aEl = childEls[i];
    const bEl = childEls[i + 1];
    if (!aEl || !bEl) return;

    const sizes = node.sizes;
    const startA = sizes[i];
    const startB = sizes[i + 1];
    const sum = startA + startB;
    const aRect = aEl.getBoundingClientRect();
    const bRect = bEl.getBoundingClientRect();
    const pxAB = dir === 'row' ? aRect.width + bRect.width : aRect.height + bRect.height;
    const startPos = dir === 'row' ? e.clientX : e.clientY;
    const growPerPx = sum / Math.max(1, pxAB);
    const minGrow = growPerPx * 60; // keep panes at least ~60px

    divider.classList.add('dragging');
    appEl.classList.add('resizing');
    document.body.style.cursor = dir === 'row' ? 'col-resize' : 'row-resize';

    const move = (ev) => {
      const cur = dir === 'row' ? ev.clientX : ev.clientY;
      let na = startA + (cur - startPos) * growPerPx;
      na = Math.max(minGrow, Math.min(sum - minGrow, na));
      sizes[i] = na;
      sizes[i + 1] = sum - na;
      aEl.style.flex = `${sizes[i]} 1 0`;
      bEl.style.flex = `${sizes[i + 1]} 1 0`;
      if (tab) fitTab(tab);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      divider.classList.remove('dragging');
      appEl.classList.remove('resizing');
      document.body.style.cursor = '';
      if (tab) fitTab(tab);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

function updatePaneHighlight(tab) {
  for (const pid of leafIds(tab.root)) {
    const p = panes.get(pid);
    if (p) p.el.classList.toggle('pane-active', pid === tab.activePaneId);
  }
}

function fitTab(tab) {
  requestAnimationFrame(() => {
    for (const pid of leafIds(tab.root)) {
      const p = panes.get(pid);
      if (p) { try { p.fit.fit(); } catch (_) {} }
    }
  });
}

function activateTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;

  // Capture the cwd of the pane we're leaving so it persists.
  const leaving = tabs.get(activeTabId);
  if (leaving && leaving.id !== id) {
    const lp = panes.get(leaving.activePaneId);
    if (lp) refreshCwd(lp).then(saveLayout);
  }

  activeTabId = id;
  for (const t of tabs.values()) {
    const on = t.id === id;
    t.container.classList.toggle('active', on);
    t.item.classList.toggle('active', on);
  }

  updateEmptyState();
  fitTab(tab);
  requestAnimationFrame(() => {
    const p = panes.get(tab.activePaneId);
    if (p) p.term.focus();
    if (!findbar.hidden) runFind();
  });
}

function setActivePane(tabId, paneId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  activeTabId = tabId;
  tab.activePaneId = paneId;
  updatePaneHighlight(tab);
  const p = panes.get(paneId);
  if (p) requestAnimationFrame(() => { p.fit.fit(); p.term.focus(); if (!findbar.hidden) runFind(); });
}

// Move focus to the nearest pane in a given direction within the active tab.
function focusPaneDir(dir) {
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  const ids = leafIds(tab.root);
  if (ids.length < 2) return;
  const cur = panes.get(tab.activePaneId);
  if (!cur) return;
  const cr = cur.el.getBoundingClientRect();
  const cx = cr.left + cr.width / 2;
  const cy = cr.top + cr.height / 2;

  let best = null;
  let bestDist = Infinity;
  for (const id of ids) {
    if (id === cur.id) continue;
    const r = panes.get(id).el.getBoundingClientRect();
    const dx = (r.left + r.width / 2) - cx;
    const dy = (r.top + r.height / 2) - cy;
    const ok = dir === 'left' ? (dx < 0 && Math.abs(dx) >= Math.abs(dy))
      : dir === 'right' ? (dx > 0 && Math.abs(dx) >= Math.abs(dy))
      : dir === 'up' ? (dy < 0 && Math.abs(dy) >= Math.abs(dx))
      : (dy > 0 && Math.abs(dy) >= Math.abs(dx));
    if (!ok) continue;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) { bestDist = dist; best = id; }
  }
  if (best) setActivePane(tab.id, best);
}

// ---------- Split / close panes ----------
async function splitActive(dir, cwdOverride) {
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  let cwd = cwdOverride || '';
  if (!cwdOverride) {
    const cur = panes.get(tab.activePaneId);
    if (cur) { await refreshCwd(cur); cwd = cur.cwd; }
  }

  const np = createPane({ cwd });
  np.tabId = tab.id;

  const found = findParent(tab.root, tab.activePaneId, null);
  if (found && found.parent && found.parent.dir === dir) {
    const parent = found.parent;
    const idx = parent.children.indexOf(found.node);
    if (!parent.sizes || parent.sizes.length !== parent.children.length) {
      parent.sizes = parent.children.map(() => 1);
    }
    parent.children.splice(idx + 1, 0, { leaf: np.id });
    parent.sizes.splice(idx + 1, 0, 1);
  } else {
    const newSplit = { dir, children: [{ leaf: tab.activePaneId }, { leaf: np.id }], sizes: [1, 1] };
    if (found && found.parent) {
      const idx = found.parent.children.indexOf(found.node);
      found.parent.children[idx] = newSplit;
    } else {
      tab.root = newSplit;
    }
  }

  renderTab(tab);
  setActivePane(tab.id, np.id);
  fitTab(tab);
  saveLayout();
}

function closePane(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  const tab = tabs.get(pane.tabId);
  if (!tab) return;

  // Last pane in the tab → close the whole tab.
  if (countLeaves(tab.root) <= 1) { closeTab(tab.id); return; }

  // Remember the richer layout before whittling it down, so reopening a tab
  // that was closed pane-by-pane (⌘W) brings its splits back.
  tab._reopenTree = serializeNode(tab.root);

  // Remember this single closed pane so ⌘⇧T can split it back into the tab.
  const par = findParent(tab.root, paneId, null);
  closedStack.push({
    kind: 'pane',
    tabId: tab.id,
    cwd: pane.cwd || '',
    dir: par && par.parent ? par.parent.dir : 'row',
  });
  if (closedStack.length > 20) closedStack.shift();

  // Prune the leaf and collapse any now-single-child split, keeping the
  // surviving children's sizes aligned.
  const prune = (node) => {
    if (isLeaf(node)) return node.leaf === paneId ? null : node;
    const kids = [];
    const sizes = [];
    node.children.forEach((c, i) => {
      const r = prune(c);
      if (r) { kids.push(r); sizes.push(node.sizes ? node.sizes[i] : 1); }
    });
    if (kids.length === 0) return null;
    if (kids.length === 1) return kids[0];
    return { dir: node.dir, children: kids, sizes };
  };
  tab.root = prune(tab.root);

  window.term.kill(paneId);
  pane.term.dispose();
  panes.delete(paneId);

  const fid = firstLeafId(tab.root);
  tab.activePaneId = fid;
  renderTab(tab);
  setActivePane(tab.id, fid);
  fitTab(tab);
  saveLayout();
}

function closeActivePane() {
  const tab = tabs.get(activeTabId);
  if (tab) closePane(tab.activePaneId);
}

function reopenClosed() {
  if (!closedStack.length) return;
  const snap = closedStack.pop();
  if (snap.kind === 'pane' && tabs.has(snap.tabId)) {
    // Re-add a single closed pane back into its (still-open) tab.
    activateTab(snap.tabId);
    splitActive(snap.dir || 'row', snap.cwd);
  } else if (snap.kind === 'pane') {
    // Its tab is gone — reopen as a fresh tab in that directory.
    createTab({ cwd: snap.cwd });
  } else {
    createTab(snap); // whole-tab snapshot (has name/custom/tree)
  }
  saveLayout();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  // Snapshot for reopen (⌘⇧T). If the tab was whittled to one pane via ⌘W, use
  // the richer pre-close layout; if closed as a whole (sidebar ×), use current.
  const tree = (tab._reopenTree && countLeaves(tab.root) <= 1)
    ? tab._reopenTree
    : serializeNode(tab.root);
  closedStack.push({ kind: 'tab', name: tab.name, custom: tab.custom, tree });
  if (closedStack.length > 20) closedStack.shift();

  for (const pid of leafIds(tab.root)) {
    const p = panes.get(pid);
    if (p) { window.term.kill(pid); p.term.dispose(); panes.delete(pid); }
  }
  tab.container.remove();
  tab.item.remove();
  tabs.delete(id);
  saveLayout();

  if (activeTabId === id) {
    const next = [...tabs.keys()].pop();
    activeTabId = null;
    if (next) activateTab(next);
    else updateEmptyState();
  }
}

function updateEmptyState() {
  emptyEl.style.display = tabs.size === 0 ? 'flex' : 'none';
}

// ---------- Rename (double-click) ----------
function beginRename(tab) {
  const item = tab.item;
  const nameEl = item.querySelector('.name');
  if (!nameEl) return;
  item.draggable = false;

  const input = document.createElement('input');
  input.className = 'name-edit';
  input.value = tab.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    const span = document.createElement('div');
    span.className = 'name';
    if (save && v) { tab.name = v; tab.custom = true; }
    span.textContent = tab.name;
    input.replaceWith(span);
    item.draggable = true;
    if (save && v) saveLayout();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

// ---------- Drag to reorder tabs ----------
function wireDrag(item) {
  item.addEventListener('dragstart', (e) => {
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    saveLayout();
  });
}
listEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  const dragging = listEl.querySelector('.dragging');
  if (!dragging) return;
  const after = getDragAfterElement(e.clientY);
  if (after == null) listEl.appendChild(dragging);
  else listEl.insertBefore(dragging, after);
});
function getDragAfterElement(y) {
  const els = [...listEl.querySelectorAll('.session:not(.dragging)')];
  let closest = { offset: -Infinity, element: null };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
  }
  return closest.element;
}

// ---------- Font size ----------
function setFont(n) {
  settings.fontSize = Math.max(8, Math.min(28, n));
  for (const p of panes.values()) {
    p.term.options.fontSize = settings.fontSize;
    try { p.fit.fit(); } catch (_) {}
    window.term.resize(p.id, p.term.cols, p.term.rows);
  }
  saveSettings();
}

// ---------- Clear / Copy / Paste / Select All (active pane) ----------
function clearActive() {
  const p = activePane();
  if (p) p.term.clear();
}
// When any text field is focused, ⌘C/⌘V/⌘A act on it (not the terminal).
function focusedInput() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el : null;
}
function copyActive() {
  const el = focusedInput();
  if (el) {
    const t = (el.value || '').substring(el.selectionStart || 0, el.selectionEnd || 0);
    if (t) window.term.clipboardWrite(t);
    return;
  }
  const p = activePane();
  if (!p) return;
  const sel = p.term.getSelection();
  if (sel && sel.length) window.term.clipboardWrite(sel);
}
async function pasteActive() {
  const text = await window.term.clipboardRead();
  if (!text) return;
  const el = focusedInput();
  if (el) {
    const a = el.selectionStart != null ? el.selectionStart : el.value.length;
    const b = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    el.value = el.value.slice(0, a) + text + el.value.slice(b);
    const pos = a + text.length;
    try { el.selectionStart = el.selectionEnd = pos; } catch (_) {}
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const p = activePane();
  if (p) p.term.paste(text);
}
function selectAllActive() {
  const el = focusedInput();
  if (el) { el.select(); return; }
  const p = activePane();
  if (p) p.term.selectAll();
}

// ---------- Find ----------
function showFind() { findbar.hidden = false; findInput.focus(); findInput.select(); runFind(); }
function hideFind() {
  findbar.hidden = true;
  const p = activePane();
  if (p) { if (p.search.clearDecorations) p.search.clearDecorations(); p.term.focus(); }
  findCount.textContent = '';
}
function toggleFind() { if (findbar.hidden) showFind(); else hideFind(); }
function runFind(dir) {
  const p = activePane();
  if (!p) return;
  const q = findInput.value;
  if (!q) {
    if (p.search.clearDecorations) p.search.clearDecorations();
    findCount.textContent = '';
    return;
  }
  if (dir === 'prev') p.search.findPrevious(q, SEARCH_OPTS);
  else p.search.findNext(q, SEARCH_OPTS);
}
findInput.addEventListener('input', () => runFind());
findInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); runFind(e.shiftKey ? 'prev' : 'next'); }
  else if (e.key === 'Escape') { e.preventDefault(); hideFind(); }
});
document.getElementById('find-next').addEventListener('click', () => runFind('next'));
document.getElementById('find-prev').addEventListener('click', () => runFind('prev'));
document.getElementById('find-close').addEventListener('click', hideFind);

// ---------- PTY -> renderer ----------
window.term.onData(({ id, data }) => {
  const p = panes.get(id);
  if (p) p.term.write(data);
});
window.term.onExit(({ id }) => {
  const p = panes.get(id);
  if (!p) return;
  p.alive = false;
  p.term.write('\r\n\x1b[90m[process exited — ⌘W to close]\x1b[0m\r\n');
});

// ---------- Quit flush: capture every pane's cwd, then persist ----------
window.term.onFlush(async () => {
  try {
    await Promise.all([...panes.values()].map(refreshCwd));
    saveLayout();
  } finally {
    window.term.flushed();
  }
});

// ---------- Menu actions ----------
window.term.onMenu((action) => {
  switch (action) {
    case 'new': createTab(); saveLayout(); break;
    case 'close': closeActivePane(); break;
    case 'reopen': reopenClosed(); break;
    case 'split-right': splitActive('row'); break;
    case 'split-down': splitActive('col'); break;
    case 'font-in': setFont(settings.fontSize + 1); break;
    case 'font-out': setFont(settings.fontSize - 1); break;
    case 'font-reset': setFont(13); break;
    case 'settings': openSettings(); break;
    case 'clear': clearActive(); break;
    case 'find': toggleFind(); break;
    case 'copy': copyActive(); break;
    case 'paste': pasteActive(); break;
    case 'selectall': selectAllActive(); break;
    case 'toggle-sidebar': toggleSidebar(); break;
    case 'palette': palette.open(); break;
  }
});

// ---------- Window + keyboard ----------
window.addEventListener('resize', () => {
  const tab = tabs.get(activeTabId);
  if (tab) fitTab(tab);
});

document.getElementById('new-session').addEventListener('click', () => {
  createTab();
  saveLayout();
});

// ⌘1–9 jumps to a tab.
window.addEventListener('keydown', (e) => {
  if (!e.metaKey) return;
  if (e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key, 10) - 1;
    const ids = [...listEl.children].map((li) => li.dataset.id);
    if (ids[idx]) { e.preventDefault(); activateTab(ids[idx]); }
  }
});

// ---------- Sidebar collapse + drag-resize ----------
const appEl = document.getElementById('app');
const resizerEl = document.getElementById('resizer');
const LS_SIDEBAR_W = 'termrack.sidebarWidth';
const LS_SIDEBAR_COLLAPSED = 'termrack.sidebarCollapsed';

function fitActiveTerm() {
  const tab = tabs.get(activeTabId);
  if (tab) fitTab(tab);
}

(function sidebar() {
  const savedW = parseInt(localStorage.getItem(LS_SIDEBAR_W), 10);
  if (Number.isFinite(savedW)) appEl.style.setProperty('--sidebar-width', `${savedW}px`);
  if (localStorage.getItem(LS_SIDEBAR_COLLAPSED) === '1') appEl.classList.add('sidebar-collapsed');

  let dragging = false;
  resizerEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    resizerEl.classList.add('dragging');
    appEl.classList.add('resizing'); // suppress width transition while dragging
    document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.max(160, Math.min(440, e.clientX));
    appEl.style.setProperty('--sidebar-width', `${w}px`);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizerEl.classList.remove('dragging');
    appEl.classList.remove('resizing');
    document.body.style.cursor = '';
    const w = parseInt(getComputedStyle(appEl).getPropertyValue('--sidebar-width'), 10);
    if (Number.isFinite(w)) localStorage.setItem(LS_SIDEBAR_W, String(w));
    fitActiveTerm();
  });

  // Re-fit terminals once the collapse/expand animation finishes.
  document.getElementById('sidebar').addEventListener('transitionend', (e) => {
    if (e.propertyName === 'width') fitActiveTerm();
  });
})();

// ---------- Tools section collapse ----------
(function tools() {
  const el = document.getElementById('tools');
  const btn = document.getElementById('tools-toggle');
  const LS = 'termrack.toolsCollapsed';
  if (localStorage.getItem(LS) === '1') el.classList.add('collapsed');
  btn.addEventListener('click', () => {
    const collapsed = el.classList.toggle('collapsed');
    localStorage.setItem(LS, collapsed ? '1' : '0');
  });
})();

function toggleSidebar() {
  const collapsed = appEl.classList.toggle('sidebar-collapsed');
  localStorage.setItem(LS_SIDEBAR_COLLAPSED, collapsed ? '1' : '0');
  fitActiveTerm();
}

// ---------- Command palette (⌘P) ----------
const palette = (function paletteModule() {
  const overlay = document.getElementById('palette-overlay');
  const input = document.getElementById('palette-input');
  const list = document.getElementById('palette-list');
  let items = [];
  let filtered = [];
  let sel = 0;

  function actions() {
    const a = [
      { label: 'New Terminal', hint: '⌘T', run: () => { createTab(); saveLayout(); } },
      { label: 'Close Pane', hint: '⌘W', run: () => closeActivePane() },
      { label: 'Reopen Closed Tab / Pane', hint: '⌘⇧T', run: () => reopenClosed() },
      { label: 'Split Right', hint: '⌘D', run: () => splitActive('row') },
      { label: 'Split Down', hint: '⌘⇧D', run: () => splitActive('col') },
      { label: 'Toggle Sidebar', hint: '⌘B', run: () => toggleSidebar() },
      { label: 'Find', hint: '⌘F', run: () => toggleFind() },
      { label: 'Clear Terminal', hint: '⌘K', run: () => clearActive() },
      { label: 'Increase Font Size', hint: '⌘+', run: () => setFont(settings.fontSize + 1) },
      { label: 'Decrease Font Size', hint: '⌘-', run: () => setFont(settings.fontSize - 1) },
      { label: 'Reset Font Size', hint: '⌘0', run: () => setFont(13) },
      { label: 'Open Settings', hint: '⌘,', run: () => openSettings() },
    ];
    for (const key of Object.keys(THEMES)) {
      a.push({ label: `Theme: ${THEMES[key].label}`, hint: '', run: () => setTheme(key) });
    }
    // Jump to any open tab.
    [...listEl.children].forEach((li, i) => {
      const t = tabs.get(li.dataset.id);
      if (t) a.push({ label: `Go to: ${t.name}`, hint: i < 9 ? `⌘${i + 1}` : '', run: () => activateTab(t.id) });
    });
    return a;
  }

  function render() {
    list.innerHTML = '';
    if (!filtered.length) {
      const li = document.createElement('li');
      li.id = 'palette-empty';
      li.textContent = 'No matching command';
      list.appendChild(li);
      return;
    }
    filtered.forEach((it, i) => {
      const li = document.createElement('li');
      if (i === sel) li.className = 'sel';
      const label = document.createElement('span');
      label.textContent = it.label;
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = it.hint || '';
      li.append(label, hint);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); run(it); });
      li.addEventListener('mousemove', () => { sel = i; paint(); });
      list.appendChild(li);
    });
  }
  function paint() {
    [...list.children].forEach((li, i) => li.classList.toggle('sel', i === sel));
  }
  function applyFilter() {
    const q = input.value.trim().toLowerCase();
    filtered = q ? items.filter((it) => it.label.toLowerCase().includes(q)) : items.slice();
    sel = 0;
    render();
  }
  function run(it) { close(); if (it && it.run) it.run(); }
  function open() {
    items = actions();
    input.value = '';
    filtered = items.slice();
    sel = 0;
    overlay.hidden = false;
    render();
    input.focus();
  }
  function close() {
    overlay.hidden = true;
    const p = activePane();
    if (p) p.term.focus();
  }

  input.addEventListener('input', applyFilter);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); paint(); ensureVisible(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); ensureVisible(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(filtered[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  function ensureVisible() {
    const li = list.children[sel];
    if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
  }
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

  return { open, close };
})();

// ---------- Settings panel (⌘,) ----------
const settingsOverlay = document.getElementById('settings-overlay');

function refreshColorPickers() {
  document.getElementById('set-fg').value = settings.termFg || activeTheme().xterm.foreground;
  document.getElementById('set-bg').value = settings.termBg || activeTheme().xterm.background;
}
function openSettings() {
  document.getElementById('set-theme').value = settings.theme;
  document.getElementById('set-accent').value = settings.accent;
  refreshColorPickers();
  document.getElementById('set-fontfamily').value = settings.fontFamily;
  document.getElementById('set-fontsize').value = settings.fontSize;
  document.getElementById('set-scrollback').value = settings.scrollback;
  document.getElementById('set-cursorblink').checked = settings.cursorBlink;
  document.getElementById('set-tfocus').value = settings.timer.focus;
  document.getElementById('set-tshort').value = settings.timer.short;
  document.getElementById('set-tlong').value = settings.timer.long;
  settingsOverlay.hidden = false;
}
function closeSettings() {
  settingsOverlay.hidden = true;
  const p = activePane();
  if (p) p.term.focus();
}

(function wireSettings() {
  const onInput = (id, fn) => document.getElementById(id).addEventListener('input', fn);
  const clampInt = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

  document.getElementById('set-theme').addEventListener('change', (e) => { setTheme(e.target.value); refreshColorPickers(); });
  onInput('set-accent', (e) => { settings.accent = e.target.value; saveSettings(); applySettings(); });
  onInput('set-fg', (e) => { settings.termFg = e.target.value; saveSettings(); applySettings(); });
  onInput('set-bg', (e) => { settings.termBg = e.target.value; saveSettings(); applySettings(); });
  document.getElementById('set-colors-reset').addEventListener('click', () => {
    settings.termFg = null;
    settings.termBg = null;
    saveSettings();
    applySettings();
    refreshColorPickers();
  });
  onInput('set-fontfamily', (e) => { settings.fontFamily = e.target.value; saveSettings(); applySettings(); });
  onInput('set-fontsize', (e) => { const v = clampInt(e.target.value, 8, 28); if (v) { settings.fontSize = v; saveSettings(); applySettings(); } });
  onInput('set-scrollback', (e) => { const v = clampInt(e.target.value, 100, 100000); if (v) { settings.scrollback = v; saveSettings(); applySettings(); } });
  document.getElementById('set-cursorblink').addEventListener('change', (e) => { settings.cursorBlink = e.target.checked; saveSettings(); applySettings(); });
  onInput('set-tfocus', (e) => { const v = clampInt(e.target.value, 1, 180); if (v) { settings.timer.focus = v; saveSettings(); if (timerApplyDurations) timerApplyDurations(); } });
  onInput('set-tshort', (e) => { const v = clampInt(e.target.value, 1, 180); if (v) { settings.timer.short = v; saveSettings(); if (timerApplyDurations) timerApplyDurations(); } });
  onInput('set-tlong', (e) => { const v = clampInt(e.target.value, 1, 180); if (v) { settings.timer.long = v; saveSettings(); if (timerApplyDurations) timerApplyDurations(); } });

  document.getElementById('settings-done').addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('mousedown', (e) => { if (e.target === settingsOverlay) closeSettings(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsOverlay.hidden) { e.preventDefault(); closeSettings(); }
  });
})();

// ---------- Pomodoro timer ----------
// Focus / short break / long break (after every 4th focus). Durations are
// configurable (click the time when stopped). setInterval runs only while
// counting down — zero idle cost when off. Tracks focus sessions per day.
(function timer() {
  const LABELS = { focus: 'Focus', short: 'Break', long: 'Long Break' };
  const LS_TODAY = 'termrack.timer.today';

  const root = document.getElementById('timer');
  const modeEl = document.getElementById('timer-mode');
  const displayEl = document.getElementById('timer-display');
  const toggleBtn = document.getElementById('timer-toggle');
  const todayEl = document.getElementById('timer-today');

  // Durations come from Settings (minutes).
  const dur = (m) => settings.timer[m] * 60;

  // "Completed focus sessions today", reset when the date rolls over.
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
  let today = { date: todayKey(), count: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(LS_TODAY) || 'null');
    if (saved && saved.date === today.date) today = saved;
  } catch (_) {}
  const saveToday = () => localStorage.setItem(LS_TODAY, JSON.stringify(today));
  function bumpToday() {
    if (today.date !== todayKey()) today = { date: todayKey(), count: 0 };
    today.count += 1;
    saveToday();
  }

  let mode = 'focus';
  let remaining = dur(mode);
  let running = false;
  let handle = null;
  let completedFocus = 0;

  function render() {
    const m = Math.floor(remaining / 60).toString().padStart(2, '0');
    const s = (remaining % 60).toString().padStart(2, '0');
    if (!displayEl.classList.contains('editing')) displayEl.textContent = `${m}:${s}`;
    modeEl.textContent = LABELS[mode];
    root.dataset.mode = mode;
    toggleBtn.textContent = running ? '⏸' : '▶';
    todayEl.textContent = `🍅 ${today.count} today`;
  }
  function setMode(m) { mode = m; remaining = dur(m); render(); }
  function start() { if (running) return; running = true; handle = setInterval(tick, 1000); render(); }
  function pause() { running = false; if (handle) { clearInterval(handle); handle = null; } render(); }
  function tick() { remaining -= 1; if (remaining <= 0) { phaseEnd(); return; } render(); }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      osc.start();
      osc.stop(ctx.currentTime + 0.6);
    } catch (_) { /* audio unavailable */ }
  }
  function notify(title, body) {
    try { new Notification(title, { body, silent: false }); } catch (_) {}
  }

  function phaseEnd() {
    pause();
    root.classList.remove('done'); void root.offsetWidth; root.classList.add('done');
    beep();
    let next;
    if (mode === 'focus') {
      completedFocus += 1;
      bumpToday();
      next = completedFocus % 4 === 0 ? 'long' : 'short';
      notify('Focus complete', `Nice work — time for a ${next === 'long' ? 'long ' : ''}break.`);
    } else {
      next = 'focus';
      notify('Break over', 'Back to focus.');
    }
    setMode(next);
    start();
  }

  // Click the time to edit the current mode's minutes (pauses if running).
  function editDuration() {
    if (displayEl.classList.contains('editing')) return;
    if (running) pause();
    displayEl.classList.add('editing');
    const input = document.createElement('input');
    input.id = 'timer-edit';
    input.type = 'text';
    input.inputMode = 'numeric';
    input.maxLength = 3;
    input.value = String(settings.timer[mode]);
    input.setAttribute('aria-label', 'Minutes');
    // Only allow digits as the user types.
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^0-9]/g, '');
    });
    displayEl.textContent = '';
    displayEl.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const v = parseInt(input.value, 10);
      if (save && Number.isFinite(v) && v >= 1 && v <= 180) {
        settings.timer[mode] = v;
        saveSettings();
        remaining = dur(mode);
      }
      displayEl.classList.remove('editing');
      render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', () => commit(true));
  }

  toggleBtn.addEventListener('click', () => (running ? pause() : start()));
  document.getElementById('timer-reset').addEventListener('click', () => { pause(); setMode(mode); });
  document.getElementById('timer-skip').addEventListener('click', () => {
    pause();
    setMode(mode === 'focus' ? 'short' : 'focus');
  });
  displayEl.addEventListener('click', editDuration);

  // Let Settings update durations live (only resets the clock when stopped).
  timerApplyDurations = () => { if (!running) { remaining = dur(mode); render(); } };

  render();
})();

// ---------- YouTube player window ----------
// Plays the real youtube.com page in a child window (reliable video; a docked
// BrowserView only painted after a manual resize). The OS window gives native
// drag / resize / minimize.
const ytdock = {
  show: (url) => window.term.ytOpen(url),
  hide: () => window.term.ytClose(),
};

// ---------- Focus music ----------
// Local file, direct audio URL, or YouTube (hidden iframe). Manual play only;
// source + volume persist across restarts.
(function music() {
  const LS_MUSIC = 'termrack.music';
  const input = document.getElementById('music-input');
  const toggleBtn = document.getElementById('music-toggle');
  const pickBtn = document.getElementById('music-pick');
  const fileInput = document.getElementById('music-file');
  const vol = document.getElementById('music-vol');
  const status = document.getElementById('music-status');
  const ytBox = document.getElementById('music-yt');
  const dockBtns = [...document.querySelectorAll('#music-dock button[data-corner]')];
  const ytMinBtn = document.getElementById('yt-min');
  const ytSmallerBtn = document.getElementById('yt-smaller');
  const ytLargerBtn = document.getElementById('yt-larger');
  const LS_CORNER = 'termrack.ytcorner';
  const LS_SIZE = 'termrack.ytsize';

  if (ytBox) ytBox.remove(); // legacy inline embed element, no longer used

  const audio = new Audio();
  audio.loop = true;

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_MUSIC) || '{}'); } catch (_) {}
  let volume = typeof saved.volume === 'number' ? saved.volume : 0.6;
  let playing = false;
  let ytActive = false; // YouTube playing in the docked window
  let corner = localStorage.getItem(LS_CORNER) || 'br';
  input.value = saved.src || '';
  vol.value = String(Math.round(volume * 100));
  audio.volume = volume;

  function applyCornerUI() { dockBtns.forEach((b) => b.classList.toggle('active', b.dataset.corner === corner)); }
  applyCornerUI();
  dockBtns.forEach((b) => b.addEventListener('click', () => {
    corner = b.dataset.corner;
    localStorage.setItem(LS_CORNER, corner);
    applyCornerUI();
    window.term.ytSetCorner(corner);
  }));

  // Video window size (persisted) and minimize state.
  const ASPECT = 232 / 400;
  let size = { w: 400, h: 232 };
  try { Object.assign(size, JSON.parse(localStorage.getItem(LS_SIZE) || '{}')); } catch (_) {}
  let ytMinimized = false;
  const saveSize = () => localStorage.setItem(LS_SIZE, JSON.stringify(size));
  function applySize() { window.term.ytSize(size); }
  function resizeBy(factor) {
    size.w = Math.round(Math.max(280, Math.min(900, size.w * factor)));
    size.h = Math.round(size.w * ASPECT);
    saveSize();
    if (ytActive && !ytMinimized) applySize();
  }
  ytSmallerBtn.addEventListener('click', () => resizeBy(1 / 1.15));
  ytLargerBtn.addEventListener('click', () => resizeBy(1.15));
  ytMinBtn.addEventListener('click', () => {
    if (!ytActive) return;
    ytMinimized = !ytMinimized;
    if (ytMinimized) window.term.ytHide(); else window.term.ytShow();
  });

  const save = () => localStorage.setItem(LS_MUSIC, JSON.stringify({ src: input.value.trim(), volume }));
  const setBtn = () => { toggleBtn.textContent = playing ? '⏸' : '▶'; };
  const setStatus = (m) => { status.textContent = m || ''; };

  function parse(str) {
    const s = (str || '').trim();
    if (!s) return null;
    // Keep the full URL for YouTube so playlists / radio mixes are preserved.
    if (/(?:youtube\.com\/|youtu\.be\/)/i.test(s)) return { type: 'youtube', url: s };
    if (/^https?:\/\//i.test(s)) return { type: 'url', url: s };
    return { type: 'file', path: s };
  }

  function toFileUrl(p) {
    if (/^file:\/\//i.test(p)) return p;
    return 'file://' + p.split('/').map(encodeURIComponent).join('/');
  }

  function play() {
    const src = parse(input.value);
    if (!src) { setStatus('Add a file or URL'); return; }
    save();
    if (src.type === 'youtube') {
      audio.pause();
      ytMinimized = false;
      window.term.ytSetCorner(corner); // dock to the chosen corner before opening
      ytdock.show(src.url);
      window.term.ytSize(size);        // apply saved size
      ytActive = true;
      playing = true; setBtn();
      setStatus('YouTube — docked player');
    } else {
      if (ytActive) { ytdock.hide(); ytActive = false; }
      const url = src.type === 'file' ? toFileUrl(src.path) : src.url;
      if (audio.src !== url) audio.src = url;
      audio.volume = volume;
      audio.play()
        .then(() => { playing = true; setBtn(); setStatus(''); })
        .catch(() => { setStatus('Couldn’t play that source'); });
    }
  }
  function pause() {
    if (ytActive) { ytdock.hide(); ytActive = false; } else audio.pause();
    playing = false; setBtn();
  }
  function toggle() { if (playing) pause(); else play(); }

  toggleBtn.addEventListener('click', toggle);
  input.addEventListener('change', () => { save(); if (playing) { pause(); play(); } });
  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (f) {
      const p = window.term.pathForFile(f) || f.path || '';
      if (p) { input.value = p; save(); setStatus(f.name); }
    }
    fileInput.value = '';
  });
  vol.addEventListener('input', () => {
    volume = Math.max(0, Math.min(1, parseInt(vol.value, 10) / 100));
    audio.volume = volume;
    save();
  });
  audio.addEventListener('error', () => { if (!ytActive) setStatus('Couldn’t load audio'); });

  // If the user closes the popout window, reflect that in the UI.
  window.term.onYtClosed(() => { if (ytActive) { ytActive = false; ytMinimized = false; playing = false; setBtn(); } });
})();

// ---------- Boot: restore saved layout, else one fresh terminal ----------
(function boot() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(LS_LAYOUT) || '[]'); } catch (_) {}
  if (Array.isArray(saved) && saved.length) {
    counter = saved.length;
    saved.forEach((o) => createTab(o));
    activateTab([...tabs.keys()][0]);
  } else {
    createTab();
    saveLayout();
  }
})();
