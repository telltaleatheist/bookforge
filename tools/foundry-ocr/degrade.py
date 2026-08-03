"""How far does CER move when the page stops being pristine?

Renders the pilot pages at the app's own 200 dpi, damages the raster the way a
real scanner does, wraps each damaged page back into a PDF at the ORIGINAL page
size, and hands it to the same app OCR path. Page size is preserved on purpose:
the typesetter's word boxes are still valid, so the same geometry alignment
works and clean-vs-degraded CER is measured by identical machinery.
"""
import fitz, os, sys, json, io, math
import numpy as np
from PIL import Image, ImageFilter, ImageEnhance

DPI = 200
SCALE = DPI / 72

def render(page):
    pm = page.get_pixmap(matrix=fitz.Matrix(SCALE, SCALE), colorspace=fitz.csGRAY, alpha=False)
    return Image.frombytes('L', (pm.width, pm.height), pm.samples)

def jpeg(im, q):
    buf = io.BytesIO(); im.convert('L').save(buf, 'JPEG', quality=q)
    return Image.open(io.BytesIO(buf.getvalue())).convert('L')

def speckle(im, amount=0.01, sigma=10):
    a = np.asarray(im).astype(np.int16)
    rng = np.random.default_rng(7)
    a = a + rng.normal(0, sigma, a.shape).astype(np.int16)
    m = rng.random(a.shape)
    a[m < amount / 2] = 0
    a[m > 1 - amount / 2] = 255
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'L')

def contrast(im, black=70, white=205):
    a = np.asarray(im).astype(np.float32) / 255.0
    return Image.fromarray((black + a * (white - black)).astype(np.uint8), 'L')

def skew(im, deg):
    return im.rotate(deg, resample=Image.BICUBIC, fillcolor=255, expand=False)

def bleed(im, strength=0.10):
    back = im.transpose(Image.FLIP_LEFT_RIGHT).filter(ImageFilter.GaussianBlur(1.2))
    a = np.asarray(im).astype(np.float32)
    b = np.asarray(back).astype(np.float32)
    return Image.fromarray(np.clip(a * (1 - strength) + b * strength, 0, 255).astype(np.uint8), 'L')

VARIANTS = {
    'clean-reraster':  lambda im: im,
    'jpeg60':          lambda im: jpeg(im, 60),
    'jpeg30':          lambda im: jpeg(im, 30),
    'blur0.6':         lambda im: im.filter(ImageFilter.GaussianBlur(0.6)),
    'blur1.2':         lambda im: im.filter(ImageFilter.GaussianBlur(1.2)),
    'speckle':         lambda im: speckle(im, 0.012, 12),
    'lowcontrast':     lambda im: contrast(im, 75, 200),
    'skew0.4deg':      lambda im: skew(im, 0.4),
    'skew1.0deg':      lambda im: skew(im, 1.0),
    'bleedthrough':    lambda im: bleed(im, 0.12),
    'photocopy-combo': lambda im: jpeg(speckle(contrast(
        im.filter(ImageFilter.GaussianBlur(0.7)), 80, 195), 0.010, 10), 45),
}

if __name__ == '__main__':
    pdf, p0, n, outdir = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    os.makedirs(outdir, exist_ok=True)
    src = fitz.open(pdf)
    pages = list(range(p0, p0 + n))
    for name, fn in VARIANTS.items():
        out = fitz.open()
        for p in pages:
            page = src[p]
            im = fn(render(page))
            buf = io.BytesIO(); im.save(buf, 'PNG')
            np_ = out.new_page(width=page.rect.width, height=page.rect.height)
            np_.insert_image(fitz.Rect(0, 0, page.rect.width, page.rect.height),
                             stream=buf.getvalue())
        path = os.path.join(outdir, f'{name}.pdf')
        out.save(path, deflate=True)
        out.close()
        print(name, path, flush=True)
    json.dump({'pdf': pdf, 'pages': pages, 'variants': list(VARIANTS)},
              open(os.path.join(outdir, 'index.json'), 'w'))
