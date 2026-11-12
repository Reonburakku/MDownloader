const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  mode: 'spotify',
  kind: 'audio',
  items: [], // { key, title, artist, durationMs, query, candidates, sel, checked, status, jobId, percent, error, el }
  formats: {},
};

// Calidades sugeridas por formato
const QUALITIES = {
  mp3: [['192', '192 kbps (recomendado)'], ['256', '256 kbps'], ['320', '320 kbps'], ['128', '128 kbps (más liviano)']],
  m4a: [['best', 'Original (~128 kbps AAC)']],
  opus: [['best', 'Original (~130 kbps Opus)']],
  mp4: [['1080', '1080p (recomendado)'], ['720', '720p (más liviano)'], ['480', '480p'], ['1440', '1440p'], ['2160', '4K (archivos grandes)']],
};

// ---------- Utilidades ----------
const fmtDur = (s) => (s == null ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Error HTTP ${res.status}`);
  return j;
}

function showMessage(text, type = '') {
  const m = $('#message');
  m.hidden = !text;
  m.textContent = text || '';
  m.className = `message ${type}`;
}

// Ejecuta tareas con concurrencia limitada
async function pool(tasks, n) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tasks.length) await tasks[i++]();
  }));
}

// ---------- Configuración inicial ----------
function setFolder(dir) {
  state.downloadDir = dir;
  $('#folderPath').textContent = dir;
  $('#openFolder').title = `Abrir ${dir}`;
}

(async () => {
  const cfg = await api('/api/config');
  state.formats = cfg.formats;
  state.cfg = cfg;
  setFolder(cfg.downloadDir);
  renderFormatOptions();
})();

// La barra de descarga es fija: se reserva su alto real debajo de la lista para que no tape canciones.
function syncBarSpace() {
  const bar = $('#downloadBar');
  document.body.style.paddingBottom = bar.hidden ? '' : `${bar.offsetHeight + 24}px`;
}
new ResizeObserver(syncBarSpace).observe($('#downloadBar'));
window.addEventListener('resize', syncBarSpace);

// ---------- Ajustes ----------
const dlg = $('#settings');

$('#openSettings').addEventListener('click', async () => {
  const cfg = await api('/api/config');
  const f = $('#settingsForm').elements;
  f.downloadDir.value = cfg.downloadDir;
  f.spotifyClientId.value = cfg.spotifyClientId || '';
  f.spotifyClientSecret.value = cfg.spotifyConfigured ? '********' : '';
  $('#pickFolder').hidden = !cfg.canPickFolder;
  $('#ytdlpVersion').textContent = cfg.ytdlpVersion || 'no encontrado';
  $('#updateMsg').textContent = '';
  dlg.showModal();
});

$('#pickFolder').addEventListener('click', async () => {
  const r = await api('/api/pick-folder', {});
  $('#settingsForm').elements.downloadDir.value = r.downloadDir;
  setFolder(r.downloadDir);
});

$('#updateYtdlp').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $('#updateMsg').textContent = 'Buscando actualización…';
  try {
    const r = await api('/api/update-ytdlp', {});
    $('#ytdlpVersion').textContent = r.version;
    $('#updateMsg').textContent = /up to date|actualizado/i.test(r.output) ? 'Ya tienes la última versión.' : `Actualizado a ${r.version}.`;
  } catch (err) {
    $('#updateMsg').textContent = `No se pudo actualizar: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'save') return;
  const f = $('#settingsForm').elements;
  try {
    const r = await api('/api/settings', {
      downloadDir: f.downloadDir.value,
      spotifyClientId: f.spotifyClientId.value,
      spotifyClientSecret: f.spotifyClientSecret.value,
    });
    setFolder(r.downloadDir);
    showMessage('Ajustes guardados.');
  } catch (err) {
    showMessage(err.message, 'error');
  }
});

// ---------- Pestañas de entrada ----------
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  state.mode = t.dataset.mode;
  $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $$('.mode').forEach((m) => m.classList.toggle('hidden', m.dataset.mode !== state.mode));
  showMessage('');
  $(`.mode[data-mode="${state.mode}"] input`).focus();
}));

