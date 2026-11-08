# Zenbook v1 — Build Plan

## Context

The repo is empty apart from `PLAN.md`. The goal is a minimal, beautiful, calm notebook where every page is an Excalidraw canvas with a Markdown notes panel. It must run on Windows and macOS (Linux is a bonus), be fast, and avoid bloat and over-engineering. It will be **open source on GitHub, used by the public and updated continuously**.

This plan keeps the core of PLAN.md: Electron, the official `@excalidraw/excalidraw` package, Space > Chapter > Page, plain files on disk. It cuts scope where PLAN.md over-reached, settles its open questions and adds the release pipeline that public distribution needs.

**Settled decisions**

| Topic | Decision |
| --- | --- |
| Shell | Electron. PLAN.md's reasoning holds: one Chromium means identical canvas and pen behaviour on all OSes. No Rust toolchain is installed either. |
| Notes editor | CodeMirror 6 with "live Markdown". The `.md` file is the editor's text; headings and emphasis are styled in place and the markers are dimmed. (Your choice.) |
| Navigation | A single calm sidebar with a Space switcher in the header, instead of a rail plus a tree. (Your choice.) |
| Sub-chapters | Not in v1. Chapters are flat. |
| Distribution | Open source under MIT, auto-updates from GitHub Releases, CI ready for signing (see Distribution). (Your direction.) |

## Changes from PLAN.md (and why)

| PLAN.md | This plan | Why |
| --- | --- | --- |
| Space rail plus tree | One sidebar; the Space switcher sits in the title strip | Calmer look, and the canvas gets 48 px more width |
| Notes inside Excalidraw's `Sidebar` with Notes, Library and Info tabs | Our own resizable right panel. Excalidraw's Library stays in its own built-in sidebar, which never docks. | Gives a wider writing surface, keeps the editor mounted with no state loss, and does not depend on Excalidraw's internal CSS |
| Info tab | A quiet footer line instead: "142 words · edited 2 min ago" | Less chrome |
| In-app Trash with 30-day restore | The OS trash (`shell.trashItem`) plus a 6-second Undo toast | Native, almost no code, and restore works through the Recycle Bin or Trash |
| Search index built in a renderer worker | MiniSearch in the main process; the renderer sends a page's extracted text when it saves | The files already live in main, so scene text never has to cross IPC to be indexed |
| Search cache in `.zenbook/` inside the library | Stored in `userData` (per device) | Caches don't belong in a synced folder, where every change would be re-uploaded |
| PDF export and chapter-to-PDF | Excalidraw's own PNG, SVG, clipboard and `.excalidraw` export; PDF moves to Later | Zero code in v1 |
| Templates including Cornell | Paper backgrounds: Plain, Dots, Lines, Grid | Gives the notebook feel at about 40 lines of code |
| Asset store in Phase 6 | Asset store in Phase 3 | The file format must be fixed before real pages exist |
| Shape library per Space | One `library.excalidrawlib` at the library root | Simpler, and most people want their shapes everywhere |
| Radix, plus cmdk-style palette | Native Electron context menus and dialogs, a hand-written palette, native HTML5 drag and drop | Fewer dependencies and native-feeling menus |
| Virtualised tree, idle prefetch | Dropped unless profiling shows a need | Premature optimisation |
| `pinned` in Markdown front matter | `pinned[]` in `space.json` | Startup would otherwise have to read every `.md` file |
| 7 phases | 6 phases | Assets moved into Phase 3; export and import came free or moved into polish |

## v1 scope

**In:** Spaces, Chapters, Pages (create, rename, reorder, move, duplicate, pin, delete with undo) · one Excalidraw canvas per page · a Markdown note per page · autosave with crash-safe writes · images stored as deduplicated assets · Ctrl/Cmd+K palette · full-text search over titles, notes and text inside drawings · paper backgrounds · focus mode · light and dark themes that follow the OS · reload when a file changes externally, with conflict copies · first-run onboarding with a sample Space · auto-update.

