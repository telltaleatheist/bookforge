"""The degradation ladder, as MEASURED — render one variant of one page range.

degrade.py and its follow-up sweep answered "how far does CER move when the page
stops being pristine?" on one book (After the Reich, Bembo, pp.288-295, 8 pages).
This file is the production half of that answer: the recipes that survived the
sweep, each annotated with the CER it actually produced, so nothing here is a
guess about what a knob does.

Why the ladder matters at all: clean-render CER on born-digital PDFs is 0.449%
folded, and 66% of that is ligature/quote/case NORMALISATION. l/1/I confusion
happens once in 115,273 characters. A model trained on clean pages learns to be
a Unicode normaliser, not an OCR repairer. Degradation is the only way to make
the corpus carry the errors the model is supposed to fix.

Measured on the pilot (charCER / charCERFoldedCaseless / alignment):

    clean-reraster   1.240% / 0.415% / 98.0%   control: the re-raster round trip
    blur2.0          1.656% / 0.782% / 98.1%   right ERRORS (ss->w, e->c, li->h),
                                               but barely moves the rate
    speckle0.4       2.760% / 1.954% / 98.1%
    speckle0.8       4.240% / 3.454% / 98.0%
    combo-mild       6.626% / 5.780% / 96.9%   top of the usable band
    speckle2.5       9.181% / 8.366% / 98.1%   OVER the cap, see below
    speckle5.0      15.525% /14.561% / 97.4%   rejected
    blur3.0         44.493% /44.219% / 92.9%   rejected — cliffs at 3.0 px
    combo-med       26.653% /26.205% / 65.8%   rejected — alignment collapsed

Two hard facts came out of that sweep and both are enforced here:

  * OPTICAL damage is nearly free. jpeg8, 75 dpi, low contrast, 1 deg skew and
    bleed-through all land within noise of the clean re-raster (1.24-1.55%).
    Tesseract simply does not care. They are kept only as ingredients of the
    combo, never offered as a level of their own, because a level that does not
    move CER is a level that wastes an OCR run.
  * SPECKLE is the smooth knob. It is the only single operation whose CER is
    monotonic and controllable across the whole usable range.

STAY UNDER ~8% CER. Past that the geometry alignment itself starts to fail
(combo-med: 65.8% aligned), and a lost alignment loses the LABEL along with the
text — you do not get a hard sample, you get a wrong one. speckle2.5 is offered
but sits above the cap; it must be asked for by name and prints a warning.

    python3 degrade-render.py <pdf> <page0> <nPages> <level> <out.pdf>
    python3 degrade-render.py --list
"""
import fitz, os, sys, io
import numpy as np
from PIL import Image, ImageFilter

# The app renders at 200 dpi and Tesseract is pinned there (see dump-ocr.js).
# Degrading at any other scale would measure the rescale, not the damage.
DPI = 200
SCALE = DPI / 72

# One RNG seed for the whole corpus. Speckle is the knob we are calibrating, so
# it has to be reproducible: two runs of the same book at the same level must
# produce the same pairs, or a re-mine silently changes the measurement.
SEED = 7


def render(page):
    pm = page.get_pixmap(matrix=fitz.Matrix(SCALE, SCALE),
                         colorspace=fitz.csGRAY, alpha=False)
    return Image.frombytes('L', (pm.width, pm.height), pm.samples)


def jpeg(im, q):
    buf = io.BytesIO()
    im.convert('L').save(buf, 'JPEG', quality=q)
    return Image.open(io.BytesIO(buf.getvalue())).convert('L')


def speckle(im, amount, sigma):
    """Gaussian sensor noise plus salt-and-pepper dropout — a photocopier's
    toner scatter. `amount` is the fraction of pixels driven fully to 0 or 255."""
    a = np.asarray(im).astype(np.int16)
    rng = np.random.default_rng(SEED)
    a = a + rng.normal(0, sigma, a.shape).astype(np.int16)
    m = rng.random(a.shape)
    a[m < amount / 2] = 0
    a[m > 1 - amount / 2] = 255
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'L')


def contrast(im, black, white):
    """Compress the dynamic range: a scan of a grey page with grey-ish ink."""
    a = np.asarray(im).astype(np.float32) / 255.0
    return Image.fromarray((black + a * (white - black)).astype(np.uint8), 'L')


