# Contributing to Zenbook

Thanks for helping. Zenbook aims to stay small, calm and fast, so the best contributions
are focused ones.

## Before you start

- **Bugs:** open an issue with steps to reproduce, your OS and the Zenbook version
  (_… → About Zenbook_).
- **Features:** open an issue first to talk it through. Ideas that add settings, panels or
  dependencies need a strong reason. The [spec](docs/SPEC.md) lists what's planned.

## Working on the code

```sh
npm install
npm run dev
```

Read [CLAUDE.md](CLAUDE.md) for the layout and conventions. The important ones:

- Only the main process touches the filesystem. The renderer calls `window.zenbook.*` and
  passes IDs, never paths. Every IPC handler validates its arguments with zod.
- Use Excalidraw's public API; style it only through its CSS variables. Never patch it.
- Files on disk are the source of truth. Anything cached must be rebuildable.
- No new runtime dependencies without discussing them first.

## Before opening a pull request

```sh
npm run check   # lint, typecheck, unit tests, end-to-end tests
```

- Keep pull requests small and focused, with a [conventional](https://www.conventionalcommits.org)
  title (`feat:`, `fix:`, `docs:` …).
- Add a test for behaviour you change: unit tests for the library service, Playwright for
  user-facing flows.
- For anything that affects speed (opening pages, drawing, search), measure with
  `npm run fixture` and `ZENBOOK_PERF=1`.

By contributing you agree that your work is released under the [MIT licence](LICENSE).
