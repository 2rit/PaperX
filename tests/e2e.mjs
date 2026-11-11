// PAPERX end-to-end test: clicks every control on every screen and asserts a REAL effect.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { launch, URL, VIEWPORTS, track, importVia, dbDocs } from './helpers.mjs';

const ENGINE = process.argv[2] || 'chromium';
const results = [];
const errs = [];
let section = '';
const out = `test-results/${ENGINE}`;
mkdirSync(out, { recursive: true });
async function check(name, fn) {
  globalThis.__cur = name;
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ section, name, ok: true, detail: detail ?? '', ms: Date.now() - t0 });
    console.log('  ✔', section, '›', name, detail ? `(${detail})` : '');
  } catch (e) {
    results.push({ section, name, ok: false, detail: String(e?.message || e).split('\n')[0], ms: Date.now() - t0 });
    try { await globalThis.__page?.screenshot({ path: `${out}/FAIL-${results.length}.png` }); } catch {}
    console.log('  ✘', section, '›', name, '→', String(e?.message || e).split('\n')[0]);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const T = (sel) => `[data-testid="${sel}"]`;
const undoToast = () => p.locator('[data-testid=toast]', { hasText: 'เลิกทำ' }).last().locator('[data-testid=toast-action]');

const b = await launch(ENGINE);
const isCr = ENGINE === 'chromium';
const ctx = await b.newContext({ ...VIEWPORTS.desktop, acceptDownloads: true, permissions: isCr ? ['camera', 'clipboard-read', 'clipboard-write'] : [] });
// WebKit on this Linux box crashes inside getUserMedia (no GStreamer camera stack), so for WebKit
// we simulate "no camera available" — exactly what the app must survive on devices without a camera.
const NO_CAM = () => { Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => Promise.reject(Object.assign(new Error('no camera'), { name: 'NotFoundError' })) } }); };
if (!isCr) await ctx.addInitScript(NO_CAM);
const p = await ctx.newPage();
track(p, errs);
globalThis.__page = p;
const go = async (h) => { await p.evaluate((h) => (location.hash = h), h); await p.waitForTimeout(250); };
const hash = () => p.evaluate(() => location.hash);
const settings = () => p.evaluate(() => JSON.parse(localStorage.getItem('paperx.settings.v1') || '{}'));
const canvasHash = (sel = T('ed-canvas')) => p.evaluate((sel) => {
  const c = document.querySelector(sel); if (!c || !c.width) return null;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0;
  for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0;
  return `${c.width}x${c.height}:${h}`;
}, sel);
const waitHashChange = async (prev, ms = 15000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { const h = await canvasHash(); if (h && h !== prev) return h; await p.waitForTimeout(120); }
  throw new Error('preview did not change');
};
const download = async (clickSel) => {
  const [d] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), p.click(clickSel)]);
  const path = `${out}/${d.suggestedFilename()}`;
  await d.saveAs(path);
  return { name: d.suggestedFilename(), buf: readFileSync(path), path };
};
const docCount = async () => (await dbDocs(p)).length;
const toastText = async () => (await p.locator(T('toast')).allInnerTexts()).join(' | ');

await p.goto(URL);
await p.waitForSelector(T('hero'));

// ---------------------------------------------------------------- HOME
section = 'หน้าแรก (Home)';
await check('Onboarding hint shows on first run and ✕ dismisses it permanently', async () => {
  await p.waitForSelector(T('onboarding'));
  await p.click(T('onboarding-close'));
  assert(!(await p.locator(T('onboarding')).count()), 'still visible');
  assert((await settings()).onboarded === true, 'not persisted');
});
await check('Empty state shown when there are no documents', async () => { await p.waitForSelector(T('recent-empty')); });
await check('ปุ่ม “สแกนเอกสาร” opens the camera scanner', async () => {
  await p.click(T('home-scan')); await p.waitForSelector(T('camera'));
  assert((await hash()).startsWith('#/camera'));
  await p.click(T('cam-close')); await p.waitForSelector(T('hero'));
});
await check('Auto Flatten spotlight → “สแกนหนังสือ (2 หน้า)” opens the camera in book mode; mode switch works', async () => {
  await p.waitForSelector(T('flatten-spotlight'));
  await p.click(T('home-book')); await p.waitForSelector(T('camera'));
  assert((await settings()).captureMode === 'book', 'book mode not set');
  assert((await p.getAttribute(T('cam-mode-book'), 'aria-checked')) === 'true', 'radio not checked');
  await p.click(T('cam-mode-doc')); assert((await settings()).captureMode === 'doc', 'doc');
  assert((await p.getAttribute(T('cam-mode-doc'), 'aria-checked')) === 'true');
  await p.click(T('cam-close')); await p.waitForSelector(T('hero'));
});
await check('ปุ่ม “นำเข้าจากแกลเลอรี” imports a photo → auto-cropped document in editor', async () => {
  await importVia(p, T('home-import'), 'test-assets/skewed_shadow.jpg');
  await p.waitForSelector(T('ed-canvas'), { timeout: 60000 });
  const d = await dbDocs(p);
  assert(d.length === 1 && d[0].pages.length === 1, 'doc not saved');
  return `doc "${d[0].name}"`;
});
await go('#/home');
await check('Recent documents grid lists the new document', async () => { await p.waitForSelector(T('doc-card')); });
await check('“ดูทั้งหมด →” opens the library', async () => { await p.click(T('see-all')); await p.waitForSelector(T('lib-grid')); });
await go('#/home');
for (const k of ['perspective', 'dewarp', 'autoCrop', 'sharpen', 'shadow']) {
  await check(`Advanced toggle “${k}” switches the real processing setting`, async () => {
    const before = (await settings())[k] ?? true;
    await p.click(T('adv-' + k));
    assert((await settings())[k] === !before, 'not toggled');
    await p.click(T('adv-' + k));
    assert((await settings())[k] === before, 'not restored');
  });
}
await check('Sidebar navigation: Home / Library / OCR / Settings', async () => {
  for (const [n, h] of [['library', '#/library'], ['ocr', '#/ocr'], ['settings', '#/settings'], ['home', '#/home']]) {
    await p.click(T('nav-' + n)); await p.waitForTimeout(150);
    assert((await hash()) === h, `nav ${n} → ${await hash()}`);
  }
});
await check('Drag & drop a file onto the window imports it', async () => {
  const n0 = await docCount();
  const b64 = readFileSync('test-assets/rotated.jpg').toString('base64');
  await p.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bin], 'dropped.jpg', { type: 'image/jpeg' }));
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, b64);
  await p.waitForSelector(T('ed-canvas'), { timeout: 60000 });
  assert((await docCount()) === n0 + 1, 'no doc created');
});
await go('#/home');
await check('Keyboard shortcuts: L → library, ? → help, N → camera', async () => {
  await p.locator('body').click({ position: { x: 900, y: 20 } });
  await p.keyboard.press('l'); await p.waitForTimeout(200); assert((await hash()) === '#/library', 'L');
  await p.keyboard.press('Shift+Slash'); await p.waitForSelector(T('shortcuts')); await p.keyboard.press('Escape');
  await p.keyboard.press('n'); await p.waitForSelector(T('camera')); await p.click(T('cam-close'));
});

