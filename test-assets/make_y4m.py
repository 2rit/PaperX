import numpy as np, sys
from PIL import Image
def y4m(src, out, W=960, H=1280, frames=20):
    im = Image.open(src).convert('RGB').resize((W, H))
    a = np.asarray(im).astype(float)
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    Y = 0.299 * R + 0.587 * G + 0.114 * B
    U = -0.168736 * R - 0.331264 * G + 0.5 * B + 128
    V = 0.5 * R - 0.418688 * G - 0.081312 * B + 128
    U = U.reshape(H // 2, 2, W // 2, 2).mean((1, 3)); V = V.reshape(H // 2, 2, W // 2, 2).mean((1, 3))
    planes = b''.join(np.clip(p, 0, 255).astype('uint8').tobytes() for p in (Y, U, V))
    with open(out, 'wb') as f:
        f.write(f'YUV4MPEG2 W{W} H{H} F30:1 Ip A1:1 C420jpeg\n'.encode())
        for _ in range(frames): f.write(b'FRAME\n' + planes)
y4m(sys.argv[1], sys.argv[2])
