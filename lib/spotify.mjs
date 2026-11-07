// Lectura de playlists / álbumes / canciones públicas de Spotify.
// 1) Sin credenciales: se lee la página "embed" pública (hasta ~100 canciones).
// 2) Con SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET: se usa la Web API oficial (sin límite).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

export function parseSpotifyUrl(input) {
  const s = String(input).trim();
  let m = s.match(/^spotify:(playlist|album|track):([A-Za-z0-9]+)/);
  if (m) return { type: m[1], id: m[2] };
  m = s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album|track)\/([A-Za-z0-9]+)/i);
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  return null;
}

async function fromEmbed(type, id) {
  const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Spotify respondió HTTP ${res.status}. ¿La lista es pública?`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('No se pudo leer la información de Spotify (cambió el formato de la página).');
  const entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new Error('Spotify no devolvió datos. Verifica que el link sea público.');

  if (type === 'track') {
    return {
      name: entity.name,
      tracks: [{
        title: entity.name,
        artist: (entity.artists || []).map((a) => a.name).join(', '),
        durationMs: entity.duration,
      }],
    };
  }
  return {
    name: entity.name || entity.title,
    tracks: (entity.trackList || []).map((t) => ({
      title: t.title,
      artist: t.subtitle?.replace(/ /g, ' ') || '',
      durationMs: t.duration,
    })),
  };
}

let tokenCache = null;
export const resetSpotifyToken = () => { tokenCache = null; };

async function getToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (tokenCache && tokenCache.expires > Date.now()) return tokenCache.token;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Credenciales de Spotify inválidas (HTTP ${res.status}).`);
  const j = await res.json();
  tokenCache = { token: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 };
  return tokenCache.token;
}

async function fromApi(type, id, token) {
  const get = async (url) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Spotify API HTTP ${r.status}`);
    return r.json();
  };
  const mapTrack = (t) => t && ({
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    durationMs: t.duration_ms,
  });

  if (type === 'track') {
    const t = await get(`https://api.spotify.com/v1/tracks/${id}`);
    return { name: t.name, tracks: [mapTrack(t)] };
  }
  const meta = await get(`https://api.spotify.com/v1/${type}s/${id}?fields=name`);
  const tracks = [];
  let url = type === 'playlist'
    ? `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100&fields=next,items(track(name,duration_ms,artists(name)))`
    : `https://api.spotify.com/v1/albums/${id}/tracks?limit=50`;
  while (url) {
    const page = await get(url);
    for (const it of page.items) {
      const t = mapTrack(type === 'playlist' ? it.track : it);
      if (t) tracks.push(t);
    }
    url = page.next;
  }
  return { name: meta.name, tracks };
}

export async function getSpotifyTracks(input) {
  const parsed = parseSpotifyUrl(input);
  if (!parsed) throw new Error('Link de Spotify no reconocido. Usa un link de playlist, álbum o canción.');
  const token = await getToken().catch(() => null);
  if (token) {
    try { return await fromApi(parsed.type, parsed.id, token); } catch { /* cae al método embed */ }
  }
  const result = await fromEmbed(parsed.type, parsed.id);
  if (parsed.type !== 'track' && result.tracks.length >= 100 && !token) {
    result.warning = 'Spotify sin credenciales solo entrega las primeras 100 canciones. Configura SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET para listas más grandes.';
  }
  return result;
}
