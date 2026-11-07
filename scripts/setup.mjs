// Prepara la carpeta bin/ con yt-dlp, ffmpeg y ffprobe.
// Uso: node scripts/setup.mjs [--update]
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin');
const isWin = process.platform === 'win32';
const exe = (n) => (isWin ? `${n}.exe` : n);
const update = process.argv.includes('--update');

mkdirSync(BIN, { recursive: true });

// --- yt-dlp (binario oficial desde GitHub releases) ---
const ytdlpPath = join(BIN, exe('yt-dlp'));
const ytdlpAsset = isWin ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';

if (!existsSync(ytdlpPath)) {
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpAsset}`;
  console.log(`Descargando yt-dlp desde ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar yt-dlp: HTTP ${res.status}`);
  writeFileSync(ytdlpPath, Buffer.from(await res.arrayBuffer()));
  if (!isWin) chmodSync(ytdlpPath, 0o755);
  console.log('yt-dlp listo.');
} else if (update) {
  console.log('Actualizando yt-dlp ...');
  spawnSync(ytdlpPath, ['-U'], { stdio: 'inherit' });
} else {
  console.log('yt-dlp ya existe (usa "npm run update-ytdlp" para actualizarlo).');
}

// --- ffmpeg / ffprobe (desde paquetes npm) ---
function copyBinary(name, srcPath) {
  const dest = join(BIN, exe(name));
  if (existsSync(dest) && !update) return;
  if (!srcPath || !existsSync(srcPath)) {
    console.warn(`AVISO: no se encontró ${name} en node_modules. Instálalo manualmente o ejecuta "npm install" de nuevo.`);
    return;
  }
  copyFileSync(srcPath, dest);
  if (!isWin) chmodSync(dest, 0o755);
  console.log(`${name} listo.`);
}

try { copyBinary('ffmpeg', require('ffmpeg-static')); } catch (e) { console.warn('ffmpeg-static:', e.message); }
try { copyBinary('ffprobe', require('ffprobe-static').path); } catch (e) { console.warn('ffprobe-static:', e.message); }

console.log('Configuración completada. Ejecuta "npm start".');