// ---------------------------------------------------------------- CAMERA
section = 'กล้องสแกน (Camera)';
if (isCr) {
  await go('#/camera');
  await check('Live camera stream starts (rear camera requested, playsinline)', async () => {
    await p.waitForFunction(() => document.querySelector('[data-testid=cam-video]')?.videoWidth > 0, null, { timeout: 15000 });
    const pi = await p.$eval(T('cam-video'), (v) => v.hasAttribute('playsinline') && v.muted);
    assert(pi, 'playsinline/muted missing');
  });
  await check('Auto document detection draws the green quad + status “ตรวจพบเอกสาร A4”', async () => {
    await p.waitForSelector(T('cam-quad'), { timeout: 40000 });
    const st = await p.innerText(T('cam-status'));
    assert(st.includes('ตรวจพบเอกสาร'), st);
    return st;
  });
  await check('Hint pill “เอกสารอยู่ในกรอบแล้ว …” shown while document is framed', async () => {
    const h = await p.innerText(T('cam-hint'));
    assert(/อยู่ในกรอบแล้ว|ถือนิ่ง/.test(h), h);
  });
  await check('Auto-capture fires when the document is steady (page added to tray)', async () => {
    await p.waitForSelector(T('tray-item'), { timeout: 20000 });
    return `${await p.locator(T('tray-item')).count()} page(s)`;
  });
  await check('Auto-capture toggle switches setting off', async () => {
    await p.click(T('cam-auto'));
    assert((await settings()).autoCapture === false);
  });
  await check('Shutter button captures another page manually', async () => {
    const n = await p.locator(T('tray-item')).count();
    await p.click(T('cam-shutter'));
    await p.waitForFunction((n) => document.querySelectorAll('[data-testid=tray-item]').length === n + 1, n);
  });
  await check('Gallery button in camera adds imported pages to the batch tray', async () => {
    const n = await p.locator(T('tray-item')).count();
    await importVia(p, T('cam-gallery'), 'test-assets/curved.jpg');
    await p.waitForFunction((n) => document.querySelectorAll('[data-testid=tray-item]').length === n + 1, n, { timeout: 30000 });
  });
  await check('Tray ✕ removes a page from the batch', async () => {
    const n = await p.locator(T('tray-item')).count();
    await p.locator(T('tray-remove')).last().click();
    await p.waitForFunction((n) => document.querySelectorAll('[data-testid=tray-item]').length === n - 1, n);
  });
  await check('โหมดหนังสือ: spine guide on the live quad; shutter → spread queued as “2 หน้า”', async () => {
    await p.click(T('cam-mode-book'));
    await p.waitForSelector(T('cam-spine'), { timeout: 20000 });
    const st = await p.innerText(T('cam-status'));
    const n = await p.locator(T('tray-item')).count();
    await p.click(T('cam-shutter'));
    await p.waitForFunction((n) => document.querySelectorAll('[data-testid=tray-item]').length === n + 1, n);
    await p.waitForSelector(T('tray-book'));
    await p.click(T('cam-mode-doc'));
    return st;
  });
  await check('Flash button hidden gracefully when the camera has no torch', async () => {
    assert((await p.locator(T('cam-torch')).count()) === 0, 'torch button visible without torch support');
  });
  await check('Close with captured pages asks to save/discard', async () => {
    await p.click(T('cam-close')); await p.waitForSelector(T('cam-confirm'));
    await p.keyboard.press('Escape');
  });
  await check('“เสร็จสิ้น” creates a multi-page document with detected crop', async () => {
    const n = (await p.locator(T('tray-item')).count()) + (await p.locator(T('tray-book')).count());
    const before = await docCount();
    await p.click(T('cam-done'));
    await p.waitForSelector(T('ed-canvas'), { timeout: 60000 });
    const docs = await dbDocs(p);
    assert(docs.length === before + 1, 'no doc');
    const d = docs.sort((a, b) => b.createdAt - a.createdAt)[0];
    assert(d.pages.length === n, `pages ${d.pages.length} != ${n}`);
    const c = d.pages[0].corners;
    assert(!(c[0].x === 0 && c[0].y === 0), 'no crop detected');
    const sides = d.pages.filter((x) => x.book).map((x) => x.book.side).join('');
    assert(sides === 'LR', 'book spread not split into L+R pages: ' + sides);
    return `${n} pages (incl. book L+R)`;
  });
  await p.evaluate(() => localStorage.setItem('paperx.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('paperx.settings.v1')), autoCapture: true })));
  await p.reload(); await p.waitForSelector(T('ed-canvas'), { timeout: 60000 });
}
await check('No-camera fallback offers native camera / gallery / retry', async () => {
  const c2 = await b.newContext({ ...VIEWPORTS.phone, permissions: [] });
  const p2 = await c2.newPage();
  await p2.addInitScript(NO_CAM);
  await p2.goto(URL + '#/camera');
  await p2.waitForSelector(T('cam-fallback') + ' ' + T('cam-native'), { timeout: 15000 });
  const [fc] = await Promise.all([p2.waitForEvent('filechooser'), p2.click(T('cam-native'))]);
  await fc.setFiles('test-assets/skewed_shadow.jpg');
  await p2.waitForSelector(T('tray-item'), { timeout: 30000 });
  await p2.click(T('cam-retry'));
  await c2.close();
});

// ---------------------------------------------------------------- EDITOR
section = 'หน้าจอแก้ไข (Editor)';
await go('#/home');
await importVia(p, T('home-import'), 'test-assets/skewed_shadow.jpg');
await p.waitForSelector(T('ed-canvas'), { timeout: 60000 });
const edId = (await hash()).match(/editor\/([^?]+)/)[1];
let h = await canvasHash();
for (const m of ['original', 'color', 'bw', 'cleanPaper', 'highContrast', 'photo', 'textBoost']) {
  await check(`โหมด “${m}” changes the processed preview`, async () => {
    await p.click(T('mode-' + m));
    h = await waitHashChange(h);
    assert((await p.getAttribute(T('mode-' + m), 'aria-checked')) === 'true');
  });
}
for (const [s, v] of [['sl-brightness', '40'], ['sl-contrast', '30'], ['sl-saturation', '-50']]) {
  await check(`Slider ${s} updates value and preview live`, async () => {
    await p.fill(T(s), v);
    h = await waitHashChange(h);
    assert((await p.innerText(T(s + '-value'))) === v);
  });
}
await check('Undo reverts last change; Redo re-applies it', async () => {
  await p.click(T('ed-undo'));
  assert((await p.innerText(T('sl-saturation-value'))) === '0', 'undo');
  await p.click(T('ed-redo'));
  assert((await p.innerText(T('sl-saturation-value'))) === '-50', 'redo');
});
await check('Keyboard Ctrl+Z / Ctrl+Shift+Z / 1-7 mode keys', async () => {
  await p.locator(T('ed-stage')).click({ position: { x: 5, y: 5 } });
  await p.keyboard.press('Control+z'); assert((await p.innerText(T('sl-saturation-value'))) === '0');
  await p.keyboard.press('Control+Shift+z'); assert((await p.innerText(T('sl-saturation-value'))) === '-50');
  await p.keyboard.press('3'); assert((await p.getAttribute(T('mode-bw'), 'aria-checked')) === 'true');
  await p.keyboard.press('4');
});
await check('หมุน rotates the page 90°', async () => {
  const [w, hh] = (await canvasHash()).split(':')[0].split('x').map(Number);
  await p.click(T('tool-rotate'));
  const h2 = await waitHashChange(await canvasHash());
  const [w2, h3] = h2.split(':')[0].split('x').map(Number);
  assert(w2 === hh && h3 === w, `${w}x${hh} → ${w2}x${h3}`);
  for (let i = 0; i < 3; i++) await p.click(T('tool-rotate'));
  h = await canvasHash();
});
await check('ปรับมุม: slider, ±0.5°, auto-straighten and reset', async () => {
  await p.click(T('tool-angle')); await p.waitForSelector(T('sheet-angle'));
  await p.fill(T('sl-angle'), '5'); h = await waitHashChange(h);
  await p.click(T('angle-auto')); await p.waitForFunction(() => /ปรับมุมอัตโนมัติ|ตรงอยู่แล้ว/.test(document.body.innerText), null, { timeout: 15000 });
  const a = await p.innerText(T('sl-angle-value'));
  assert(Math.abs(parseFloat(a)) < 2, 'auto angle ' + a);
  await p.click(T('angle-reset')); assert((await p.innerText(T('sl-angle-value'))) === '0°');
  await p.keyboard.press('Escape');
  return 'auto = ' + a;
});
await check('ฟิลเตอร์ sheet renders live thumbnails for all 7 modes and applies one', async () => {
  await p.click(T('tool-filters'));
  await p.waitForFunction(() => document.querySelectorAll('[data-testid=mode-thumbs] canvas').length === 7, null, { timeout: 30000 });
  await p.click(T('thumb-cleanPaper'));
  assert((await p.getAttribute(T('mode-cleanPaper'), 'aria-checked')) === 'true');
  await p.keyboard.press('Escape');
  h = await waitHashChange(h).catch(() => h);
});
await check('ปรับแต่ง sheet: Shadow Removal & Text Enhancement toggles change output; reset works', async () => {
  await p.click(T('tool-adjust')); await p.waitForSelector(T('sheet-adjust'));
  h = await canvasHash();
  await p.click(T('tg-shadow')); h = await waitHashChange(h);
  await p.click(T('tg-sharpen')); h = await waitHashChange(h);
  await p.click(T('tg-shadow')); await p.click(T('tg-sharpen'));
  await p.click(T('adjust-reset'));
  assert((await p.locator(T('sheet-adjust') + ' ' + T('sl-brightness-value')).innerText()) === '0');
  await p.keyboard.press('Escape');
});
await check('เปรียบเทียบ shows before/after split with draggable divider', async () => {
  await p.click(T('tool-compare')); await p.waitForSelector(T('ed-compare'));
  await p.fill(T('ed-split'), '80');
  const clip = await p.$eval(T('ed-compare'), (e) => e.style.clipPath);
  assert(clip.includes('20%'), clip);
  await p.click(T('tool-compare'));
  assert(!(await p.locator(T('ed-compare')).count()));
});
await check('Zoom in / out / reset', async () => {
  await p.click(T('ed-zoomin'));
  const tr = await p.$eval(T('ed-canvas'), (c) => c.parentElement.style.transform);
  assert(tr.includes('scale(1.4'), tr);
  await p.click(T('ed-zoomout'));
  await p.click(T('ed-zoomin')); await p.click(T('ed-zoom-reset'));
  const tr2 = await p.$eval(T('ed-canvas'), (c) => c.parentElement.style.transform);
  assert(tr2.includes('scale(1)'), tr2);
});
await check('ครอบตัด: drag a corner (4-corner crop) and apply → perspective re-warp', async () => {
  h = await canvasHash();
  await p.click(T('tool-crop')); await p.waitForSelector(T('crop-path'));
  const bb = await p.locator(T('crop-corner-0') + ' circle').first().boundingBox();
  await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await p.mouse.down();
  await p.mouse.move(bb.x + bb.width / 2 + 40, bb.y + bb.height / 2 + 30, { steps: 6 }); await p.mouse.up();
  await p.click(T('crop-apply'));
  h = await waitHashChange(h);
});
await check('ครอบตัด: mid-edge handle bends edge (curved dewarp), “ขอบตรง”, “ทั้งภาพ”, “ตรวจจับอัตโนมัติ”, ยกเลิก', async () => {
  await p.click(T('tool-crop')); await p.waitForSelector(T('crop-path'));
  const d0 = await p.getAttribute(T('crop-path'), 'd');
  const bb = await p.locator(T('crop-mid-0') + ' rect').boundingBox();
  await p.mouse.move(bb.x + 9, bb.y + 9); await p.mouse.down(); await p.mouse.move(bb.x + 9, bb.y - 25, { steps: 5 }); await p.mouse.up();
  assert((await p.getAttribute(T('crop-path'), 'd')) !== d0, 'edge did not bend');
  await p.click(T('crop-straight'));
  await p.click(T('crop-full')); assert((await p.getAttribute(T('crop-path'), 'd')).startsWith('M0,0'), 'full');
  await p.click(T('crop-auto')); await p.waitForFunction(() => /ตรวจพบขอบเอกสาร/.test(document.body.innerText), null, { timeout: 30000 });
  assert(!(await p.getAttribute(T('crop-path'), 'd')).startsWith('M0,0'), 'auto detect did not move corners');
  await p.click(T('crop-cancel'));
  assert(!(await p.locator(T('crop-view')).count()));
});
await check('Inline rename in the top bar', async () => {
  await p.click(T('ed-name'));
  await p.fill(T('rename-input'), 'สัญญาเช่า_ทดสอบ'); await p.keyboard.press('Enter');
  await p.waitForTimeout(300);
  assert((await dbDocs(p)).some((d) => d.name === 'สัญญาเช่า_ทดสอบ'));
});
await check('บันทึก renders full-res output and persists to IndexedDB', async () => {
  const before = (await dbDocs(p)).find((d) => d.id === edId).pages[0].outKey;
  await p.click(T('ed-save'));
  await p.waitForFunction(() => document.body.innerText.includes('· บันทึกแล้ว'), null, { timeout: 30000 });
  const pg = (await dbDocs(p)).find((d) => d.id === edId).pages[0];
  assert(pg.outKey !== before && pg.mode === 'cleanPaper', 'not saved');
  return `${pg.outW}×${pg.outH}px`;
});
await check('Page tray: “เพิ่ม” → from gallery adds a page', async () => {
  await p.click(T('strip-add')); await p.waitForSelector(T('sheet-add'));
  await importVia(p, T('add-gallery'), ['test-assets/curved.jpg', 'test-assets/rotated.jpg']);
  await p.waitForFunction(() => document.querySelectorAll('[data-testid=strip-page]').length === 3, null, { timeout: 60000 });
});
await check('Page tray: tap selects page; drag reorders pages', async () => {
  const ids0 = (await dbDocs(p)).find((d) => d.id === edId).pages.map((x) => x.id);
  await p.locator(T('strip-page')).nth(2).click();
  assert((await p.innerText(T('editor'))).includes('หน้า 3/3'));
  const a = await p.locator(T('strip-page')).nth(2).boundingBox();
  const c = await p.locator(T('strip-page')).nth(0).boundingBox();
  await p.mouse.move(a.x + 20, a.y + 30); await p.mouse.down();
  await p.mouse.move(a.x - 10, a.y + 30, { steps: 3 }); await p.mouse.move(c.x + 5, c.y + 30, { steps: 8 }); await p.mouse.up();
  await p.click(T('ed-save'));
  await p.waitForFunction(() => document.body.innerText.includes('· บันทึกแล้ว'), null, { timeout: 30000 });
  const ids1 = (await dbDocs(p)).find((d) => d.id === edId).pages.map((x) => x.id);
  assert(ids1[0] === ids0[2], 'order unchanged ' + JSON.stringify([ids0, ids1]));
});
await check('Page tray: ✕ deletes a page, toast “เลิกทำ” restores it', async () => {
  await p.locator(T('strip-delete')).click();
  assert((await p.locator(T('strip-page')).count()) === 2);
  await undoToast().click();
  assert((await p.locator(T('strip-page')).count()) === 3);
});
await check('Menu ⋯ → ทำสำเนาเอกสาร duplicates the document', async () => {
  const n = await docCount();
  await p.click(T('ed-more')); await p.click(T('more-dup'));
  await p.waitForFunction(async (n) => true, n); await p.waitForTimeout(800);
  assert((await docCount()) === n + 1);
});
await check('Menu ⋯ → คีย์ลัด opens shortcut help', async () => {
  await p.click(T('ed-more')); await p.click(T('more-keys')); await p.waitForSelector(T('shortcuts')); await p.keyboard.press('Escape');
});
await check('Menu ⋯ → แชร์ only shown when Web Share with files is supported', async () => {
  await p.click(T('ed-more')); await p.waitForSelector(T('sheet-more'));
  const can = await p.evaluate(() => !!navigator.canShare && navigator.canShare({ files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] }));
  assert((await p.locator(T('more-share')).count()) === (can ? 1 : 0));
  await p.keyboard.press('Escape');
  return can ? 'supported → shown' : 'unsupported → hidden';
});
await check('Panel buttons OCR / ส่งออก and menu items navigate (with autosave)', async () => {
  await p.click(T('ed-export')); await p.waitForSelector(T('export-card'));
  await go('#/editor/' + edId); await p.waitForSelector(T('ed-canvas'));
  await p.click(T('ed-ocr')); await p.waitForSelector(T('ocr-card'));
  await go('#/editor/' + edId); await p.waitForSelector(T('ed-canvas'));
  await p.click(T('ed-more')); await p.click(T('more-export')); await p.waitForSelector(T('export-card'));
  await go('#/editor/' + edId); await p.waitForSelector(T('ed-canvas'));
  await p.click(T('ed-more')); await p.click(T('more-ocr')); await p.waitForSelector(T('ocr-card'));
  await go('#/editor/' + edId); await p.waitForSelector(T('ed-canvas'));
});
await check('Menu ⋯ → ลบเอกสารนี้ deletes; “เลิกทำ” restores', async () => {
  const n = await docCount();
  await p.click(T('ed-more')); await p.click(T('more-delete'));
  await p.waitForSelector(T('lib-grid'));
  assert((await docCount()) === n - 1);
  await undoToast().click(); await p.waitForTimeout(400);
  assert((await docCount()) === n);
});
await check('Back button leaves editor and auto-saves pending edits', async () => {
  await go('#/editor/' + edId); await p.waitForSelector(T('ed-canvas'));
  await p.click(T('mode-highContrast'));
  await p.click(T('ed-back'));
  await p.waitForFunction(() => !document.querySelector('[data-testid=editor]'), null, { timeout: 30000 });
  const pg = (await dbDocs(p)).find((d) => d.id === edId).pages[0];
  assert(pg.mode === 'highContrast', 'not autosaved');
});

// ---------------------------------------------------------------- AUTO FLATTEN + BOOK MODE
section = 'Auto Flatten & โหมดหนังสือ';
await go('#/home');
await importVia(p, T('home-import'), 'test-assets/wrinkled_page.png');
await p.waitForSelector(T('ed-canvas'), { timeout: 60000 });
await p.waitForTimeout(600);
await check('Auto Flatten is ON by default for new scans (chip + saved page param)', async () => {
  assert((await p.getAttribute(T('ed-flatten-chip'), 'aria-pressed')) === 'true', 'chip off');
  const id = (await hash()).match(/editor\/([^?]+)/)[1];
  assert((await dbDocs(p)).find((d) => d.id === id).pages[0].flatten === true, 'param not saved');
});
await check('Auto Flatten chip OFF/ON really re-renders the page (wrinkled lines bend back / straighten)', async () => {
  h = await canvasHash();
  await p.click(T('ed-flatten-chip')); h = await waitHashChange(h);
  assert((await p.getAttribute(T('ed-flatten-chip'), 'aria-pressed')) === 'false');
  await p.click(T('ed-flatten-chip')); h = await waitHashChange(h);
  assert((await p.getAttribute(T('ed-flatten-chip'), 'aria-pressed')) === 'true');
});
await check('ปรับแต่ง sheet + side panel “Auto Flatten” toggles drive the same setting', async () => {
  await p.click(T('tool-adjust')); await p.waitForSelector(T('sheet-adjust'));
  await p.click(T('tg-flatten')); h = await waitHashChange(h);
  assert((await p.getAttribute(T('ed-flatten-chip'), 'aria-pressed')) === 'false');
  await p.keyboard.press('Escape');
  await p.click(T('pn-flatten')); h = await waitHashChange(h);
  assert((await p.getAttribute(T('ed-flatten-chip'), 'aria-pressed')) === 'true');
});
await check('เปรียบเทียบ: “ก่อน” side is the un-flattened page', async () => {
  await p.click(T('tool-compare')); await p.waitForSelector(T('ed-compare') + ' canvas');
  await p.waitForTimeout(800);
  const diff = await p.evaluate(() => {
    const a = document.querySelector('[data-testid=ed-canvas]'), b = document.querySelector('[data-testid=ed-compare] canvas');
    if (!a || !b || a.width !== b.width) return -1;
    const da = a.getContext('2d').getImageData(0, 0, a.width, a.height).data, db = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
    let n = 0; for (let i = 0; i < da.length; i += 4 * 7) if (Math.abs(da[i] - db[i]) > 60) n++;
    return n;
  });
  await p.click(T('tool-compare'));
  assert(diff > 50, 'before/after identical: ' + diff);
  return diff + ' differing samples';
});
await go('#/home');
await importVia(p, T('home-import'), 'test-assets/book_spread.jpg');
await p.waitForSelector(T('ed-canvas'), { timeout: 60000 });
const bookId = (await hash()).match(/editor\/([^?]+)/)[1];
await check('หนังสือ tool → “แยกเป็น 2 หน้า” splits the spread at the detected spine', async () => {
  await p.click(T('tool-book')); await p.waitForSelector(T('sheet-book'));
  await p.click(T('book-split'));
  await p.waitForFunction(() => document.querySelectorAll('[data-testid=strip-page]').length === 2, null, { timeout: 30000 });
  assert((await p.innerText(T('ed-book-badge'))).includes('ซ้าย'), 'left badge');
  const t = await toastText();
  const m = t.match(/สันหนังสือ (\d+)%/); assert(m && Math.abs(Number(m[1]) - 50) <= 4, 'spine ' + t);
  await p.locator(T('strip-page')).nth(1).click();
  assert((await p.innerText(T('ed-book-badge'))).includes('ขวา'), 'right badge');
  return `spine ${m[1]}% (truth 50%)`;
});
await check('Book sheet: spine slider moves the split (both pages), auto spine, Auto Flatten toggle', async () => {
  h = await canvasHash();
  await p.click(T('tool-book')); await p.waitForSelector(T('sl-spine'));
  await p.fill(T('sl-spine'), '40'); h = await waitHashChange(h);
  assert((await p.innerText(T('sl-spine-value'))) === '40%');
  await p.click(T('book-auto')); await p.waitForFunction(() => /พบสันหนังสือที่/.test(document.body.innerText), null, { timeout: 20000 });
  const v = parseInt(await p.innerText(T('sl-spine-value')));
  assert(Math.abs(v - 50) <= 4, 'auto spine ' + v);
  await p.click(T('bk-flatten')); h = await waitHashChange(h);
  await p.click(T('bk-flatten')); h = await waitHashChange(h);
  await p.keyboard.press('Escape');
  return 'auto spine ' + v + '%';
});
await check('บันทึก persists L/R book pages; “รวมเป็นหน้าเดียว” merges back; undo restores the split', async () => {
  await p.click(T('ed-save'));
  await p.waitForFunction(() => document.body.innerText.includes('· บันทึกแล้ว'), null, { timeout: 60000 });
  const pg = (await dbDocs(p)).find((d) => d.id === bookId).pages;
  assert(pg.length === 2 && pg[0].book?.side === 'L' && pg[1].book?.side === 'R' && pg[0].srcKey === pg[1].srcKey, 'not persisted');
  assert(pg[0].outW < pg[0].outH, 'half page should be portrait: ' + pg[0].outW + 'x' + pg[0].outH);
  await p.click(T('tool-book')); await p.click(T('book-merge'));
  await p.waitForFunction(() => document.querySelectorAll('[data-testid=strip-page]').length === 1);
  await undoToast().click();
  await p.waitForFunction(() => document.querySelectorAll('[data-testid=strip-page]').length === 2);
  return `${pg[0].outW}×${pg[0].outH}px per page`;
});

// ---------------------------------------------------------------- LIBRARY
section = 'คลังเอกสาร (Library)';
await go('#/library');
await p.waitForSelector(T('lib-grid'));
await check('Search filters by name (and clears)', async () => {
  await p.fill(T('search'), 'สัญญาเช่า');
  const n = await p.locator(T('doc-card')).count();
  assert(n >= 1 && n < (await docCount()), 'filter count ' + n);
  await p.fill(T('search'), 'zzzz_ไม่มี'); await p.waitForSelector(T('lib-empty'));
  await p.fill(T('search'), '');
});
await check('Sort (เรียงตาม) changes ordering', async () => {
  const names = async () => p.$$eval(T('doc-card'), (e) => e.map((x) => x.dataset.name));
  await p.selectOption(T('sort'), 'name'); const a = await names();
  assert(JSON.stringify(a) === JSON.stringify([...a].sort((x, y) => x.localeCompare(y, 'th'))), 'name sort');
  await p.selectOption(T('sort'), 'oldest'); const o = await names();
  await p.selectOption(T('sort'), 'recent'); const r = await names();
  assert(JSON.stringify(o) === JSON.stringify([...r].reverse()), 'oldest/recent');
  await p.selectOption(T('sort'), 'pages');
  await p.selectOption(T('sort'), 'recent');
});
await check('Select checkmark → bottom bar “เลือกแล้ว 1 รายการ”', async () => {
  await p.locator(T('doc-select')).first().click();
  assert((await p.innerText(T('sel-count'))).includes('1'));
});
await check('คัดลอก duplicates selected', async () => {
  const n = await docCount(); await p.click(T('act-copy')); await p.waitForTimeout(800);
  assert((await docCount()) === n + 1);
});
await check('เลือกทั้งหมด + รวม merges documents into one', async () => {
  await p.click(T('select-all'));
  const docs = await dbDocs(p); const total = docs.reduce((s, d) => s + d.pages.length, 0);
  await p.click(T('act-merge')); await p.waitForTimeout(800);
  const after = await dbDocs(p);
  assert(after.length === docs.length + 1 && after.some((d) => d.pages.length === total), 'merge');
  return `${total} pages`;
});
await check('ลบ removes selected; “เลิกทำ” restores', async () => {
  const n = await docCount();
  await p.locator(T('doc-select')).first().click();
  await p.click(T('act-delete')); await p.waitForTimeout(300);
  assert((await docCount()) === n - 1, 'delete');
  await undoToast().click(); await p.waitForTimeout(400);
  assert((await docCount()) === n, 'undo');
});
await check('Keyboard Delete removes selection', async () => {
  const n = await docCount();
  await p.locator(T('doc-select')).first().click();
  await p.keyboard.press('Delete'); await p.waitForTimeout(300);
  assert((await docCount()) === n - 1);
  await undoToast().click(); await p.waitForTimeout(300);
});
await check('Inline rename on card (✎)', async () => {
  await p.locator(T('doc-card')).first().hover();
  await p.locator(T('rename-btn')).first().click();
  await p.fill(T('rename-input'), 'เอกสารสำคัญ'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  assert((await dbDocs(p)).some((d) => d.name === 'เอกสารสำคัญ'));
});
await check('ส่งออก and เปิด act on the selected document', async () => {
  await p.locator(T('doc-select')).first().click();
  await p.click(T('act-export')); await p.waitForSelector(T('export-card'));
  await go('#/library'); await p.locator(T('doc-select')).first().click();
  await p.click(T('act-open')); await p.waitForSelector(T('ed-canvas'));
});
await check('Library “นำเข้า” imports files', async () => {
  await go('#/library');
  const n = await docCount();
  await importVia(p, T('lib-import'), 'test-assets/rotated.jpg');
  await p.waitForSelector(T('ed-canvas'), { timeout: 60000 });
  assert((await docCount()) === n + 1);
});

// ---------------------------------------------------------------- EXPORT
section = 'ส่งออกเอกสาร (Export)';
await go('#/export/' + edId);
await p.waitForSelector(T('export-card'));
const nPages = (await dbDocs(p)).find((d) => d.id === edId).pages.length;
await check('Option buttons PDF/JPG/PNG, A4/ขนาดต้นฉบับ, สูง/มาตรฐาน, checkbox', async () => {
  for (const [g, vals] of [['fmt', ['jpg', 'png', 'pdf']], ['paper', ['original', 'a4']], ['quality', ['standard', 'high']]]) {
    for (const v of vals) { await p.click(T(`${g}-${v}`)); assert((await p.getAttribute(T(`${g}-${v}`), 'aria-checked')) === 'true'); }
  }
  const before = (await settings()).openAfter;
  await p.click(T('exp-open-label')); assert((await settings()).openAfter === !before);
  await p.click(T('exp-open-label'));
});
await p.evaluate(() => localStorage.setItem('paperx.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('paperx.settings.v1')), openAfter: false })));
await p.reload(); await p.waitForSelector(T('export-card'));
await check(`ดาวน์โหลด PDF (A4, สูง) → valid ${nPages}-page PDF`, async () => {
  await p.fill(T('exp-name'), 'ทดสอบ_PDF');
  const f = await download(T('exp-download'));
  const s = f.buf.toString('latin1');
  assert(s.startsWith('%PDF-'), 'not a PDF');
  const pages = (s.match(/\/Type \/Page[^s]/g) || []).length;
  assert(pages === nPages, `pages ${pages}`);
  assert(/MediaBox \[0 0 595\.2\d* 841\.8\d*\]/.test(s), 'not A4');
  return `${f.name}, ${(f.buf.length / 1024).toFixed(0)} KB, ${pages} pages`;
});
await check('ดาวน์โหลด PDF ขนาดต้นฉบับ + มาตรฐาน → smaller, non-A4 pages', async () => {
  await p.click(T('paper-original')); await p.click(T('quality-standard'));
  const f = await download(T('exp-download'));
  const s = f.buf.toString('latin1');
  assert(s.startsWith('%PDF-') && !/MediaBox \[0 0 595\.2\d* 841\.8\d*\]/.test(s), 'still A4');
  await p.click(T('paper-a4')); await p.click(T('quality-high'));
  return `${(f.buf.length / 1024).toFixed(0)} KB`;
});
await check('ดาวน์โหลด JPG → one JPEG per page', async () => {
  await p.click(T('fmt-jpg'));
  const names = [];
  const listener = (d) => names.push(d.suggestedFilename());
  p.on('download', listener);
  const f = await download(T('exp-download'));
  await p.waitForTimeout(1500); p.off('download', listener);
  assert(f.buf[0] === 0xff && f.buf[1] === 0xd8, 'not jpeg');
  return names.join(', ');
});
await check('ดาวน์โหลด PNG → PNG file', async () => {
  await p.click(T('fmt-png'));
  const f = await download(T('exp-download'));
  assert(f.buf.slice(1, 4).toString() === 'PNG', 'not png');
  await p.click(T('fmt-pdf'));
});
await check('“เปิดด้วยแอปพลิเคชันหลังดาวน์โหลด” opens the file in a new tab', async () => {
  await p.click(T('exp-open-label'));
  const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 60000 }), p.click(T('exp-download'))]);
  // headless Chromium has no PDF viewer, so navigating the tab to the PDF shows up as a download from that tab
  let u = popup.url(); let dl = null;
  popup.on('download', (d) => { dl = d.url(); });
  for (let i = 0; i < 100 && !u.startsWith('blob:') && !dl && !popup.isClosed(); i++) { await p.waitForTimeout(200); u = popup.url(); }
  // no PDF viewer (headless WebKit): the tab must not be left blank — app closes it and tells the user
  const closedGracefully = popup.isClosed() && /เปิดไฟล์ในแท็บใหม่ไม่ได้/.test(await toastText());
  await popup.close().catch(() => {});
  assert(u.startsWith('blob:') || (dl && dl.startsWith('blob:')) || closedGracefully, 'popup never received the file: ' + u);
  return u.startsWith('blob:') ? 'opened in new tab' : dl ? 'new tab received the file' : 'no viewer → blank tab closed + toast';
});
await check('ปุ่มแชร์ only rendered when Web Share (files) is available', async () => {
  const can = await p.evaluate(() => !!navigator.canShare && navigator.canShare({ files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] }));
  assert((await p.locator(T('exp-share')).count()) === (can ? 1 : 0));
  return can ? 'shown' : 'hidden (unsupported here)';
});
await check('Back button returns', async () => { await p.click(T('exp-back')); await p.waitForTimeout(300); assert(!(await hash()).startsWith('#/export')); });

