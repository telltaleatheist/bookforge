import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import { componentManager } from './components/component-manager';
import { getComponent } from './components/component-catalog';

/**
 * Tesseract is always spawned ASYNCHRONOUSLY, with an ARGUMENT ARRAY.
 *
 * Asynchronously, because `execSync` here blocks the Electron MAIN process for
 * the whole run — a second or three per page — and while main is blocked it
 * services no IPC at all. The renderer keeps painting, so it does not look like
 * a freeze; page renders, saves and autosave simply stall, which reads as the UI
 * partially hanging while OCR runs. Multiply by 400 pages.
 *
 * With an argument array, because the default Windows install path is
 * `C:\Program Files\Tesseract-OCR\tesseract.exe` and the tessdata directory
 * beside it carries the same space. Interpolating either into a command line
 * hands cmd.exe `C:\Program` as the program name, so a perfectly good install
 * reports itself as MISSING and the picker refuses to run OCR while Settings
 * (which detects it a different way) says it is installed.
 *
 * That second rule is why node-tesseract-ocr no longer spawns anything here: its
 * `recognize()` joins the binary, the input path and every option into a single
 * UNQUOTED shell string and hands it to `exec`, so it can express neither a
 * binary nor a `--tessdata-dir` containing a space. Every invocation below is an
 * explicit execFile with an argument array instead.
 */
const execFileAsync = promisify(execFile);

/**
 * The one render resolution the whole OCR path uses, in dpi.
 *
 * Every label in the training corpus is defined against Tesseract's paragraph
 * segmentation at 200 dpi, and that segmentation MOVES with resolution — so a
 * caller that renders at some other dpi produces different blocks and silently
 * invalidates the labels keyed to them. Anything that rasterises a page for OCR
 * renders at this number and passes it through as user_defined_dpi.
 *
 * Declared in `shared/ocr/ocr-render.ts` and re-exported here, so the picker uses
 * the same constant instead of the hand-kept mirror it used to carry. It is
 * re-exported rather than moved because `cli/ocr-pdf.js` and `headless-ocr.ts`
 * already read it from this module.
 */
export { OCR_DPI, OCR_RENDER_SCALE } from '../shared/ocr/ocr-render';
import { OCR_DPI } from '../shared/ocr/ocr-render';

/** LSTM OCR engine — the only engine that reports the hOCR metrics we parse. */
const OEM_LSTM = 1;
/** Fully automatic page segmentation, with orientation/script detection. */
const PSM_AUTO = 3;
/** Orientation and script detection ONLY (no recognition). */
const PSM_OSD_ONLY = 0;
/**
 * The "language" of the orientation-and-script model. OSD reads
 * osd.traineddata, NOT the page language's file, and it is a legacy-only model:
 * `-l eng --psm 0` fails outright with "OSD requires a model for the legacy
 * engine", and adding `--oem 1` makes it warn "LSTM requested, but not
 * present!!". So the OSD pass uses this language and no --oem at all.
 */
const OSD_LANG = 'osd';

/** The component id BOTH Settings and this service resolve Tesseract through. */
const TESSERACT_COMPONENT_ID = 'tesseract';

/**
 * Env var naming a directory of traineddata files, following the convention
 * BOOKFORGE_LEGACY_TESSDATA already established for the legacy-engine data.
 */
const TESSDATA_ENV_VAR = 'BOOKFORGE_TESSDATA';

/**
 * The tessdata directories a Tesseract install keeps relative to its binary.
 *
 * Windows and scoop keep tessdata in the install directory itself; the Unix
 * package layouts put it under `../share` — Homebrew as `share/tessdata`,
 * Debian/Ubuntu as `share/tesseract-ocr/<version>/tessdata`. The versioned
 * directory is READ rather than guessed, because which version numbers exist
 * differs per distro release.
 */
function tessdataDirsBesideBinary(binary: string): string[] {
  const binDir = path.dirname(binary);
  const shareDir = path.join(binDir, '..', 'share');
  const dirs = [path.join(binDir, 'tessdata'), path.join(shareDir, 'tessdata')];
  const versioned = path.join(shareDir, 'tesseract-ocr');
  try {
    for (const entry of fs.readdirSync(versioned)) {
      dirs.push(path.join(versioned, entry, 'tessdata'));
    }
  } catch {
    // Not this layout — nothing to add.
  }
  return dirs;
}

// Declared in `shared/ocr/ocr-render`'s neighbour `shared/ocr/ocr-line.ts` and
// re-exported here. The OCR post-processor — shared with the renderer — consumes
// exactly this shape, so it is one declaration rather than one per program.
export type { OcrTextLine } from '../shared/ocr/ocr-line';
import type { OcrTextLine } from '../shared/ocr/ocr-line';

export interface OcrParagraph {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];  // [x1, y1, x2, y2]
  lineCount: number;
  blockNum: number;  // Tesseract block number
  parNum: number;    // Paragraph number within block
}

export interface OcrResult {
  text: string;
  confidence: number;
  textLines?: OcrTextLine[];  // Individual lines with bounding boxes
  paragraphs?: OcrParagraph[];  // Paragraphs grouped by Tesseract's layout analysis
}

export interface DeskewResult {
  angle: number;  // Rotation angle in degrees (negative = clockwise correction needed)
  confidence: number;
}

