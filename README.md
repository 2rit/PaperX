# PAPERX

On-device document scanner. Scan, straighten, enhance, OCR Thai and English, and export PDF. Nothing leaves the phone.

**Live:** https://2rit.github.io/PaperX/

The production build is served from the `/PaperX/` subpath (GitHub Pages project site). Pushes to `main` deploy with GitHub Actions.

```bash
npm ci
npm run dev      # http://localhost:5173/PaperX/
npm run build
npm run preview  # http://localhost:4173/PaperX/
```