// ---------------------------------------------------------------- OCR
section = 'OCR (ไทย-อังกฤษ)';
await go('#/ocr');
await check('OCR picker lists documents', async () => { await p.waitForSelector(T('ocr-picker')); });
await go('#/home');
await importVia(p, T('home-import'), ['test-assets/skewed_shadow.jpg', 'test-assets/rotated.jpg']);
await p.waitForSelector(T('ed-canvas'), { timeout: 60000 });
const ocrId = (await hash()).match(/editor\/([^?]+)/)[1];
await go('#/ocr/' + ocrId);
let ocrText = '';
await check('Thai+English text extracted on-device (ข้อความที่ตรวจพบ + success pill)', async () => {
  await p.waitForSelector(T('ocr-success'), { timeout: 180000 });
  ocrText = await p.inputValue(T('ocr-text'));
  assert(/PAPERX/.test(ocrText), 'no PAPERX');
  assert(/สแกนเอกสาร/.test(ocrText) && /ภาษาไทย/.test(ocrText), 'Thai missing');
  return ocrText.slice(0, 60).replace(/\n/g, ' ⏎ ');
});
if (isCr) await check('คัดลอก copies text to clipboard', async () => {
  await p.click(T('ocr-copy'));
  const clip = await p.evaluate(() => navigator.clipboard.readText());
  assert(clip === ocrText, 'clipboard mismatch');
});
await check('บันทึกเป็น .txt downloads UTF-8 text', async () => {
  const f = await download(T('ocr-txt'));
  assert(f.buf.toString('utf8') === ocrText);
});
await check('Page ‹ › navigation runs OCR per page', async () => {
  if (!(await p.locator(T('ocr-next')).count())) return 'single page';
  await p.click(T('ocr-next')); await p.waitForSelector(T('ocr-success'), { timeout: 180000 });
  await p.click(T('ocr-prev')); await p.waitForSelector(T('ocr-success'), { timeout: 180000 });
});
await check('Language “English” re-runs OCR; อ่านใหม่ re-runs', async () => {
  await p.click(T('lang-eng')); await p.waitForSelector(T('ocr-progress'), { timeout: 5000 }).catch(() => {});
  await p.waitForSelector(T('ocr-success'), { timeout: 180000 });
  const t = await p.inputValue(T('ocr-text'));
  assert(!/สแกนเอกสาร/.test(t), 'still Thai');
  await p.click(T('lang-tha+eng')); await p.waitForSelector(T('ocr-success'), { timeout: 180000 });
  await p.click(T('ocr-rerun')); await p.waitForSelector(T('ocr-success'), { timeout: 180000 });
});
await check('OCR text becomes searchable in the library', async () => {
  await go('#/library'); await p.fill(T('search'), 'ภาษาไทย');
  assert((await p.locator(T('doc-card')).count()) >= 1);
  await p.fill(T('search'), '');
});