export interface OcrServiceConfig {
  lang?: string;  // Language code (default: 'eng')
  /**
   * Path to the tesseract binary. When given it WINS over component resolution —
   * this is the "the caller pointed straight at it" escape hatch. Omit it and the
   * binary comes from the component system (see resolveBinaryDetail).
   */
  tesseractPath?: string;
  /**
   * Directory of traineddata files. Same escape hatch, for language data: given,
   * it is the first place searched. Omit it and the directory is resolved (see
   * resolveTessdataDetail).
   */
  tessdataDir?: string;
  /**
   * True resolution of the images this service will be handed, in dpi.
   *
   * Passed to Tesseract as user_defined_dpi. Must match what the caller actually
   * rendered — the point is to stop Tesseract guessing, so a wrong value here is
   * worse than none. 200 matches the training corpus and OCR_RENDER_SCALE in the
   * picker; see the note on OCR_DPI there.
   */
  dpi?: number;
  /**
   * Run the OpenCV pass (denoise / contrast / binarize) before Tesseract.
   *
   * OFF by default, which was measured rather than assumed — on two scanned
   * books, 20 pages each, it ranged from useless to actively destructive:
   *
   *   Kritz (sturdy type, greyscale scan)
   *     mean confidence +0.0006, total characters +1 — no improvement at all —
   *     while costing 6 of 156 paragraph blocks and moving 33% of the surviving
   *     bounding boxes.
   *   Hayner (fine high-contrast serif, clean 357 dpi scan)
   *     mean confidence 0.9395 -> 0.7685, text visibly wrecked ("Despite the
   *     intense pressures" -> "eat.*e the intense pressures"), and segmentation
   *     fragmented by 20% (152 -> 182 blocks).
   *
   * Binarizing thins already-thin strokes until Tesseract misreads them, and it
   * changes the pixels the layout analysis measures — so it moves segmentation
   * away from the raw-render boundaries every training label is keyed to. Paying
   * that for negative accuracy is a bad trade twice over.
   *
   * It stays available for the case it was presumably written for — highlighter,
   * heavy noise, bleed-through — where the trade may genuinely invert. But the
   * caller has to ask, and should check the confidence both ways before
   * believing it helped.
   */
  preprocess?: boolean;
}

/**
 * Everything the UI needs to explain OCR's state — not just a bare boolean.
 *
 * "Not installed" was shown for an install that was present but had no language
 * data, which is a completely different problem with a completely different fix.
 * Both halves are reported separately so the renderer can say which one is
 * missing.
 */
export interface OcrAvailability {
  /** True only when a binary, a tessdata dir AND the configured language exist. */
  available: boolean;
  /** Tesseract's own version string, or null when it could not be run. */
  version: string | null;
  /** The resolved binary, or null when none could be located. */
  binaryPath: string | null;
  /** The resolved traineddata directory, or null when none qualified. */
  tessdataDir: string | null;
  /** The language OCR will actually run with. */
  lang: string;
  /** Languages present in the resolved directory, or null when unknown. */
  languages: string[] | null;
  /** One short sentence naming what is wrong. Null when available. */
  reason: string | null;
  /** The full diagnostic — every path searched. Null when available. */
  detail: string | null;
}

/**
 * OCR Service - Provides OCR and deskew detection using Tesseract
 */
export class OcrService {
  private readonly options: OcrServiceConfig;
  /**
   * Language code every invocation is made with (`-l`). Fixed at construction:
   * callers that need a second language construct a second service (see
   * headless-ocr's serviceFor), which keeps the per-language tessdata cache below
   * honest and stops two languages sharing one instance.
   */
  private readonly lang: string;
  /** See OcrServiceConfig.dpi. */
  private readonly dpi: number;
  /** See OcrServiceConfig.preprocess. */
  private readonly preprocess: boolean;

  /** Cached POSITIVE binary resolution (see resolveBinaryDetail). */
  private resolvedBinary: string | null = null;
  /** Cached POSITIVE tessdata resolution, per language. */
  private readonly resolvedTessdata = new Map<string, string>();