$('#inputForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = { mode: state.mode };
  if (state.mode === 'spotify') body.value = f.spotify.value;
  if (state.mode === 'youtube') body.value = f.youtube.value;
  if (state.mode === 'song') { body.title = f.title.value; body.artist = f.artist.value; }

  const btn = $('#addBtn');
  btn.disabled = true;
  btn.textContent = 'Buscando…';
  showMessage(state.mode === 'spotify' ? 'Leyendo la lista de Spotify…' : 'Consultando…');
  try {
    const r = await api('/api/resolve', body);
    const newItems = r.items.map((it) => ({ ...it, sel: 0, checked: true, status: it.candidates ? 'ready' : 'searching' }));
    state.items.push(...newItems);
    newItems.forEach(renderRow);
    updateCounts();
    const dupes = r.removed ? ` Se omitieron ${r.removed} repetida(s).` : '';
    showMessage(r.warning || `Agregadas ${newItems.length} canción(es) de "${r.name}".${dupes}`, r.warning ? 'warn' : '');
    e.target.reset();
    // Busca en YouTube las que vienen de Spotify / nombre+artista
    const toSearch = newItems.filter((it) => !it.candidates);
    await pool(toSearch.map((it) => () => searchItem(it)), 4);
  } catch (err) {
    showMessage(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buscar y agregar';
  }
});

async function searchItem(it) {
  try {
    const r = await api('/api/search', { query: it.query, durationMs: it.durationMs, artist: it.artist });
    it.candidates = r.candidates;
    it.status = r.candidates.length ? 'ready' : 'notfound';
    if (!r.candidates.length) it.checked = false;
  } catch (err) {
    it.status = 'error';
    it.error = err.message;
    it.checked = false;
  }
  renderRow(it);
  updateCounts();
}

// ---------- Lista ----------
function renderRow(it) {
  if (!it.el) {
    it.el = $('#rowTpl').content.firstElementChild.cloneNode(true);
    $('#list').append(it.el);
    $('.sel', it.el).addEventListener('change', (e) => { it.checked = e.target.checked; updateCounts(); });
    $('.cand', it.el).addEventListener('change', (e) => { it.sel = Number(e.target.value); renderRow(it); });
    bindClip(it);
    $('.clip-play', it.el).addEventListener('click', () => togglePlay(it));
  }
  const el = it.el;
  const c = it.candidates?.[it.sel];
  $('.t', el).textContent = it.title;
  $('.a', el).textContent = it.artist ? `— ${it.artist}` : '';
  $('.sel', el).checked = it.checked;
  $('.sel', el).disabled = !c;

  const img = $('.thumb', el);
  if (c) img.src = c.thumbnail; else img.removeAttribute('src');

  const select = $('.cand', el);
  select.innerHTML = '';
  if (it.candidates?.length) {
    it.candidates.forEach((x, i) => select.add(new Option(`${x.title} · ${x.channel} · ${fmtDur(x.duration)}`, i)));
    select.value = it.sel;
    select.disabled = it.candidates.length < 2 || ['queued', 'downloading', 'converting'].includes(it.status);
  } else {
    select.add(new Option(it.status === 'searching' ? 'Buscando en YouTube…' : 'Sin resultados'));
    select.disabled = true;
  }
  const a = $('.yt', el);
  a.hidden = !c;
  if (c) a.href = c.url;

  renderClip(it);

  const labels = {
    searching: 'Buscando…', ready: '', notfound: 'No encontrada', queued: 'En cola',
    downloading: it.clipActive && !it.percent
      ? 'Descargando fragmento…'
      : `${Math.round(it.percent || 0)}%${it.speed ? ' · ' + it.speed : ''}`,
    converting: 'Convirtiendo…', done: '✓ Descargada', error: it.error || 'Error',
  };
  $('.st', el).textContent = labels[it.status] ?? '';
  $('.st', el).title = it.status === 'error' ? it.error || '' : it.file || '';
  $('.bar i', el).style.width = `${it.status === 'done' ? 100 : it.percent || 0}%`;
  el.classList.toggle('busy', ['queued', 'downloading', 'converting'].includes(it.status));
  el.classList.toggle('done', it.status === 'done');
  el.classList.toggle('error', it.status === 'error' || it.status === 'notfound');
}