**Later (v1.1+):** PDF and chapter export · page links and backlinks (`zenbook://`, using Excalidraw's `onLinkOpen`) · version history · thumbnails · tags · sub-chapters · importing PDFs or images to annotate · presentation mode from frames · multiple windows · installing libraries by deep link · opening `.excalidraw` files with Zenbook via file association · i18n · encryption.

## UX & design

```text
+--------------------------+---------------------------------------------+--------------------------+
| (mac lights)  ● Work ⌄   |  Distributed Systems / Lecture 3 — Raft  ·  |  ▤  (win controls)       | 40px drag strip
|--------------------------|---------------------------------------------|--------------------------|
| ⌕ Search        Ctrl K   |          [ Excalidraw toolbar ]             | Lecture 3 — Raft         |
| PINNED                   |   ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·     | ## Key ideas             |
|   Raft cheat sheet       |   ·  ·  ·   dotted paper   ·  ·  ·  ·      | - Leader election        |
| ▾ Distributed Systems    |   ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·     | - [ ] Read the paper     |
|     Lecture 1 — Intro    |                                             |                          |
|   ▌ Lecture 3 — Raft     |                                             |                          |
| ▸ Q4 Planning            |                                             |                          |
| + New page           ⚙   |  zoom · undo                                | 142 words · edited 2m    |
+--------------------------+---------------------------------------------+--------------------------+
  Sidebar 248px (200–360)          Canvas (one Excalidraw)                 Notes 340px (280–560)
```

- **Title strip** (40 px, draggable)
  - macOS: `hiddenInset` traffic lights, then the Space switcher.
  - Windows: `titleBarOverlay`, with its colours updated when the theme changes.
  - Linux: native frame, with the strip used only for the breadcrumb.
  - Contents: breadcrumb, save state and the notes toggle.
- **Space switcher**
  - A native popup menu: Spaces as radio items, New Space, Rename, Colour ▸, Delete.
  - Ctrl/Cmd+1…9 switches Space.
  - New items are created as "Untitled" and go straight into inline rename, so the app needs **no modal dialogs**. Deleting a Space is the only action that asks for confirmation, through a native dialog.
- **Tree**
  - 28 px rows; the active page gets a 2 px accent bar and medium weight.
  - Chevrons with expand state remembered; F2 or Enter renames inline.
  - Native right-click menu: Rename, Duplicate, Pin, Move to ▸ (chapters grouped by Space), Reveal in Explorer/Finder, Delete.
  - HTML5 drag to reorder or move, with a drop line.
  - Full keyboard navigation with tree ARIA roles.
- **Canvas**
  - A custom `MainMenu`: Export image, Save as `.excalidraw`, Find on canvas, Paper ▸, Reveal in folder, Help.
  - Removed from the menu: Open, Live collaboration, Socials, Theme, Canvas background.
  - A `WelcomeScreen` that shows only one calm line in the centre.
- **Notes panel**
  - The page title appears as a heading; click it to rename the page.
  - Below it, the editor and the footer line.
  - Docked when the window is at least 1200 px wide; below that it slides over the canvas.
- **Palette** (Ctrl/Cmd+K)
  - About 560 px wide, near the top of the window, over a dimmed backdrop.
  - Empty query: recent pages plus common actions.
  - Typing: page results plus matching actions. A leading `>` limits the list to actions.
  - Each action shows its shortcut.
- **Focus mode** (Ctrl/Cmd+.): hides the sidebar, the notes panel and the strip's contents, and turns on `zenModeEnabled`. Esc exits when nothing is selected.

**Design tokens** (CSS variables in `tokens.css`; dark mode via `prefers-color-scheme`, which `nativeTheme.themeSource` drives)

- Light theme
  - Background `#FBFAF8`, surface `#F4F3F0`, text `#24231F`.
  - Muted text `#6F6C66` (4.7:1 on the background; the earlier `#8A877F` was only 3.4:1), faint text `#B5B2AA`, lines `#E7E5E0`.
- Dark theme
  - Background `#1A1A19`, surface `#201F1E`, text `#E9E7E2`.
  - Muted text `#9A978F`, lines `#2E2D2B`.
- Space accents (muted): sage, clay, slate, sand, plum, ocean, moss, rose. Accents appear only on the active page bar, the Space dot and the Excalidraw tool highlight.
- Type: the system UI font stack (Segoe UI Variable, SF Pro, Cantarell or Ubuntu) at 13/20 px for the interface. Notes use 15 px with 1.65 line height. Section labels are 11 px uppercase with letter spacing. No bundled fonts.
- Layout: 8 px grid, 6–8 px corner radius, 1 px hairlines, **no shadows**. Excalidraw's island shadows are removed by overriding its CSS variables; the package itself is never patched.
- Motion: 140 ms ease-out for panels, 120 ms fade for the palette; honours `prefers-reduced-motion`. Visible `:focus-visible` rings; text contrast of at least 4.5:1.
- Icons: about 10 simple 24 px stroke icons drawn inline in `ui/icons.tsx`; no icon package.

**Shortcuts** (Excalidraw's keymap was checked; Ctrl+K "add link" is overridden, but links stay available from the element's link button)

| Action | Win/Linux | macOS |
| --- | --- | --- |
| Palette / New page | Ctrl+K / Ctrl+N | ⌘K / ⌘N |
| Prev/next page in chapter | Ctrl+Alt+↑/↓ | ⌘⌥↑/↓ |
| Switch Space | Ctrl+1…9 | ⌘1…9 |
| Toggle sidebar / notes | Ctrl+\ / Ctrl+J | ⌘\ / ⌘J |
| Focus mode | Ctrl+. | ⌘. |
| Rename | F2 | F2 / Enter |

Excalidraw keeps its own Ctrl+F (find on canvas) and Ctrl+/ (canvas commands). Our keys are caught with a capture-phase `keydown` listener on `window`. On macOS, menu items show the shortcut but use `registerAccelerator: false`, so one handler serves all OSes.

## Architecture

- **Main process:** library service (scan, CRUD, atomic writes, watcher, assets, search), window and menus, the `app://` protocol, per-device state, the updater.
- **Preload:** `contextBridge` exposes one typed `window.zenbook` API. The renderer sends **IDs, never paths**; main resolves IDs from its in-memory tree. `assertInsideRoot()` is defence in depth.
- **Renderer:** React 19 with one Zustand store. Canvas and Notes are lazy chunks, so the sidebar paints first.

```text
src/shared/    api.ts (ZenbookApi + types), channels.ts
src/main/      index.ts window.ts protocol.ts menu.ts state.ts updater.ts ipc.ts
src/main/library/  paths.ts fsx.ts scan.ts ops.ts pages.ts assets.ts watcher.ts search.ts (+ *.test.ts)
src/preload/   index.ts
src/renderer/src/  App.tsx store.ts keys.ts
               sidebar/ (Sidebar, SpaceSwitcher, Tree)   canvas/ (Canvas, save.ts, paper.ts, menu.tsx)
               notes/ (NotesPanel, editor.ts)   palette/ (Palette, fuzzy.ts, actions.ts)
               ui/ (TitleStrip, Toast, Banner, icons)   styles/ (tokens.css, base.css, excalidraw.css)
e2e/  scripts/ (copy-excalidraw-fonts.mjs, make-fixture.mjs)  build/ (icons, entitlements)  .github/workflows/
```

**IPC surface** (every handler validates its input with zod through one `handle(channel, schema, fn)` helper)

- `library`: `status`, `choose`, `tree`, `onTree`, `loadShapes`, `saveShapes`
- `page`: `open` (scene and notes in one round trip), `saveScene(id, json, text)`, `saveNotes(id, md)`, `saveConflictCopy`, `onExternalChange`
- `assets`: `put(spaceId, files)` (sent once per new image), `get(spaceId, ids)`
- `ops`: `create`, `rename`, `move`, `duplicate`, `pin`, `setColor`, `remove`, `undoRemove`
- `search.query`, `ui.menu` (native menu, returns the chosen action), `ui.reveal`, `state.get/set`
- Events: `onFlush` (before quit), `onMenuAction`, `onUpdate`

**Security**

- Window: `contextIsolation`, `sandbox`, `nodeIntegration: false`.
- Navigation: `will-navigate` is blocked; `setWindowOpenHandler` sends only http(s) links to `shell.openExternal`.
- Production CSP: `default-src 'self'`, plus `data:` and `blob:` for images and workers.
- Electron Fuses: `runAsNode`, `NODE_OPTIONS` and inspect flags off; asar integrity on.
- Single-instance lock.
- ESLint `no-restricted-imports` blocks Node built-ins in the renderer.

## Data model on disk

```text
Zenbook/                         (default: Documents/Zenbook, chosen on first run)
  zenbook.json                   { "format": 1, "spaces": [spaceId…] }
  library.excalidrawlib          shared Excalidraw shape library
  Work/
    space.json                   { "id", "color": "sage", "chapters": [chapterId…], "pinned": [pageId…] }
    .assets/<fileId>.png         Excalidraw's fileId is already a SHA-1 hash, so dedup comes free
    Distributed Systems/
      chapter.json               { "id", "pages": [{ "id", "file": "Lecture 3 - Raft" }] }
      Lecture 3 - Raft.excalidraw   standard format + top-level "zenbook": { "id", "paper" }; "files": {}
      Lecture 3 - Raft.md           created only when the note is non-empty
```

**Rules**

- **Names and IDs**
  - A display name is the folder or file name (one source of truth).
  - Names are sanitised: no `/\:*?"<>|` or control characters, no trailing dots or spaces, Windows reserved names (CON, PRN and similar) avoided, 120 characters at most.
  - Name collisions are checked case-insensitively and resolved as "Name 2".
  - IDs and order live in the parent JSON, so startup never opens page files.
  - A page file found on disk but missing from `chapter.json` is appended. Its embedded `zenbook.id` is reused if present, otherwise it gets a new UUID.
  - Entries whose files have gone are dropped.
- **Images**
  - On save, images are stripped from the scene and written once to `.assets/`. On load they are re-injected with `addFiles`.
  - Files that arrive with embedded `files` (for example from excalidraw.com) migrate into assets on their first save.
  - Excalidraw's "Save as .excalidraw" re-embeds the images, so exports stay portable.
  - Moving a page to another Space copies the assets it references.
- **Writes**
  - Each write goes to `<name>.<rand>.tmp`, is fsynced, then renamed into place.
  - Rename is retried with backoff on Windows `EPERM`/`EBUSY` (antivirus and sync-tool locks).
  - Each path has its own write queue that keeps only the latest pending content.
- **Deletes:** the item is hidden immediately and a 6 s Undo toast appears, then `shell.trashItem`. Pending deletes are committed on quit. On Linux, if no trash is available, items go to a root `.trash/` folder instead.
- **External changes**
  - The watcher (Node's recursive `fs.watch`) ignores `*.tmp` and dot-folders such as `.assets`.
  - The app ignores its own writes by comparing the recorded mtime and size.
  - Structural changes trigger a debounced rescan, and the full tree is pushed to the renderer (about 100 KB for 1,000 pages).
- **Conflicts**
  - If the open page changes on disk and has no local edits, it reloads silently and keeps the viewport.
  - If it also has local edits, our scene and notes are saved as `<name> (conflict 2026-11-08 1430)`, the disk version is loaded, and a banner explains what happened.
  - Sync-tool conflict names (Dropbox "conflicted copy", Syncthing `.sync-conflict-`, and our own) get a warning dot in the tree.
- **Per-device state** in `userData/state.json`: library path, last page, recent pages, theme, window bounds, panel widths and visibility, per-page viewport (up to 200 pages). The search cache also lives in `userData`.
- **Format versioning:** `zenbook.json.format` is checked on open. A newer format shows "please update"; an older one runs migrations after making a backup. This matters because the app will keep shipping updates.

## Save / load pipeline (the performance-critical path)

1. **`onChange` stays tiny.**
   - It only compares `getSceneVersion(elements)` (and the paper setting) with the last saved version and resets an 800 ms timer.
   - It never calls React `setState`, serialises JSON or touches IPC.
2. **Debounce fires.**
   - The renderer builds compact JSON from `getNonDeletedElements`, the file's original appState subset (kept as read), `files: {}` and `zenbook: { id, paper }`.
   - It extracts search text with `getTextFromElements`.
   - It calls `assets.put` only for new file IDs, then `page.saveScene(id, json, text)`.
   - The scene travels as a string; image data never rides along on routine saves.
3. **Flush** whenever you switch page, the window blurs or closes, or the app quits.
   - On quit, `before-quit` waits for `onFlush` and the write queues to drain, with a 3 s cap.
   - A failed save shows a persistent "Couldn't save — retrying" banner. Nothing fails silently.
4. **Opening a page**
   - One IPC call returns scene and notes, read in parallel.
   - Then: `restoreElements`, `updateScene({ elements, appState: savedViewport, captureUpdate: CaptureUpdateAction.NEVER })`, `history.clear()`.
   - The baseline version is read back with `getSceneElements()`, so a restore never triggers a phantom save.
   - Finally `assets.get` for file IDs the instance hasn't loaded yet.
5. **Notes:** the same pattern with a 600 ms debounce. A `.md` file is written only when its content changes.

## Performance design

**Targets**

- Window visible in under 1 s; last page on canvas in under 1.5 s.
- Page switch under 300 ms for a 2,000-element page.
- Search under 100 ms on 1,000 pages (expected under 10 ms).
- Drawing and typing at 60 fps.
- Idle memory at or below about 300 MB.

**Rules**

- **One memoised Excalidraw instance.** Pages switch with `updateScene`; the component is never remounted. Props stay stable: `UIOptions` is a module constant and callbacks live in refs. Canvas subscribes only to `currentPageId`, through a Zustand selector.
- **Fast first paint**
  - Serve the renderer from a custom `app://` protocol with `{ standard, secure, supportFetchAPI, codeCache }`. The V8 code cache cuts parse time for Excalidraw's roughly 3 MB of JavaScript on later launches.
  - Create the window hidden with a theme-matched `backgroundColor`, so there's no white flash, and show it on `ready-to-show`.
  - Canvas and Notes are lazy chunks; the placeholder is plain paper, with no spinner.
- **Lazy, parallel I/O.** Startup reads only `zenbook.json`, `space.json` and `chapter.json` plus directory listings, all in parallel. Page files are read when opened.
- **Deferred work.** About 3 s after idle: start the watcher, reconcile the search index (stale pages by mtime, in batches of 20 via `setImmediate`). The update check runs at 10 s.
- **Cheap paper.** The pattern layer updates in `onScrollChange` through `requestAnimationFrame` and direct style writes, with no React render. It fades out below 0.35 zoom.
- **Offline.** Excalidraw's fonts are copied locally and `EXCALIDRAW_ASSET_PATH` points at them; nothing waits on the network.
- **Instrumentation.** `ZENBOOK_PERF=1` logs start-up and page-open marks, so the targets above are measured rather than guessed.

## Dependencies (complete list) & bloat budget

| Where | Packages |
| --- | --- |
| Renderer (bundled) | `react`, `react-dom` 19 · `@excalidraw/excalidraw` 0.18.1 · `@codemirror/{state,view,commands,language,lang-markdown}` · `zustand` |
| Main (bundled) | `minisearch` · `zod` (file watching uses Node's built-in `fs.watch`) |
| Main (shipped in node_modules) | `electron-updater`, the only one, because it doesn't bundle cleanly |
| Dev | `electron` 45 · `electron-vite` 6 · `vite` 8 · `@vitejs/plugin-react` · `typescript` **~6.0** (typescript-eslint doesn't support TS 7 yet) · `eslint` 10 + `typescript-eslint` + `eslint-plugin-react-hooks` · `prettier` · `vitest` · `@playwright/test` · `electron-builder` · `@types/*` |

- **Deliberately not used:** Radix, cmdk, dnd-kit, icon packs, CSS frameworks, Inter, vanilla-extract, lodash, date libraries, `@electron-toolkit/*`, starter-template extras.
- **Budget**
  - `app.asar` at or under 15 MB, since all runtime libraries are in `devDependencies` and bundled, so `node_modules` isn't shipped.
  - Renderer entry chunk (excluding Excalidraw and the editor) at or under 250 KB minified. React 19 alone is about 200 KB; the Phase 1 shell measured 222 KB.
  - Installers at roughly Electron's baseline: about 85–100 MB per OS and architecture. Builds are per architecture, never universal, so each download stays half the size.
  - `electronLanguages: ['en-US']` trims about 40 MB of Chromium locales.
- **Guardrails against over-engineering:** no plugin system, no abstraction layer over Excalidraw, no generic repository pattern, no state-machine library. If a feature seems to need a new layer, stop and reconsider.

## Distribution & updates (your question: the best option)

**Recommendation: open source (MIT) on GitHub, with electron-updater pulling from GitHub Releases and signing added in stages.**

- **Windows and Linux:** auto-update works from the first release without signing (NSIS installer and AppImage; `.deb` is a manual download). Until the app is signed, Windows shows a SmartScreen warning. Fix it for free through **SignPath Foundation**, which signs open-source projects at no cost, or Azure Trusted Signing (about $10 a month, where eligible).
- **macOS:** macOS 15+ makes unsigned apps hard to open, and **Mac auto-update requires a signed app**. Join the Apple Developer Program ($99 a year) before announcing the Mac build publicly. Until then, Mac builds are a manual download with "Open Anyway" instructions, and the app shows a calm "Update available → Download" pill instead of installing silently.
- **CI is ready for signing from day one.** Signing and notarisation steps run only when their secrets exist, so adding certificates later means adding secrets, not changing code.
- **Release flow**
  1. Run `npm version minor && git push --follow-tags`.
  2. `release.yml` builds Windows (x64 and arm64), macOS (arm64 and x64, dmg and zip) and Linux (AppImage and deb).
  3. It creates a draft GitHub Release with the `latest*.yml` update files.
  4. You write the notes and publish; installed apps pick up the update.
- **Update UX:** checks 10 s after launch and every 6 hours, downloads in the background, then shows a "Restart to update" pill in the sidebar footer. It never restarts on its own. A setting turns off automatic checks.
- **Privacy:** no telemetry. The only network use is update checks and links you open yourself. The README says so.

## Build phases

Each phase ends with lint, typecheck, unit and e2e tests passing, then a short summary of what changed and a conventional commit. **Stop after each phase and wait for your go-ahead** (as PLAN.md asks).

1. **Scaffold and shell**
   - `git init`, `.gitignore`, MIT `LICENSE`, README stub, this plan saved as `docs/SPEC.md`, and a `CLAUDE.md` covering stack, layout, commands and conventions.
   - Hand-written electron-vite config, strict TypeScript (node and web tsconfigs), ESLint flat config, Prettier, Vitest, Playwright.
   - Secure window: per-OS frames, `app://` protocol with code cache, CSP, Fuses, saved window bounds, macOS app menu.
   - Typed preload skeleton.
   - `tokens.css` and the empty three-column layout with drag regions, in both themes.
   - `ci.yml` running on Windows, macOS and Ubuntu (Linux e2e under xvfb).
   - *Done when:* `npm run dev` opens the themed frameless window on Windows; CI is green on all three OSes; the e2e test launches the app and sees the layout.
2. **Library on disk (main only)**
   - `paths`, `fsx` (atomic writes, retries, queues), `scan` and reconcile, `ops` (including delete with undo), `pages`, `assets`, `watcher` (own-write suppression, conflict detection).
   - zod-validated IPC; per-device `state.json`.
   - *Done when:* Vitest, against real temp folders, covers create, rename, move, reorder, duplicate, delete and undo; external add, remove and rename; a simulated crash between write and rename leaving no partial file; sanitisation including reserved names; conflict-name detection. No renderer code can import `fs`.
3. **Canvas and navigation**
   - First-run welcome: "Use Documents/Zenbook", "Choose folder…" or "Open existing".
   - Sidebar: switcher, pinned section, tree with inline rename, native menus, drag and drop, keyboard navigation.
   - Single Excalidraw instance with the custom `MainMenu` and `WelcomeScreen`, local fonts and theme sync.
   - The full save/load pipeline including assets, viewport memory, Saved indicator, error banner, external reload and conflict copies.
   - Breadcrumb strip; New page, previous/next page, Space and sidebar shortcuts.
   - *Done when:*
     - e2e: draw a rectangle, switch page, quit and relaunch, and the rectangle is there.
     - A page with a pasted image has `files: {}` in its JSON and the image in `.assets/`.
     - "Save as .excalidraw" opens on excalidraw.com with its images (checked by hand once).
     - An external edit to the open page reloads it.
     - Switching to a 2,000-element fixture page takes under 300 ms.
4. **Notes panel**
   - Resizable panel that docks or overlays at 1200 px, with the title heading and footer line.
   - CodeMirror as a lazy chunk: Markdown with GFM task lists and strikethrough, our theme, live styling with faint markers, clickable checkboxes, spellcheck.
   - One `EditorView` and an `EditorState` cache per page, so undo and cursor survive switching away and back.
   - 600 ms autosave and flush.
   - The shape library persisted to `library.excalidrawlib`.
   - *Done when:* e2e: notes survive a switch and a relaunch, and the `.md` matches; empty notes create no file; the panel changes behaviour at 1200 px; a library item survives a relaunch.
5. **Search, palette, paper and focus**
   - MiniSearch in main (title boost, prefix and fuzzy matching, cache in `userData`, mtime reconcile).
   - Palette: recent pages, actions, `>` mode, shortcut hints; kept mounted so it opens instantly.
   - Paper per page: transparent canvas with an underlay, and export dialogs temporarily switch to a solid paper colour.
   - Focus mode, the Pinned section and the Recent list.
   - *Done when:* on a 1,000-page fixture, searches return in under 100 ms and find text inside drawings and in notes; every action is reachable from the keyboard; e2e: Ctrl+K, type, Enter opens the page.
6. **Polish and ship**
   - Sample "Start here" Space built with `convertToExcalidrawElements`.
   - Design pass: Excalidraw CSS-variable overrides, motion, empty states, focus rings, contrast in both themes; ensō app icon.
   - Drop `.excalidraw` files on a chapter to import them.
   - `electron-builder.yml`: targets, `files: out/**`, asar, locales, Fuses, macOS hardened runtime and entitlements.
   - Updater and `release.yml`; README with screenshots and install notes; privacy note; short CONTRIBUTING and issue templates.
   - *Done when:* a test tag produces installers for all three OSes; Windows and AppImage builds update from 0.1.0 to 0.1.1 on their own; the performance targets are measured and written down.

## Verification

- **Every phase:** `npm run lint && npm run typecheck && npm test && npm run e2e` locally on Windows, and in CI on Windows, macOS and Ubuntu.
- **Performance:** run `npm run fixture -- --pages 1000 --elements 2000 --out <tmp>`, then launch with `ZENBOOK_LIBRARY=<tmp> ZENBOOK_PERF=1 npm run dev` and read the logged timings. Use a Chrome DevTools performance trace while drawing to confirm `onChange` stays under 0.5 ms. The test-only environment overrides work only when the app is unpackaged.
- **Manual checks:** offline launch (fonts still render); round-trip through excalidraw.com; dropping files in through Explorer or Finder and seeing them in the tree; an edit from a second machine in a synced folder (Dropbox or OneDrive) producing a conflict copy. Before the first public release, try the app on a real Mac.

## Risks to settle early (short spikes)

1. **Transparent Excalidraw canvas plus paper underlay** in both themes, and the export-dialog colour swap (Phase 3 spike, used in Phase 5). Fallback: plain paper, plus Excalidraw's built-in grid for "Grid".
2. **Capture-phase shortcuts** don't interfere with Excalidraw text editing or with CodeMirror, and Excalidraw ignores keys while the notes editor has focus.
3. **Fonts over `app://`:** the protocol, the code cache and `EXCALIDRAW_ASSET_PATH` load fonts correctly when offline.
4. **Image timing:** `addFiles` versus `updateScene` order when switching to pages with images.

## Before going public

- **Name:** "Zenbook" is ASUS's laptop brand. Consider a distinct name before announcing; it's one config value plus the repo name.
- **Signing:** the Apple Developer ID for Mac, and SignPath or Azure for Windows (see Distribution).
- **Repo identity:** set the `appId` (for example `io.github.<you>.zenbook`) and the GitHub `publish` owner once the repo exists.
