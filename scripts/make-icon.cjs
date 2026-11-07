// Genera build/icon.png (512x512) dibujándolo en un canvas.
// Uso: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const draw = `(() => {
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, S, S); grad.addColorStop(0, '#6af0d0'); grad.addColorStop(1, '#0d8a76');
  g.fillStyle = grad; g.beginPath(); g.roundRect(16, 16, S - 32, S - 32, 110); g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath(); g.ellipse(200, 350, 62, 48, -0.35, 0, Math.PI * 2); g.fill();
  g.fillRect(238, 110, 30, 245);
  g.beginPath(); g.moveTo(238, 110); g.lineTo(350, 140); g.quadraticCurveTo(372, 150, 362, 200); g.lineTo(268, 175); g.closePath(); g.fill();
  g.strokeStyle = '#ffffff'; g.lineWidth = 30; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(370, 240); g.lineTo(370, 380); g.stroke();
  g.beginPath(); g.moveTo(320, 335); g.lineTo(370, 385); g.lineTo(420, 335); g.stroke();
  return c.toDataURL('image/png');
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const url = await win.webContents.executeJavaScript(draw);
  const out = join(__dirname, '..', 'build');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'icon.png'), Buffer.from(url.split(',')[1], 'base64'));
  console.log('build/icon.png creado');
  app.quit();
});
