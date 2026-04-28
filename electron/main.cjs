'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, utilityProcess, dialog, ipcMain, safeStorage } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const isDev = !app.isPackaged;
const PORT = 3001;

app.setName('Helix');
const VITE_URL = 'http://localhost:5173';
const APP_URL = `http://localhost:${PORT}`;
const ERR_CONNECTION_REFUSED = -102;

// 1×1 transparent PNG — tray fallback when no icon file is present
const FALLBACK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=';

let win = null;
let tray = null;
let serverProc = null;

// ── Server ────────────────────────────────────────────────────────────────────

function startServer() {
  const serverScript = path.join(__dirname, 'server.cjs');
  const staticPath = path.join(process.resourcesPath, 'dist');

  serverProc = utilityProcess.fork(serverScript, [], {
    env: { ...process.env, PORT: String(PORT), STATIC_PATH: staticPath },
    stdio: 'pipe',
  });

  serverProc.stdout?.on('data', (d) => console.log('[server]', String(d).trim()));
  serverProc.stderr?.on('data', (d) => console.error('[server]', String(d).trim()));
}

function waitForServer(maxAttempts = 50) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const attempt = () => {
      if (attempts >= maxAttempts) {
        reject(new Error(`Server did not start after ${maxAttempts} attempts`));
        return;
      }
      attempts++;
      http
        .get(`${APP_URL}/api/connect/status`, resolve)
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

ipcMain.handle('passwords:save', (_e, name, password) => {
  if (typeof name !== 'string' || !name || typeof password !== 'string') return;
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
    startServer();
    const started = await waitForServer().catch((err) => {
      dialog.showErrorBox('Helix failed to start', err.message);
      app.quit();
      return false;
    });
    if (started === false) return;
  }
  createWindow();
  createTray();

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
