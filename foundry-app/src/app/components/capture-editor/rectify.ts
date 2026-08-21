/**
 * The projective rectify — ONE transform, drawn twice.
 *
 * ── Why this is a module and not a method on the editor ─────────────────────
 *
 * docs/CAPTURE.md rules that the live preview and the mint are "one shader, not
 * two implementations", and this file is where that promise becomes checkable.
 * The editor draws a quad being dragged; the mint draws the same quad at full
 * resolution minutes later. If those were two bodies of code, the picture in
 * front of the person choosing the corners would be a PROMISE about the page
 * they are going to get rather than the page itself, and the day the two drifted
 * nobody would find out until a book had been minted crooked.
 *
 * So: one entry point, called by both, and the only thing that differs between
 * the two calls is the size of the output.
 *
 * ── What "rectify" means here, exactly ──────────────────────────────────────
 *
 * The four corners the user dragged are a QUADRILATERAL on the photograph — the
 * page, seen from a camera held at an angle, so its edges converge. The output
 * is an upright rectangle. The map between them is a projective transform (a
 * homography), which is the one family of maps that can straighten converging
 * edges; an affine transform cannot, which is why rotate/scale/skew would leave
 * the keystone in. Tilt, keystone and crop are resolved in this single sampling
 * step, which is also why the recipe has no rotation field to disagree with the
 * corner order (docs/CAPTURE.md, "Conventions, pinned").
 *
 * ── Why WebGL rather than 2d canvas ─────────────────────────────────────────
 *
 * A 2d context can only do affine (`setTransform` takes six numbers, not eight),
 * so a projective warp there means resampling per pixel in JavaScript: seconds
 * per page against milliseconds here, on a mint that runs to hundreds of pages.
 * The doc's own reasoning, recorded there under "Where the work runs".
 *
 * ── ONE CONTEXT, REUSED, AND THAT IS THE LOAD-BEARING DECISION ──────────────
 *
 * Browsers cap live WebGL contexts (Chromium's limit is in the low tens) and
 * drop the OLDEST when a new one exceeds it. A rectifier per card would mean
 * twenty-seven contexts for one shoot, the first ones dying silently as the last
 * ones open, and the failure presents as blank cards rather than as an error.
 * So a `Rectifier` owns exactly one canvas, one context and one compiled
 * program, and callers hold ONE of them for as long as they are drawing.
 *
 * ── This file knows nothing about the recipe ────────────────────────────────
 *
 * `Quad` below is declared here rather than imported from `shared/types` on
 * purpose: the recipe shape is P1's to land (docs/CAPTURE.md, work packages),
 * and a geometry routine that imported it could not be written until it had.
 * The two are structurally identical — four [x, y] pairs in ORIGINAL-IMAGE
 * PIXELS, ordered top-left, top-right, bottom-right, bottom-left of the OUTPUT
 * page — and when the recipe type lands this stays assignable to it. If it ever
 * stops being assignable, that is the contract having changed and it should be
 * an error here rather than a silent reinterpretation of somebody's corners.
 */

/** A point on the SOURCE image, in that image's own pixels. */
export type Point = readonly [number, number];

/**
 * The four corners, in the order the recipe pins: top-left, top-right,
 * bottom-right, bottom-left OF THE OUTPUT PAGE.
 *
 * THE ORDER IS THE ORIENTATION. Rotating a page is permuting this tuple, which
 * is why there is no angle anywhere in this file — a quarter turn is the same
 * four points listed starting one place further along.
 */
export type Quad = readonly [Point, Point, Point, Point];

/** What a rectify produced, and whether it is the whole truth. */
export interface Rectified {
  /**
   * The canvas holding the rectified page. It is the Rectifier's OWN canvas,
   * reused by the next call — encode it or draw it before you call again.
   */
  readonly canvas: HTMLCanvasElement;
  /**
   * FALSE when any corner fell outside the source image.
   *
   * ── Why this is returned rather than thrown, or ignored ─────────────────────
   *
   * Sampling outside the texture clamps to the edge pixel, so an out-of-bounds
   * quad does not fail — it produces a page with a smeared border, which looks
   * like a bad photograph rather than like a bug. That silence is a real hazard
   * for "apply to all": the doc copies one quad onto every photo, and a photo of
   * different dimensions (a late drop, a turned camera) can take a quad that
   * does not fit it.
   *
   * The caller decides what to do — the editor can say so beside the card, the
   * mint can refuse — but nobody can decide anything about a fact they were
   * never told, so this is the one thing the transform reports about itself.
   */
  readonly withinSource: boolean;
}

/** The homography, column-major for `uniformMatrix3fv`. */
type Matrix3 = Float32Array;

const VERTEX_SOURCE = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  // Clip space to the OUTPUT PAGE's own coordinates, y downward: (0,0) is the
  // top-left of the page, which is the corner the quad's first point names.
  vUV = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAGMENT_SOURCE = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform mat3 uH;
