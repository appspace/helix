# Helix

A MySQL database management web app — a browser-based alternative to MySQL Workbench. Built with React, TypeScript, and Vite. Designed to run locally (e.g. inside a Docker container) and accessed at `localhost`.

## What it does

- SQL query editor with line numbers and `Ctrl+Enter` to run
- Schema browser — collapsible tree of tables, columns (with types and PK indicators), views, procedures, triggers
- Query results grid — sortable columns, row selection, NULL highlighting, execution time
- Multi-tab query workspace
- Connection manager modal (host, port, user, password, SSL)
- Dark and light theme toggle

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
```

## Design system

The visual design is defined in two places:

- **`src/index.css`** — all CSS custom properties: background layers, border levels, accent teal, text hierarchy, semantic colors (error/warning/success), SQL syntax colors, typography scale, spacing, radii, shadows
- **`src/theme.ts`** — the same tokens as a TypeScript object (`DARK` / `LIGHT`), passed as a `t` prop to every component for inline styles
