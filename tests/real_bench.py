#!/usr/bin/env python3
"""DocUNet benchmark plus a broad document-category set.

Old = geometric text-line flatten. New = UVDoc grid, then the geometric sheet
only when it still reduces line spread. MS-SSIM is higher-better. LD is the mean
SIFT residual (px) after a homography, a stand-in for the DocUNet local-distortion
metric (the official one needs the MATLAB SIFT-flow toolbox). CER is OCR(result)
against OCR(flatbed scan) on a sample, character error rate, lower-better.
"""
import json, math, os, subprocess, time
from pathlib import Path
import numpy as np
import cv2
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFont
from sewar.full_ref import msssim

ROOT = Path('/tmp/bench')
DOC = ROOT / 'docunet'
OUT = ROOT / 'report'
OUT.mkdir(parents=True, exist_ok=True)
MAX = 720

so = ort.SessionOptions()
so.intra_op_num_threads = 2
so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
UV = ort.InferenceSession('/workspace/models/UVDoc_grid.onnx', so, providers=['CPUExecutionProvider'])
AL = ort.InferenceSession('/workspace/models/docaligner-lcnet100.onnx', so, providers=['CPUExecutionProvider'])

def read(p):
    im = cv2.imread(str(p), cv2.IMREAD_COLOR)
    if im is None:
        raise SystemExit('missing ' + str(p))
    return im

def fit(im, max_side):
    h, w = im.shape[:2]
    k = min(1.0, max_side / max(h, w))
    if k == 1:
        return im
    return cv2.resize(im, (max(1, int(w * k)), max(1, int(h * k))), interpolation=cv2.INTER_AREA)

