
# Zenbook — Product & Build Spec

## Overview

Zenbook is a local-first, cross-platform (Windows, macOS, Linux) desktop notebook where every page is an Excalidraw canvas, organised as Spaces > Chapters > Pages, with a text notes panel attached to each page.

**Goals**

- Feel like a calm notebook, not a whiteboard tool: the canvas is the hero, chrome stays out of the way.
- Fast: open any page in under 300 ms, never lose a stroke (autosave, crash-safe writes).
- Own your data: plain files on disk that open in excalidraw.com and sync with any folder-sync tool.
- Keyboard-first navigation without sacrificing mouse and pen use.

**Non-goals for v1**

- Real-time multi-user collaboration and a hosted cloud backend.
- Mobile apps.
- A custom drawing engine — use the official `@excalidraw/excalidraw` React package, not a fork.

## Information architecture

Use **Space > Chapter > Page**. "Chapter" fits the book metaphor of the name Zenbook, and it avoids "Folder" (feels like a file manager) and "Notebook" (collides with the app itself).

| Level | What it is | Example | Rules |
| --- | --- | --- | --- |
| Space | A top-level context with its own colour and icon | Work, University, Personal | Switch with Ctrl/Cmd+1…9; one Space open at a time |
| Chapter | An ordered group of pages | "Distributed Systems", "Q4 Planning" | Manual drag order; one level of sub-chapters allowed (no deeper) |
| Page | One Excalidraw canvas + one notes document | "Lecture 3 — Raft" | Manual order; can be pinned, duplicated, moved between chapters |

Also include three virtual views per Space that are not folders: **Recent**, **Pinned**, and **Trash** (deleted pages kept 30 days).

## UI layout & design language

Keep navigation on the left, the canvas in the centre and per-page notes on the right — and do not mix navigation with drawing tools in one sidebar.

```text
+----+------------------------+--------------------------------------+------------------------------+
| W  | Work                   | Distributed Systems / Lecture 3 Saved| Notes   Library   Info       |
| U  | [Search  Ctrl/Cmd+K ]  |--------------------------------------|------------------------------|
| P  | v Distributed Systems  |     [ Excalidraw tools (top) ]       | Raft key ideas               |
| +  |     Lecture 1 — Intro  |  +-----------+                       | • Leader election            |
|    |   > Lecture 3 — Raft   |  |Style panel|                       | • Log replication            |
|    |     Lecture 4 — Paxos  |  |(only when |    Infinite canvas    | • Safety via term numbers    |
|    | > Q4 Planning          |  | selected) |  (template: blank /   |                              |
|    | > Reading notes        |  +-----------+   dots / lines)       | Markdown, autosaved          |
|    |                        |                                      |                              |
|    | + New page             |                                      |                              |
|    | Recent · Pinned · Trash| Zoom · Undo                          |                              |
+----+------------------------+--------------------------------------+------------------------------+
 Space   Chapter tree               Canvas (Excalidraw)                 Right panel (Sidebar tabs)
 rail
```

Excalidraw's style panel already appears only when something is selected, so moving it into a permanent left tab would add clutter, not remove it.

**Left: navigation**

- Slim Space rail (48 px): one coloured initial per Space, + to add one. Collapses to rail-only or hides fully.
- Chapter tree: drag to reorder and move, inline rename (F2), right-click menu (duplicate, move, pin, export, delete).
- Replace Excalidraw's hamburger menu contents via its `MainMenu` component: Export, Page template, Canvas background, Help. Remove items that don't apply (live collaboration, excalidraw+ links).

**Right: notes panel**

- Built on Excalidraw's own `Sidebar` component with `Sidebar.Tabs`, so it docks exactly where Library lives today.
- Tabs: **Notes** (default, Markdown editor), **Library** (Excalidraw library, shared per Space), **Info** (created, edited, word count, links to and from this page).
- Docked on windows wider than 1200 px, overlay below that.

**Focus mode** — Ctrl/Cmd+. hides both sidebars and the breadcrumb and enables Excalidraw's `zenModeEnabled`. Esc exits.

**Design language**

- Neutral greys, one accent colour per Space (used for the active page and rail dot only).
- System UI font (Inter as fallback), 8 px spacing grid, 1 px borders, no shadows or gradients.
- Light and dark themes follow the OS; Excalidraw `theme` prop is kept in sync.
- Frameless window: `titleBarStyle: 'hiddenInset'` on macOS, `titleBarOverlay` on Windows, native frame on Linux.
- Command palette (Ctrl/Cmd+K) as the main way to jump, create and run actions.

## Features

v1.0 ships the notebook core plus search and export; everything marked "Added" is a suggestion beyond the original brief, so cut freely.