  constructor(options: OcrServiceConfig = {}) {
    this.options = options;
    this.lang = options.lang || 'eng';
    // OCR_DPI, not a second literal 200: the corpus labels are keyed to
    // Tesseract's segmentation at that resolution, so the two must not drift.
    this.dpi = options.dpi ?? OCR_DPI;
    this.preprocess = options.preprocess ?? false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Resolution — ONE authority for the binary, ONE for the language data
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The Tesseract binary, resolved through the SAME seam Settings uses, plus the
   * places that were searched when nothing was found.
   *
   * There used to be a second, hardcoded candidate list here, and it disagreed
   * with the component system: on a machine with both a scoop Tesseract on PATH
   * and the Program Files install, Settings resolved the scoop one and this
   * service resolved the other, so Settings reported Tesseract installed while
   * the picker reported it missing. The candidate paths now live in ONE place —
   * the component catalog's `detect.candidates` — and both readers go through
   * `componentManager`.
   *
   * `resolveEntry()` is synchronous but reads only the recorded manifest, so it
   * returns null until the component has been detected once. `getStatus()` IS
   * that detection pass (env var → PATH → the catalog's platform candidates) and
   * it records a hit, so every later lookup is the cheap synchronous one. Hence
   * lazy async resolution rather than a constructor probe.
   */
  private async resolveBinaryDetail(): Promise<{ path: string | null; searched: string[] }> {
    if (this.options.tesseractPath) {
      // Explicit wins — but it does not get to be silently WRONG. A path that
      // isn't there would otherwise reach spawn and surface as a raw ENOENT, and
      // a bare command name here would be the "assume it's on PATH" guess this
      // service exists to remove.
      if (!fs.existsSync(this.options.tesseractPath)) {
        return {
          path: null,
          searched: [`the configured tesseractPath ${this.options.tesseractPath} (does not exist)`],
        };
      }
      return { path: this.options.tesseractPath, searched: [] };
    }
    if (this.resolvedBinary) {
      return { path: this.resolvedBinary, searched: [] };
    }

    let entry = componentManager.resolveEntry(TESSERACT_COMPONENT_ID);
    if (!entry) {
      await componentManager.getStatus(TESSERACT_COMPONENT_ID);
      entry = componentManager.resolveEntry(TESSERACT_COMPONENT_ID);
    }
    // Only HITS are cached: a Tesseract installed while the app is running is then
    // picked up on the next attempt instead of needing a restart.
    if (entry) {
      this.resolvedBinary = entry;
      return { path: entry, searched: [] };
    }
    return { path: null, searched: this.binarySearchDescription() };
  }

  /**
   * Every place the component system looked for the binary, for the error
   * message. Read off the catalog so the message can never drift from the search.
   */
  private binarySearchDescription(): string[] {
    const detect = getComponent(TESSERACT_COMPONENT_ID)?.detect;
    if (!detect) {
      throw new Error(
        `The "${TESSERACT_COMPONENT_ID}" component has no detect spec in the component catalog, ` +
        `so there is nothing to search. This is a catalog bug, not a missing install.`
      );
    }
    const out: string[] = [];
    if (detect.envVar) out.push(`$${detect.envVar}`);
    for (const name of detect.commandNames ?? []) out.push(`"${name}" on PATH`);
    for (const cand of detect.candidates ?? []) {
      if (cand.platform === process.platform) out.push(cand.path);
    }
    return out;
  }

  /** The resolved binary, or a loud error naming everywhere that was searched. */
  private async requireBinary(): Promise<string> {
    const { path: binary, searched } = await this.resolveBinaryDetail();
    if (binary) return binary;
    throw new Error(
      `No Tesseract OCR binary could be located. Searched: ${searched.join('; ')}. ` +
      `Install or locate Tesseract in Settings → Add-ons.`
    );
  }

  /**
   * The directory holding `<lang>.traineddata`, plus every directory searched.
   *
   * Tesseract normally finds traineddata through the GLOBAL `TESSDATA_PREFIX`
   * env var, which is the wrong owner: a package manager sets it for its OWN
   * install (scoop points it at `…\scoop\persist\tesseract\tessdata`, which ships
   * no .traineddata at all), and a Tesseract resolved from anywhere else then
   * reports zero languages and cannot OCR a single page. So the app resolves the
   * directory itself and passes `--tessdata-dir` on every invocation.
   *
   * Order — first QUALIFYING directory wins:
   *   1. `options.tessdataDir`        — the caller pointed straight at it
   *   2. `$BOOKFORGE_TESSDATA`        — env override (mirrors BOOKFORGE_LEGACY_TESSDATA)
   *   3. `<userData>/tessdata`        — app-staged language data (mirrors tessdata-legacy)
   *   4. `$TESSDATA_PREFIX` and `$TESSDATA_PREFIX/tessdata` — Tesseract 3 wanted the
   *      PARENT of tessdata, 4/5 want the directory itself, and both spellings are
   *      in the wild. Honoured, but only when it really holds the file.
   *   5. beside the RESOLVED binary (see tessdataDirsBesideBinary)
   *   6. the same derivation applied to the catalog's other platform candidates,
   *      so a second install's language data is usable by whichever binary was
   *      resolved — e.g. a scoop shim reading the Program Files tessdata.
   *
   * A directory QUALIFIES only when `<dir>/<lang>.traineddata` really exists.
   * Accepting one that merely exists is precisely the bug this replaces.
   */
  private async resolveTessdataDetail(
    lang: string
  ): Promise<{ dir: string | null; searched: string[] }> {
    const cached = this.resolvedTessdata.get(lang);
    if (cached) return { dir: cached, searched: [] };

    const searched: string[] = [];
    for (const dir of await this.tessdataCandidates()) {
      if (searched.includes(dir)) continue;
      searched.push(dir);
      try {
        if (fs.existsSync(path.join(dir, `${lang}.traineddata`))) {
          this.resolvedTessdata.set(lang, dir);
          return { dir, searched };
        }
      } catch {
        // Unreadable directory — keep looking.
      }
    }
    return { dir: null, searched };
  }

  /** The ordered, language-independent list of directories to test. */
  private async tessdataCandidates(): Promise<string[]> {
    const dirs: string[] = [];
    if (this.options.tessdataDir) dirs.push(this.options.tessdataDir);

    const envOverride = process.env[TESSDATA_ENV_VAR];
    if (envOverride) dirs.push(envOverride);

    try {
      dirs.push(path.join(app.getPath('userData'), 'tessdata'));
    } catch {
      // app unavailable (tests / CLI) — skip the staged dir.
    }

    const prefix = process.env['TESSDATA_PREFIX'];
    if (prefix) dirs.push(prefix, path.join(prefix, 'tessdata'));

    const binary = (await this.resolveBinaryDetail()).path;
    if (binary) dirs.push(...tessdataDirsBesideBinary(binary));

    for (const cand of getComponent(TESSERACT_COMPONENT_ID)?.detect?.candidates ?? []) {
      if (cand.platform !== process.platform) continue;
      dirs.push(...tessdataDirsBesideBinary(cand.path));
    }

    return dirs;
  }

  /**
   * The traineddata directory for `lang`, or a loud error naming the language,
   * every directory searched, and how to fix it.
   */
  private async requireTessdataDir(lang: string): Promise<string> {
    const { dir, searched } = await this.resolveTessdataDetail(lang);
    if (dir) return dir;
    throw new Error(
      `No Tesseract language data for "${lang}" could be located: none of the ` +
      `directories searched contains ${lang}.traineddata. Searched:\n  ` +
      searched.join('\n  ') +
      `\nInstall the "${lang}" language data into one of those directories, or point ` +
      `$${TESSDATA_ENV_VAR} at the directory that holds it.`
    );
  }

  /**
   * The binary AND the traineddata directory for one invocation. Both halves are
   * required together — a binary with no language data cannot OCR anything, so
   * resolving only the binary would defer the failure into Tesseract's stderr.
   */
  private async requireInvocation(lang: string): Promise<{ binary: string; tessdataDir: string }> {
    const binary = await this.requireBinary();
    const tessdataDir = await this.requireTessdataDir(lang);
    return { binary, tessdataDir };
  }

  private preprocessScriptPath: string | null = null;
  private preprocessAvailable: boolean | null = null;
  /** Serial number for temp filenames; see preprocessImage(). */
  private static preprocessSeq = 0;

  /**
   * Find the ocr-preprocess.py script
   */
  private findPreprocessScript(): string {
    const possiblePaths = [
      path.join(__dirname, 'ocr-preprocess.py'),
      path.join(__dirname, '..', '..', 'electron', 'ocr-preprocess.py'),
      path.join(process.resourcesPath || '', 'ocr-preprocess.py'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return path.join(__dirname, 'ocr-preprocess.py');
  }

  /**
   * Preprocess an image for better OCR results.
   * Removes highlights, denoises, enhances contrast, and binarizes.
   * Returns the path to the preprocessed temp file, or the original path on failure.
   */
  private async preprocessImage(imagePath: string): Promise<string> {
    // Opt-in; see OcrServiceConfig.preprocess for the measurement behind that.
    if (!this.preprocess) {
      return imagePath;
    }

    if (this.preprocessAvailable === false) {
      return imagePath;
    }

    if (!this.preprocessScriptPath) {
      this.preprocessScriptPath = this.findPreprocessScript();
    }

    if (!fs.existsSync(this.preprocessScriptPath)) {
      console.warn('[OCR] Preprocess script not found:', this.preprocessScriptPath);
      this.preprocessAvailable = false;
      return imagePath;
    }

    const tempDir = app.getPath('temp');
    const ext = path.extname(imagePath) || '.png';
    // Date.now() alone is not unique: with pages OCR'd concurrently two workers
    // land in the same millisecond, and then one deletes the other's
    // preprocessed image mid-Tesseract. The counter makes the name per-call.
    const outputPath = path.join(tempDir,
      `ocr_preproc_${process.pid}_${Date.now()}_${++OcrService.preprocessSeq}${ext}`);

    try {
      // Async, and the heaviest of the three fixes: this spawns PYTHON per page,
      // and interpreter startup plus the OpenCV import routinely costs more than
      // the Tesseract run it precedes. Synchronously, that was main-thread dead
      // time on every single page.
      await execFileAsync(
        'python3', [this.preprocessScriptPath, imagePath, outputPath],
        { encoding: 'utf-8', timeout: 30000 }
      );

      if (fs.existsSync(outputPath)) {
        this.preprocessAvailable = true;
        return outputPath;
      }
    } catch (err) {
      if (this.preprocessAvailable === null) {
        console.warn('[OCR] Image preprocessing unavailable (python3/OpenCV missing), using raw images');
        this.preprocessAvailable = false;
      } else {
        console.warn('[OCR] Preprocessing failed for', imagePath, (err as Error).message);
      }
    }

    return imagePath;
  }

  /**
   * Perform OCR on an image file (plain text only).
   *
   * Tesseract's plain-text output carries NO confidence measurement, so the field
   * is deliberately omitted rather than fabricated as 0 — a hardcoded number is
   * indistinguishable from a real (terrible) measurement. Use
   * recognizeFileWithBounds() (the hOCR path) when real confidence is needed.
   */
  async recognizeFile(imagePath: string): Promise<Omit<OcrResult, 'confidence'>> {
    const { binary, tessdataDir } = await this.requireInvocation(this.lang);
    try {
      const args = [imagePath, 'stdout', '-l', this.lang,
        '--oem', String(OEM_LSTM), '--psm', String(PSM_AUTO),
        '--tessdata-dir', tessdataDir,
        // user_defined_dpi for the same reason as recognizeFileWithBounds: without
        // it Tesseract guesses, and its guess is never the rendered resolution.
        '-c', `user_defined_dpi=${this.dpi}`];
      const { stdout } = await execFileAsync(binary, args,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
      return { text: stdout.trim() };
    } catch (err) {
      console.error('OCR failed:', err);
      throw new Error(`OCR failed: ${(err as Error).message}`);
    }
  }

  /**
   * Parse hOCR into lines and paragraphs.
   *
   * Replaces the TSV parser. hOCR is a strict superset for our purposes: the
   * ocr_carea -> ocr_par -> ocr_line nesting carries the same grouping TSV
   * encoded as block_num/par_num, and it additionally reports per-line
   * x_size, x_ascenders, x_descenders and baseline, none of which exist in TSV.
   * Losing x_size was expensive — font size had to be guessed from bounding-box
   * height, which pinned most of a book to the minimum and left the classifier
   * with almost no size signal to separate body from footnotes.
   *
   * Scanned as a token stream rather than parsed as XML: hOCR from Tesseract is
   * flat and regular, and this runs once per page across whole books.
   */
  private parseHocrOutput(hocr: string): OcrResult {
    const textLines: OcrTextLine[] = [];
    const paragraphs: OcrParagraph[] = [];

    const field = (title: string, name: string): number[] | null => {
      const m = new RegExp(`${name}\\s+(-?[\\d.]+(?:\\s+-?[\\d.]+)*)`).exec(title);
      return m ? m[1].split(/\s+/).map(Number) : null;
    };

    let blockNum = 0;
    let parNum = 0;
    let parLines: OcrTextLine[] = [];
    let fullText = '';
    let confSum = 0;
    let confCount = 0;

    const flushParagraph = () => {
      if (parLines.length === 0) return;
      let minL = Infinity, minT = Infinity, maxR = 0, maxB = 0, cSum = 0;
      for (const l of parLines) {
        minL = Math.min(minL, l.bbox[0]); minT = Math.min(minT, l.bbox[1]);
        maxR = Math.max(maxR, l.bbox[2]); maxB = Math.max(maxB, l.bbox[3]);
        cSum += l.confidence;
      }
      paragraphs.push({
        text: parLines.map(l => l.text).join(' '),
        confidence: cSum / parLines.length,
        bbox: [minL, minT, maxR, maxB],
        lineCount: parLines.length,
        blockNum: parLines[0].blockNum ?? 0,
        parNum: parLines[0].parNum ?? 0,
      });
      parLines = [];
    };

    // One pass over the structural tags in document order.
    //
    // Tesseract does NOT emit every text line as ocr_line. Lines its layout
    // analysis reads as a running head, a caption or floating text get the
    // classes ocr_header, ocr_caption and ocr_textfloat instead — same title
    // attributes, same nesting, different class name. Matching only ocr_line
    // silently DROPPED all of them: measured on a scanned page of Kritz,
    // 13 of 53 lines were ocr_header, and because their paragraphs then held no
    // lines at all, flushParagraph() emitted nothing for them. Whole running
    // heads, footnotes and captions vanished from the OCR result — 7% of blocks
    // across a 20-page sample, concentrated in exactly the categories the block
    // classifier scores worst on (caption, footer, header).
    const token = /<div class='ocr_carea'|<p class='ocr_par'|<span class='ocr_(?:line|header|caption|textfloat)'[^>]*title="([^"]*)"|<span class='ocrx_word'[^>]*title='([^']*)'[^>]*>([\s\S]*?)<\/span>/g;
    let m: RegExpExecArray | null;
    let line: OcrTextLine | null = null;
    let lineWordConfs: number[] = [];

    const closeLine = () => {
      if (!line) return;
      if (line.text.trim().length > 0) {
        line.confidence = lineWordConfs.length
          ? lineWordConfs.reduce((a, b) => a + b, 0) / lineWordConfs.length / 100
          : 0;
        confSum += line.confidence; confCount++;
        textLines.push(line);
        parLines.push(line);
        fullText += (fullText ? '\n' : '') + line.text;
      }
      line = null;
      lineWordConfs = [];
    };

    while ((m = token.exec(hocr)) !== null) {
      const raw = m[0];
      if (raw.startsWith("<div class='ocr_carea'")) {
        closeLine(); flushParagraph(); blockNum++; parNum = 0;
      } else if (raw.startsWith("<p class='ocr_par'")) {
        closeLine(); flushParagraph(); parNum++;
      } else if (raw.startsWith("<span class='ocr_")) {
        // ocr_line / ocr_header / ocr_caption / ocr_textfloat — see `token`.
        // ocrx_word also starts with "<span class='ocr" but has an x, so the
        // prefix test above ends at the underscore deliberately.
        closeLine();
        const title = m[1] ?? '';
        const bbox = field(title, 'bbox');
        if (!bbox || bbox.length < 4) continue;
        const baseline = field(title, 'baseline');
        line = {
          text: '',
          confidence: 0,
          bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
          blockNum,
          parNum,
          xSize: field(title, 'x_size')?.[0],
          ascenders: field(title, 'x_ascenders')?.[0],
          descenders: field(title, 'x_descenders')?.[0],
          baselineSlope: baseline?.[0],
        };
      } else if (line) {
        const conf = Number(/x_wconf (-?[\d.]+)/.exec(m[2] ?? '')?.[1] ?? NaN);
        if (Number.isFinite(conf)) lineWordConfs.push(conf);
        const word = this.decodeEntities((m[3] ?? '').replace(/<[^>]+>/g, '')).trim();
        if (word) line.text += (line.text ? ' ' : '') + word;
      }
    }
    closeLine();
    flushParagraph();

    console.log(`[OCR] Parsed hOCR: ${textLines.length} lines, ${paragraphs.length} paragraphs`);
    return {
      text: fullText,
      confidence: confCount > 0 ? confSum / confCount : 0,
      textLines,
      paragraphs,
    };
  }

  private decodeEntities(s: string): string {
    return s
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  /**
   * Word-level typography from Tesseract's LEGACY engine.
   *
   * Only --oem 0 reports font attributes, and only into hOCR with
   * hocr_font_info enabled — TSV has no font columns on either engine, and the
   * LSTM engine dropped the feature entirely. So text comes from LSTM (better
   * accuracy) and typography from a second legacy pass, joined by bbox.
   *
   * Returns [] when the legacy traineddata isn't installed; callers degrade to
   * bbox-derived font sizes rather than failing.
   *
   * NOTE the two distinct notions of "tessdata dir" — they are NOT interchangeable.
   * `requireTessdataDir()` finds the data the LSTM text pass runs on (`--oem 1`),
   * whatever the local Tesseract shipped. `legacyTessdataDir()` finds a
   * legacy-CAPABLE `<lang>.traineddata`, a different file with the same name that
   * is staged as its own downloadable component because Homebrew's is LSTM-only.
   * This pass is the only caller of the legacy one, and it is the only pass that
   * uses `--oem 0`.
   */
  private async recognizeFontAttributes(
    imagePath: string
  ): Promise<Array<{ left: number; top: number; right: number; bottom: number; font: string; size: number; bold: boolean; italic: boolean }>> {
    const binary = await this.requireBinary();
    const lang = this.lang;
    const tessdataDir = this.legacyTessdataDir();
    if (!tessdataDir) return [];

    try {
      // Async and argument-array, for the reason given at execFileAsync: this is
      // a SECOND Tesseract pass per page, so run synchronously it doubled the
      // window in which main could not answer IPC.
      const args = [imagePath, 'stdout', '-l', lang, '--oem', '0', '--psm', '3',
        '--tessdata-dir', tessdataDir,
        '-c', 'tessedit_create_hocr=1', '-c', 'hocr_font_info=1'];
      const { stdout: hocr } = await execFileAsync(binary, args,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });

      const words: Array<{ left: number; top: number; right: number; bottom: number; font: string; size: number; bold: boolean; italic: boolean }> = [];
      // <span class='ocrx_word' id='..' title='bbox L T R B; x_wconf N; x_font F; x_fsize S'>[<strong>|<em>]text
      const wordRe = /<span class='ocrx_word'[^>]*title='([^']*)'[^>]*>(.*?)<\/span>/g;
      let m: RegExpExecArray | null;
      while ((m = wordRe.exec(hocr)) !== null) {
        const title = m[1];
        const inner = m[2];
        const bbox = /bbox (\d+) (\d+) (\d+) (\d+)/.exec(title);
        if (!bbox) continue;
        const font = /x_font ([A-Za-z0-9_\-]+)/.exec(title)?.[1] ?? '';
        const size = Number(/x_fsize (\d+)/.exec(title)?.[1] ?? 0);
        words.push({
          left: Number(bbox[1]), top: Number(bbox[2]), right: Number(bbox[3]), bottom: Number(bbox[4]),
          font, size,
          bold: inner.includes('<strong>') || /_Bold/i.test(font),
          italic: inner.includes('<em>') || /_Italic/i.test(font),
        });
      }
      console.log(`[OCR] Font attributes: ${words.length} words from the legacy pass`);
      return words;
    } catch (err) {
      console.warn('[OCR] Font attribute pass unavailable:', (err as Error).message.split('\n')[0]);
      return [];
    }
  }

  /**
   * Directory holding legacy-capable traineddata, or null when absent.
   *
   * Homebrew ships LSTM-only traineddata, so --oem 0 fails with "components are
   * not present". The legacy file comes from the tessdata repo and is staged
   * alongside the app's other downloadable components.
   */
  private legacyTessdataDir(): string | null {
    const lang = this.lang;
    for (const dir of this.legacyTessdataCandidates()) {
      try {
        if (fs.existsSync(path.join(dir, `${lang}.traineddata`))) return dir;
      } catch { /* keep looking */ }
    }
    return null;
  }

  private legacyTessdataCandidates(): string[] {
    const dirs: string[] = [];
    if (process.env['BOOKFORGE_LEGACY_TESSDATA']) dirs.push(process.env['BOOKFORGE_LEGACY_TESSDATA']!);
    try {
      dirs.push(path.join(app.getPath('userData'), 'tessdata-legacy'));
    } catch { /* app unavailable in tests */ }
    return dirs;
  }

  /**
   * Attach typography to lines by bbox overlap.
   *
   * Aggregated per line, never trusted per word: on a clean page 622 of 626
   * words read Times_New_Roman and the other four came back Verdana, Arial and
   * Trebuchet. A majority vote absorbs that; a per-word read would not.
   */
  private applyFontAttributes(
    lines: OcrTextLine[],
    // Awaited: recognizeFontAttributes is async now, so its bare ReturnType is a
    // Promise and this takes the resolved array the caller already awaited.
    words: Awaited<ReturnType<OcrService['recognizeFontAttributes']>>
  ): void {
    if (words.length === 0) return;

    for (const line of lines) {
      const [lx1, ly1, lx2, ly2] = line.bbox;
      const inside = words.filter(w =>
        w.left < lx2 && w.right > lx1 && w.top < ly2 && w.bottom > ly1
      );
      if (inside.length === 0) continue;

      const fontVotes = new Map<string, number>();
      const sizes: number[] = [];
      let bold = 0, italic = 0;
      for (const w of inside) {
        if (w.font) fontVotes.set(w.font, (fontVotes.get(w.font) ?? 0) + 1);
        if (w.size > 0) sizes.push(w.size);
        if (w.bold) bold++;
        if (w.italic) italic++;
      }

      let bestFont = '', bestCount = 0;
      for (const [font, count] of fontVotes) {
        if (count > bestCount) { bestCount = count; bestFont = font; }
      }
      if (bestFont) line.fontName = bestFont;
      if (sizes.length > 0) {
        sizes.sort((a, b) => a - b);
        line.fontSize = sizes[Math.floor(sizes.length / 2)];   // median resists stray reads
      }
      line.boldFrac = bold / inside.length;
      line.italicFrac = italic / inside.length;
    }
  }

  /**
   * Perform OCR on an image file with bounding boxes
   * Uses Tesseract's TSV output format to get line-level positions
   */
  async recognizeFileWithBounds(imagePath: string): Promise<OcrResult> {
    const lang = this.lang;
    // Resolved BEFORE preprocessing so a missing binary / missing language data
    // fails immediately, with a message naming what was searched, instead of after
    // a per-page Python preprocess that would then be thrown away.
    const { binary, tessdataDir } = await this.requireInvocation(lang);

    const preprocessedPath = await this.preprocessImage(imagePath);
    const didPreprocess = preprocessedPath !== imagePath;

    try {
      // hOCR rather than TSV: same block/paragraph/line grouping, plus the
      // per-line x_size, x_ascenders, x_descenders and baseline that TSV omits.
      //
      // Argument array, not a shell string: paths here contain spaces, brackets
      // and accented characters (the library is full of them), and quoting them
      // into a shell was one escaping bug away from failing on a real filename.
      // user_defined_dpi, or Tesseract GUESSES — and it guessed 132-140 on pages
      // rendered at 144, which shifts paragraph grouping away from the 200-dpi
      // segmentation the training corpus and every existing label are defined
      // against. Callers render at OCR_DPI; this tells Tesseract so, rather than
      // letting it infer a number that is close but never right.
      // --tessdata-dir, not the global TESSDATA_PREFIX: see resolveTessdataDetail.
      const args = [preprocessedPath, 'stdout', '-l', lang,
        '--oem', String(OEM_LSTM), '--psm', String(PSM_AUTO),
        '--tessdata-dir', tessdataDir,
        '-c', 'tessedit_create_hocr=1', '-c', `user_defined_dpi=${this.dpi}`];
      console.log('[OCR] Running:', binary, args.join(' '),
        didPreprocess ? '(preprocessed)' : '(raw)');

      const { stdout: output } = await execFileAsync(binary, args,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });

      const result = this.parseHocrOutput(output);

      // Second pass purely for typography. Runs on the same preprocessed image
      // so its bboxes share a coordinate space with the TSV lines.
      if (result.textLines?.length) {
        this.applyFontAttributes(result.textLines, await this.recognizeFontAttributes(preprocessedPath));
        const withFont = result.textLines.filter(l => l.fontSize !== undefined).length;
        console.log(`[OCR] Typography applied to ${withFont}/${result.textLines.length} lines`);
      }

      console.log('[OCR] Parsed result - textLines:', result.textLines?.length, 'text length:', result.text.length);

      return result;
    } catch (err) {
      console.error('OCR with bounds failed:', err);
      throw new Error(`OCR failed: ${(err as Error).message}`);
    } finally {
      if (didPreprocess) {
        try { fs.unlinkSync(preprocessedPath); } catch { /* ignore */ }
      }
    }
  }


