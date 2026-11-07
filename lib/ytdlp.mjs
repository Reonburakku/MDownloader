// Envoltorio sobre yt-dlp: búsqueda, metadatos y descarga.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);

// Configuración por defecto (modo "npm start"): binarios en ./bin y Node del sistema.
const cfg = {
  ytdlp: null,      // ruta a yt-dlp
  ffmpegDir: null,  // carpeta con ffmpeg(.exe)
  jsRuntime: 'node',
  env: process.env,
};

/**
 * Ajusta las rutas usadas por yt-dlp.
 * @param {{binDir?: string, ytdlp?: string, ffmpegDir?: string, jsRuntime?: string, env?: object}} o
 */
export function configure(o = {}) {
  const binDir = o.binDir || join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
  cfg.ytdlp = o.ytdlp || (existsSync(join(binDir, exe('yt-dlp'))) ? join(binDir, exe('yt-dlp')) : 'yt-dlp');
  cfg.ffmpegDir = o.ffmpegDir || (existsSync(join(binDir, exe('ffmpeg'))) ? binDir : null);
  if (o.jsRuntime) cfg.jsRuntime = o.jsRuntime;
  if (o.env) cfg.env = o.env;
}
configure();

export const ytdlpPath = () => cfg.ytdlp;

function baseArgs() {
  // YouTube requiere un runtime de JavaScript desde 2025 (aquí: Node).
  // --encoding utf-8: en Windows yt-dlp escribe por defecto en cp1252 y las tildes llegan rotas.
  const a = ['--js-runtimes', cfg.jsRuntime, '--no-warnings', '--ignore-config', '--encoding', 'utf-8'];
  if (cfg.ffmpegDir) a.push('--ffmpeg-location', cfg.ffmpegDir);
  return a;
}

/** Actualiza yt-dlp a la última versión. Devuelve el texto de salida. */
export function updateYtdlp() {
  return new Promise((resolve, reject) => {
    const p = spawn(cfg.ytdlp, ['-U'], { windowsHide: true, env: cfg.env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(out.trim() || `código ${code}`))));
  });
}

export function ytdlpVersion() {
  return new Promise((resolve) => {
    const p = spawn(cfg.ytdlp, ['--version'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => resolve(out.trim() || null));
  });
}

function run(args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cfg.ytdlp, [...baseArgs(), ...args], { windowsHide: true, env: cfg.env });
    let out = '', err = '', buf = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      out += d;
      if (onLine) {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        lines.forEach(onLine);
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (onLine && buf) onLine(buf);
      if (code === 0) resolve(out);
      else reject(new Error((err.match(/ERROR:.*$/m)?.[0] || err.trim() || `yt-dlp terminó con código ${code}`).slice(0, 400)));
    });
  });
}

const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

function mapEntry(e) {
  return {
    id: e.id,
    url: `https://www.youtube.com/watch?v=${e.id}`,
    title: e.title,
    channel: e.channel || e.uploader || '',
    duration: e.duration ?? null,
    thumbnail: thumb(e.id),
  };
}

/** Información de un link de YouTube (video o playlist). */
export async function getYoutubeInfo(url) {
  const j = JSON.parse(await run(['-J', '--flat-playlist', url]));
  if (j._type === 'playlist') {
    return {
      name: j.title,
      videos: (j.entries || []).filter((e) => e.id && e.title !== '[Private video]' && e.title !== '[Deleted video]').map(mapEntry),
    };
  }
  return { name: j.title, videos: [mapEntry(j)] };
}

// Penaliza versiones que normalmente no queremos, salvo que el usuario las pida.
const BAD_WORDS = ['live', 'en vivo', 'cover', 'karaoke', 'instrumental', 'remix', 'sped up', 'slowed', 'reverb', '8d', 'reaction', 'tutorial', 'lesson', 'nightcore', 'bass boosted', 'acoustic'];

