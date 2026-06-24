// Globals provided by the <script> tags in index.html:
//   Terminal                    (@xterm/xterm)
//   FitAddon.FitAddon           (@xterm/addon-fit)
//   WebLinksAddon.WebLinksAddon (@xterm/addon-web-links)
//   SearchAddon.SearchAddon     (@xterm/addon-search)
// and window.term                (the preload bridge)

const sessions = new Map(); // id -> session
let activeId = null;
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

// --- Layout persistence: remember session names + order across restarts.
function saveLayout() {
  const arr = [...listEl.children].map((li) => {
    const s = sessions.get(li.dataset.id);
    return s ? { name: s.name, custom: !!s.custom } : null;
  }).filter(Boolean);
  localStorage.setItem(LS_LAYOUT, JSON.stringify(arr));
}

function createSession(opts) {
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

  // --- terminal host element ---
  const host = document.createElement('div');
  host.className = 'term-host';
  host.dataset.id = id;
  termsEl.appendChild(host);

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
  term.open(host);

  // --- sidebar item ---
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

  // Manual double-click detection: draggable elements suppress the native
  // dblclick event in Chromium, so we time two quick clicks on the name.
  let lastNameClick = 0;
  item.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) return;
    if (e.target.classList.contains('name')) {
      const now = Date.now();
      if (now - lastNameClick < 350) { lastNameClick = 0; beginRename(session); return; }
      lastNameClick = now;
    }
    activate(id);
  });
  item.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeSession(id);
  });
  wireDrag(item);
  listEl.appendChild(item);

  const session = { id, name, custom, term, fit, search, host, item, alive: true };
  sessions.set(id, session);

  // Keep the find counter live for the active terminal.
  search.onDidChangeResults((e) => {
    if (activeId !== id || findbar.hidden) return;
    findCount.textContent = e && e.resultCount > 0
      ? `${(e.resultIndex ?? -1) + 1}/${e.resultCount}`
      : 'none';
  });

  // Show it first so fit() can measure real pixels, then spawn the PTY sized to fit.
  activate(id);
  fit.fit();
  window.term.create(id, term.cols, term.rows, '');

  term.onData((data) => window.term.input(id, data));
  term.onResize(({ cols, rows }) => window.term.resize(id, cols, rows));

  // Programs that set the window title (\e]0;...\a) rename the tab — unless the
  // user gave it a custom name, which always wins.
  term.onTitleChange((title) => {
    if (session.custom) return;
    if (title && title.trim()) {
      session.name = title.trim();
      const nameEl = item.querySelector('.name');
      if (nameEl) nameEl.textContent = session.name;
    }
  });

  return session;
}

function activate(id) {
  const session = sessions.get(id);
  if (!session) return;
  activeId = id;

  for (const s of sessions.values()) {
    const on = s.id === id;
    s.host.classList.toggle('active', on);
    s.item.classList.toggle('active', on);
  }

  updateEmptyState();
  requestAnimationFrame(() => {
    session.fit.fit();
    session.term.focus();
    if (!findbar.hidden) runFind();
  });
}

function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return;

  window.term.kill(id);
  session.term.dispose();
  session.host.remove();
  session.item.remove();
  sessions.delete(id);
  saveLayout();

  if (activeId === id) {
    const next = [...sessions.keys()].pop();
    activeId = null;
    if (next) activate(next);
    else updateEmptyState();
  }
}

function updateEmptyState() {
  emptyEl.style.display = sessions.size === 0 ? 'flex' : 'none';
}

// ---------- Rename (double-click) ----------
function beginRename(session) {
  const item = session.item;
  const nameEl = item.querySelector('.name');
  if (!nameEl) return;
  item.draggable = false;

  const input = document.createElement('input');
  input.className = 'name-edit';
  input.value = session.name;
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
    if (save && v) {
      session.name = v;
      session.custom = true;
    }
    span.textContent = session.name;
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

// ---------- Drag to reorder ----------
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
  for (const s of sessions.values()) {
    s.term.options.fontSize = fontSize;
    s.fit.fit();
    window.term.resize(s.id, s.term.cols, s.term.rows);
  }
  localStorage.setItem(LS_FONT, String(fontSize));
}

// ---------- Clear ----------
function clearActive() {
  const s = sessions.get(activeId);
  if (s) s.term.clear();
}

// ---------- Find ----------
function showFind() {
  findbar.hidden = false;
  findInput.focus();
  findInput.select();
  runFind();
}
function hideFind() {
  findbar.hidden = true;
  const s = sessions.get(activeId);
  if (s) {
    if (s.search.clearDecorations) s.search.clearDecorations();
    s.term.focus();
  }
  findCount.textContent = '';
}
function toggleFind() {
  if (findbar.hidden) showFind();
  else hideFind();
}
function runFind(dir) {
  const s = sessions.get(activeId);
  if (!s) return;
  const q = findInput.value;
  if (!q) {
    if (s.search.clearDecorations) s.search.clearDecorations();
    findCount.textContent = '';
    return;
  }
  if (dir === 'prev') s.search.findPrevious(q, SEARCH_OPTS);
  else s.search.findNext(q, SEARCH_OPTS);
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
  const session = sessions.get(id);
  if (session) session.term.write(data);
});

window.term.onExit(({ id }) => {
  const session = sessions.get(id);
  if (!session) return;
  session.alive = false;
  session.item.classList.add('dead');
  session.term.write('\r\n\x1b[90m[process exited — ⌘W to close]\x1b[0m\r\n');
});

// ---------- Menu actions (from main process) ----------
window.term.onMenu((action) => {
  switch (action) {
    case 'new': createSession(); saveLayout(); break;
    case 'close': if (activeId) closeSession(activeId); break;
    case 'font-in': setFont(fontSize + 1); break;
    case 'font-out': setFont(fontSize - 1); break;
    case 'font-reset': setFont(13); break;
    case 'clear': clearActive(); break;
    case 'find': toggleFind(); break;
  }
});

// ---------- Window + keyboard ----------
window.addEventListener('resize', () => {
  const session = sessions.get(activeId);
  if (session) session.fit.fit();
});

document.getElementById('new-session').addEventListener('click', () => {
  createSession();
  saveLayout();
});

// ⌘1–9 to jump to a session (the rest of the shortcuts live in the app menu).
window.addEventListener('keydown', (e) => {
  if (!e.metaKey) return;
  if (e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key, 10) - 1;
    const ids = [...listEl.children].map((li) => li.dataset.id);
    if (ids[idx]) { e.preventDefault(); activate(ids[idx]); }
  }
});

// ---------- Boot: restore saved layout, else one fresh terminal ----------
(function boot() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(LS_LAYOUT) || '[]'); } catch (_) {}
  if (Array.isArray(saved) && saved.length) {
    counter = saved.length;
    saved.forEach((o) => createSession(o));
    activate([...sessions.keys()][0]);
  } else {
    createSession();
    saveLayout();
  }
})();