  /**
   * Perform OCR on an image (supports data URLs, base64, or bookforge-page:// file paths)
   * Returns text lines with bounding boxes
   */
  /**
   * Turn a bookforge-page:// or file:// URL into a filesystem path.
   *
   * The renderer appends a cache-busting query (`?v=ms40xr2y`) to every page
   * URL so the browser re-fetches re-rendered pages. Stripping only the scheme
   * left that query on the end of the path, so every existsSync() failed and
   * OCR threw "Image file not found" for every single page — which surfaced as
   * the OCR run finishing instantly having done nothing.
   *
   * Returns null when the input isn't a URL (raw base64 / data URL).
   */
  private static filePathFromUrl(input: string): string | null {
    let rest: string;
    if (input.startsWith('bookforge-page://')) rest = input.substring('bookforge-page://'.length);
    else if (input.startsWith('file://')) rest = input.substring('file://'.length);
    else return null;

    // Drop the cache-busting query and any fragment, then undo URL escaping
    // (spaces and accented characters in book filenames arrive percent-encoded).
    rest = rest.split('#')[0].split('?')[0];
    try {
      rest = decodeURIComponent(rest);
    } catch {
      // Malformed escape — fall through with the raw value rather than throwing.
    }
    return rest.startsWith('/') ? rest : `/${rest}`;
  }

