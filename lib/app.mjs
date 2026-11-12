// Servidor HTTP de MDownloader (API + interfaz). Lo usan tanto "npm start" como Electron.
import express from 'express';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, extname } from 'node:path';
import { Readable } from 'node:stream';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getSpotifyTracks, parseSpotifyUrl, resetSpotifyToken } from './spotify.mjs';
import { getYoutubeInfo, searchYoutube, download, FORMATS, updateYtdlp, ytdlpVersion, getAudioStream } from './ytdlp.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * @param {object} o
 * @param {string} o.settingsFile  archivo JSON donde se guardan los ajustes
 * @param {number} [o.port]        0 = puerto libre aleatorio
 * @param {string} [o.mode]        'web' | 'desktop'
 * @param {() => Promise<string|null>} [o.pickFolder]  selector de carpeta nativo (solo escritorio)
 * @param {(p: string) => void} [o.openPath]           abre una carpeta en el explorador
 * @returns {Promise<{port: number, close: () => void}>}
 */
export async function startServer(o) {
  // ---------- Ajustes persistentes ----------
  const defaults = {
    downloadDir: process.env.DOWNLOAD_DIR || join(homedir(), 'Downloads', 'MDownloader'),
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
    spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  };
  let settings = { ...defaults };
  try { settings = { ...defaults, ...JSON.parse(readFileSync(o.settingsFile, 'utf8')) }; } catch { /* primera vez */ }

  const applySettings = () => {
    process.env.SPOTIFY_CLIENT_ID = settings.spotifyClientId || '';
    process.env.SPOTIFY_CLIENT_SECRET = settings.spotifyClientSecret || '';
    resetSpotifyToken();
  };
  const saveSettings = () => {
    mkdirSync(dirname(o.settingsFile), { recursive: true });
    writeFileSync(o.settingsFile, JSON.stringify(settings, null, 2));
  };
  applySettings();

  const concurrency = Number(process.env.CONCURRENCY) || 3;
  const openPath = o.openPath || ((p) => {
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(cmd, [p], { detached: true, stdio: 'ignore' }).unref();
  });

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(PUBLIC));

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: e.message }));

  app.get('/api/config', wrap(async (req, res) => res.json({
    mode: o.mode || 'web',
    downloadDir: settings.downloadDir,
    formats: FORMATS,
    canPickFolder: !!o.pickFolder,
    spotifyConfigured: !!(settings.spotifyClientId && settings.spotifyClientSecret),
    spotifyClientId: settings.spotifyClientId,
    ytdlpVersion: await ytdlpVersion(),
  })));

  app.post('/api/settings', wrap(async (req, res) => {
    const b = req.body || {};
    if (typeof b.downloadDir === 'string' && b.downloadDir.trim()) settings.downloadDir = b.downloadDir.trim();
    if (typeof b.spotifyClientId === 'string') settings.spotifyClientId = b.spotifyClientId.trim();
    if (typeof b.spotifyClientSecret === 'string' && b.spotifyClientSecret !== '********') settings.spotifyClientSecret = b.spotifyClientSecret.trim();
    applySettings();
    saveSettings();
    res.json({ ok: true, downloadDir: settings.downloadDir });
  }));

  app.post('/api/pick-folder', wrap(async (req, res) => {
    if (!o.pickFolder) throw new Error('No disponible en modo navegador.');
    const dir = await o.pickFolder(settings.downloadDir);
    if (dir) { settings.downloadDir = dir; saveSettings(); }
    res.json({ downloadDir: settings.downloadDir });
  }));

  app.post('/api/update-ytdlp', wrap(async (req, res) => {
    const output = await updateYtdlp();
    res.json({ output, version: await ytdlpVersion() });
  }));

  /**
   * Convierte la entrada del usuario en una lista de elementos.
   * Los elementos de Spotify / nombre+artista traen "query" y se buscan después en YouTube.
   */
  app.post('/api/resolve', wrap(async (req, res) => {
    const { mode, value, title, artist } = req.body || {};
    // Marca las canciones que ya están en la carpeta de descargas
    const send = (payload) => res.json(markExisting(payload, settings.downloadDir));
    if (mode === 'spotify') {
      if (!parseSpotifyUrl(value)) throw new Error('Pega un link de Spotify (playlist, álbum o canción).');
      const r = await getSpotifyTracks(value);
      // Sin repetidas (mismo título y artista) y en orden alfabético
      const tracks = sortByTitle(uniqueBy(r.tracks, (t) => `${songKey(cleanTitle(t.title))}|${songKey(t.artist)}`));
      return send({
        name: r.name,
        warning: r.warning,
        removed: r.tracks.length - tracks.length,
        items: tracks.map((t) => ({
          key: randomUUID(),
          title: t.title,
          artist: t.artist,
          durationMs: t.durationMs,
          query: `${t.artist.split(',')[0]} - ${cleanTitle(t.title)}`,
        })),
      });
    }
    if (mode === 'song') {
      if (!title?.trim()) throw new Error('Escribe el nombre de la canción.');
      return send({
        name: 'Búsqueda',
        items: [{ key: randomUUID(), title: title.trim(), artist: (artist || '').trim(), query: `${(artist || '').trim()} ${title.trim()}`.trim() }],
      });
    }
    if (mode === 'youtube') {
      if (!/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(String(value).trim())) {
        throw new Error('Pega un link de YouTube válido.');
      }
      const r = await getYoutubeInfo(value.trim());
      // Sin repetidas (mismo video o mismo título) y en orden alfabético
      const videos = sortByTitle(uniqueBy(uniqueBy(r.videos, (v) => v.id), (v) => songKey(v.title)));
      return send({
        name: r.name,
        removed: r.videos.length - videos.length,
        items: videos.map((v) => ({ key: randomUUID(), title: v.title, artist: v.channel, candidates: [v] })),
      });
    }
    throw new Error('Tipo de entrada no válido.');
  }));

  app.post('/api/search', wrap(async (req, res) => {
    const { query, durationMs, artist } = req.body || {};
    if (!query) throw new Error('Falta la búsqueda.');
    res.json({ candidates: await searchYoutube(query, durationMs, artist) });
  }));

  // ---------- Reproducción ----------
  /** Escucha previa: reenvía el audio de YouTube (con soporte de saltos / Range) para el reproductor. */
  app.get('/api/preview/:id', async (req, res) => {
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    try {
      if (!/^[\w-]{6,20}$/.test(req.params.id)) throw new Error('Video no válido.');
      const s = await getAudioStream(req.params.id);
      const headers = { ...s.headers };
      if (req.headers.range) headers.Range = req.headers.range;
      const up = await fetch(s.url, { headers, signal: ac.signal });
      if (!up.ok && up.status !== 206) throw new Error(`YouTube respondió ${up.status}`);
      res.status(up.status);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = up.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: e.message });
      else res.destroy();
    }
  });

  /** Archivo ya descargado (solo dentro de la carpeta de descargas). */
  app.get('/api/file', (req, res) => {
    const p = resolve(String(req.query.path || ''));
    const rel = relative(resolve(settings.downloadDir), p);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(p)) {
      return res.status(404).json({ error: 'Archivo no encontrado.' });
    }
    res.sendFile(p);
  });

  // ---------- Cola de descargas ----------
  const jobs = new Map();
  const queue = [];
  let active = 0;

  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active++;
      job.status = 'downloading';
      download({
        ...job.params,
        onProgress: (p) => {
          job.percent = p.percent ?? job.percent;
          job.speed = p.speed;
          job.eta = p.eta;
          if (p.stage === 'convert') job.status = 'converting';
        },
      })
        .then((file) => { job.status = 'done'; job.percent = 100; job.file = file; })
        .catch((e) => { job.status = 'error'; job.error = e.message; })
        .finally(() => { active--; pump(); });
    }
  }

  app.post('/api/download', wrap(async (req, res) => {
    const { items, kind, format, quality } = req.body || {};
    if (!Array.isArray(items) || !items.length) throw new Error('No hay elementos para descargar.');
    if (!FORMATS[kind]?.[format]) throw new Error('Formato no válido.');
    const clips = items.map(parseClip); // valida todo antes de encolar nada
    mkdirSync(settings.downloadDir, { recursive: true });
    const ids = items.map((it, i) => {
      const id = randomUUID();
      const job = {
        id, status: 'queued', percent: 0,
        params: { url: it.url, name: it.name, kind, format, quality, outDir: settings.downloadDir, ...clips[i] },
      };
      jobs.set(id, job);
      queue.push(job);
      return { key: it.key, jobId: id };
    });
    pump();
    res.json({ jobs: ids });
  }));

  app.post('/api/jobs', (req, res) => {
    const ids = req.body?.ids || [];
    res.json(Object.fromEntries(ids.map((id) => {
      const j = jobs.get(id);
      return [id, j ? { status: j.status, percent: j.percent, speed: j.speed, eta: j.eta, error: j.error, file: j.file } : null];
    })));
  });

  app.post('/api/open-folder', (req, res) => {
    mkdirSync(settings.downloadDir, { recursive: true });
    openPath(settings.downloadDir);
    res.json({ ok: true });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(o.port ?? 0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
    server.on('error', reject);
  });
}