def downres(im, dpi):
    """Scan at a lower optical resolution, then upsample back — the commonest
    real defect, and the one plain blur only imitates."""
    w, h = im.size
    s = dpi / DPI
    return (im.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
              .resize((w, h), Image.LANCZOS))


# Recipes, keyed by the name used in the output filenames and in the `source`
# field of every row. Changing a recipe under an existing name would make two
# incompatible corpora share a label, so add a new name instead.
LADDER = {
    # Control. Answers "what does the render->PDF->OCR round trip cost by
    # itself", which is the floor every other number here sits on.
    'clean-reraster': lambda im: im,

    # Produces the RIGHT confusions (ss->w, e->c, li->h) but hardly moves the
    # rate. Useful as a low-CER, high-realism variant; not as the main supply.
    'blur2.0': lambda im: im.filter(ImageFilter.GaussianBlur(2.0)),

    'speckle0.4': lambda im: speckle(im, 0.004, 8),
    'speckle0.8': lambda im: speckle(im, 0.008, 10),

    # INTERPOLATED between speckle0.8 (4.24%) and speckle2.5 (9.18%), assuming
    # the local response is roughly linear in `amount`. NOT measured. If you use
    # it, read the CER it actually produced out of the stats file rather than
    # trusting this comment.
    'speckle1.5': lambda im: speckle(im, 0.015, 12),

    # Above the 8% cap on the pilot book. Kept because the cap is about where
    # ALIGNMENT breaks and speckle2.5's alignment was still 98.1% — but a book
    # with tighter leading may not be so lucky, so this warns.
    'speckle2.5': lambda im: speckle(im, 0.025, 14),

    # The realistic photocopy: slight blur, flattened contrast, sensor noise,
    # lossy compression. Highest CER that kept alignment above 96%.
    'combo-mild': lambda im: jpeg(speckle(contrast(
        im.filter(ImageFilter.GaussianBlur(0.5)), 90, 190), 0.004, 8), 55),
}

# Levels whose pilot CER exceeded the alignment-safety cap. Not refused — asked
# for by name, with the reason printed.
OVER_CAP = {'speckle2.5': 0.0918}


def main():
    if '--list' in sys.argv:
        for k in LADDER:
            print(k)
        return
    if len(sys.argv) != 6:
        sys.exit(__doc__.strip().splitlines()[-2].strip())
    pdf_path, p0, n, level, out_path = (sys.argv[1], int(sys.argv[2]),
                                        int(sys.argv[3]), sys.argv[4], sys.argv[5])
    if level not in LADDER:
        sys.exit(f'degrade-render: unknown level {level!r}. '
                 f'Legal levels: {", ".join(LADDER)}')
    if level in OVER_CAP:
        print(f'degrade-render: !! {level} measured {OVER_CAP[level]*100:.2f}% CER on the '
              'pilot, above the ~8% cap where geometry alignment starts losing labels. '
              'Check alignmentRate in the stats before using its pairs.',
              file=sys.stderr)

    src = fitz.open(pdf_path)
    if p0 < 0 or p0 + n > src.page_count:
        sys.exit(f'degrade-render: pages {p0}..{p0+n-1} do not exist in a '
                 f'{src.page_count}-page PDF')
    fn = LADDER[level]
    out = fitz.open()
    for p in range(p0, p0 + n):
        page = src[p]
        im = fn(render(page))
        buf = io.BytesIO()
        im.save(buf, 'PNG')
        # The wrapper page keeps the ORIGINAL page size on purpose: the
        # typesetter's word boxes are still valid in those coordinates, so the
        # same geometry alignment runs against the untouched source text layer.
        # Only the page NUMBER shifts, which is what align-pairs.py's OFFSET is.
        np_ = out.new_page(width=page.rect.width, height=page.rect.height)
        np_.insert_image(fitz.Rect(0, 0, page.rect.width, page.rect.height),
                         stream=buf.getvalue())
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    out.save(out_path, deflate=True)
    out.close()
    print(f'degrade-render: {level} pages {p0}-{p0+n-1} -> {out_path}', file=sys.stderr)


if __name__ == '__main__':
    main()