  async recognizeBase64(imageData: string): Promise<OcrResult> {
    // Handle bookforge-page:// and file:// URLs — these are direct file paths
    const urlPath = OcrService.filePathFromUrl(imageData);
    if (urlPath !== null) {
      if (fs.existsSync(urlPath)) {
        return this.recognizeFileWithBounds(urlPath);
      }
      throw new Error(`Image file not found: ${urlPath}`);
    }

    // Handle data URLs and raw base64
    const base64Clean = imageData.replace(/^data:image\/\w+;base64,/, '');

    // Write to temp file
    const tempDir = app.getPath('temp');
    const tempFile = path.join(tempDir, `ocr_${Date.now()}.png`);

    try {
      // Async: a 200-dpi page is a few MB, and a sync write of that per page is
      // main-thread time for no reason. Same argument as execFileAsync above.
      await fs.promises.writeFile(tempFile, Buffer.from(base64Clean, 'base64'));
      const result = await this.recognizeFileWithBounds(tempFile);
      return result;
    } finally {
      // Best-effort: a leftover temp PNG is harmless, and throwing from a
      // finally block would mask the real OCR error.
      await fs.promises.unlink(tempFile).catch(() => {});
    }
  }

  /**
   * Detect skew angle of an image using Tesseract's OSD (Orientation and Script Detection)
   * Returns the angle needed to deskew the image, or null if detection FAILED —
   * never a fabricated {angle: 0} that is indistinguishable from "page is straight".
   */
  async detectSkew(imagePath: string): Promise<DeskewResult | null> {
    try {
      // OSD reads osd.traineddata, not the page language's file, so the directory
      // this pass needs is the one that actually holds `osd` — which is not
      // necessarily the one that holds `eng`. And no --oem: osd.traineddata is a
      // legacy-only model, so `-l eng --psm 0` fails outright with "OSD requires a
      // model for the legacy engine" and `--oem 1` warns "LSTM requested, but not
      // present!!". The old invocation passed BOTH `-l eng` and `oem: 1`.
      const { binary, tessdataDir } = await this.requireInvocation(OSD_LANG);
      const args = [imagePath, 'stdout', '-l', OSD_LANG, '--psm', String(PSM_OSD_ONLY),
        '--tessdata-dir', tessdataDir];
      const { stdout: output } = await execFileAsync(binary, args, { encoding: 'utf-8' });

      // Tesseract prints "Orientation in degrees: 0\nRotate: 0\n..." on stdout.
      const orientationMatch = output.match(/Orientation in degrees:\s*([\d.]+)/);
      const confidenceMatch = output.match(/Orientation confidence:\s*([\d.]+)/);

      // No fabricated zeros: an unparseable OSD report is a FAILED detection, and
      // {angle: 0, confidence: 0} is indistinguishable from "the page is straight".
      if (!orientationMatch || !confidenceMatch) {
        console.error(
          '[OCR] Skew detection produced no orientation report. Tesseract said:',
          output.trim().slice(0, 500)
        );
        return null;
      }

      return {
        angle: parseFloat(orientationMatch[1]),
        confidence: parseFloat(confidenceMatch[1]),
      };
    } catch (err) {
      console.error('Skew detection failed:', err);
      // null = "detection failed", which callers must treat differently from
      // a real measurement of 0 degrees.
      return null;
    }
  }

