// Globals from index.html <script> tags:
//   Terminal, FitAddon.FitAddon, WebLinksAddon.WebLinksAddon, SearchAddon.SearchAddon
//   window.term (preload bridge)
//
// Model: a "tab" (sidebar entry) owns a binary tree of "panes"; each pane is a
// real shell. Splitting divides the active pane; the tree renders to nested
// flex containers.

const tabs = new Map();   // tabId -> tab
const panes = new Map();  // paneId -> pane
const closedTabs = [];    // stack of recently closed tab snapshots (for ⌘⇧T)
let activeTabId = null;
let counter = 0;
let fontSize = loadFontSize();

const listEl = document.getElementById('session-list');
const termsEl = document.getElementById('terminals');
const emptyEl = document.getElementById('empty-state');

const findbar = document.getElementById('findbar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');

const LS_FONT = 'termrack.font';
const LS_LAYOUT = 'termrack.layout';

const THEME = {
  background: '#0d0d0f',
  foreground: '#e6e6e9',
  cursor: '#4f8cff',
  selectionBackground: '#33405e',
  black: '#1c1c20', red: '#ff5f57', green: '#3ecf6b', yellow: '#f5c451',
  blue: '#4f8cff', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdce0',
  brightBlack: '#5c5c66', brightRed: '#ff7b72', brightGreen: '#7ee787',
  brightYellow: '#ffd866', brightBlue: '#79b8ff', brightMagenta: '#d2a8ff',
  brightCyan: '#76e3ea', brightWhite: '#ffffff',
};

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
function loadFontSize() {
  const n = parseInt(localStorage.getItem('termrack.font'), 10);
  return Number.isFinite(n) ? n : 13;
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
    fontFamily: 'Menlo, "SF Mono", Monaco, "Courier New", monospace',
    fontSize: fontSize,
    cursorBlink: true,
    allowProposedApi: true,
    theme: THEME,
    scrollback: 10000,
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
async function splitActive(dir) {
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  const cur = panes.get(tab.activePaneId);
  let cwd = '';
  if (cur) { await refreshCwd(cur); cwd = cur.cwd; }

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
  if (!closedTabs.length) return;
  createTab(closedTabs.pop());
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
  closedTabs.push({ name: tab.name, custom: tab.custom, tree });
  if (closedTabs.length > 10) closedTabs.shift();

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
  fontSize = Math.max(8, Math.min(28, n));
  for (const p of panes.values()) {
    p.term.options.fontSize = fontSize;
    try { p.fit.fit(); } catch (_) {}
    window.term.resize(p.id, p.term.cols, p.term.rows);
  }
  localStorage.setItem(LS_FONT, String(fontSize));
}

// ---------- Clear / Copy / Paste / Select All (active pane) ----------
function clearActive() {
  const p = activePane();
  if (p) p.term.clear();
}
function copyActive() {
  if (document.activeElement === findInput) {
    const t = findInput.value.substring(findInput.selectionStart, findInput.selectionEnd);
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
  if (document.activeElement === findInput) {
    const a = findInput.selectionStart;
    const b = findInput.selectionEnd;
    findInput.value = findInput.value.slice(0, a) + text + findInput.value.slice(b);
    findInput.selectionStart = findInput.selectionEnd = a + text.length;
    runFind();
    return;
  }
  const p = activePane();
  if (p) p.term.paste(text);
}
function selectAllActive() {
  if (document.activeElement === findInput) { findInput.select(); return; }
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
    case 'font-in': setFont(fontSize + 1); break;
    case 'font-out': setFont(fontSize - 1); break;
    case 'font-reset': setFont(13); break;
    case 'clear': clearActive(); break;
    case 'find': toggleFind(); break;
    case 'copy': copyActive(); break;
    case 'paste': pasteActive(); break;
    case 'selectall': selectAllActive(); break;
    case 'toggle-sidebar': toggleSidebar(); break;
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

function toggleSidebar() {
  const collapsed = appEl.classList.toggle('sidebar-collapsed');
  localStorage.setItem(LS_SIDEBAR_COLLAPSED, collapsed ? '1' : '0');
  fitActiveTerm();
}

// ---------- Pomodoro timer ----------
// Focus / short break / long break (after every 4th focus). Durations are
// configurable (click the time when stopped). setInterval runs only while
// counting down — zero idle cost when off. Tracks focus sessions per day.
(function timer() {
  const LABELS = { focus: 'Focus', short: 'Break', long: 'Long Break' };
  const DEFAULT_MIN = { focus: 25, short: 5, long: 15 };
  const LS_DUR = 'termrack.timer.durations';
  const LS_TODAY = 'termrack.timer.today';

  const root = document.getElementById('timer');
  const modeEl = document.getElementById('timer-mode');
  const displayEl = document.getElementById('timer-display');
  const toggleBtn = document.getElementById('timer-toggle');
  const todayEl = document.getElementById('timer-today');

  // Durations (minutes), persisted.
  const mins = { ...DEFAULT_MIN };
  try { Object.assign(mins, JSON.parse(localStorage.getItem(LS_DUR) || '{}')); } catch (_) {}
  const dur = (m) => mins[m] * 60;
  const saveDur = () => localStorage.setItem(LS_DUR, JSON.stringify(mins));

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
    input.value = String(mins[mode]);
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
        mins[mode] = v;
        saveDur();
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
  render();
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