// ---------- Fragmento (desde / hasta) ----------
const BUSY = ['queued', 'downloading', 'converting'];

/** "1:45" → 105, "1:02:03" → 3723, "90" → 90, "" → null, inválido → NaN */
function parseTime(str) {
  const s = String(str).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  if (!/^\d+(:[0-5]?\d){1,2}$/.test(s)) return NaN;
  return s.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
}

const fmtTime = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

/** Fragmento del video elegido. Por defecto, de 0:00 al final; se reinicia si se cambia de video. */
function getClip(it) {
  const c = it.candidates?.[it.sel];
  if (!it.clip || it.clip.sel !== it.sel) it.clip = { sel: it.sel, start: 0, end: c?.duration ?? null };
  return it.clip;
}

/** Devuelve { start, end } para enviar al servidor, solo si no es la canción completa. */
function clipToSend(it) {
  const c = it.candidates[it.sel];
  const { start, end } = getClip(it);
  const fullEnd = end == null || (c.duration != null && end >= c.duration);
  return { start: start > 0 ? start : undefined, end: fullEnd ? undefined : end };
}

function bindClip(it) {
  const el = it.el;
  const [cs, ce, r1, r2] = ['.cs', '.ce', '.r1', '.r2'].map((s) => $(s, el));

  const set = (start, end) => {
    const d = it.candidates?.[it.sel]?.duration ?? null;
    const clip = getClip(it);
    clip.start = Math.max(0, Math.min(start, d != null ? d - 1 : start));
    clip.end = end == null ? null : Math.max(clip.start + 1, d != null ? Math.min(end, d) : end);
    renderClip(it);
  };

  // Deslizadores: cada manija no puede cruzar a la otra
  r1.addEventListener('input', () => {
    const v = Math.min(Number(r1.value), Number(r2.value) - 1);
    r1.value = v;
    set(v, getClip(it).end);
  });
  r2.addEventListener('input', () => {
    const v = Math.max(Number(r2.value), Number(r1.value) + 1);
    r2.value = v;
    set(getClip(it).start, v);
  });

  // Cajas de texto: se aplican al salir del campo o con Enter
  const commit = (input, which) => {
    const v = parseTime(input.value);
    const clip = getClip(it);
    const d = it.candidates?.[it.sel]?.duration ?? null;
    const bad = Number.isNaN(v)
      || (which === 'start' && v != null && ((clip.end ?? Infinity) <= v || (d != null && v >= d)))
      || (which === 'end' && v != null && v <= clip.start);
    input.classList.toggle('invalid', bad);
    if (bad) {
      input.title = which === 'start' ? 'El inicio debe ser menor que el final' : 'El final debe ser mayor que el inicio';
      return;
    }
    input.title = which === 'start' ? 'Desde (m:ss)' : 'Hasta (m:ss)';
    if (which === 'start') set(v ?? 0, clip.end);
    else set(clip.start, v ?? d); // vacío = hasta el final
    // Muestra el valor ya normalizado ("45" → "0:45", "20:00" → duración real)
    const val = which === 'start' ? getClip(it).start : getClip(it).end;
    input.value = val == null ? '' : fmtTime(val);
  };
  for (const [input, which] of [[cs, 'start'], [ce, 'end']]) {
    input.addEventListener('change', () => commit(input, which));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(input, which); input.blur(); } });
  }

  $('.clip-reset', el).addEventListener('click', () => {
    it.clip = null;
    [cs, ce].forEach((i) => i.classList.remove('invalid'));
    renderClip(it);
  });
}

