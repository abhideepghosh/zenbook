# Zenbook — notes for Claude

A calm, local-first desktop notebook (Electron + React + TypeScript). Every page is an
Excalidraw canvas plus a Markdown note, organised Space › Chapter › Page. The full
spec and phase plan is **docs/SPEC.md**; read it before starting a phase.
PLAN.md is the original brief and is kept for reference only.

## Stack

- Electron 45 · electron-vite 6 (Vite 8) · React 19 · TypeScript 6.0 strict
- `@excalidraw/excalidraw` 0.18 (official package, never forked or patched)
- CodeMirror 6 for notes · Zustand for UI state · MiniSearch, chokidar, zod in main
- Vitest (unit) · Playwright for Electron (e2e) · electron-builder + electron-updater
- TypeScript stays on 6.0.x until typescript-eslint supports 7.

## Layout

```text
src/shared/     types and constants used by both sides (api.ts, channels.ts, theme.ts)
src/main/       main process: window, app:// protocol, security, menu, IPC, state
src/main/library/  library service (Phase 2+): fs, scan, ops, pages, assets, watcher, search
src/preload/    contextBridge → window.zenbook (the only bridge)
src/renderer/   React app (index.html, src/App.tsx, styles/tokens.css, ui/)
e2e/            Playwright tests, run against the built app in out/
```

## Commands

- `npm run dev` · `npm run build` · `npm run lint` · `npm run typecheck`
- `npm test` (Vitest) · `npm run e2e` (builds, then Playwright)
- `npm run check` runs lint, typecheck, unit and e2e. Run it before every commit.

## Conventions

- TypeScript strict. No `any` without a comment explaining why.
- Only the main process touches the filesystem. The renderer uses `window.zenbook.*`.
- The renderer sends **IDs, never paths**. Main resolves IDs from its tree and still checks
  every path stays inside the library root.
- Every IPC handler goes through `handle()` in src/main/ipc.ts (sender check + zod).
- Use Excalidraw's public APIs (MainMenu, updateScene, CaptureUpdateAction,
  exportToBlob …). Style it only by overriding its CSS variables.
- Files on disk are the source of truth. Caches live in userData and must be rebuildable.
- Excalidraw `onChange` must stay tiny: no setState, no JSON, no IPC (see SPEC
  "Save / load pipeline").
- Runtime libraries go in devDependencies so they get bundled (nothing in node_modules
  ships). Only electron-updater is a real `dependency`.
- Ask before adding any dependency not listed in docs/SPEC.md.
- Unit-test the library service; one Playwright test per phase for its "Done when".
- Small commits with conventional messages (feat:, fix:, chore:, docs:, test:).
- Work phase by phase: stop at the end of each phase, run `npm run check`, summarise
  what changed and wait for the go-ahead.

## Gotchas

- Sandboxed preloads must be CommonJS, so package.json has no `"type": "module"`.
  ESM config files therefore use `.mjs` or `.mts` extensions.
- Excalidraw binds Ctrl/Cmd+K to "add link". Zenbook takes it for the palette using a
  capture-phase listener on `window`.
- `ZENBOOK_USER_DATA`, `ZENBOOK_LIBRARY` and `ZENBOOK_PERF=1` are honoured only when the
  app is not packaged (tests, fixtures, timing).
- If GitHub release downloads fail while installing Electron, set
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`. The download is still verified
  against the checksums bundled in the electron npm package.