| Feature | Release | Source | Notes |
| --- | --- | --- | --- |
| Spaces, Chapters, Pages (create, rename, reorder, move, delete) | v1.0 | Brief | Drag-and-drop in the tree |
| Excalidraw canvas per page | v1.0 | Brief | Official package; pen/stylus mode on |
| Notes panel per page | v1.0 | Brief | Markdown (Milkdown or TipTap), autosave |
| Autosave + crash-safe writes | v1.0 | Added | No Save button; "Saved" indicator only |
| Command palette and quick switcher (Ctrl/Cmd+K) | v1.0 | Added | Fuzzy search over pages and actions |
| Full-text search | v1.0 | Added | Page titles, notes, and text inside drawings |
| Page templates | v1.0 | Added | Blank, dot grid, lined, squared, Cornell layout |
| Focus mode | v1.0 | Added | See UI section |
| Export page to PNG, SVG, PDF; chapter to one PDF | v1.0 | Added | Uses Excalidraw `exportToBlob` / `exportToSvg` |
| Import `.excalidraw` files and folders | v1.0 | Added | Drag files onto a chapter |
| Recent, Pinned, Trash (30-day restore) | v1.0 | Added | Virtual views, not folders |
| Page thumbnails in tree hover and chapter grid view | v1.1 | Added | Generated in the background |
| Links between pages | v1.1 | Added | `zenbook://page/<id>` on any element or in notes; backlinks in Info tab |
| Version history per page | v1.1 | Added | Snapshot every 10 min of editing, keep 50 |
| Tags | v1.1 | Added | Filter in sidebar and palette |
| Import PDF or images as pages to annotate | v1.2 | Added | One page per PDF page, locked background |
| Presentation mode from Excalidraw frames | v1.2 | Added | Arrow keys step through frames |
| Multiple windows / open page in new window | v1.2 | Added | |
| Optional Space encryption | Later | Added | Password per Space |
| Mobile / web companion | Later | Added | Same file format makes it possible |

**Sync** — no backend in v1. Because the library is plain files, users can put it in Dropbox, iCloud Drive, OneDrive, Syncthing or a git repo. The app must detect external changes and conflicted copies (see Data model).

## Tech stack & architecture

Electron is the right call: it ships one Chromium everywhere, so Excalidraw's canvas renders and performs identically on all three OSes.

Tauri was the main alternative (installers around 10 MB instead of ~100 MB), but it uses each OS's own webview — WebKitGTK on Linux and WebKit on macOS — where canvas performance and pointer/stylus events differ. For a drawing-first app that inconsistency costs more than the download size saves.

| Layer | Choice |
| --- | --- |
| Shell | Electron (latest stable), `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| Build tooling | electron-vite + Vite, TypeScript strict mode |
| UI | React (version required by `@excalidraw/excalidraw`), CSS Modules or vanilla-extract, Radix primitives for menus/dialogs |
| Canvas | `@excalidraw/excalidraw` (latest stable), self-hosted fonts and assets so it works offline |
| Notes editor | Milkdown or TipTap with Markdown serialisation |
| State | Zustand for UI state; files on disk are the source of truth |
| Search | MiniSearch index built in a worker, persisted to a cache file |
| File watching | chokidar in the main process |
| Packaging | electron-builder: `.dmg` (universal, notarised), NSIS `.exe` + portable, AppImage + `.deb` + `.rpm` |
| Updates | electron-updater with GitHub Releases |
| Tests | Vitest (unit), Playwright for Electron (end-to-end) |

**Process model**

- **Main process** owns the filesystem: library CRUD, atomic writes, file watching, asset store, export to PDF, menus, auto-update.
- **Preload** exposes one typed API (`window.zenbook.*`) via `contextBridge`; every path is validated to stay inside the library root.
- **Renderer** is the React app: sidebar, one Excalidraw instance, notes editor, palette.
- **Worker** (in the renderer) builds the search index and thumbnails so the UI thread never blocks.

## Data model & storage

The library is a plain folder the user picks on first run (default `~/Zenbook`); folders mirror Spaces and Chapters, and each page is a standard `.excalidraw` file plus a `.md` notes file.

```text
Zenbook/
  .zenbook/                     # app data, safe to delete (rebuilt)
    search-index.json
    thumbnails/<pageId>.webp
    history/<pageId>/<timestamp>.excalidraw
  Work/
    space.json                  # { id, name, color, icon, order[] }
    assets/<sha256>.png         # deduplicated images for this Space
    Distributed Systems/
      chapter.json              # { id, name, order[], created }
      Lecture 3 - Raft.excalidraw
      Lecture 3 - Raft.md
  .trash/