/** Fragmento opcional { start, end } en segundos; end null = hasta el final. */
function parseClip(it) {
  const start = it.start == null || it.start === '' ? 0 : Number(it.start);
  const end = it.end == null || it.end === '' ? null : Number(it.end);
  if (!Number.isFinite(start) || start < 0) throw new Error(`Inicio de fragmento no válido en "${it.name || it.url}".`);
  if (end != null && (!Number.isFinite(end) || end <= start)) {
    throw new Error(`El final del fragmento debe ser mayor que el inicio en "${it.name || it.url}".`);
  }
  return { start, end };
}

// ---------- Canciones ya descargadas ----------
const MEDIA_EXT = new Set(['.mp3', '.m4a', '.opus', '.ogg', '.webm', '.mp4', '.mkv', '.aac', '.flac', '.wav']);
// Sufijo que se agrega a los fragmentos: " (0m30s-1m45s)" o " (1m00s-fin)"
const CLIP_SUFFIX = /\s\((\d+h)?\d+m\d{2}s-((\d+h)?\d+m\d{2}s|fin)\)$/;

/**
 * Índice de los archivos de la carpeta: clave normalizada del nombre → ruta.
 * Si existen la canción completa y algún fragmento, se prefiere la completa.
 */
function indexDownloads(dir) {
  const index = new Map();
  let names = [];
  try { names = readdirSync(dir); } catch { return index; }
  for (const f of names) {
    const ext = extname(f).toLowerCase();
    if (!MEDIA_EXT.has(ext)) continue;
    const base = f.slice(0, -ext.length);
    const clip = CLIP_SUFFIX.test(base);
    const k = songKey(base.replace(CLIP_SUFFIX, ''));
    if (!k) continue;
    const prev = index.get(k);
    if (!prev || (prev.clip && !clip)) index.set(k, { path: join(dir, f), clip });
  }
  return index;
}