function renderClip(it) {
  const el = it.el;
  const box = $('.clip', el);
  const c = it.candidates?.[it.sel];
  box.classList.toggle('hidden-clip', !c);
  if (!c) return;

  const d = c.duration ?? null;
  const clip = getClip(it);
  const [cs, ce, r1, r2] = ['.cs', '.ce', '.r1', '.r2'].map((s) => $(s, el));

  // No pisar lo que el usuario está escribiendo
  if (document.activeElement !== cs && !cs.classList.contains('invalid')) cs.value = fmtTime(clip.start);
  if (document.activeElement !== ce && !ce.classList.contains('invalid')) ce.value = clip.end == null ? '' : fmtTime(clip.end);

  box.classList.toggle('no-duration', d == null);
  if (d != null) {
    for (const r of [r1, r2]) r.max = d;
    r1.value = clip.start;
    r2.value = clip.end ?? d;
    const range = $('.range', el);
    range.style.setProperty('--a', `${(clip.start / d) * 100}%`);
    range.style.setProperty('--b', `${((clip.end ?? d) / d) * 100}%`);
    // Si las manijas se juntan al final, la de inicio debe quedar encima para poder moverla
    r1.style.zIndex = clip.start > d * 0.9 ? 2 : 1;
  }

  const play = $('.clip-play', el);
  const downloaded = hasDownloadedFile(it);
  play.title = play.ariaLabel = player.item === it
    ? 'Detener'
    : downloaded ? 'Reproducir la parte descargada' : 'Escuchar el fragmento seleccionado';

  const trimmed = clip.start > 0 || (clip.end != null && (d == null || clip.end < d));
  box.classList.toggle('trimmed', trimmed);
  const busy = BUSY.includes(it.status);
  for (const i of [cs, ce, r1, r2, $('.clip-reset', el)]) i.disabled = busy;
}

// ---------- Reproducción del fragmento ----------
const player = { audio: new Audio(), item: null, end: null };

/** El archivo descargado corresponde al video elegido ahora (si se cambió de video, ya no). */
const hasDownloadedFile = (it) => it.status === 'done' && it.file && it.dlSel === it.sel;

function setPlayIcon(it, mode) { // mode: 'idle' | 'loading' | 'playing'
  if (!it?.el) return;
  const b = $('.clip-play', it.el);
  b.textContent = mode === 'idle' ? '▶' : '■';
  b.classList.toggle('playing', mode === 'playing');
  b.classList.toggle('loading', mode === 'loading');
  renderClip(it);
}

function stopPlayer() {
  const it = player.item;
  player.item = null;
  player.audio.pause();
  player.audio.removeAttribute('src');
  player.audio.load();
  setPlayIcon(it, 'idle');
}

function togglePlay(it) {
  const same = player.item === it;
  stopPlayer();
  if (same) return;
  const a = player.audio;
  player.item = it;
  if (hasDownloadedFile(it)) {
    // El archivo ya es el fragmento descargado: se reproduce entero.
    player.end = null;
    a.src = `/api/file?path=${encodeURIComponent(it.file)}`;
  } else {
    // Escucha previa del fragmento elegido directamente desde YouTube.
    const c = it.candidates[it.sel];
    const { start, end } = getClip(it);
    player.end = end;
    a.src = `/api/preview/${encodeURIComponent(c.id)}#t=${start}`;
  }
  setPlayIcon(it, 'loading');
  a.play().catch((err) => {
    if (player.item !== it) return; // se detuvo antes de empezar
    stopPlayer();
    if (err.name !== 'AbortError') showMessage(`No se pudo reproducir "${it.title}".`, 'error');
  });
}

player.audio.addEventListener('playing', () => setPlayIcon(player.item, 'playing'));
player.audio.addEventListener('waiting', () => setPlayIcon(player.item, 'loading'));
player.audio.addEventListener('timeupdate', () => {
  if (player.end != null && player.audio.currentTime >= player.end) stopPlayer();
});
player.audio.addEventListener('ended', stopPlayer);
player.audio.addEventListener('error', () => {
  const it = player.item;
  if (!it) return;
  stopPlayer();
  showMessage(`No se pudo reproducir "${it.title}".`, 'error');
});

function selectedItems() {
  return state.items.filter((it) => it.checked && it.candidates?.[it.sel]);
}