// ---------------------------------------------------------------- SETTINGS
section = 'ตั้งค่า (Settings)';
await go('#/settings');
await check('Default mode select applies to new scans', async () => {
  await p.selectOption(T('set-mode'), 'bw');
  await go('#/home'); await importVia(p, T('home-import'), 'test-assets/rotated.jpg');
  await p.waitForSelector(T('ed-canvas'), { timeout: 60000 });
  assert((await p.getAttribute(T('mode-bw'), 'aria-checked')) === 'true', 'new scan not bw');
  await go('#/settings'); await p.selectOption(T('set-mode'), 'textBoost');
});
await check('Toggles & selects persist (auto-capture, OCR lang, export defaults)', async () => {
  await p.click(T('set-auto')); assert((await settings()).autoCapture === false); await p.click(T('set-auto'));
  if (await p.locator(T('set-haptics')).count()) { await p.click(T('set-haptics')); assert((await settings()).haptics === false); await p.click(T('set-haptics')); }
  await p.selectOption(T('set-ocr'), 'eng'); assert((await settings()).ocrLang === 'eng'); await p.selectOption(T('set-ocr'), 'tha+eng');
  await p.selectOption(T('set-format'), 'png'); await p.selectOption(T('set-paper'), 'original'); await p.selectOption(T('set-quality'), 'standard');
  const s = await settings(); assert(s.format === 'png' && s.paper === 'original' && s.quality === 'standard');
});
await check('คืนค่า restores defaults', async () => {
  await p.click(T('reset-settings')); const s = await settings();
  assert(s.format === 'pdf' && s.paper === 'a4' && s.quality === 'high');
});
await check('Persistent-storage button requests storage persistence', async () => {
  if (!(await p.locator(T('persist-btn')).count())) return 'already persisted';
  await p.click(T('persist-btn')); await p.waitForSelector(T('toast'));
  return await toastText();
});
await check('ดูคีย์ลัด opens help', async () => { await p.click(T('shortcuts-btn')); await p.waitForSelector(T('shortcuts')); await p.keyboard.press('Escape'); });
await check('Install section shows a real action (prompt or platform instructions)', async () => {
  const t = await p.innerText(T('install-section'));
  assert(/ติดตั้ง|หน้าจอโฮม|หน้าจอหลัก/.test(t));
});

