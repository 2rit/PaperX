"""Harder phone-photo fixtures: low contrast, a holding hand, a heavy shadow, a curled book page.

Ground truth corners are normalized TL, TR, BR, BL. Curled pages also store a flat RGBA
the dewarper should approach.
"""
import json, math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

R = 'plexthai.ttf'
B = 'plexthai-b.ttf'
OUT = '.'

def text_page(w, h, seed=1):
    rng = np.random.default_rng(seed)
    im = Image.new('RGB', (w, h), (250, 248, 242))
    d = ImageDraw.Draw(im)
    d.text((70, 60), 'PAPERX', font=ImageFont.truetype(B, 72), fill=(20, 20, 20))
    f = ImageFont.truetype(R, 36)
    lines = [
        'สแกนเอกสารได้อย่างรวดเร็วและคมชัด',
        'The quick brown fox jumps over the lazy dog.',
        'หน้าโค้งจะถูกคลี่ให้บรรทัดตรง',
        'Curved lines should become straight.',
        'รองรับภาษาไทยและอังกฤษในเครื่อง',
        'Processed entirely on this device.',
    ]
    y = 180
    k = 0
    while y < h - 80:
        d.text((70, y), lines[k % len(lines)], font=f, fill=(28, 28, 28))
        y += 58
        k += 1
    return im

def coeffs(dst, src):
    A, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        A += [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
        b += [u, v]
    return np.linalg.solve(np.array(A, float), np.array(b, float)).tolist()

def save_photo(name, doc, corners, size, bg, shadow=None, hand=None):
    dw, dh = doc.size
    warped = doc.convert('RGBA').transform(size, Image.PERSPECTIVE, coeffs(corners, [(0, 0), (dw, 0), (dw, dh), (0, dh)]), Image.BICUBIC)
    mask = warped.split()[3]
    canvas = bg.copy()
    if shadow is not None:
        canvas = Image.fromarray(np.clip(np.asarray(canvas).astype(float) * shadow[..., None], 0, 255).astype('uint8'))
    canvas.paste(warped.convert('RGB'), (0, 0), mask)
    arr = np.asarray(canvas).astype(float)
    if hand is not None:
        arr = hand(arr)
    arr += np.random.default_rng(2).normal(0, 2.0, arr.shape)
    im = Image.fromarray(np.clip(arr, 0, 255).astype('uint8')).filter(ImageFilter.GaussianBlur(0.8))
    im.save(f'{name}.jpg', quality=90)
    json.dump({'corners': [{'x': x / size[0], 'y': y / size[1]} for x, y in corners]}, open(f'{name}.json', 'w'))
    print('wrote', name)

def light_table(w, h):
    a = np.full((h, w, 3), 236.0)
    a += np.random.default_rng(1).normal(0, 3, a.shape)
    # faint wood-grain so it is not a perfectly flat field
    xs = np.linspace(0, 1, w)[None, :]
    grain = np.sin(xs * 18 * math.pi) * 2.5
    a += grain[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype('uint8'))

W, H = 1600, 2100
doc = text_page(1000, 1400)
# 1. white page on a white table, only a soft contact shadow
yy, xx = np.mgrid[0:H, 0:W]
# contact shadow is a dark ring just outside the page; inside stays bright
corners = [(280, 340), (1320, 300), (1380, 1760), (240, 1800)]
save_photo('quality_white', doc, corners, (W, H), light_table(W, H))

# 2. same page with a hand covering the bottom edge
def paint_hand(arr):
    h, w = arr.shape[:2]
    skin = np.zeros((h, w), np.float32)
    # palm blob and two fingers along the bottom of the sheet
    for cx, cy, rx, ry in [(700, 1680, 220, 160), (560, 1560, 46, 150), (820, 1540, 40, 170)]:
        skin += np.exp(-(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2))
    skin = np.clip(skin, 0, 1)
    color = np.array([214, 166, 140])
    arr = arr * (1 - skin[..., None] * 0.92) + color * (skin[..., None] * 0.92)
    return arr
save_photo('quality_hand', doc, corners, (W, H), light_table(W, H), hand=paint_hand)

# 3. heavy side shadow on a darker table (wood-ish)
def wood(w, h):
    xs = np.linspace(0, 1, w)[None, :]
    ys = np.linspace(0, 1, h)[:, None]
    g = np.sin((xs * 26 + np.sin(ys * 6) * 1.2) * math.pi) * 0.5 + 0.5
    b = np.stack([100 + 40 * g, 68 + 28 * g, 40 + 16 * g], -1)
    return Image.fromarray(np.clip(b, 0, 255).astype('uint8'))
shade = 0.45 + 0.55 * np.clip((xx / W - 0.15) / 0.7, 0, 1)
corners2 = [(360, 280), (1480, 420), (1360, 1880), (220, 1700)]
save_photo('quality_shadow', doc, corners2, (W, H), wood(W, H), shadow=shade)

# 4. a single curled page (vertical displacement only) with a flat truth
flat = np.asarray(text_page(1100, 1500, seed=4)).astype(np.float32)
h, w = flat.shape[:2]
yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
# cubic sheet: sag toward the right (gutter), stronger at the bottom — like page_dewarp
u = xx / w
bow = 70 * (u ** 2) * (0.45 + 0.55 * (yy / h))
sy = np.clip(yy - bow, 0, h - 1)
y0 = np.floor(sy).astype(int)
y1 = np.minimum(h - 1, y0 + 1)
t = (sy - y0)[..., None]
curled = flat[y0, xx.astype(int)] * (1 - t) + flat[y1, xx.astype(int)] * t
# gutter shade
curled *= (1 - 0.28 * (u ** 2))[..., None]
Image.fromarray(np.clip(curled, 0, 255).astype('uint8')).save('quality_curl.png')
Image.fromarray(np.clip(flat, 0, 255).astype('uint8')).save('quality_curl_truth.png')
print('wrote quality_curl')
