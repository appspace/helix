'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, utilityProcess, dialog, ipcMain, safeStorage, powerMonitor } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');

const isDev = !app.isPackaged;
// In dev the server is started by `npm run dev:server` outside this process,
// and is hardcoded to 3001. In production we pick a free port at startup so
// a leftover dev server (or any other listener) can't shadow us — the prior
// behaviour silently failed to bind, leaving the BrowserWindow to load
// whatever happened to be answering on 3001 (often "Cannot GET /").
let PORT = 3001;
let APP_URL = `http://localhost:${PORT}`;

app.setName('Helix');
const VITE_URL = 'http://localhost:5173';
const ERR_CONNECTION_REFUSED = -102;

// 1×1 transparent PNG — tray fallback when no icon file is present
const FALLBACK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=';

let win = null;
let tray = null;
let serverProc = null;

// ── Server ────────────────────────────────────────────────────────────────────

// Ask the OS for a port nobody's listening on. There's a small race window
// between close-and-fork where another process could grab it, but in practice
// it's many orders of magnitude better than hardcoding 3001 and silently
// losing to a leftover listener.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Fork the bundled server, wait until it answers, and reject loudly if it
// dies on the way up. Captures stderr so the error dialog can surface the
// real cause instead of a generic timeout.
async function startServer() {
  PORT = await findFreePort();
  APP_URL = `http://localhost:${PORT}`;

  const serverScript = path.join(__dirname, 'server.cjs');
  const staticPath = path.join(process.resourcesPath, 'dist');

  serverProc = utilityProcess.fork(serverScript, [], {
    env: { ...process.env, PORT: String(PORT), STATIC_PATH: staticPath },
    stdio: 'pipe',
  });

  let stderrBuf = '';
  let exited = false;
  serverProc.stdout?.on('data', (d) => console.log('[server]', String(d).trim()));
  serverProc.stderr?.on('data', (d) => {
    const s = String(d);
    stderrBuf += s;
    console.error('[server]', s.trim());
  });

  return new Promise((resolve, reject) => {
    serverProc.on('exit', (code) => {
      exited = true;
      // A clean exit before we've finished readiness probing is still a
      // failure — there's no surviving server for the renderer to talk to.
      reject(new Error(stderrBuf.trim() || `Server exited with code ${code}`));
    });

    const maxAttempts = 50;
    let attempts = 0;
    const attempt = () => {
      if (exited) return;
      if (attempts >= maxAttempts) {
        reject(new Error(stderrBuf.trim() || `Server did not respond after ${maxAttempts} attempts`));
        return;
      }
      attempts++;
      http
        .get(`${APP_URL}/api/connect/status`, () => resolve())
        .on('error', () => setTimeout(attempt, 300));
    };
    attempt();
  });
}

// ── Saved passwords (encrypted via OS keychain) ───────────────────────────────

function passwordsFile() {
  return path.join(app.getPath('userData'), 'passwords.json');
}

let passwordsCache = null;
function readPasswords() {
  if (passwordsCache) return passwordsCache;
  try {
    passwordsCache = JSON.parse(fs.readFileSync(passwordsFile(), 'utf8'));
  } catch {
    passwordsCache = {};
  }
  return passwordsCache;
}
function writePasswords(obj) {
  passwordsCache = obj;
  try {
    fs.writeFileSync(passwordsFile(), JSON.stringify(obj, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[passwords] write failed:', err);
  }
}

ipcMain.handle('passwords:available', () => {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
});

// Known limitation: renaming a saved connection orphans the old keychain entry —
// only the new name gets an entry; the old one is never removed.
ipcMain.handle('passwords:save', (_e, name, password) => {
  if (typeof name !== 'string' || !name || typeof password !== 'string' || !password) return;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Encryption not available on this system');
  const all = readPasswords();
  all[name] = safeStorage.encryptString(password).toString('base64');
  writePasswords(all);
});

ipcMain.handle('passwords:load', (_e, name) => {
  if (typeof name !== 'string' || !name) return null;
  const all = readPasswords();
  const b64 = all[name];
  if (!b64) return null;
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch (err) {
    console.error('[passwords] decrypt failed for', name, err);
    return null;
  }
});

ipcMain.handle('passwords:delete', (_e, name) => {
  if (typeof name !== 'string' || !name) return;
  const all = readPasswords();
  if (name in all) {
    delete all[name];
    writePasswords(all);
  }
});

// ── Icons ─────────────────────────────────────────────────────────────────────

function loadIcon(filename) {
  const img = nativeImage.createFromPath(path.join(app.getAppPath(), 'build', filename));
  return img.isEmpty() ? nativeImage.createFromDataURL(FALLBACK_PNG) : img;
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png';

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: loadIcon(iconFile),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
  });

  const url = isDev ? VITE_URL : APP_URL;
  win.loadURL(url);

  // Retry if Vite/Express dev servers haven't started yet
  win.webContents.on('did-fail-load', (_e, code) => {
    if (isDev && code === ERR_CONNECTION_REFUSED) setTimeout(() => win?.loadURL(url), 1000);
  });

  win.on('close', (e) => {
    // macOS convention: closing the window hides it; the app stays in the tray
    if (process.platform === 'darwin' && !app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(loadIcon('tray.png'));
  tray.setToolTip('Helix');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show Helix',
        click() {
          if (win) { win.show(); win.focus(); }
          else createWindow();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click() { app.isQuitting = true; app.quit(); },
      },
    ]),
  );

  tray.on('double-click', () => {
    if (win) { win.show(); win.focus(); }
    else createWindow();
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = loadIcon('icon.png');
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
  }

  if (!isDev) {
    try {
      await startServer();
    } catch (err) {
      // Show the underlying cause (captured stderr) so a user installing the
      // DMG can tell whether it's e.g. EADDRINUSE from a leftover dev server
      // vs. some other crash. Without this they'd see a blank "Cannot GET /"
      // page with no context.
      dialog.showErrorBox(
        "Helix can't start",
        `The bundled server failed to launch.\n\n${err.message || err}`,
      );
      app.quit();
      return;
    }
  }
  createWindow();
  createTray();

  // Sleep kills idle TCP sockets in the pool — the OS still reports them as
  // open, so the first post-resume query hangs on a dead socket. Notify the
  // bundled server so it drops and rebuilds its pool. See #145. Dev mode runs
  // its own server outside this process, so the message has no recipient and
  // is silently dropped.
  powerMonitor.on('resume', () => {
    serverProc?.postMessage({ type: 'host-resumed' });
  });

  app.on('activate', () => {
    if (win) win.show();
    else createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => { serverProc?.kill(); });
