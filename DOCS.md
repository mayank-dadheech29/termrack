# Termrack — Documentation

A local-first macOS terminal with a cmux-style sidebar: a list of terminal
sessions on the left, the selected session (and its split panes) filling the
pane on the right. Every session is a **real shell** running in a pseudo-terminal
(PTY), so it behaves exactly like Terminal.app.

No telemetry, no network calls, no third-party services.

---

## Install & run

```bash
npm install        # also rebuilds node-pty for Electron
npm start          # run from source
npm run deploy     # build Termrack.app, sign, install to /Applications
```

After `npm run deploy`, launch **Termrack** from Spotlight, the Dock, or
`/Applications` like any other Mac app.

---

## Features

### Terminals (tabs)
- Each sidebar entry is a real `zsh` (or your `$SHELL`) in a PTY — full color,
  `vim`, `htop`, `Ctrl-C`, tab-completion, job control.
- **New** with the `+` button or `⌘T`. **Switch** by clicking, or `⌘1`–`⌘9`.
- **Rename** by double-clicking the tab's name (custom names stick and won't be
  overwritten by the shell title).
- **Reorder** by dragging tabs up/down.
- **Close** with the hover `×` or `⌘W`. **Reopen** the last closed tab *or
  split pane* with `⌘⇧T` (a closed pane is split back into its tab).

### Split panes
- **Split right** with `⌘D`, **split down** with `⌘⇧D` — each pane is its own
  real shell, opened in the same directory as the pane you split from.
- **Focus** a pane by clicking it, or move by direction with `⌘⌥` + arrow keys.
  The active pane shows a blue ring.
- **Resize** by dragging the divider between panes (panes won't shrink below
  ~60px).
- **Close** a pane with its hover `×` or `⌘W`; closing the last pane closes the
  tab. Splits nest arbitrarily (split right, then down, etc.).

### Sidebar
- **Collapse / expand** with `⌘B` (animated). State is remembered.
- **Resize** by dragging the divider between the sidebar and the terminal.
- When collapsed, a draggable strip at the top lets you still move the window.

### Find
- `⌘F` opens the find bar (top-right). Type to highlight matches.
  - `Enter` = next, `⇧Enter` = previous, `Esc` = close.
  - A match counter (e.g. `2/7`) shows on the right.

### Clipboard
- **Copy-on-select** — highlight text and it's instantly on the clipboard.
- `⌘C` copies the selection, `⌘V` pastes, `⌘A` selects all (these defer to the
  find box when it's focused).
- **Right-click** pastes into the pane under the cursor.

### Line editing
- `⌘⌫` deletes the **whole** current input line (regardless of cursor position).
- Standard shell line editing still works: `Ctrl-U` (to start), `Ctrl-K`
  (to end), `Ctrl-W` (word), `Ctrl-A` / `Ctrl-E` (start / end).

### Font size
- `⌘+` / `⌘-` change the terminal font size (8–28pt), `⌘0` resets to 13pt.
  Size is remembered. (Window zoom is disabled so it doesn't conflict.)

### Clear
- `⌘K` clears the active pane's scrollback.

### Working-directory restore
- Each tab remembers its working directory; on relaunch, tabs reopen **in the
  folder they were last in** (captured on tab-switch and at quit — no polling,
  zero idle cost). If a folder no longer exists, the tab falls back to `~`.

### Pomodoro timer
- A timer lives in the sidebar: **▶/⏸** start/pause, **↺** reset, **⤳** skip.
- Cycle: **25m Focus → 5m Break**, with a **15m long break after every 4th
  focus**. The next phase auto-starts; finishing fires a native notification
  + a short beep, and the chip flashes.
- **Configurable durations** — click the time (it pauses if running) to edit
  the current phase's minutes; saved across restarts.
- **🍅 daily counter** — counts focus sessions completed today; resets at
  midnight.

### Focus music
- A small player under the timer plays background music while you work.
- Paste an **audio file path**, a **direct audio URL** (e.g. a lofi/radio
  stream), or a **YouTube URL** — or click 📁 to pick a local file.
- **▶ / ⏸** plays/pauses; a volume slider sits below. The source and volume
  **persist** across restarts (set it once). Playback is manual (not tied to
  the timer).
- YouTube plays via a hidden embed; private/unavailable videos can't play (a
  note is shown), and free YouTube may include ads.

### Settings (`⌘,`)
- **Appearance:** accent color, terminal font family, font size.
- **Terminal:** scrollback size, cursor blink.
- **Timer:** default focus / short-break / long-break minutes.
- Everything applies live to all panes and persists. Esc / click-outside /
  Done closes it. The whole UI is driven by CSS design tokens.

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘T` | New terminal (tab) |
| `⌘W` | Close active pane (closes tab if last pane) |
| `⌘⇧T` | Reopen last closed tab or pane |
| `⌘1`–`⌘9` | Jump to tab N |
| `⌘B` | Toggle sidebar |
| `⌘D` | Split pane right |
| `⌘⇧D` | Split pane down |
| `⌘⌥ ← ↑ → ↓` | Move focus between split panes |
| `⌘F` | Find (Enter / ⇧Enter / Esc) |
| `⌘C` / `⌘V` / `⌘A` | Copy / Paste / Select All |
| `⌘⌫` | Delete whole input line |
| `⌘+` / `⌘-` / `⌘0` | Font bigger / smaller / reset |
| `⌘K` | Clear scrollback |
| `⌘,` | Open Settings |

All of these are also available in the menu bar (Edit / View).

---

## What persists across restarts

**Saved:** tab names, tab order, each tab's **full split-pane layout**
(directions, sizes, and per-pane working directory), font size, sidebar width,
sidebar collapsed state, timer durations, today's focus count, appearance
settings (accent, font, scrollback, cursor), and the focus-music source +
volume. `⌘⇧T` also restores a closed tab's (or pane's) full split layout.

**Not saved (yet):** scrollback contents, and running programs (a shell's
directory is restored, but not the process that was running in it).

---

## Coming soon

Planned, roughly in priority order:

- **Settings v2** — theme presets (incl. light), default shell & starting
  directory, custom font import.
- **Profiles** — launch different shells or pre-set commands per tab
  (e.g. a Python REPL, an SSH host).
- **SSH bookmarks** — quick-connect to saved remote hosts.
- **Broadcast input** — type once into all panes of a tab at once.
- **Command palette** (`⌘P`) — fuzzy-run any action.
- **Themes** — light/dark and custom color schemes with a switcher.
- **Draggable pane layout polish** — proportional resize on window resize,
  subtler active-pane highlight.
- **README screenshot / GIF** and a short demo.
- **Distribution** — code signing + notarization so the app opens cleanly on
  other Macs, plus in-app auto-update.

Have a request? Open an issue on the repo.

---

## Architecture (for contributors)

- **`src/main.js`** — Electron main process. Owns every PTY (keyed by id),
  spawns shells via `node-pty`, forwards output to the renderer and input/resize
  back, resolves cwd via `lsof`, bridges the clipboard, and builds the app menu.
- **`src/preload.js`** — a narrow `window.term` bridge (contextIsolation on,
  nodeIntegration off). The UI never touches Node directly.
- **`src/renderer.js`** — the UI: tabs, a binary **pane tree** per tab, find,
  clipboard, font, timer, sidebar collapse/resize, and persistence.
- **`src/index.html` / `src/styles.css`** — layout and dark theme.
- **`build/`** — the app icon and its generator script.

Stack: **Electron** (window) · **xterm.js** (terminal rendering) ·
**node-pty** (real shells).