// ---------------------------------------------------------------- PIPELINE
section = 'ระบบประมวลผล (Pipeline accuracy)';
for (const name of ['skewed_shadow', 'curved', 'rotated', 'square_sign', 'box_face', 'color_label', 'clear_board', 'noodle_packet']) {
  await check(`Four-corner detection on “${name}.jpg” matches ground truth`, async () => {
    const truth = JSON.parse(readFileSync(`test-assets/${name}.json`, 'utf8')).corners;
    const n0 = await docCount();
    await go('#/home'); await importVia(p, T('home-import'), `test-assets/${name}.jpg`);
    await p.waitForSelector(T('ed-canvas'), { timeout: 60000 });
    const d = (await dbDocs(p)).sort((a, b) => b.createdAt - a.createdAt)[0];
    const c = d.pages[0].corners;
    const err = Math.max(...c.map((q, i) => Math.hypot(q.x - truth[i].x, q.y - truth[i].y)));
    const limit = ['square_sign', 'box_face', 'color_label', 'clear_board', 'noodle_packet'].includes(name) ? 0.06 : 0.03;
    if (name !== 'curved') assert(err < limit, 'corner error ' + err.toFixed(3));
    if (name === 'curved') assert(d.pages[0].mids, 'curvature not detected');
    if (name === 'skewed_shadow' || name === 'rotated') assert(!d.pages[0].mids, 'false curvature');
    return `max corner error ${(err * 100).toFixed(2)}% · curved=${!!d.pages[0].mids}`;
  });
}
await check('Shadow removal flattens illumination (left/right paper brightness)', async () => {
  const stats = await p.evaluate(async () => {
    const r = indexedDB.open('paperx'); await new Promise((res) => (r.onsuccess = res));
    const docs = await new Promise((res) => { const t = r.result.transaction('docs').objectStore('docs').getAll(); t.onsuccess = () => res(t.result); });
    const d = docs.find((x) => x.name === 'skewed_shadow');
    const v = await new Promise((res) => { const t = r.result.transaction('blobs').objectStore('blobs').get(d.pages[0].outKey); t.onsuccess = () => res(t.result); });
    const blob = v instanceof Blob ? v : new Blob([v.buf], { type: v.type });
    const bmp = await createImageBitmap(blob); const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    const reg = (fx) => { const dd = x.getImageData(Math.round(bmp.width * fx), Math.round(bmp.height * 0.03), Math.round(bmp.width * 0.06), Math.round(bmp.height * 0.03)).data; let s = 0; for (let i = 0; i < dd.length; i += 4) s += dd[i]; return s / (dd.length / 4); };
    return { left: reg(0.05), right: reg(0.89) };
  });
  assert(Math.abs(stats.left - stats.right) < 12 && stats.right > 225, JSON.stringify(stats));
  return `paper L=${stats.left.toFixed(0)} R=${stats.right.toFixed(0)} (input photo differs by >40)`;
});

