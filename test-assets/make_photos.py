"""Generate realistic 'phone photos' of a document: perspective skew, wood background, shadow, curl.
Writes JPEGs + ground-truth corner JSON."""
import json, math, random
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

random.seed(3); np.random.seed(3)
R = 'plexthai.ttf'; B = 'plexthai-b.ttf'
W, H = 1240, 1754

def document():
    im = Image.new('RGB', (W, H), (250, 250, 246))
    d = ImageDraw.Draw(im)
    d.text((110, 110), 'PAPERX', font=ImageFont.truetype(B, 110), fill=(25, 25, 25))
    d.text((110, 240), 'Document Scanner', font=ImageFont.truetype(B, 60), fill=(35, 35, 35))
    f = ImageFont.truetype(R, 44)
    lines = ['สแกนเอกสารได้อย่างรวดเร็ว', 'ด้วยเทคโนโลยีการปรับภาพขั้นสูง', 'รองรับภาษาไทยและอังกฤษ', 'พร้อมส่งออกในรูปแบบ PDF',
             'Scan documents quickly and', 'export them as high quality PDF.']
    y = 380
    for ln in lines:
        d.text((110, y), ln, font=f, fill=(30, 30, 30)); y += 78
    # chart
    for i, h in enumerate([120, 190, 260, 330]):
        d.rectangle((760 + i * 95, 1330 - h, 820 + i * 95, 1330), fill=(90, 90, 90))
    fs = ImageFont.truetype(R, 34)
    for i in range(5):
        d.text((110, 1000 + i * 62), 'รายการที่ %d  Item number %d' % (i + 1, i + 1), font=fs, fill=(60, 60, 60))
    for i in range(4):
        d.rectangle((110, 1420 + i * 50, 1130 - (i % 2) * 200, 1440 + i * 50), fill=(150, 150, 150))
    return im

def wood(w, h):
    x = np.linspace(0, 1, w)[None, :]; y = np.linspace(0, 1, h)[:, None]
    grain = np.sin((x * 40 + np.sin(y * 9) * 1.5) * math.pi) * 0.5 + 0.5
    base = np.stack([120 + 50 * grain, 80 + 35 * grain, 45 + 20 * grain], -1)
    base += np.random.normal(0, 6, base.shape)
    return Image.fromarray(np.clip(base, 0, 255).astype('uint8'))

def coeffs(dst, src):
    # PIL PERSPECTIVE maps output(dst) -> input(src)
    A = []; bvec = []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); bvec.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); bvec.append(v)
    return np.linalg.solve(np.array(A, float), np.array(bvec, float)).tolist()

def curl(doc, amount):
    """bend page like a book page: whole page (incl. its edges) displaced vertically by a sine profile"""
    a = np.array(doc.convert('RGBA')); h, w = a.shape[:2]
    A = abs(amount)
    out = np.zeros((h + 2 * A, w, 4), dtype=np.uint8)
    for x in range(w):
        dy = A + int(amount * math.sin(math.pi * x / w))
        out[dy:dy + h, x] = a[:, x]
    return Image.fromarray(out, 'RGBA')

def photo(name, corners, shadow=True, bend=0, size=(2000, 2600)):
    doc = document().convert('RGBA')
    if bend: doc = curl(doc, bend)
    bg = wood(*size)
    dw, dh = doc.size
    src = [(0, 0), (dw, 0), (dw, dh), (0, dh)]
    warped = doc.transform(size, Image.PERSPECTIVE, coeffs(corners, src), Image.BICUBIC)
    mask = warped.split()[3]
    warped = warped.convert('RGB')
    # soft drop shadow
    sh = mask.filter(ImageFilter.GaussianBlur(25)).point(lambda v: v * 0.45)
    dark = Image.new('RGB', size, (20, 12, 5))
    bg = Image.composite(dark, bg, sh.transform(size, Image.AFFINE, (1, 0, -18, 0, 1, -22)))
    bg.paste(warped, (0, 0), mask)
    a = np.asarray(bg).astype(float)
    if shadow:  # hand/phone shadow: darkening gradient across one side + blob
        yy, xx = np.mgrid[0:size[1], 0:size[0]]
        g = 1 - 0.45 * np.clip((xx / size[0] - 0.45) * 2.2, 0, 1) * np.clip(1 - yy / size[1] * 0.6, 0, 1)
        blob = 1 - 0.3 * np.exp(-(((xx - size[0] * 0.3) / 380) ** 2 + ((yy - size[1] * 0.75) / 300) ** 2))
        a *= (g * blob)[..., None]
    a *= np.array([1.03, 1.0, 0.9])  # warm cast
    a += np.random.normal(0, 3, a.shape)
    im = Image.fromarray(np.clip(a, 0, 255).astype('uint8')).filter(ImageFilter.GaussianBlur(1.1))
    im.save(name + '.jpg', quality=90)
    json.dump({'corners': [{'x': x / size[0], 'y': y / size[1]} for x, y in corners]}, open(name + '.json', 'w'))
    print('wrote', name)

photo('skewed_shadow', [(330, 360), (1640, 470), (1760, 2240), (220, 2330)])
photo('curved', [(300, 330), (1700, 330), (1740, 2290), (260, 2290)], shadow=True, bend=-110)
photo('rotated', [(520, 300), (1820, 760), (1400, 2420), (130, 1960)], shadow=False)
document().save('flat_doc.png')