/**
 * Quita tildes y otros diacríticos latinos (á→a, ü→u, ç→c) para la búsqueda.
 * Conserva la ñ, porque es otra letra ("año" ≠ "ano"), y no toca otros alfabetos
 * (japonés, coreano, árabe…), cuyas marcas no están en el rango U+0300–U+036F.
 */
export function stripAccents(s) {
  return [...String(s || '').normalize('NFC')]
    .map((ch) => (ch === 'ñ' || ch === 'Ñ' ? ch : ch.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC')))
    .join('');
}

// Para comparar textos: minúsculas y sin ningún diacrítico (incluida la ñ, en ambos lados por igual).
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => fold(s).replace(/[^a-z0-9]/g, '');

function score(c, query, durationSec, artist) {
  const t = fold(c.title);
  const q = fold(query);
  const ch = norm(c.channel).replace(/(topic|vevo|official|oficial|music|tv)$/g, '');
  const artists = String(artist || '').split(',').map(norm).filter(Boolean);
  // Canal del propio artista (o su VEVO / Topic) = fuente oficial
  const official = ch && artists.some((a) => a && (ch.includes(a) || a.includes(ch)));
  let s = 0;
  for (const w of BAD_WORDS) if (t.includes(w) && !q.includes(w)) s -= 30;
  if (official) s += 30;
  if (/ - topic$/i.test(c.channel)) s += 25;               // canal "Artista - Topic" = audio oficial
  if (/vevo$/i.test(c.channel)) s += 10;
  if (/official (audio|video|music video|visualizer)|audio oficial|video oficial/.test(t)) s += official ? 10 : 3;
  // Subidas de fans con letra / traducción
  if (/lyrics?|letra|sub\.?\s|subtitulad|traducid|español|espanol/.test(t)) s -= official ? 3 : 15;
  if (durationSec && c.duration) {
    const diff = Math.abs(c.duration - durationSec);
    s -= diff <= 3 ? 0 : Math.min(60, diff / 2);
  }
  // Coincidencia de palabras de la búsqueda en título + canal
  const words = q.split(/[\s\-–,()&]+/).filter((w) => w.length > 1);
  const hay = `${t} ${fold(c.channel)}`;
  s += words.filter((w) => hay.includes(w)).length * 4;
  return s;
}

/** Busca en YouTube y devuelve candidatos ordenados del mejor al peor. */
export async function searchYoutube(query, durationMs, artist) {
  const search = async (q) => JSON.parse(await run(['-J', '--flat-playlist', `ytsearch8:${q}`])).entries || [];
  // Se busca sin tildes; si así no aparece nada, se reintenta con el texto original.
  const plain = stripAccents(query);
  let entries = await search(plain);
  if (!entries.length && plain !== query) entries = await search(query);
  const durationSec = durationMs ? durationMs / 1000 : null;
  return entries
    .filter((e) => e.id && e.duration !== null) // descarta transmisiones en vivo
    .map(mapEntry)
    .map((c) => ({ ...c, score: score(c, query, durationSec, artist) }))
    .sort((a, b) => b.score - a.score);
}

// ---------- Formatos de descarga ----------
export const FORMATS = {
  audio: {
    mp3: { label: 'MP3', note: 'Máxima compatibilidad' },
    m4a: { label: 'M4A (AAC)', note: 'Más liviano, misma calidad percibida' },
    opus: { label: 'Opus', note: 'El más liviano; menos compatible con reproductores antiguos' },
  },
  video: {
    mp4: { label: 'MP4 (H.264 + AAC)', note: 'Se reproduce en prácticamente todo' },
  },
};

function formatArgs(kind, format, quality) {
  if (kind === 'audio') {
    const args = ['-f', 'bestaudio/best', '-x', '--embed-thumbnail', '--convert-thumbnails', 'jpg', '--embed-metadata'];
    if (format === 'mp3') args.push('--audio-format', 'mp3', '--audio-quality', `${quality || 192}K`);
    else if (format === 'm4a') {
      // Si existe la pista AAC original (128 kbps) se copia sin recodificar.
      args[1] = 'bestaudio[ext=m4a]/bestaudio/best';
      args.push('--audio-format', 'm4a');
    } else if (format === 'opus') {
      args[1] = 'bestaudio[acodec=opus]/bestaudio/best';
      args.push('--audio-format', 'opus');
    } else throw new Error('Formato de audio no válido');
    // Thumbnail cuadrada (estilo portada de álbum)
    args.push('--ppa', 'ThumbnailsConvertor+FFmpeg_o:-c:v mjpeg -vf crop="\'if(gt(ih,iw),iw,ih)\':\'if(gt(iw,ih),ih,iw)\'"');
    return args;
  }
  if (kind === 'video') {
    const h = Number(quality) || 1080;
    return [
      '-f', `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`,
      // Prioriza H.264 + AAC en MP4 para que se reproduzca en cualquier dispositivo
      '-S', `res:${h},vcodec:h264,acodec:aac,ext:mp4:m4a`,
      '--merge-output-format', 'mp4',
      '--embed-thumbnail', '--embed-metadata',
    ];
  }
  throw new Error('Tipo de descarga no válido');
}

// 105 → "1m45s" (sin ":" porque Windows no lo permite en nombres de archivo)
function clipLabel(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h ? `${h}h` : ''}${m}m${String(r).padStart(2, '0')}s`;
}

const sanitize = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);

/**
 * Descarga un video/audio, completo o solo un fragmento.
 * @param {object} o { url, name, kind, format, quality, outDir, start, end, onProgress }
 *   start / end: segundos del fragmento (end null = hasta el final). Sin ellos se descarga completo.
 * @returns {Promise<string>} ruta del archivo final
 */
export async function download({ url, name, kind, format, quality, outDir, start = 0, end = null, onProgress }) {
  const clip = start > 0 || end != null;
  // El fragmento va en el nombre para no sobrescribir la versión completa: "Canción (0m30s-1m45s)"
  const suffix = clip ? ` (${clipLabel(start)}-${end == null ? 'fin' : clipLabel(end)})` : '';
  const base = (name ? sanitize(name).replace(/%/g, '%%') : '%(title).150B') + suffix;
  let finalPath = null;
  const clipArgs = clip
    ? [
        '--download-sections', `*${start}-${end ?? 'inf'}`,
        // Corta en el segundo exacto (recodifica los bordes) en lugar del fotograma clave más cercano.
        '--force-keyframes-at-cuts',
        // Los capítulos incrustados conservarían la duración original del video.
        '--no-embed-chapters',
      ]
    : [];
  const args = [
    ...formatArgs(kind, format, quality),
    ...clipArgs,
    '--no-playlist', '--newline', '--progress', '--no-simulate',
    '--progress-template', 'download:PROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print', 'after_move:FILE|%(filepath)s',
    '-P', outDir,
    '-o', `${base}.%(ext)s`,
    url,
  ];
  // Las descargas de video vienen en 2 partes (video + audio); combinamos el progreso.
  // Los fragmentos los descarga ffmpeg de una vez, sin progreso intermedio.
  let part = 0, lastPct = 0;
  const parts = kind === 'video' && !clip ? 2 : 1;
  await run(args, {
    onLine: (line) => {
      if (line.startsWith('PROG|')) {
        const [, pct, speed, eta] = line.split('|');
        const p = parseFloat(pct) || 0;
        if (p < lastPct - 50) part = Math.min(part + 1, parts - 1);
        lastPct = p;
        if (p >= 100 && part === parts - 1) onProgress?.({ stage: 'convert', percent: 99 });
        else onProgress?.({ stage: 'download', percent: Math.min(99, (part * 100 + p) / parts), speed: speed?.trim(), eta: eta?.trim() });
      } else if (line.startsWith('FILE|')) {
        finalPath = line.slice(5).trim();
      }
    },
  });
  return finalPath;
}
