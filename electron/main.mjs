// Proceso principal de Electron: levanta el servidor interno y lo muestra en una ventana.
import { app, BrowserWindow, dialog, shell, Menu } from 'electron';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configure } from '../lib/ytdlp.mjs';
import { startServer } from '../lib/app.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

function setupBinaries() {
  // En la app empaquetada los binarios están en resources/bin (fuera del .asar).
  const bundledBin = app.isPackaged ? join(process.resourcesPath, 'bin') : join(ROOT, 'bin');

  // yt-dlp se copia a la carpeta de datos del usuario para poder actualizarlo sin permisos de administrador.
  const userBin = join(app.getPath('userData'), 'bin');
  const ytdlp = join(userBin, exe('yt-dlp'));
  if (!existsSync(ytdlp)) {
    mkdirSync(userBin, { recursive: true });
    copyFileSync(join(bundledBin, exe('yt-dlp')), ytdlp);
  }

  configure({
    binDir: bundledBin,
    ytdlp,
    // El propio ejecutable de Electron actúa como Node para resolver el JavaScript de YouTube.
    jsRuntime: `node:${process.execPath}`,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

async function createWindow() {
  setupBinaries();
  const { port } = await startServer({
    port: 0,
    mode: 'desktop',
    settingsFile: join(app.getPath('userData'), 'settings.json'),
    pickFolder: async (current) => {
      const r = await dialog.showOpenDialog(win, {
        title: 'Elegir carpeta de descargas',
        defaultPath: current,
        properties: ['openDirectory', 'createDirectory'],
      });
      return r.canceled ? null : r.filePaths[0];
    },
    openPath: (p) => shell.openPath(p),
  });

  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 420,
    minHeight: 500,
    title: 'MDownloader',
    backgroundColor: '#0f1115',
    icon: join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  Menu.setApplicationMenu(null);

  // Los links (p. ej. "ver en YouTube") se abren en el navegador del sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) { e.preventDefault(); shell.openExternal(url); }
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(createWindow).catch((e) => {
  dialog.showErrorBox('MDownloader', `No se pudo iniciar la aplicación:\n${e.stack || e.message}`);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