  /**
   * Detect skew angle from image (supports data URLs, base64, or bookforge-page:// file paths)
   * Returns null when detection failed (see detectSkew).
   */
  async detectSkewBase64(imageData: string): Promise<DeskewResult | null> {
    // Same URL handling as recognizeBase64 — cache-busting query included.
    const urlPath = OcrService.filePathFromUrl(imageData);
    if (urlPath !== null) {
      if (fs.existsSync(urlPath)) {
        return this.detectSkew(urlPath);
      }
      throw new Error(`Image file not found: ${urlPath}`);
    }

    // Handle data URLs and raw base64
    const base64Clean = imageData.replace(/^data:image\/\w+;base64,/, '');

    const tempDir = app.getPath('temp');
    const tempFile = path.join(tempDir, `skew_${Date.now()}.png`);

    try {
      await fs.promises.writeFile(tempFile, Buffer.from(base64Clean, 'base64'));
      return await this.detectSkew(tempFile);
    } finally {
      await fs.promises.unlink(tempFile).catch(() => {});
    }
  }

  /**
   * Get the list of available languages, AS THE RECOGNITION PASSES WILL SEE IT.
   *
   * `--tessdata-dir` is passed for exactly that reason: without it Tesseract
   * lists whatever the global TESSDATA_PREFIX happens to point at, which on a
   * scoop-installed machine is an empty directory — so this answered "(0)
   * languages" while recognition would have been perfectly capable of `eng` from
   * the directory beside a different install.
   *
   * Throws when the list cannot be read (e.g. Tesseract missing) — a fabricated
   * ['eng'] would mask a broken/absent install.
   */
  async getAvailableLanguages(): Promise<string[]> {
    const { binary, tessdataDir } = await this.requireInvocation(this.lang);
    try {
      const { stdout } = await execFileAsync(
        binary, ['--tessdata-dir', tessdataDir, '--list-langs'], { encoding: 'utf-8' }
      );
      // First line is "List of available languages in "<dir>" (N):" — dropped by
      // the colon test; the rest is one language code per line.
      //
      // TRIMMED, because Tesseract on Windows ends each line with CRLF and
      // splitting on '\n' alone leaves the '\r' attached: the codes came back as
      // "eng\r"/"osd\r", so every `languages.includes('eng')` test failed and the
      // language dropdown was populated with values Tesseract would reject.
      return stdout
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line && !line.includes(':'));
    } catch (err) {
      console.error(
        `[OCR] Failed to list Tesseract languages via "${binary} --tessdata-dir ${tessdataDir} --list-langs":`,
        err
      );
      throw new Error(
        `Failed to list Tesseract languages ("${binary} --tessdata-dir ${tessdataDir} ` +
        `--list-langs"): ${(err as Error).message}`
      );
    }
  }

  /**
   * Whether OCR can actually run: a located binary AND language data for the
   * configured language. Async because resolution is (see resolveBinaryDetail).
   *
   * Prefer getAvailability() where the reason matters — a bare false cannot tell
   * "no Tesseract" from "Tesseract but no language data", and those have different
   * fixes.
   */
  async isAvailable(): Promise<boolean> {
    return (await this.getAvailability()).available;
  }

  /**
   * Get Tesseract's version, or null when the binary can't be located or run.
   */
  async getVersion(): Promise<string | null> {
    const binary = (await this.resolveBinaryDetail()).path;
    if (!binary) return null;
    try {
      const { stdout } = await execFileAsync(binary, ['--version'], { encoding: 'utf-8' });
      // Tesseract prints "tesseract v5.4.0.20240606" — the v is part of the real
      // output, so a pattern without it silently reported "no version" for every
      // build that has one.
      const match = stdout.match(/tesseract\s+v?([\d.]+)/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * The full picture: which binary, which traineddata directory, which languages,
   * and — when OCR can't run — a short reason plus the complete search detail.
   *
   * This exists because a bare `available: false` cost an hour of debugging: the
   * picker said "Not installed" while the truth was "installed, but the global
   * TESSDATA_PREFIX points at a directory with zero .traineddata files".
   */
  async getAvailability(): Promise<OcrAvailability> {
    const lang = this.lang;

    const { path: binaryPath, searched: binarySearched } = await this.resolveBinaryDetail();
    if (!binaryPath) {
      return {
        available: false, version: null, binaryPath: null, tessdataDir: null,
        lang, languages: null,
        reason: 'Tesseract is not installed. Install or locate it in Settings → Add-ons.',
        detail: `No Tesseract OCR binary could be located. Searched: ${binarySearched.join('; ')}.`,
      };
    }

    const version = await this.getVersion();
    if (version === null) {
      return {
        available: false, version: null, binaryPath, tessdataDir: null, lang, languages: null,
        reason: 'Tesseract was found but would not run.',
        detail: `"${binaryPath} --version" produced no recognisable version. Re-locate ` +
                `Tesseract in Settings → Add-ons, or reinstall it.`,
      };
    }

    const { dir: tessdataDir, searched: dirsSearched } = await this.resolveTessdataDetail(lang);
    if (!tessdataDir) {
      return {
        available: false, version, binaryPath, tessdataDir: null, lang, languages: null,
        reason: `Tesseract ${version} is installed but has no "${lang}" language data.`,
        detail: `No directory containing ${lang}.traineddata was found. Searched:\n  ` +
                dirsSearched.join('\n  ') +
                `\nInstall the "${lang}" language data into one of those directories, or point ` +
                `$${TESSDATA_ENV_VAR} at the directory that holds it.`,
      };
    }

    let languages: string[];
    try {
      languages = await this.getAvailableLanguages();
    } catch (err) {
      return {
        available: false, version, binaryPath, tessdataDir, lang, languages: null,
        reason: 'Tesseract could not list its languages.',
        detail: (err as Error).message,
      };
    }

    // resolveTessdataDetail already proved <lang>.traineddata is on disk, so a
    // language list that omits it means Tesseract rejected the file itself.
    if (!languages.includes(lang)) {
      return {
        available: false, version, binaryPath, tessdataDir, lang, languages,
        reason: `Tesseract ${version} does not accept the "${lang}" language data.`,
        detail: `${path.join(tessdataDir, `${lang}.traineddata`)} exists, but ` +
                `"${binaryPath} --list-langs" reports only: ${languages.join(', ') || '(none)'}. ` +
                `The file is likely for a different Tesseract major version.`,
      };
    }

    return {
      available: true, version, binaryPath, tessdataDir, lang, languages,
      reason: null, detail: null,
    };
  }
}

// Singleton instance
let ocrServiceInstance: OcrService | null = null;

export function getOcrService(): OcrService {
  if (!ocrServiceInstance) {
    ocrServiceInstance = new OcrService();
  }
  return ocrServiceInstance;
}
