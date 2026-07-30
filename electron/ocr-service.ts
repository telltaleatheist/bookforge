import tesseract from 'node-tesseract-ocr';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';

/**
 * Tesseract must be spawned ASYNCHRONOUSLY on the recognition path.
 *
 * `execSync` here blocks the Electron MAIN process for the whole run — a second
 * or three per page — and while main is blocked it services no IPC at all. The
 * renderer keeps painting, so it does not look like a freeze; page renders,
 * saves and autosave simply stall, which reads as the UI partially hanging while
 * OCR runs. Multiply by 400 pages.
 *
 * Synchronous spawning survives only where it is genuinely one-shot probing
 * (--version, --list-langs), which happens once and is not on a hot path — and
 * even there it is `execFileSync` with an argument array, never a shell string:
 * the Windows install path contains a space, and a shell string turns that into
 * a bogus "command not found" that reads as Tesseract being absent.
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
 * Mirrored as OCR_DPI in pdf-picker.component.ts, which cannot import a main
 * process module. Change both together.
 */
export const OCR_DPI = 200;

export interface OcrTextLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];  // [x1, y1, x2, y2]
  // Tesseract's own layout analysis. Lines sharing a (blockNum, parNum) pair
  // belong to the same paragraph — this is the segmentation Tesseract already
  // performed, and it is far more reliable than re-deriving paragraph breaks
  // from geometry downstream. Absent for OCR plugins that don't report it.
  blockNum?: number;
  parNum?: number;
  /**
   * Typography, from the legacy-engine attribute pass. LSTM (--oem 1) reports
   * none of this, so without the second pass every OCR line arrives the same
   * size and weight and the classifier is blind to the strongest heading,
   * caption and footnote signals.
   */
  fontName?: string;
  /** Point size, as reported (not derived from bbox height). */
  fontSize?: number;
  /** 0..1 share of the line's words marked bold. Per-word reads are noisy. */
  boldFrac?: number;
  /** 0..1 share of the line's words marked italic. */
  italicFrac?: number;
  /**
   * Line metrics Tesseract reports in hOCR but not in TSV — which is why the
   * pipeline used to estimate font size from bounding-box height and land 86%
   * of a book on the clamp floor.
   */
  /** Measured type size in image pixels (from x-height). Divide by render scale for points. */
  xSize?: number;
  /** Ascender height above the x-height band, in image pixels. */
  ascenders?: number;
  /**
   * Descender depth below the baseline, in image pixels.
   *
   * Text set in capitals has essentially none, which identifies running heads,
   * chapter openers and small-caps subheads optically — that holds even when
   * OCR misreads the letters themselves, which case-from-text cannot.
   */
  descenders?: number;
  /** Baseline slope. Near zero on a flat scan; rises where the page curves. */
  baselineSlope?: number;
}

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
  tesseractPath?: string;  // Path to tesseract binary (auto-detected if not provided)
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
   * OFF by default, which was measured rather than assumed. On a 20-page sample
   * of a scanned book, preprocessing:
   *   - changed mean OCR confidence by +0.0006 and total characters by +1 — i.e.
   *     it did not improve the text at all; and
   *   - cost 6 of 156 paragraph blocks and moved 33% of the surviving bounding
   *     boxes, because binarizing changes the pixels Tesseract's layout analysis
   *     measures.
   * Every label in the training corpus is keyed to the raw-render segmentation,
   * so paying real segmentation drift for no accuracy is a bad trade. It stays
   * available for genuinely damaged scans (highlighter, heavy noise) where the
   * trade may invert — but the caller has to ask.
   */
  preprocess?: boolean;
}

/**
 * OCR Service - Provides OCR and deskew detection using Tesseract
 */
export class OcrService {
  private config: tesseract.Config;
  /** See OcrServiceConfig.dpi. Kept off `config` because tesseract.Config has no such field. */
  private readonly dpi: number;
  /** See OcrServiceConfig.preprocess. */
  private readonly preprocess: boolean;

