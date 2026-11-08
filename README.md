# Zenbook

A calm, local-first notebook for Windows, macOS and Linux. Every page is an
[Excalidraw](https://excalidraw.com) canvas with a Markdown note beside it, organised
as **Spaces › Chapters › Pages**.

> **Status:** early development (Phase 1 of 6: app shell). Not ready for everyday use yet.

## Principles

- **The canvas is the hero.** Chrome stays quiet and out of the way.
- **Your files, your folder.** Pages are standard `.excalidraw` and `.md` files in a
  folder you choose. They open on excalidraw.com and sync with Dropbox, iCloud Drive,
  OneDrive, Syncthing or git.
- **Fast and small.** One canvas instance, autosave with crash-safe writes, no bloat.
- **Private.** No accounts, no telemetry. The only network use is checking for updates.

## Development

Requires Node.js 22.12 or newer.

```sh
npm install
npm run dev        # run the app with hot reload
npm run check      # lint, typecheck, unit tests and end-to-end tests
```

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Start the app in development mode             |
| `npm run build`     | Build main, preload and renderer into `out/`  |
| `npm run lint`      | ESLint                                        |
| `npm run typecheck` | TypeScript, strict                            |
| `npm test`          | Unit tests (Vitest)                           |
| `npm run e2e`       | Build, then end-to-end tests (Playwright)     |
| `npm run dist`      | Build installers for the current OS (`dist/`) |

The full product and build plan lives in [docs/SPEC.md](docs/SPEC.md).

## License

[MIT](LICENSE)
