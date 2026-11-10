"""Synthetic book spread + wrinkled page photos for the auto-flatten / book-mode tests."""
import json, math, random
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
random.seed(7); np.random.seed(7)
R = 'plexthai.ttf'; B = 'plexthai-b.ttf'
TH = ['การสแกนเอกสารด้วยโทรศัพท์มือถือช่วยประหยัดเวลา', 'หน้าหนังสือที่โค้งจะถูกปรับให้เรียบโดยอัตโนมัติ', 'ตัวอักษรภาษาไทยอ่านได้ชัดเจนหลังการประมวลผล',
      'ระบบตรวจจับบรรทัดข้อความเพื่อคำนวณความโค้ง', 'แล้วคลี่ภาพให้บรรทัดตรงเหมือนกระดาษเรียบ']
EN = ['The quick brown fox jumps over the lazy dog.', 'Curved book pages are flattened automatically.', 'Text lines are detected and straightened.',
      'Every page is processed on the device itself.', 'Export the result as a multi page PDF file.']

def text_page(w, h, title, seed):
    rnd = random.Random(seed)
    im = Image.new('RGB', (w, h), (248, 246, 238)); d = ImageDraw.Draw(im)
    d.text((80, 70), title, font=ImageFont.truetype(B, 54), fill=(25, 25, 25))
    f = ImageFont.truetype(R, 30); y = 170
    while y < h - 90:
        ln = rnd.choice(TH + EN); d.text((80, y), ln, font=f, fill=(30, 30, 30)); y += 52
    return np.asarray(im).astype(np.float32)

def remap_vertical(arr, disp):
    """out(x,y) = in(x, y - disp(x,y))  (disp>0 moves content down)"""
    h, w = arr.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    sy = np.clip(yy - disp, 0, h - 1)
    y0 = np.floor(sy).astype(int); y1 = np.minimum(h - 1, y0 + 1); t = (sy - y0)[..., None]
    return arr[y0, xx.astype(int)] * (1 - t) + arr[y1, xx.astype(int)] * t

def wood(w, h):
    x = np.linspace(0, 1, w)[None, :]; y = np.linspace(0, 1, h)[:, None]
    g = np.sin((x * 30 + np.sin(y * 7) * 1.5) * math.pi) * 0.5 + 0.5
    b = np.stack([110 + 50 * g, 72 + 35 * g, 40 + 20 * g], -1) + np.random.normal(0, 6, (h, w, 3))
    return b

def line_offsets(arr):
    """per-strip vertical offset of text vs centre strip (measures line curvature) -> max abs px"""
    g = arr.mean(-1); ink = (g < 140).astype(np.float32)
    h, w = ink.shape; n = 12; prof = [ink[:, int(i*w/n):int((i+1)*w/n)].mean(1) for i in range(n)]
    return prof

# ---------- book spread ----------
PW, PH = 900, 1250
L = text_page(PW, PH, 'บทที่ 1  Chapter One', 1); Rr = text_page(PW, PH, 'บทที่ 2  Chapter Two', 2)
spread = np.concatenate([L, Rr], 1)
Image.fromarray(np.clip(L,0,255).astype('uint8')).save('book_truth_L.png'); Image.fromarray(np.clip(Rr,0,255).astype('uint8')).save('book_truth_R.png')
H2, W2 = spread.shape[:2]
xs = np.arange(W2)[None, :].astype(np.float32); ys = np.arange(H2)[:, None].astype(np.float32)
u = np.abs(xs - W2 / 2) / (W2 / 2)            # 0 at spine, 1 at outer edge
bow = 46 * (1 - u) ** 2.2                       # lines sag towards the spine
vert = (ys / H2 - 0.5) * 2                      # -1 top .. 1 bottom
disp = bow * (0.35 + 0.65 * vert) + 10 * np.sin(u * math.pi) * (1 + 0 * ys)
book = remap_vertical(spread, disp)
shade = 1 - 0.42 * np.exp(-((xs - W2 / 2) / 55) ** 2) - 0.06 * u
book = book * shade[..., None]
# canvas with margin + mild perspective via PIL
pad = 160
canvas = wood(W2 + 2 * pad, H2 + 2 * pad)
canvas[pad:pad + H2, pad:pad + W2] = book
img = Image.fromarray(np.clip(canvas, 0, 255).astype('uint8'))
cw, ch = img.size
dst = [(pad + 30, pad + 20), (pad + W2 - 10, pad - 10), (pad + W2 + 20, pad + H2 + 15), (pad - 15, pad + H2 - 5)]
img = img.resize((cw // 1, ch // 1)).filter(ImageFilter.GaussianBlur(0.6))
img.save('book_spread.jpg', quality=90)
json.dump({'spine': 0.5, 'size': [cw, ch], 'page_box': [pad, pad, pad + W2, pad + H2]}, open('book_spread.json', 'w'))

# ---------- wrinkled single page (already cropped: tests the flow field in isolation) ----------
P = text_page(1100, 1500, 'เอกสารยับ  Wrinkled page', 3)
h, w = P.shape[:2]
yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
wr = (14 * np.sin(xx / w * 2.3 * math.pi + yy / h * 1.2) + 9 * np.sin(xx / w * 5.1 * math.pi + 1.3) * np.cos(yy / h * 2.0 * math.pi)
      + 22 * ((xx / w - 0.5) * 2) ** 2)
wp = remap_vertical(P, wr)
light = 1 - 0.07 * np.cos(xx / w * 5.1 * math.pi + 1.3)
wp = wp * light[..., None]
Image.fromarray(np.clip(wp, 0, 255).astype('uint8')).save('wrinkled_page.png')
Image.fromarray(np.clip(P, 0, 255).astype('uint8')).save('wrinkled_page_truth.png')
print('ok', img.size)
