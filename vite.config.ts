import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Project-site base. `configure-pages` passes VITE_BASE like `/PaperX` (no trailing slash). */
function siteBase(): string {
  const raw = (process.env.VITE_BASE || '/PaperX').trim();
  if (raw === '/' || raw === './' || raw === '.') return raw === '.' ? './' : raw.endsWith('/') ? raw : `${raw}/`;
  const withLead = raw.startsWith('/') ? raw : `/${raw}`;
  return `${withLead.replace(/\/+$/, '')}/`;
}

// Injects the list of built app-shell assets into the service worker for offline precache.
function swPrecache(base: string): Plugin {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return {
    name: 'sw-precache',
    apply: 'build',
    closeBundle() {
      const dist = join(__dirname, 'dist');
      const files: string[] = [];
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          if (f.startsWith('.')) continue;
          const p = join(d, f);
          if (statSync(p).isDirectory()) { if (f !== 'vendor') walk(p); }
          else files.push(prefix + relative(dist, p).replace(/\\/g, '/'));
        }
      };
      walk(dist);
      const list = files.filter((f) => !f.endsWith('/sw.js') && !f.endsWith('.map') && !f.includes('screenshots'));
      const swPath = join(dist, 'sw.js');
      const version = Date.now().toString(36);
      const engines = [
        'vendor/opencv/opencv.js',
        'vendor/tesseract/worker.min.js',
        'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
        'vendor/tesseract/core/tesseract-core-lstm.wasm.js',
        'vendor/tesseract/lang/tha.traineddata.gz',
        'vendor/tesseract/lang/eng.traineddata.gz',
      ].map((f) => prefix + f);
      const sw = readFileSync(swPath, 'utf8')
        .replace('self.__PRECACHE__', JSON.stringify([prefix, ...list]))
        .replace(/const ENGINE_FILES = \[[\s\S]*?\];/, `const ENGINE_FILES = ${JSON.stringify(engines)};`)
        .replace('__VERSION__', version);
      writeFileSync(swPath, sw);
    },
  };
}

export default defineConfig({
  base: siteBase(),
  plugins: [react(), swPrecache(siteBase())],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500, sourcemap: false },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['pdfjs-dist'] },
  server: { host: true },
  // allow the public HTTPS tunnel hostname (*.trycloudflare.com) to reach the preview server
  preview: { host: true, allowedHosts: ['.trycloudflare.com', 'localhost'] },
});
