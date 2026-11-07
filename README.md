# MDownloader

Aplicación local para buscar canciones en YouTube y descargarlas como audio o video, a partir de:

- **Link público de Spotify**: playlist, álbum o canción
- **Nombre de la canción y artista**
- **Link de YouTube**: video o playlist

## Para compartir con amigos (Windows)

En `dist/` están los archivos listos para compartir. No requieren instalar nada más:

- **`MDownloader-Setup-1.0.0.exe`** (~175 MB): instalador. No pide permisos de administrador y crea accesos directos en el escritorio y el menú Inicio.
- **`MDownloader-1.0.0-win.zip`** (~215 MB): versión portable. Se descomprime y se abre `MDownloader.exe`.

Ambos incluyen yt-dlp, ffmpeg y el motor de JavaScript que YouTube exige (el Node integrado en Electron).

> **Aviso de Windows:** como el ejecutable no tiene firma digital, Windows SmartScreen mostrará "Windows protegió su PC". Hay que hacer clic en **Más información → Ejecutar de todas formas**. Algunos antivirus también marcan yt-dlp por error.

Desde **⚙️ Ajustes** cada usuario puede cambiar la carpeta de descargas, poner sus credenciales de Spotify y actualizar yt-dlp con un clic.

## Desarrollo

Requisito: [Node.js](https://nodejs.org) 20 o superior.

```bash
npm install        # descarga yt-dlp, ffmpeg y ffprobe en bin/
npm run app        # abre la app de escritorio (Electron)
npm start          # o bien: modo navegador en http://localhost:5317
npm run dist       # genera el instalador y el zip en dist/
```

Si el binario de Electron no se descargó durante `npm install` (npm 11 puede bloquear scripts de instalación), ejecuta `node node_modules/electron/install.js`.

En modo navegador las descargas se guardan en `Descargas\MDownloader` (se puede cambiar en Ajustes o en `.env`, ver `.env.example`).

## Cómo funciona

1. Elige el tipo de entrada y pega el link o escribe la canción.
2. La app busca cada canción en YouTube y elige automáticamente el mejor resultado: prioriza el canal oficial del artista, los canales "Topic" o VEVO y la duración más cercana a la de Spotify, y penaliza versiones en vivo, covers, karaokes, remixes y videos de fans con letra.
3. Puedes cambiar el video elegido con el desplegable de cada fila (↗ lo abre en YouTube).
4. Elige **Audio** o **Video**, el formato y la calidad, y presiona **Descargar**.

## Formatos

| Tipo | Formato | Detalle | ~MB por canción de 4 min |
|---|---|---|---|
| Audio | **MP3 192 kbps** (por defecto) | Se reproduce en todo: autos, parlantes, celulares viejos | ~5,5 |
| Audio | **M4A (AAC)** | Copia la pista AAC original de YouTube sin recodificar, sin pérdida extra. Compatible con iPhone, Android, Windows y autos modernos | ~3,8 |
| Audio | Opus | El más liviano con mejor calidad por kbps; algunos reproductores antiguos no lo abren | ~3,5 |
| Video | **MP4 (H.264 + AAC) 1080p** (por defecto) | El formato de video más compatible que existe. 720p si prefieres archivos más livianos | ~40–80 / ~20–40 |

Los audios incluyen portada (miniatura recortada en cuadrado) y metadatos.

> YouTube entrega el audio a ~128 kbps (AAC) o ~130 kbps (Opus). Un MP3 a 256/320 kbps **no suena mejor**, solo pesa más. 192 kbps es el punto óptimo para MP3.

## Spotify

Sin configurar nada se leen hasta **100 canciones** por playlist. Para listas más grandes, crea una app gratis en el [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) y pon el Client ID y Client Secret en **⚙️ Ajustes** (o en `.env` en modo navegador).

## Mantenimiento

YouTube cambia su sitio con frecuencia. Si las descargas empiezan a fallar, actualiza yt-dlp desde **⚙️ Ajustes → Buscar actualización** (en la app de escritorio se actualiza en `%APPDATA%\MDownloader\bin`, sin permisos de administrador). En desarrollo: `npm run update-ytdlp`.

## Estructura

```
electron/main.mjs   Proceso principal de Electron (ventana, selector de carpeta, rutas de binarios)
server.mjs          Modo navegador ("npm start")
lib/app.mjs         Servidor Express: API, ajustes y cola de descargas
lib/spotify.mjs     Lectura de playlists/álbumes/canciones de Spotify
lib/ytdlp.mjs       Búsqueda, selección del mejor resultado y descarga con yt-dlp
public/             Interfaz (HTML/CSS/JS sin frameworks)
scripts/setup.mjs   Descarga de yt-dlp y copia de ffmpeg/ffprobe a bin/
scripts/make-icon.cjs  Genera build/icon.png
```

## Aviso

Usa esta herramienta solo para contenido que tengas derecho a descargar (uso personal, contenido libre o propio). Descargar contenido protegido puede infringir los términos de servicio de YouTube y las leyes de derechos de autor de tu país.
