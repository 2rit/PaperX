import { chromium, webkit } from 'playwright';
export const URL = process.env.URL || 'http://localhost:4173/';
export const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 860 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  ipadP: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  ipadL: { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
};
export async function launch(engine = 'chromium', video = 'test-assets/cam_doc.y4m') {
  if (engine === 'webkit') return webkit.launch();
  return chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`, '--autoplay-policy=no-user-gesture-required'],
  });
}
export function track(page, errs) {
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => { if (!r.url().startsWith('blob:')) errs.push('requestfailed: ' + r.url() + ' ' + r.failure()?.errorText + ' [during: ' + (globalThis.__cur || '-') + ']'); });
}
export async function importVia(page, selector, files) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(selector)]);
  await fc.setFiles(files);
}
export async function seed(page, files) {
  for (const f of files) {
    await page.evaluate(() => (location.hash = '#/home'));
    await page.waitForSelector('[data-testid=home-import]');
    await importVia(page, '[data-testid=home-import]', f);
    await page.waitForSelector('[data-testid=ed-canvas]', { timeout: 60000 });
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => (location.hash = '#/home'));
}
export async function dbDocs(page) {
  return page.evaluate(async () => {
    const r = indexedDB.open('paperx'); await new Promise((res) => (r.onsuccess = res));
    const t = r.result.transaction('docs').objectStore('docs').getAll(); await new Promise((res) => (t.onsuccess = res));
    return t.result;
  });
}