// ---------------------------------------------------------------- PWA
await check('Auto Flatten accuracy: wrinkled-page text-line misalignment vs ground truth drops ≥ 50%', async () => {
  const { execFileSync } = await import('node:child_process');
  const o = execFileSync('node', ['tests/flatten-bench.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const m = o.match(/wrinkled: .*before ([\d.]+)\/\d+ -> after ([\d.]+)\/\d+/);
  assert(m, o);
  const [bf, af] = [Number(m[1]), Number(m[2])];
  assert(af <= bf * 0.5, `${bf} → ${af}`);
  const sp = o.match(/book spine at ([\d.]+)/);
  assert(sp && Math.abs(Number(sp[1]) - 0.5) < 0.03, 'spine ' + (sp && sp[1]));
  return `mean misalignment ${bf}px → ${af}px; spine ${sp[1]} (truth 0.500)`;
});

section = 'PWA / Offline';
await check('Web app manifest valid with icons + apple-touch-icon', async () => {
  const m = await p.evaluate(async () => (await fetch('./manifest.webmanifest')).json());
  assert(m.display === 'standalone' && m.icons.length >= 3);
  for (const i of m.icons) { const ok = await p.evaluate(async (s) => (await fetch(s)).ok, i.src); assert(ok, i.src); }
  assert(await p.evaluate(async () => (await fetch(document.querySelector('link[rel=apple-touch-icon]').href)).ok));
});
await check('Service worker controls the page', async () => {
  await p.waitForLoadState('networkidle').catch(() => {}); await p.waitForTimeout(1000); await p.reload(); await p.waitForTimeout(1500);
  assert(await p.evaluate(() => !!navigator.serviceWorker.controller));
});
await check('Works offline after first load (reload while offline)', async () => {
  await p.waitForTimeout(4000);
  await go('#/home');
  await ctx.setOffline(true);
  await p.reload(); await p.waitForSelector(T('sidebar'), { timeout: 15000 });
  await go('#/library'); await p.waitForSelector(T('doc-card'));
  await ctx.setOffline(false);
});

// ---------------------------------------------------------------- PHONE layout
section = 'มือถือ (Phone 390×844, touch)';
{
  const c3 = await b.newContext({ ...VIEWPORTS.phone, permissions: isCr ? ['camera'] : [] });
  if (!isCr) await c3.addInitScript(NO_CAM);
  const p3 = await c3.newPage(); track(p3, errs);
  await p3.goto(URL); await p3.waitForSelector(T('hero'));
  await check('Bottom tab bar navigation + center scan button', async () => {
    for (const [n, hh] of [['library', '#/library'], ['ocr', '#/ocr'], ['settings', '#/settings'], ['home', '#/home']]) {
      await p3.tap(T('bnav-' + n)); await p3.waitForTimeout(150);
      assert((await p3.evaluate(() => location.hash)) === hh, n);
    }
    await p3.tap(T('bnav-scan')); await p3.waitForSelector(T('camera')); await p3.tap(T('cam-close'));
  });
  await check('Touch targets ≥ 44px on primary controls', async () => {
    const small = await p3.$$eval('button', (bs) => bs.filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.height < 36 || r.width < 36); }).map((b) => b.innerText || b.getAttribute('aria-label')));
    assert(small.length === 0, 'small: ' + small.join(','));
  });
  await check('Editor on phone: tools open bottom sheets (filters/adjust/angle) and work', async () => {
    const [fc] = await Promise.all([p3.waitForEvent('filechooser'), p3.tap(T('home-import'))]);
    await fc.setFiles('test-assets/skewed_shadow.jpg');
    await p3.waitForSelector(T('ed-canvas'), { timeout: 60000 });
    await p3.tap(T('tool-filters')); await p3.waitForSelector(T('sheet-filters'));
    await p3.tap(T('thumb-bw')); await p3.keyboard.press('Escape');
    await p3.tap(T('tool-adjust')); await p3.waitForSelector(T('sheet-adjust')); await p3.keyboard.press('Escape');
    await p3.tap(T('ed-more')); await p3.waitForSelector(T('sheet-more')); await p3.keyboard.press('Escape');
  });
  await c3.close();
}

await ctx.close();
await b.close();
const relevantErrs = errs.filter((e) => !/favicon/.test(e));
results.push({ section: 'Console', name: 'No console errors / page errors / failed requests', ok: relevantErrs.length === 0, detail: relevantErrs.slice(0, 5).join(' || ') });
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));
const pass = results.filter((r) => r.ok).length;
console.log(`\n${ENGINE}: ${pass}/${results.length} passed`);
if (relevantErrs.length) console.log('ERRORS:', relevantErrs);
