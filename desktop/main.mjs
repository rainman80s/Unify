// Unify.js desktop shell: runs the local engine + server in-process and shows it in a native window.
import { app, BrowserWindow, Menu, dialog, ipcMain, shell, safeStorage } from 'electron';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3'); // Electron has no node:sqlite
const here = dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
// Packaged builds carry a copy of app/ + engine/ in ./bundle (see bundle.mjs); in development, use the repo directly.
const { existsSync } = await import('node:fs');
const serverPath = existsSync(join(here, 'bundle/app/server.js')) ? join(here, 'bundle/app/server.js') : join(here, '../app/server.js');
const { startServer } = await import(pathToFileURL(serverPath).href);
const { createSecretStore } = await import(pathToFileURL(join(dirname(serverPath), 'secrets.js')).href);

// Apps launched from Finder don't get your shell PATH, so `claude` / `codex` wouldn't be found. Borrow it from a login shell.
function adoptLoginShellPath() {
  if (process.platform === 'win32') return;
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    const p = execFileSync(sh, ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { encoding: 'utf8', timeout: 5000 });
    const m = p.match(/__P__(.*)__P__/);
    if (m && m[1]) process.env.PATH = m[1];
  } catch { /* keep the default PATH */ }
}

const settingsFile = () => join(app.getPath('userData'), 'settings.json');
const loadSettings = () => { try { return JSON.parse(readFileSync(settingsFile(), 'utf8')); } catch { return {}; } };
const saveSettings = s => writeFileSync(settingsFile(), JSON.stringify(s, null, 2));

let win = null;
let server = null;

async function boot() {
  const { folder } = loadSettings();
  if (server) await server.close();
  server = await startServer({
    mode: folder ? 'real' : 'demo', cwd: folder ?? app.getPath('home'), port: 0,
    appVersion: app.getVersion(), // enables the "new version available" check against GitHub Releases
    dataDir: join(app.getPath('userData'), 'data'), Database,
    // API keys are encrypted with the OS keychain (safeStorage). If that's unavailable, keys can only come from env vars.
    secrets: safeStorage.isEncryptionAvailable()
      ? createSecretStore({ file: join(app.getPath('userData'), 'keys.json'),
          encrypt: s => safeStorage.encryptString(s).toString('base64'), decrypt: b => safeStorage.decryptString(Buffer.from(b, 'base64')) })
      : createSecretStore({ file: null }),
  });
  console.log(`[unify] ${server.mode} mode at ${server.url}`);
  app.setName('Unify.js');
  if (win) { win.setTitle(folder ? `Unify.js — ${basename(folder)}` : 'Unify.js — Demo'); await win.loadURL(`${server.url}/?desktop=1`); }
}

async function chooseFolder() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open a project folder', buttonLabel: 'Use This Folder', properties: ['openDirectory', 'createDirectory'],
    message: 'Claude Code and Codex will be able to read and edit files in this folder.',
  });
  if (r.canceled || !r.filePaths[0]) return false;
  saveSettings({ ...loadSettings(), folder: r.filePaths[0] });
  await boot(); buildMenu(); return true;
}
async function useDemo() { const s = loadSettings(); delete s.folder; saveSettings(s); await boot(); buildMenu(); }

function buildMenu() {
  const { folder } = loadSettings();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Open Project Folder…', accelerator: 'CmdOrCtrl+O', click: chooseFolder },
      { label: 'Demo Mode (simulated AIs)', type: 'checkbox', checked: !folder, click: useDemo },
      { type: 'separator' },
      folder ? { label: `Reveal ${basename(folder)} in Finder`, click: () => shell.openPath(folder) } : { label: 'No project folder', enabled: false },
      { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 820, minHeight: 560, show: false,
    title: 'Unify.js',
    ...(isMac ? { titleBarStyle: 'hiddenInset', vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: '#00000000' } : { backgroundColor: '#ececf1' }),
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  // Stay on the local app; open anything else in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!server || !url.startsWith(server.url)) { e.preventDefault(); shell.openExternal(url); } });
}

ipcMain.handle('unify:open-folder', () => chooseFolder());
ipcMain.handle('unify:use-demo', () => useDemo());

app.whenReady().then(async () => {
  adoptLoginShellPath();
  createWindow(); buildMenu();
  try { await boot(); }
  catch (e) { dialog.showErrorBox('Unify.js could not start', String(e?.stack ?? e)); app.quit(); }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { createWindow(); boot(); } });
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
app.on('before-quit', () => server?.close());