```

**Rules**

- Every Space, Chapter and Page has a stable UUID stored in its JSON (`appState.zenbook.pageId` for pages). Names on disk are for humans; links and history use IDs, so renames never break anything.
- Order lives in the parent's `order[]` array of IDs; unknown files found on disk are appended at the end.
- Images are stripped out of the scene's `files` map on save and written once to `assets/<sha256>.<ext>`, then re-injected on load. Export and "Open in excalidraw.com" re-embed them so the file stays portable.
- Notes are plain Markdown with optional YAML front matter (`tags`, `pinned`).
- Writes are atomic: write `<name>.tmp`, fsync, rename. Never leave a half-written file.
- File watcher reloads a page changed by another app or sync tool. If the open page has unsaved edits and the file also changed on disk, keep both: save ours as `<name> (conflict <date>).excalidraw` and show a banner.
- Detect sync-tool conflict copies (Dropbox "conflicted copy", OneDrive "-PC name", Syncthing `.sync-conflict-`) and surface them in the tree with a warning badge.

## Performance

Targets: window visible in under 1.5 s cold start, page switch under 300 ms for a 2,000-element page, typing and drawing never drop below 60 fps.

- **One Excalidraw instance.** Switch pages with `excalidrawAPI.updateScene()` and `history.clear()` instead of remounting the component.
- **Load lazily.** Read only the tree (JSON metadata) at startup; read a page's scene and notes when it is opened. Prefetch the next/previous page in the chapter when idle.
- **Debounced autosave.** Save 800 ms after the last change, and always flush on page switch, window blur and app quit (`before-quit` waits for pending writes).
- **Skip no-op saves.** Compare `getSceneVersion(elements)` with the last saved version before writing.
- **Assets out of the scene.** Storing images separately (see Data model) keeps page JSON small, so parsing and IPC stay fast.
- **Small IPC payloads.** Send scene JSON as a string, not a structured clone of large objects; never send image data URLs over IPC on every save.
- **Background work in a worker.** Search indexing and thumbnail rendering (`exportToBlob` at 320 px wide, WebP) run off the UI thread, on idle, only for pages whose version changed.
- **Virtualised tree.** Render the sidebar with a virtual list once a Space exceeds about 200 pages.
- **Fast startup.** Create the window hidden, show it on `ready-to-show`, restore the last open page, and defer the updater check and index rebuild by 5 s.
- **Offline assets.** Bundle Excalidraw's fonts locally (set `window.EXCALIDRAW_ASSET_PATH`) so nothing waits on the network.

## Build phases

Build in seven phases, each ending in a running app and a commit; do not start a phase until the previous one's checks pass.

1. **Scaffold**
   - electron-vite + React + TypeScript, ESLint, Prettier, Vitest, Playwright, secure `BrowserWindow` defaults, typed preload bridge.
   - Done when: `npm run dev` opens a blank window on all three OSes; `npm test` passes; CI (GitHub Actions) builds on Windows, macOS and Ubuntu.
2. **Library on disk**
   - Main-process library service: choose folder, read tree, CRUD for Spaces/Chapters/Pages, atomic writes, path validation, chokidar watcher.
   - Done when: unit tests cover create/rename/move/delete/reorder and external file changes; no renderer code touches `fs`.
3. **Canvas + navigation**
   - Left rail and chapter tree, one Excalidraw instance, page switching, debounced autosave, "Saved" indicator, custom `MainMenu`.
   - Done when: draw, switch pages, quit, relaunch — every stroke is there; a saved page opens on excalidraw.com unchanged.
4. **Notes panel**
   - Excalidraw `Sidebar` with Notes / Library / Info tabs, Markdown editor, per-Space library.
   - Done when: notes persist per page as `.md`, panel docks/undocks at 1200 px, Library items persist per Space.
5. **Search, palette, templates, focus mode**
   - Worker-built index, Ctrl/Cmd+K palette, page templates, focus mode, Recent/Pinned/Trash.
   - Done when: search finds text inside drawings and notes within 100 ms on a 1,000-page library; all actions reachable from the keyboard.
6. **Assets, export, import**
   - Asset store with dedup, PNG/SVG/PDF export, chapter-to-PDF, `.excalidraw` import.
   - Done when: a page with 10 images saves under 50 KB of JSON; exports match the canvas.
7. **Polish and ship**
   - Themes, frameless title bars, app icon, onboarding with a sample Space, electron-builder targets, code signing/notarisation hooks, auto-update.
   - Done when: installers build in CI for all three OSes and the performance targets above are met.

v1.1 (thumbnails, page links and backlinks, version history, tags) follows as its own plan.

## Instructions for Claude Code

Save this file in the repo as `docs/SPEC.md`, and start Claude Code with the prompt below.

```markdown
Read docs/SPEC.md fully. We are building Zenbook, an Electron + React + TypeScript
notebook app where each page is an Excalidraw canvas.

First: create CLAUDE.md summarising the stack, folder layout, commands, and the
conventions below. Then implement Phase 1 only. Stop at the end of each phase,
run lint + tests, show me what changed, and wait for my go-ahead.

Conventions:
- TypeScript strict; no `any` without a comment explaining why.
- Only the main process touches the filesystem; renderer uses window.zenbook.* via preload.
- Validate every IPC argument (zod) and every path against the library root.
- Use the official @excalidraw/excalidraw package and its APIs (MainMenu, Sidebar,
  updateScene, exportToBlob); do not fork or patch it.
- Files on disk are the source of truth; caches in .zenbook/ must be rebuildable.
- Unit-test the library service; one Playwright test per phase covering its "Done when".
- Small commits with conventional messages (feat:, fix:, chore:).
- Ask me before adding any dependency not listed in the spec.
```

**Open questions to settle before Phase 3**

- [ ] Notes editor: Milkdown (closer to plain Markdown) or TipTap (richer, more mature)?
- [ ] Should sub-chapters exist in v1, or only flat Chapters?
- [ ] Licence and distribution: open source on GitHub, or closed with paid code-signing certificates?