function updateCounts() {
  const n = state.items.length;
  $('#listCard').hidden = n === 0;
  $('#downloadBar').hidden = n === 0;
  syncBarSpace();
  const sel = selectedItems().length;
  $('#countLabel').textContent = `${sel} de ${n} seleccionada(s)`;
  $('#checkAll').checked = sel > 0 && sel === state.items.filter((it) => it.candidates?.length).length;
  $('#downloadBtn').textContent = `Descargar ${sel || ''}`.trim();
  $('#downloadBtn').disabled = sel === 0;
}

$('#checkAll').addEventListener('change', (e) => {
  state.items.forEach((it) => { if (it.candidates?.length) { it.checked = e.target.checked; renderRow(it); } });
  updateCounts();
});

$('#clearBtn').addEventListener('click', () => {
  stopPlayer();
  state.items = state.items.filter((it) => ['queued', 'downloading', 'converting'].includes(it.status));
  $('#list').innerHTML = '';
  state.items.forEach((it) => { it.el = null; renderRow(it); });
  updateCounts();
  showMessage('');
});

$('#openFolder').addEventListener('click', () => api('/api/open-folder', {}));

// ---------- Opciones de descarga ----------
$$('#kindSeg button').forEach((b) => b.addEventListener('click', () => {
  state.kind = b.dataset.kind;
  $$('#kindSeg button').forEach((x) => x.classList.toggle('active', x === b));
  renderFormatOptions();
}));

function renderFormatOptions() {
  const fmts = state.formats[state.kind] || {};
  const sel = $('#format');
  sel.innerHTML = '';
  Object.entries(fmts).forEach(([k, v]) => sel.add(new Option(v.label, k)));
  renderQualityOptions();
}

function renderQualityOptions() {
  const fmt = $('#format').value;
  const q = $('#quality');
  q.innerHTML = '';
  (QUALITIES[fmt] || []).forEach(([v, l]) => q.add(new Option(l, v)));
  q.disabled = q.options.length < 2;
  $('#formatNote').textContent = state.formats[state.kind]?.[fmt]?.note || '';
}
$('#format').addEventListener('change', renderQualityOptions);

// ---------- Descargas ----------
let polling = null;

$('#downloadBtn').addEventListener('click', async () => {
  const items = selectedItems().filter((it) => !['queued', 'downloading', 'converting'].includes(it.status));
  if (!items.length) return;
  try {
    const r = await api('/api/download', {
      kind: state.kind,
      format: $('#format').value,
      quality: $('#quality').value,
      items: items.map((it) => ({
        key: it.key,
        url: it.candidates[it.sel].url,
        // Para Spotify / búsqueda usamos "Artista - Título"; para links de YouTube, el título del video
        name: it.query ? (it.artist ? `${it.artist} - ${it.title}` : it.title) : null,
        ...clipToSend(it),
      })),
    });
    for (const { key, jobId } of r.jobs) {
      const it = state.items.find((x) => x.key === key);
      const clip = clipToSend(it);
      const clipActive = clip.start != null || clip.end != null;
      Object.assign(it, { jobId, status: 'queued', percent: 0, error: null, file: null, checked: false, clipActive, dlSel: it.sel });
      renderRow(it);
    }
    updateCounts();
    if (!polling) polling = setInterval(poll, 700);
  } catch (err) {
    showMessage(err.message, 'error');
  }
});

async function poll() {
  const active = state.items.filter((it) => it.jobId && ['queued', 'downloading', 'converting'].includes(it.status));
  if (!active.length) { clearInterval(polling); polling = null; return; }
  try {
    const r = await api('/api/jobs', { ids: active.map((it) => it.jobId) });
    for (const it of active) {
      const j = r[it.jobId];
      if (!j) continue;
      Object.assign(it, j);
      renderRow(it);
    }
    const done = state.items.filter((it) => it.jobId);
    if (done.every((it) => ['done', 'error'].includes(it.status))) {
      const ok = done.filter((it) => it.status === 'done').length;
      showMessage(`Descargas terminadas: ${ok} de ${done.length}. Están en ${state.downloadDir}`, ok === done.length ? '' : 'warn');
    }
  } catch { /* el servidor puede estar ocupado; reintenta en el siguiente ciclo */ }
}