uniform vec2 uSrcSize;
void main() {
  // The homography maps the output page onto the photograph. The divide by z is
  // what makes it projective rather than affine, and it is the whole reason the
  // converging edges of a tilted page come out parallel.
  vec3 p = uH * vec3(vUV, 1.0);
  vec2 sourcePixel = p.xy / p.z;
  gl_FragColor = texture2D(uTex, sourcePixel / uSrcSize);
}
`;

/**
 * Anything that can be uploaded as a texture — an `ImageBitmap` from
 * `createImageBitmap`, or an `<img>` that has finished decoding.
 */
export type RectifySource = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

export class Rectifier {
  private readonly canvasElement: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly positions: WebGLBuffer;
  private readonly uH: WebGLUniformLocation;
  private readonly uSrcSize: WebGLUniformLocation;
  private readonly mipmapAllowed: boolean;
  private disposed = false;

  constructor() {
    this.canvasElement = document.createElement('canvas');

    /*
     * `preserveDrawingBuffer` because the mint READS THIS BACK. Without it the
     * drawing buffer may be cleared as soon as the call stack unwinds, and
     * `toBlob` on the next tick returns a blank page — intermittently, because
     * whether it survives depends on compositing. The cost is a copy per frame,
     * which is nothing against a mint that JPEG-encodes the same pixels anyway.
     *
     * `alpha: false` and `premultipliedAlpha: false`: a page is opaque, and an
     * alpha channel here would only travel as far as the JPEG that discards it.
     * `desynchronized` is deliberately NOT set — it trades readback correctness
     * for latency, and this canvas exists to be read back.
     */
    const options: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    };

    /*
     * WebGL2 first, only for its NPOT mipmaps. A 12 MP photograph drawn into a
     * card two hundred pixels wide is a 20:1 minification, and a single bilinear
     * tap at that ratio samples one source pixel in four hundred: the card
     * shimmers as it is dragged and fine print turns to noise. Mipmaps fix it,
     * and WebGL1 may only build them for power-of-two textures, which no camera
     * produces. WebGL1 still works — it just draws a rougher thumbnail — so this
     * is a quality fallback, not a capability gate.
     */
    const gl2 = this.canvasElement.getContext('webgl2', options);
    const gl = gl2 ?? this.canvasElement.getContext('webgl', options);
    if (gl === null) {
      throw new Error('This window has no WebGL context, so photographs cannot be rectified.');
    }
    this.gl = gl as WebGLRenderingContext;
    this.mipmapAllowed = gl2 !== null;

    this.program = this.link(VERTEX_SOURCE, FRAGMENT_SOURCE);

    const uH = this.gl.getUniformLocation(this.program, 'uH');
    const uSrcSize = this.gl.getUniformLocation(this.program, 'uSrcSize');
    if (uH === null || uSrcSize === null) {
      throw new Error('The rectify shader linked without its uniforms.');
    }
    this.uH = uH;
    this.uSrcSize = uSrcSize;

    const positions = this.gl.createBuffer();
    const texture = this.gl.createTexture();
    if (positions === null || texture === null) {
      throw new Error('WebGL refused a buffer for the rectify.');
    }
    this.positions = positions;
    this.texture = texture;

    // Two triangles covering clip space. The geometry never changes — every
    // rectify is the same rectangle with a different matrix behind it.
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positions);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      this.gl.STATIC_DRAW,
    );

    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    // CLAMP_TO_EDGE on both axes: a quad that strays outside the photograph
    // smears its border pixel rather than wrapping the far edge of the image
    // into the page. `withinSource` is how the caller learns it happened.
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
  }

  /**
   * Draw `source`'s `quad` as an upright `outWidth` x `outHeight` page.
   *
   * The output size is the caller's: the mint takes it from `capture:mint-begin`
   * (main computes the page list, and the renderer renders exactly that list),
   * and the editor passes whatever its preview box is. Nothing here scales,
   * fits or letterboxes — the quad becomes the whole rectangle, which is what
   * makes the preview and the minted page the same picture at two sizes.
   */
  rectify(source: RectifySource, quad: Quad, outWidth: number, outHeight: number): Rectified {
    if (this.disposed) throw new Error('This rectifier has been disposed.');
    const width = Math.max(1, Math.round(outWidth));
    const height = Math.max(1, Math.round(outHeight));
    const { gl } = this;

    const sourceWidth = sourceWidthOf(source);
    const sourceHeight = sourceHeightOf(source);
    if (sourceWidth === 0 || sourceHeight === 0) {
      throw new Error('That photograph has no pixels yet, so it cannot be rectified.');
    }

    this.canvasElement.width = width;
    this.canvasElement.height = height;
    gl.viewport(0, 0, width, height);

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    /*
     * No `UNPACK_FLIP_Y_WEBGL`, deliberately. Left alone, row zero of the image
     * lands at t = 0, so a texture coordinate computed from a pixel row counted
     * DOWNWARD from the top — which is how every coordinate in the recipe is
     * counted — addresses the row it names. Flipping here would mean flipping
     * back in the shader, and the two would eventually disagree.
     */
    if (this.mipmapAllowed) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.useProgram(this.program);
    const aPos = gl.getAttribLocation(this.program, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positions);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.uniformMatrix3fv(this.uH, false, homography(quad));
    gl.uniform2f(this.uSrcSize, sourceWidth, sourceHeight);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    return {
      canvas: this.canvasElement,
      withinSource: quad.every(
        ([x, y]) => x >= 0 && y >= 0 && x <= sourceWidth && y <= sourceHeight,
      ),
    };
  }

  /** Release the context's objects. A disposed rectifier refuses to draw. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteTexture(this.texture);
    this.gl.deleteBuffer(this.positions);
    this.gl.deleteProgram(this.program);
    // Chromium frees the context when the canvas is collected; this asks for it
    // now, because a rectifier is disposed precisely when its pane is closing
    // and the next one wants the slot.
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private link(vertexSource: string, fragmentSource: string): WebGLProgram {
    const { gl } = this;
    const program = gl.createProgram();
    if (program === null) throw new Error('WebGL refused a program for the rectify.');
    const vertex = this.compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = this.compile(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    // The shaders are attached to the linked program and no longer needed on
    // their own; deleting them here is what keeps a long-lived context from
    // accumulating one pair per rectifier.
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? 'no reason given';
      gl.deleteProgram(program);
      throw new Error(`The rectify shader did not link: ${log}`);
    }
    return program;
  }

  private compile(type: number, source: string): WebGLShader {
    const { gl } = this;
    const shader = gl.createShader(type);
    if (shader === null) throw new Error('WebGL refused a shader for the rectify.');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? 'no reason given';
      gl.deleteShader(shader);
      throw new Error(`The rectify shader did not compile: ${log}`);
    }
    return shader;
  }
}

function sourceWidthOf(source: RectifySource): number {
  return source instanceof HTMLImageElement ? source.naturalWidth : source.width;
}

function sourceHeightOf(source: RectifySource): number {
  return source instanceof HTMLImageElement ? source.naturalHeight : source.height;
}

/**
 * The homography taking the OUTPUT PAGE's unit square onto the quad, as a
 * column-major mat3.
 *
 * ── Closed form rather than a solver ────────────────────────────────────────
 *
 * Mapping a unit square onto four arbitrary points is the one case of the
 * eight-unknown projective fit that has a closed form (Heckbert, *Fundamentals
 * of Texture Mapping and Image Warping*, 1989, §2.2), because three of the four
 * source corners are 0 or 1. A general four-point fit needs an 8x8 solve; this
 * needs a dozen multiplies and cannot fail to converge. It is also exactly
 * invertible in the affine case, which is the case a straight-on shot produces
 * and the one where a numerical solver would leave a fraction of a pixel of
 * skew in a page that had none.
 *
 * The corners arrive in the recipe's pinned order — top-left, top-right,
 * bottom-right, bottom-left of the output — which is (0,0), (1,0), (1,1), (0,1)
 * of the unit square, in that order.
 */
function homography(quad: Quad): Matrix3 {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;

  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;

  let a: number;
  let b: number;
  let d: number;
  let e: number;
  let g: number;
  let h: number;

  if (dx3 === 0 && dy3 === 0) {
    // The quad is a parallelogram — a straight-on shot, or a pure crop. The
    // projective terms are exactly zero rather than nearly zero, so the shader's
    // divide is by one and the page comes out with no residual keystone.
    a = x1 - x0;
    b = x2 - x1;
    d = y1 - y0;
    e = y2 - y1;
    g = 0;
    h = 0;
  } else {
    const denominator = dx1 * dy2 - dx2 * dy1;
    if (denominator === 0) {
      // Three corners collinear, or two coincident: there is no page here. The
      // editor should never hand this over, so it is an error rather than a
      // degenerate draw that would look like a rendering bug.
      throw new Error('Those four corners do not enclose a page.');
    }
    g = (dx3 * dy2 - dx2 * dy3) / denominator;
    h = (dx1 * dy3 - dx3 * dy1) / denominator;
    a = x1 - x0 + g * x1;
    b = x3 - x0 + h * x3;
    d = y1 - y0 + g * y1;
    e = y3 - y0 + h * y3;
  }

  // Column-major, because `uniformMatrix3fv` is given `transpose = false` — the
  // only form WebGL1 accepts, so the layout is decided here rather than there.
  return new Float32Array([a, d, g, b, e, h, x0, y0, 1]);
}