def uvdoc(im):
    rgb = cv2.cvtColor(im, cv2.COLOR_BGR2RGB)
    small = cv2.resize(rgb, (496, 720)).astype(np.float32) / 255.0
    ten = np.transpose(small, (2, 0, 1))[None]
    grid = UV.run(None, {UV.get_inputs()[0].name: ten})[0][0]  # 2,45,31
    gh, gw = grid.shape[1], grid.shape[2]
    up = np.transpose(grid, (1, 2, 0))
    up = cv2.resize(up, (im.shape[1], im.shape[0]), interpolation=cv2.INTER_LINEAR)
    mx = ((up[..., 0] + 1) / 2) * (im.shape[1] - 1)
    my = ((up[..., 1] + 1) / 2) * (im.shape[0] - 1)
    return cv2.remap(im, mx.astype(np.float32), my.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

def corners(im):
    rgb = cv2.cvtColor(im, cv2.COLOR_BGR2RGB)
    small = cv2.resize(rgb, (256, 256)).astype(np.float32) / 255.0
    ten = np.transpose(small, (2, 0, 1))[None]
    hm = AL.run(None, {AL.get_inputs()[0].name: ten})[0][0]
    pts = []
    for k in range(4):
        h = hm[k]
        idx = int(h.argmax())
        y, x = divmod(idx, h.shape[1])
        pts.append([ (x + 0.5) / h.shape[1], (y + 0.5) / h.shape[0], float(h.max()) ])
    return pts

def to_png_bytes_dir(pairs, folder):
    folder.mkdir(parents=True, exist_ok=True)
    meta = []
    for name, im in pairs:
        cv2.imwrite(str(folder / f'{name}.png'), im)
        meta.append(name)
    return meta

def geo_batch(src_dir, dst_dir):
    dst_dir.mkdir(parents=True, exist_ok=True)
    raw = src_dir.parent / (src_dir.name + '_raw')
    raw.mkdir(parents=True, exist_ok=True)
    for p in src_dir.glob('*.png'):
        im = cv2.imread(str(p), cv2.IMREAD_COLOR)
        rgb = cv2.cvtColor(im, cv2.COLOR_BGR2RGBA)
        (raw / f'{p.stem}_{im.shape[1]}x{im.shape[0]}.raw').write_bytes(rgb.tobytes())
    subprocess.check_call(['node', '/workspace/tests/geo_flatten.mjs', str(raw), str(dst_dir)], cwd='/workspace')

def same(a, b):
    if a.shape[:2] != b.shape[:2]:
        a = cv2.resize(a, (b.shape[1], b.shape[0]), interpolation=cv2.INTER_AREA)
    return a, b

def ms(a, b):
    a, b = same(a, b)
    v = msssim(b, a)
    return float(np.real(v))

def ld(a, b):
    a, b = same(a, b)
    g1 = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    g2 = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
    sift = cv2.SIFT_create(nfeatures=800)
    k1, d1 = sift.detectAndCompute(g1, None)
    k2, d2 = sift.detectAndCompute(g2, None)
    if d1 is None or d2 is None or len(k1) < 8 or len(k2) < 8:
        return None
    knn = cv2.BFMatcher().knnMatch(d1, d2, k=2)
    good = [m for m, n in knn if m.distance < 0.75 * n.distance]
    if len(good) < 12:
        return None
    src = np.float32([k2[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([k1[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
    if H is None or mask is None:
        return None
    proj = cv2.perspectiveTransform(src, H)
    err = np.linalg.norm(proj - dst, axis=2).ravel()
    keep = mask.ravel().astype(bool)
    if keep.sum() < 8:
        return None
    return float(err[keep].mean())

def cer(hyp, ref):
    # Levenshtein over characters
    a, b = list(hyp), list(ref)
    if not b:
        return None
    dp = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        nd = [i]
        for j, cb in enumerate(b, 1):
            nd.append(min(dp[j] + 1, nd[-1] + 1, dp[j - 1] + (ca != cb)))
        dp = nd
    return dp[-1] / len(b)

def ocr(im):
    if not hasattr(ocr, 'ok'):
        ocr.ok = subprocess.call(['bash', '-lc', 'command -v tesseract'], stdout=subprocess.DEVNULL) == 0
    if not ocr.ok:
        return None
    p = OUT / '_ocr.png'
    cv2.imwrite(str(p), im)
    t = subprocess.check_output(['tesseract', str(p), 'stdout', '--psm', '6'], stderr=subprocess.DEVNULL, text=True)
    return ' '.join(t.split())

def summarize(rows):
    def avg(key):
        xs = [r[key] for r in rows if r.get(key) is not None]
        return None if not xs else float(np.mean(xs))
    return {k: avg(k) for k in ['msssim_in', 'msssim_old', 'msssim_new', 'ld_in', 'ld_old', 'ld_new', 'cer_old', 'cer_new']}

# ---------- DocUNet ----------
pairs = []
for p in sorted((DOC / 'crop' / 'crop').glob('*.png')):
    stem = p.name.replace(' copy.png', '').replace('.png', '')
    doc_id = stem.split('_')[0]
    gt = DOC / 'scan' / 'scan' / f'{doc_id}.png'
    if gt.exists():
        pairs.append((stem, p, gt))
print('docunet pairs', len(pairs), flush=True)

inputs, gts = [], []
for name, src, gt in pairs:
    im = fit(read(src), MAX)
    inputs.append((name, im))
    gts.append((name, fit(read(gt), MAX)))
gt_map = dict(gts)

print('uvdoc...', flush=True)
t0 = time.perf_counter()
uv_imgs = [(n, uvdoc(im)) for n, im in inputs]
print(f'uvdoc {len(uv_imgs)} in {time.perf_counter()-t0:.1f}s', flush=True)

in_dir, uv_dir, old_dir, new_dir = OUT / 'in', OUT / 'uv', OUT / 'old', OUT / 'new'
to_png_bytes_dir(inputs, in_dir)
to_png_bytes_dir(uv_imgs, uv_dir)
print('geometric...', flush=True)
t1 = time.perf_counter()
geo_batch(in_dir, old_dir)
geo_batch(uv_dir, new_dir)
print(f'geometric in {time.perf_counter()-t1:.1f}s', flush=True)

rows = []
for i, (name, im) in enumerate(inputs):
    gt = gt_map[name]
    old = read(old_dir / f'{name}.png')
    new = read(new_dir / f'{name}.png')
    row = {
        'name': name,
        'msssim_in': ms(im, gt), 'msssim_old': ms(old, gt), 'msssim_new': ms(new, gt),
        'ld_in': ld(im, gt), 'ld_old': ld(old, gt), 'ld_new': ld(new, gt),
    }
    if i < 24:
        ro, rn, rg = ocr(old), ocr(new), ocr(gt)
        if ro is not None and rg:
            row['cer_old'] = cer(ro, rg)
            row['cer_new'] = cer(rn or '', rg)
    rows.append(row)
    if i < 6:
        side = np.concatenate([
            cv2.resize(im, (360, 480)),
            cv2.resize(old, (360, 480)),
            cv2.resize(new, (360, 480)),
            cv2.resize(gt, (360, 480)),
        ], axis=1)
        cv2.imwrite(str(OUT / f'docunet_{name}.jpg'), side, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    if i % 20 == 0:
        print(' scored', i, flush=True)

doc_sum = summarize(rows)
(OUT / 'docunet.json').write_text(json.dumps({'summary': doc_sum, 'n': len(rows), 'rows': rows}, indent=2))
print('DOCUNET', json.dumps(doc_sum), flush=True)

# ---------- category set (synthetic, with a flat ground truth) ----------
font = ImageFont.truetype('/workspace/test-assets/plexthai.ttf', 28)
fontb = ImageFont.truetype('/workspace/test-assets/plexthai-b.ttf', 40)

def page(kind):
    im = Image.new('RGB', (900, 1200), (248, 246, 240))
    d = ImageDraw.Draw(im)
    if kind == 'thai-official':
        d.ellipse((400, 30, 500, 130), fill=(186, 146, 46))
        d.text((180, 150), 'หนังสือราชการ', font=fontb, fill=(20, 20, 80))
        y = 230
        for i, line in enumerate(['เรื่อง ขอความอนุเคราะห์ข้อมูล', 'เรียน ผู้อำนวยการสำนัก', 'ด้วยมีเอกสารแนบมาเพื่อโปรดพิจารณา']):
            d.text((70, y), line, font=font, fill=(20, 20, 20))
            d.line((420, y + 28, 820, y + 28), fill=(20, 20, 20), width=2)
            for x in range(420, 820, 10):
                d.point((x, y + 28), fill=(20, 20, 20))
            y += 70
        for r in range(4):
            for c in range(3):
                d.rectangle((70 + c * 250, 520 + r * 80, 310 + c * 250, 590 + r * 80), outline=(30, 30, 30), width=2)
        d.ellipse((620, 900, 820, 1100), outline=(180, 20, 30), width=8)
        d.text((660, 980), 'ตราแดง', font=fontb, fill=(180, 20, 30))
        d.ellipse((80, 930, 230, 1080), outline=(20, 50, 160), width=6)
    elif kind == 'receipt':
        im = Image.new('RGB', (500, 1400), (236, 236, 230))
        d = ImageDraw.Draw(im)
        d.text((40, 40), 'ใบเสร็จรับเงิน', font=fontb, fill=(10, 10, 10))
        y = 140
        for i in range(16):
            d.text((30, y), f'รายการ {i+1}  ......  {20+i}.00', font=font, fill=(15, 15, 15))
            y += 60
        return np.asarray(im).astype(np.float32)
    elif kind == 'blackboard':
        im = Image.new('RGB', (1100, 700), (28, 36, 32))
        d = ImageDraw.Draw(im)
        d.text((60, 50), 'Board notes', font=fontb, fill=(230, 230, 220))
        d.text((60, 160), 'y = ax + b', font=fontb, fill=(230, 230, 220))
        d.text((60, 280), 'ประชุมวันศุกร์ 09:00', font=font, fill=(230, 230, 220))
        return np.asarray(im).astype(np.float32)
    elif kind == 'id-glare':
        d.rounded_rectangle((80, 250, 820, 900), radius=24, outline=(20, 20, 20), width=4, fill=(250, 250, 252))
        d.text((140, 300), 'บัตรประจำตัว', font=fontb, fill=(20, 40, 90))
        d.text((140, 400), 'ชื่อ สมชาย ใจดี', font=font, fill=(20, 20, 20))
        d.text((140, 470), 'ID 1103700000000', font=font, fill=(20, 20, 20))
        # plastic glare
        arr = np.asarray(im).astype(np.float32)
        yy, xx = np.mgrid[0:arr.shape[0], 0:arr.shape[1]]
        glare = np.exp(-((xx - 500) ** 2 + (yy - 500) ** 2) / (2 * 90 ** 2))
        arr += glare[..., None] * 180
        im = Image.fromarray(np.clip(arr, 0, 255).astype('uint8'))
    elif kind == 'whiteboard':
        d.rectangle((40, 40, 860, 1160), outline=(180, 180, 180), width=6, fill=(252, 252, 252))
        d.text((80, 80), 'Whiteboard', font=fontb, fill=(30, 30, 160))
        d.text((80, 180), 'งานที่ต้องทำวันนี้', font=font, fill=(20, 20, 20))
        d.line((80, 240, 700, 240), fill=(200, 30, 30), width=3)
    else:
        d.text((70, 60), kind, font=fontb, fill=(20, 20, 20))
        y = 160
        for i in range(14):
            d.text((70, y), 'The quick brown fox jumps over the lazy dog.', font=font, fill=(25, 25, 25))
            y += 64
    return np.asarray(im).astype(np.float32)

def curl(arr, gutter='left'):
    h, w = arr.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u = xx / w if gutter == 'left' else 1 - xx / w
    bow = 42 * (1 - u) ** 2.1
    disp = bow * (0.4 + 0.6 * ((yy / h) - 0.5) * 2)
    sy = np.clip(yy - disp, 0, h - 1)
    y0 = np.floor(sy).astype(int)
    y1 = np.minimum(h - 1, y0 + 1)
    t = (sy - y0)[..., None]
    out = arr[y0, xx.astype(int)] * (1 - t) + arr[y1, xx.astype(int)] * t
    if gutter == 'left':
        shade = 1 - 0.45 * np.exp(-((xx) / 70) ** 2)
        out = out * shade[..., None]
    return np.clip(out, 0, 255).astype(np.uint8)

cats = {}
for kind, gutter in [('thai-official', 'left'), ('receipt', 'right'), ('blackboard', 'left'), ('id-glare', 'left'), ('whiteboard', 'right'), ('letter', 'left')]:
    gt = page(kind).astype(np.uint8)
    warped = curl(gt.astype(np.float32), gutter=gutter)
    # put the curled page on a desk so detection has a background
    H, W = warped.shape[:2]
    desk = np.full((H + 180, W + 180, 3), (92, 64, 40), np.uint8)
    desk[90:90 + H, 90:90 + W] = cv2.cvtColor(warped, cv2.COLOR_RGB2BGR)
    photo = desk
    gt_bgr = cv2.cvtColor(gt, cv2.COLOR_RGB2BGR)
    pred = corners(photo)
    # truth corners of the page on the desk, normalized
    truth = [[90 / photo.shape[1], 90 / photo.shape[0]], [(90 + W) / photo.shape[1], 90 / photo.shape[0]], [(90 + W) / photo.shape[1], (90 + H) / photo.shape[0]], [90 / photo.shape[1], (90 + H) / photo.shape[0]]]
    err = max(math.hypot(pred[i][0] - truth[i][0], pred[i][1] - truth[i][1]) for i in range(4))
    uv = uvdoc(cv2.cvtColor(warped, cv2.COLOR_RGB2BGR))
    cv2.imwrite(str(OUT / f'cat_{kind}_in.png'), cv2.cvtColor(warped, cv2.COLOR_RGB2BGR))
    cv2.imwrite(str(OUT / f'cat_{kind}_gt.png'), gt_bgr)
    cv2.imwrite(str(OUT / f'cat_{kind}_uv.png'), uv)
    cats[kind] = {'corner_err_pct': round(err * 100, 2), 'scores': [round(p[2], 2) for p in pred]}

# geometric on the category warps
cat_in = OUT / 'cat_in'
cat_old = OUT / 'cat_old'
cat_new = OUT / 'cat_new'
to_png_bytes_dir([(k, cv2.cvtColor(curl(page(k).astype(np.uint8).astype(np.float32), gutter='left' if k != 'receipt' else 'right'), cv2.COLOR_RGB2BGR)) for k in cats], cat_in)
# uv versions
uv_pairs = []
for k in cats:
    im = read(cat_in / f'{k}.png')
    uv_pairs.append((k, uvdoc(im)))
to_png_bytes_dir(uv_pairs, OUT / 'cat_uv')
geo_batch(cat_in, cat_old)
geo_batch(OUT / 'cat_uv', cat_new)
for k in cats:
    gt = read(OUT / f'cat_{k}_gt.png')
    old = read(cat_old / f'{k}.png')
    new = read(cat_new / f'{k}.png')
    inn = read(cat_in / f'{k}.png')
    cats[k]['msssim_in'] = round(ms(inn, gt), 4)
    cats[k]['msssim_old'] = round(ms(old, gt), 4)
    cats[k]['msssim_new'] = round(ms(new, gt), 4)
    side = np.concatenate([cv2.resize(inn, (300, 400)), cv2.resize(old, (300, 400)), cv2.resize(new, (300, 400)), cv2.resize(gt, (300, 400))], 1)
    cv2.imwrite(str(OUT / f'compare_{k}.jpg'), side, [int(cv2.IMWRITE_JPEG_QUALITY), 82])

(OUT / 'categories.json').write_text(json.dumps(cats, indent=2))
print('CATEGORIES', json.dumps(cats, ensure_ascii=False), flush=True)
