// Modo navegador: "npm start" levanta el servidor y abre la app en el navegador.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './lib/app.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Carga simple de .env (opcional)
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { port } = await startServer({
  port: Number(process.env.PORT) || 5317,
  settingsFile: join(ROOT, 'settings.json'),
  mode: 'web',
});

const url = `http://localhost:${port}`;
console.log(`MDownloader listo en ${url}`);
if (!process.env.NO_OPEN) {
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
}
