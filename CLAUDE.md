# Zenbook — notes for Claude

A calm, local-first desktop notebook (Electron + React + TypeScript). Every page is an
Excalidraw canvas plus a Markdown note, organised Space › Chapter › Page. The full spec,
with an "as built" status section, is **docs/SPEC.md**. PLAN.md is the original brief.

## Stack

- Electron 45 · electron-vite 6 (Vite 8) · React 19 · TypeScript 6.0 strict
- `@excalidraw/excalidraw` 0.18 (official package, never forked or patched)
- CodeMirror 6 for notes · Zustand for UI state · MiniSearch and zod in main; Node fs.watch for watching
- Vitest (unit) · Playwright for Electron (e2e) · electron-builder + electron-updater
- TypeScript stays on 6.0.x until typescript-eslint supports 7.

## Layout

```text
src/shared/            types and constants for both sides (api.ts is the whole IPC contract)
src/main/              window, app:// protocol, security, menus, IPC, prefs, updater, session
src/main/library/      library service: fsx (atomic writes), scan, library (ops, pages,
                       assets), watcher, search, sample content (+ *.test.ts)
src/preload/           contextBridge → window.zenbook (the only bridge)
src/renderer/src/      App, store, commands (every user action), keys, editors, tree helpers
  sidebar/ canvas/ notes/ palette/ ui/ styles/
e2e/                   Playwright tests against the built app (helpers.ts launches it)
scripts/               copy-excalidraw-fonts, make-fixture (perf library), make-icon
build/                 icon.svg/png, macOS entitlements
```

## Commands

- `npm run dev` · `npm run build` · `npm run lint` · `npm run typecheck`
- `npm test` (Vitest) · `npm run e2e` (builds, then Playwright)
- `npm run check` runs lint, typecheck, unit and e2e. Run it before every commit.
- `npm run fixture -- --pages 1000 --elements 2000 --out <dir>`, then run the app with
  `ZENBOOK_LIBRARY=<dir> ZENBOOK_PERF=1` to measure.

## Conventions

- TypeScript strict. No `any` without a comment explaining why.
- Only the main process touches the filesystem. The renderer uses `window.zenbook.*` and
  sends **IDs, never paths**. Every IPC handler goes through `handle()` in src/main/ipc.ts
  (sender check + zod).
- User actions live in `src/renderer/src/commands.ts`, so menus, shortcuts and the palette
  behave identically.
- Use Excalidraw's public APIs. Style it only by overriding its CSS variables
  (styles/excalidraw.css).
- Excalidraw `onChange` and CodeMirror updates must stay tiny: no setState, no JSON, no IPC.
  Saving happens in the canvas/notes controllers, debounced.
- Files on disk are the source of truth. Caches live in userData and must be rebuildable.
- Runtime libraries go in devDependencies so they get bundled. Only electron-updater is a
  real `dependency`.
- Ask before adding any dependency not listed in docs/SPEC.md.
- Unit-test the library service; a Playwright test for each user-facing flow.
- Small commits with conventional messages (feat:, fix:, chore:, docs:, test:).

## Gotchas

- Sandboxed preloads must be CommonJS, so package.json has no `"type": "module"`. ESM config
  files use `.mjs` or `.mts`.
- Zustand selectors must return stable values (strings, booleans, existing objects), not
  new objects, or React re-renders forever.
- The React Compiler lint rules forbid `setState` directly inside effects: derive state,
  remount with a key, or set it from event handlers and async callbacks.
- Excalidraw binds Ctrl/Cmd+K to "add link". Zenbook takes it in a capture-phase listener.
- `EXCALIDRAW_ASSET_PATH` is set in main.tsx, before the Excalidraw chunk loads. Console
  errors about `esm.sh` fonts are expected: the CSP blocks Excalidraw's CDN fallback.
- Never watch with one handle per folder (e.g. chokidar): on Windows it blocks renaming
  Space folders. The watcher uses recursive `fs.watch` (one handle on the root).
- Windows can't move a folder while any file inside it is open, and `shell.trashItem` on a
  locked folder pops up an "administrator permission" dialog. `Library.trash()` first proves
  each item can move (rename to a hidden name and back); a failed delete comes back with a
  `notice` toast. Restart the app after a main-process change: a stale main keeps old code.
- Tall scrollers need `contain: strict`, or software-rendered canvases slow to a crawl
  (see the SPEC status section).
- `ZENBOOK_USER_DATA`, `ZENBOOK_LIBRARY` are honoured only when the app is not packaged;
  `ZENBOOK_PERF=1` logs timings.
- If GitHub release downloads fail (504), set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
  and, for electron-builder, `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.
  Both are checksum-verified.