/** Agrega "existing" (ruta del archivo) a los elementos que ya se descargaron antes. */
function markExisting(payload, dir) {
  const index = indexDownloads(dir);
  let found = 0;
  for (const it of payload.items) {
    // Mismo nombre que usa la descarga: "Artista - Título" (Spotify / búsqueda) o el título del video
    const name = it.query ? (it.artist ? `${it.artist} - ${it.title}` : it.title) : it.candidates?.[0]?.title;
    const hit = index.get(songKey(name));
    if (hit) { it.existing = hit.path; found++; }
  }
  payload.existing = found;
  return payload;
}

// Clave para detectar canciones repetidas: sin mayúsculas, tildes ni signos.
const songKey = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

/** Conserva solo la primera aparición de cada clave. */
function uniqueBy(list, keyFn) {
  const seen = new Set();
  return list.filter((x) => {
    const k = keyFn(x);
    if (!k) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true, ignorePunctuation: true });
/** Orden alfabético por título (y por artista/canal si el título coincide). */
const sortByTitle = (list) => [...list].sort((a, b) =>
  collator.compare(a.title || '', b.title || '') || collator.compare(a.artist || a.channel || '', b.artist || b.channel || ''));

function cleanTitle(t) {
  return t
    .replace(/\s*-\s*(\d{4}\s*)?remaster(ed)?(\s*\d{4})?.*$/i, '')
    .replace(/\s*[([](\d{4}\s*)?remaster(ed)?[^)\]]*[)\]]/i, '')
    .trim();
}
