import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const svg = readFileSync('public/icons/icon.svg', 'utf8');
const b = await chromium.launch();
const p = await b.newPage();
for (const [name, size, pad, bg] of [['icon-192.png', 192, 0, null], ['icon-512.png', 512, 0, null], ['maskable-512.png', 512, 0.12, '#1c1f22'], ['apple-touch-icon.png', 180, 0, '#1c1f22']]) {
  await p.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - pad * 2));
  await p.setContent(`<html><body style="margin:0;background:${bg || 'transparent'};display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</body></html>`);
  await p.screenshot({ path: 'public/icons/' + name, omitBackground: !bg });
}
await b.close();