  constructor(options: OcrServiceConfig = {}) {
    this.config = {
      lang: options.lang || 'eng',
      oem: 1,  // LSTM OCR Engine
      psm: 3,  // Fully automatic page segmentation
    };
    this.dpi = options.dpi ?? OCR_DPI;
    this.preprocess = options.preprocess ?? false;

    // Set tesseract path if provided or try to find it
    if (options.tesseractPath) {
      this.config.binary = options.tesseractPath;
    } else {
      // Try common locations
      const possiblePaths = [
        '/opt/homebrew/bin/tesseract',  // macOS ARM
        '/usr/local/bin/tesseract',      // macOS Intel
        '/usr/bin/tesseract',            // Linux
        'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',  // Windows
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          this.config.binary = p;
          break;
        }
      }
    }
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
   * node-tesseract-ocr's plain-text path provides NO confidence measurement, so
   * the field is deliberately omitted rather than fabricated as 0 — a hardcoded
   * number is indistinguishable from a real (terrible) measurement. Use
   * recognizeFileWithBounds() (TSV path) when real confidence is needed.
   */
  async recognizeFile(imagePath: string): Promise<Omit<OcrResult, 'confidence'>> {
    try {
      const text = await tesseract.recognize(imagePath, this.config);
      return { text: text.trim() };
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
   */
  private async recognizeFontAttributes(
    imagePath: string
  ): Promise<Array<{ left: number; top: number; right: number; bottom: number; font: string; size: number; bold: boolean; italic: boolean }>> {
    const binary = this.config.binary || 'tesseract';
    const lang = this.config.lang || 'eng';
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
    const lang = this.config.lang || 'eng';
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
    const binary = this.config.binary || 'tesseract';
    const lang = this.config.lang || 'eng';

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
      const args = [preprocessedPath, 'stdout', '-l', lang, '--oem', '1', '--psm', '3',
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
      // Use psm 0 for orientation and script detection only
      const osdConfig: tesseract.Config = {
        ...this.config,
        psm: 0,  // OSD only
      };

      const output = await tesseract.recognize(imagePath, osdConfig);

      // Parse the OSD output for rotation angle
      // Tesseract outputs something like: "Rotate: 0\nOrientation in degrees: 0\n..."
      const rotateMatch = output.match(/Rotate:\s*(\d+)/);
      const orientationMatch = output.match(/Orientation in degrees:\s*([\d.]+)/);
      const confidenceMatch = output.match(/Orientation confidence:\s*([\d.]+)/);

      const angle = orientationMatch ? parseFloat(orientationMatch[1]) : 0;
      const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0;

      return { angle, confidence };
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
   * Get list of available languages.
   * Throws when the language list cannot be read (e.g. Tesseract missing) —
   * a fabricated ['eng'] would mask a broken/absent Tesseract install.
   */
  async getAvailableLanguages(): Promise<string[]> {
    const binary = this.config.binary || 'tesseract';
    try {
      // Argument array, not a shell string — see the note on the probes below.
      const output = execFileSync(binary, ['--list-langs'], { encoding: 'utf-8' });
      const lines = output.split('\n').filter((line: string) => line.trim() && !line.includes(':'));
      return lines;
    } catch (err) {
      console.error(`[OCR] Failed to list Tesseract languages via "${binary} --list-langs":`, err);
      throw new Error(`Failed to list Tesseract languages ("${binary} --list-langs"): ${(err as Error).message}`);
    }
  }

  /**
   * Check if Tesseract is available.
   *
   * Argument array, never a shell string. The default Windows install path is
   * `C:\Program Files\Tesseract-OCR\tesseract.exe`, and interpolating that into a
   * command line hands cmd.exe `C:\Program` as the program name — so a perfectly
   * good install reported itself as MISSING, and the picker refused to run OCR
   * while Settings (which detects it a different way) said it was installed.
   * The recognition paths already pass argument arrays for this same reason.
   */
  isAvailable(): boolean {
    try {
      const binary = this.config.binary || 'tesseract';
      execFileSync(binary, ['--version'], { encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Tesseract version. Argument array for the reason given on isAvailable().
   */
  getVersion(): string | null {
    try {
      const binary = this.config.binary || 'tesseract';
      const output = execFileSync(binary, ['--version'], { encoding: 'utf-8' });
      // Tesseract prints "tesseract v5.4.0.20240606" — the v is part of the real
      // output, so a pattern without it silently reported "no version" for every
      // build that has one.
      const match = output.match(/tesseract\s+v?([\d.]+)/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
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
