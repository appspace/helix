# Helix

A MySQL database management web app — a browser-based alternative to MySQL Workbench. Built with React, TypeScript, and Vite. Designed to run locally (e.g. inside a Docker container) and accessed at `localhost`.

![Helix walkthrough — connect, browse, query, edit, insert](docs/demo.gif)

## What it does

- SQL query editor with line numbers and `Ctrl+Enter` to run
- Schema browser — collapsible tree of tables, columns (with types and PK indicators), views, procedures, triggers
- Query results grid — sortable columns, row selection, NULL highlighting, execution time
- Multi-tab query workspace
- Connection manager modal (host, port, user, password, SSL)
- Dark and light theme toggle

## Security model — local use only

Helix is a **local-first** tool. The backend has **no authentication**: `/api/connect`, `/api/query`, `/api/delete-row`, and `/api/update-cell` are all open to anyone who can reach port `3001`. The MySQL connection pool is a process-wide singleton, so whoever connects last controls what every subsequent request runs — and every request can execute arbitrary SQL against that connection.

**Do not expose the backend (port `3001`) or the Vite dev server to any network you don't fully control.** Bind to `localhost` only, do not put it behind a public reverse proxy, and do not run it with `--host` on a shared or untrusted network. Treat it like a desktop app: if you wouldn't hand someone raw MySQL credentials, don't give them access to this service either.

If you need to share access with others, run a separate instance per person and keep each one on its own machine.

## Getting started

Install dependencies for both the frontend and the backend:

```bash
npm install
npm install --prefix server
```

Create the server env file from the example:

```bash
cp server/.env.example server/.env
```

Note: `server/.env.example` ships with `CORS_ORIGIN=http://localhost:5174`, but Vite defaults to `5173`. Set `CORS_ORIGIN=http://localhost:5173` in `server/.env` unless you've overridden Vite's port.

Run the frontend and backend together:

```bash
npm run dev:all
```

- Frontend (Vite): `http://localhost:5173`
- Backend (Express + mysql2): `http://localhost:3001`

You can also start them individually with `npm run dev` (frontend only) or `npm run dev:server` (backend only).

To build the frontend for production:

```bash
npm run build
```

## Desktop app (Electron)

Helix can run as a native desktop app on macOS, Windows, and Linux using Electron. The packaged app bundles both the React frontend and the Express backend into a single installer — no separate server process or browser tab required.

### Run in dev mode (Electron window + hot reload)

```bash
npm run electron:dev
```

This starts the Vite dev server, the Express backend, and an Electron window all at once. The window loads from the Vite dev server so hot module replacement works as normal.

> **Note:** The Express server must be able to accept requests from `http://localhost:5173`. Make sure `CORS_ORIGIN=http://localhost:5173` is set in `server/.env`.

### Build a distributable installer

```bash
npm run electron:build
```

This runs three steps in sequence:

1. `npm run build` — compiles TypeScript and bundles the React app into `dist/`
2. `npm run electron:build:server` — uses esbuild to bundle the Express server and all its dependencies into a single `electron/server.cjs` file
3. `electron-builder` — packages everything into a platform-specific installer under `release/`

Output installers:

| Platform | Format | Location |
|---|---|---|
| macOS | `.dmg` | `release/*.dmg` |
| Windows | NSIS `.exe` installer | `release/*.exe` |
| Linux | `.AppImage` | `release/*.AppImage` |

### Icons

Place these files in the `build/` directory before running `electron:build`:

| File | Size | Used for |
|---|---|---|
| `build/icon.icns` | 512×512+ | macOS app icon |
| `build/icon.ico` | 256×256 | Windows app icon |
| `build/icon.png` | 512×512 | Linux app icon, window chrome |
| `build/tray.png` | 16×16 or 32×32 | Taskbar / menu-bar tray icon |

You can generate all formats from a single 1024×1024 PNG using [electron-icon-builder](https://www.npmjs.com/package/electron-icon-builder) or a tool like [IconKitchen](https://icon.kitchen). Without icon files the app falls back to a transparent placeholder and won't crash, but icons are required to produce a properly branded installer.

### How the production build works

In the packaged app, Electron uses Node's `utilityProcess` API to fork the bundled Express server as a subprocess. The server is given the path to `dist/` and serves the React frontend as static files alongside the API, so the Electron window loads everything from `http://localhost:3001` — no separate browser or proxy needed. The server process is terminated automatically when the app quits.

## Tech stack

| Layer | Tool |
|---|---|
| Framework | React 19 |
| Language | TypeScript (strict, `verbatimModuleSyntax`) |
| Build | Vite 8 + esbuild |
| Backend | Express 4 + mysql2, run with `tsx watch` |
| Node | 24 LTS |

## Project structure

```
src/
├── App.tsx                     # App shell, state, mock data
├── theme.ts                    # DARK and LIGHT token objects (colors, shadows, SQL palette)
├── index.css                   # CSS custom properties (design tokens), Google Fonts, resets
└── components/
    ├── TopBar.tsx              # Tab bar, logo, theme toggle, connection status
    ├── SchemaBrowser.tsx       # Left sidebar — schema selector, filter, collapsible tree
    ├── QueryEditor.tsx         # SQL textarea with line numbers and toolbar
    ├── ResultsTable.tsx        # Sortable data grid with status bar
    └── ConnectionManager.tsx   # Connection modal (host/port/user/password/SSL)

server/
└── src/
    └── index.ts               # Express API server (connect, query, schema, MCP)

electron/
├── main.cjs                   # Electron main process (window, tray, server lifecycle)
└── server.cjs                 # Bundled Express server — generated by electron:build:server

build/
├── icon.icns                  # macOS app icon (add your own)
├── icon.ico                   # Windows app icon (add your own)
├── icon.png                   # Linux app icon (add your own)
└── tray.png                   # Taskbar tray icon (add your own)
```

## Design system

The visual design is defined in two places:

- **`src/index.css`** — all CSS custom properties: background layers, border levels, accent teal, text hierarchy, semantic colors (error/warning/success), SQL syntax colors, typography scale, spacing, radii, shadows
- **`src/theme.ts`** — the same tokens as a TypeScript object (`DARK` / `LIGHT`), passed as a `t` prop to every component for inline styles

## License

Helix is licensed under the [GNU Affero General Public License v3.0](LICENSE). You're free to use, modify, and redistribute it, including commercially — but if you run a modified version as a network-accessible service, you must publish your source changes under the same license.
