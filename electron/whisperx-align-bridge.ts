/**
 * Epub-align bridge — aligns a project's EPUB text to its audiobook to produce
 * ACCURATE read-along subtitles.
 *
 * Unlike the transcription path (generate-sentences-bridge), which infers the
 * words from the audio (and so inherits ASR spelling/word errors), this path
 * takes the ebook as ground truth: it extracts the ebook's sentences in reading
 * order and gets back a VTT whose text is the ebook's own words with real audio
 * timings.
 *
 * THE MODELS ARE CRUCIBLE'S, THE LOGIC IS BOOKFORGE'S (Owen, 2026-09-24: "all gpu
 * use in bookforge should run through crucible"). `crucible/sentence-align.ts` runs
 * Qwen3-ASR (an `asr` job) → the EPUB diff here → Qwen3-ForcedAligner (`align`
 * jobs) on the windows the two disagree on → cue edges in real pauses. The local
 * spawn of `align_audiobook.py` (faster-whisper rough pass in `whisperx-env`,
 * qwen3/wav2vec2 forced alignment in `qwen-align-env`) is deleted
 * (docs/REORG-PLAN.md, B2); the script itself stays as CLI-owned tooling for
 * `cli/align_book_chapters.py`. The file name is older than both and is not worth
 * renaming a keeper over.
 *
 * The caller (startGenerateSentences) owns embed + manifest linking + completion.
 */

import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

import { loadEpubForComparison, HEADING_MARKER } from './epub-processor.js';
import * as manifestService from './manifest-service.js';
import { getFfmpegPath } from './tool-paths.js';
import { GenerateSentencesConfig, sendProgress, glog } from './generate-sentences-bridge.js';
import { crucibleAsrLanguage } from './crucible/asr.js';
import { alignableTextRefusal } from '../shared/document/alignable-text';
import { periodTerminatorGuard } from '../shared/text/sentence-abbreviations';

/**
 * Live aligns, keyed by jobId, so a queue cancel can actually REACH them —
 * whichever machine the alignment is running on.
 *
 * BUG (2026-07-24): the align child was spawned into a local variable with no
 * registry and no kill path. generate-sentences' cancel is COOPERATIVE — it sets a
 * flag checked *between* stages — but the align stage is the long one and never
 * checks it, so cancelling mid-align left WhisperX running to completion, holding
 * the GPU. Owen hit this: two orphaned align_audiobook.py trees survived the queue
 * X and had to be taskkill'd by hand.
 *
 * THE SAME BUG WITH THE SAME SHAPE, ON THE OTHER MACHINE (2026-09-18): the
 * Crucible arm below took no cancel at all. `runLongformAlign` accepts a
 * `signal` and this bridge passed none, so the ✕ on the one job in the app that
 * runs for hours reached nothing, and the alignment carried on holding that
 * server's exclusive lane. Both arms are in ONE map on purpose: "what is
 * running for this job" is one fact, and a second registry is a door somebody
 * forgets to open.
 */
type LiveAlign =
  /** The run's Crucible jobs; aborting DELETEs the one in flight (crucible/job.ts). */
  { readonly where: 'crucible'; readonly stop: AbortController };
const activeAligns = new Map<string, LiveAlign>();

/**
 * Cancel the alignment for a job: abort its signal, which the generic job door
 * turns into `DELETE /v1/jobs/{id}` and then reads the `cancelled` frame off the
 * stream it is already following — a cancel, not a hang-up, because hanging up
 * leaves the job running on somebody else's card.
 *
 * Safe to call for an unknown/already-finished jobId.
 */
export function cancelEpubAlign(jobId: string): void {
  const live = activeAligns.get(jobId);
  if (!live) return;
  activeAligns.delete(jobId);
  glog(`[epub-align] cancel requested job=${jobId} on crucible`);
  live.stop.abort();
}

/**
 * THE SEGMENTATION DEFAULT FOR EVERY CALLER THAT PASSES NO OPTIONS — the app's
 * Generate Sentences button included: paragraph-aware segmentation ON. It fixes
 * a real defect (headings fused into the first prose cue, 2026-09-03) and the
 * read-along text is strictly better for it.
 */
export const DEFAULT_PARAGRAPH_AWARE = true;

/** A sentence handed to the aligner, plus what kind of block it came from. */
export interface AlignSentence {
  text: string;
  /** 'heading' = a short, unpunctuated block of its own (part/chapter number,
   *  chapter title, running head, epigraph attribution). Everything else is
   *  'prose'. align_audiobook.py tags heading cues `NOTE heading` in the VTT so a
   *  downstream corpus cutter can drop them without guessing from the text. */
  kind: 'prose' | 'heading';
}

const HEADING_MAX_CHARS = 90;
const HEADING_MAX_WORDS = 12;

/** Lowercase function words a title legitimately leaves uncapitalized ("Ohio Born
 *  **and** Molded"). Everything else in a title-case run must be capitalized. */
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor',
  'of', 'on', 'onto', 'or', 'over', 'the', 'to', 'up', 'upon', 'with', 'via',
  'vs', 'versus', 'per', 'than',
]);

/** Words that open a heading whatever follows ("Part I", "Chapter 3", "Notes"). */
const HEADING_LEAD = /^(part|chapter|book|section|appendix|prologue|epilogue|introduction|foreword|preface|afterword|conclusion|contents|notes|index|bibliography|acknowledgments|acknowledgements)\b/i;

/**
 * "1", "12", "IV", "xvii", "3.", "12.", "1)" — a bare number or roman numeral
 * standing alone is the classic chapter-number block, a heading with no ambiguity.
 *
 * A CHARACTER CLASS IS NOT A ROMAN NUMERAL. The first version tested
 * `[ivxlcdm]{1,7}`, which matches ordinary English words built from those letters —
 * did, dim, lid, mid, mild, mill, civil, vivid, ill, id, dill, and their capitalized
 * forms — every one of which would have been tagged `heading`, i.e. droppable by a
 * corpus cutter. This is the real grammar, anchored and non-empty, plus a value cap:
 * `MIX` genuinely is a valid numeral (1009), as are `DI`, `MC` and friends, and the
 * cap is what keeps those English words out while leaving every plausible chapter or
 * front-matter number in.
 */
const ROMAN_NUMERAL = /^(?=[MDCLXVI])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;
const ROMAN_MAX = 100;
const ROMAN_VALUES: ReadonlyArray<readonly [string, number]> = [
  ['CM', 900], ['CD', 400], ['XC', 90], ['XL', 40], ['IX', 9], ['IV', 4],
  ['M', 1000], ['D', 500], ['C', 100], ['L', 50], ['X', 10], ['V', 5], ['I', 1],
];
function romanValue(s: string): number {
  let v = 0;
  outer: for (let i = 0; i < s.length; ) {
    for (const [sym, val] of ROMAN_VALUES) {
      if (s.startsWith(sym, i)) { v += val; i += sym.length; continue outer; }
    }
    return NaN;
  }
  return v;
}

/** A block that is nothing but a chapter number, with at most one trailing mark. */
function isNumberingOnly(b: string): boolean {
  const core = b.replace(/\s*[.,):\]]$/, '').trim();
  if (!core) return false;
  if (/^\d{1,4}$/.test(core)) return true;
  // uniform case only — "Mix" is not how anyone sets a chapter number
  if (core !== core.toUpperCase() && core !== core.toLowerCase()) return false;
  const up = core.toUpperCase();
  if (!ROMAN_NUMERAL.test(up)) return false;
  const v = romanValue(up);
  return Number.isFinite(v) && v > 0 && v <= ROMAN_MAX;
}

function coreOf(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Title Case or ALL CAPS — the two shapes a set heading actually takes. */
function isTitleOrAllCaps(words: string[]): boolean {
  const cores = words.map(coreOf).filter(Boolean);
  if (cores.length < 2) return false;
  if (cores.every((c) => !/\p{Ll}/u.test(c))) return true;   // ALL CAPS (or caps+digits)
  if (!/^[\p{Lu}\p{N}]/u.test(cores[0])) return false;       // a title starts capitalized
  let capped = 0;
  for (const c of cores) {
    if (/^[\p{Lu}\p{N}]/u.test(c)) { capped++; continue; }
    if (!TITLE_STOPWORDS.has(c.toLowerCase())) return false; // lowercase content word ⇒ prose
  }
  return capped >= 2;
}

/**
 * Is this whole block a heading?
 *
 * `structural` short-circuits everything: the block came from an `<h1>`-`<h6>`,
 * so it is a heading BY MARKUP and nothing needs inferring. That path exists
 * because `extractTextFromXhtml` appends a period to headings for the TTS read,
 * which made the no-terminal-punctuation rule below score every semantically
 * marked-up EPUB at zero headings.
 *
 * Otherwise this is a HEURISTIC, and it is deliberately narrow, because the label
 * has teeth: a corpus cutter that drops `NOTE heading` cues drops whatever this
 * gets wrong, so a false positive silently deletes real narration from a training
 * set. "Short and unpunctuated" alone was far too loose — it swallowed
 * `<li>Bread</li>`, a one-word "Yes", a dialogue fragment ending in a dash. A
 * block now has to LOOK like a set heading:
 *
 *   * bare numbering ("1", "IV", "12.") — the chapter-number block; or
 *   * a recognized heading lead word ("Part I", "Chapter 3", "Notes"); or
 *   * two or more words, all Title Case or all ALL CAPS,
 *
 * the last two also being short and carrying no terminal punctuation — where
 * terminal includes ':' and ';', which end a lead-in ("The rules are:"), not a title.
 *
 * NUMBERING IS TESTED FIRST, BEFORE THE PUNCTUATION GATE, and the order is the
 * whole point. Testing it after meant the `[.)]` tail in the numbering pattern was
 * dead code: "1." and "12." were rejected by the punctuation gate before numbering
 * was ever consulted, so a `<p class="cn">1.</p>` chapter number — at least as
 * common as the bare "1" — got no cue at all and its spoken announcement fell into
 * the previous prose cue's tail, while "IV." came out as ordinary prose.
 *
 * KNOWN LIMIT (accepted): the Title Case arm will tag a short capitalized line that
 * is really prose — "Mr. Smith", "New York", "Thank You", "Oh God" — as a heading.
 * It is a heuristic for publishers who set headings as `<p class="cn">`, and it
 * cannot be made exact from text alone. `<h1>`-`<h6>` is the exact path; see the
 * README's note before wiring a cutter to drop these cues.
 */
function looksLikeHeading(block: string, structural = false): boolean {
  const b = block.replace(/\s+/g, ' ').trim();
  if (!b) return false;
  if (structural) return true;
  if (b.length > HEADING_MAX_CHARS) return false;
  const words = b.split(' ');
  if (words.length > HEADING_MAX_WORDS) return false;
  if (isNumberingOnly(b)) return true;
  if (/[.!?…:;,]["”’')\]]*$/.test(b)) return false;
  if (HEADING_LEAD.test(b)) return true;
  return isTitleOrAllCaps(words);
}

/**
 * Split the ebook's plain text into sentences (reading order).
 *
 * PARAGRAPH STRUCTURE IS A SENTENCE BOUNDARY (2026-09-03). `extractTextFromXhtml`
 * goes to real trouble to preserve block structure — every `</p>`, `</h1-6>`,
 * `</li>`, `</blockquote>`, `</figcaption>` becomes a blank line — and this
 * function used to throw all of it away on its first statement (`\s+` → ' ')
 * before splitting on punctuation alone. The cost was measured on William
 * McKinley (Phillips, 2003): headings are `<p class="pn">Part I</p>`,
 * `<p class="cn">1</p>`, `<p class="ct">William McKinley, Ohioan</p>` — separate
 * blocks with NO terminal punctuation, so the punctuation split could not see
 * them and glued each one onto the prose that followed:
 *
 *   "Part I Ohio Born and Molded 1 William McKinley, Ohioan It is generally
 *    believed by strangers that…"  → ONE 24-second cue.
 *
 * 168 of 2,370 cues (7.1%) opened that way. Every one is poison for a
 * training-corpus cut: the heading read, and the long pause the narrator leaves
 * after it, are invisible inside a prose cue, so the cutter slices mid-pause and
 * ships a clip whose first seconds are a title announcement.
 *
 * So: split on blank lines FIRST, sentence-split WITHIN each block. Headings get
 * their own cue and a `kind`; nothing crosses a paragraph boundary. Single
 * newlines (authored `<br>`, verse lines) still do not split — only real block
 * boundaries do.
 */
export function splitSentences(text: string, paragraphAware = true): AlignSentence[] {
  const blocks = paragraphAware ? text.split(/\n[ \t]*\n+/) : [text];
  const out: AlignSentence[] = [];
  for (const raw of blocks) {
    // A block the extractor stamped as an <h1>-<h6> is a heading by markup.
    const structural = raw.trimStart().startsWith(HEADING_MARKER);
    const block = structural ? raw.replace(HEADING_MARKER, '') : raw;
    const heading = paragraphAware && looksLikeHeading(block, structural);
    if (heading) {
      // A HEADING IS ONE CUE, EMITTED WHOLE — never routed through the sentence
      // splitter, whose final filter (`length > 1 && /[A-Za-z]/`) exists to bin
      // stray fragments and ate the very blocks this feature is named for:
      // splitBlockIntoSentences('1') and ('I') both returned [], so the chapter
      // number `<p class="cn">1</p>` got no cue at all and its spoken
      // announcement fell into the tail of the previous prose cue — the exact
      // defect this change set out to fix, reintroduced one line lower down.
      const t = block.split(HEADING_MARKER).join(' ').replace(/\s+/g, ' ').trim();
      if (t) out.push({ text: t, kind: 'heading' });
      continue;
    }
    for (const s of splitBlockIntoSentences(block)) {
      out.push({ text: s, kind: 'prose' });
    }
  }
  return out;
}

/**
 * Sentence-split ONE block: normalizes whitespace, then splits on sentence-final
 * punctuation followed by whitespace and an opening capital/quote. Simple and
 * robust — the aligner is tolerant of rough boundaries, and keeping this cheap
 * avoids dragging in an NLP dependency.
 *
 * Scene-break glyphs (`*`, `* * *`, `⁂`, `•`) between sentences are treated as
 * part of the separator and dropped. Gluing across them was an alignment trap:
 * `"She made us all love her." * Up in the director's gallery…` became ONE
 * sentence whose opening tokens belong to the PREVIOUS scene — and a scene seam
 * is exactly where dramatized audiobooks put music bridges, so the aligner keyed
 * the new scene's first cue on words that are never spoken there.
 */
/**
 * WHERE ONE SENTENCE ENDS AND THE NEXT BEGINS, in a block of prose.
 *
 * Terminal punctuation, an optional closing quote, whitespace (with any
 * scene-break glyphs swallowed), then an opening capital or quote.
 *
 * THE PERIOD BRANCH IS GUARDED AND THE OTHERS ARE NOT, deliberately: `!` and `?`
 * are unambiguous terminators, while `.` is also an abbreviation mark and an
 * initial. `R.L. Dabney` came out as two cues in every aligned transcript until
 * 2026-09-10 (Owen: "thats a persons name"), and so did `Mr. Darcy` and
 * `St. Louis` — this splitter had no guard at all, where narrator's renderer has
 * had one since the port. Both rules and the table they come from are in
 * shared/text/sentence-abbreviations.ts.
 *
 * BUILT ONCE, at module load. The guard is ~120 lookbehinds; recompiling it per
 * block would cost real time on a book with thousands of them.
 */
const SENTENCE_BOUNDARY = new RegExp(
  `(?<=(?:${periodTerminatorGuard()}\\.|[!?…])["”'’]?|["”])\\s+(?:[*⁂•#]+\\s+)*(?=[A-Z“"'‘“])`,
);

function splitBlockIntoSentences(text: string): string[] {
  // Any structural-heading marker still embedded here is a mid-block one (or the
  // whole text in --no-paragraph-split mode). It is a transport marker, never
  // prose — strip it so it can't reach a cue.
  const normalized = text.split(HEADING_MARKER).join(' ').replace(/\s+/g, ' ').trim()
    // ORPHANED ENDNOTE MARKERS (2026-07-24). epub-processor now strips digits-only
    // <sup> at the source, but text can reach us already flattened (a supplied VTT,
    // a cached extraction, a PDF-derived epub whose markup was lost). Such a marker
    // sits BETWEEN the terminator and the next capital — "…first one. 1 This
    // declaration…" — where it does double damage: the split below requires [A-Z]
    // immediately after the whitespace, so the digit BLOCKS the split, merging two
    // sentences AND embedding a token the narrator never speaks. Measured on The
    // Third Reich in Power: 1,283 of 8,246 cues (15.6%).
    //
    // Bounded to 1-3 digits so a sentence legitimately opening with a year
    // ("…ended. 1933 saw…") can never match; ai-cleanup-prepass.detectFootnotes
    // remains the tool for inferring markers in text with no markup at all.
    .replace(/([.!?…]["”'’]?)\s+\d{1,3}\s+(?=[A-Z“"'‘])/g, '$1 ');
  if (!normalized) return [];
  return normalized
    .split(SENTENCE_BOUNDARY)
    // A scene-break glyph run at the very start of a piece has no preceding
    // terminator to hang the split on — strip it rather than let it poison the
    // sentence's opening tokens.
    .map((s) => s.replace(/^(?:[*⁂•#]+\s+)+/, '').trim())
    // Drop empties and trivial heading-only fragments (a lone number / single
    // short token with no sentence punctuation) that carry no alignable speech.
    .filter((s) => s.length > 1 && /[A-Za-z]/.test(s));
}

/** Map the script's STAGE names to friendly progress messages. */
function stageMessage(stage: string): string {
  switch (stage) {
    case 'prepare': return 'Preparing audio…';
    case 'transcribe': return 'Transcribing narration…';
    case 'coarse-align': return 'Aligning your ebook to the audio…';
    case 'align': return 'Aligning your ebook to the audio…';
    case 'write': return 'Writing subtitles…';
    default: return 'Aligning your ebook to the audio…';
  }
}

/**
 * Force-align the ebook variant identified by `config.epubVariantId` to the
 * audiobook at `config.m4bPath`. Returns the produced VTT path + cue count.
 * Throws with a clear message if the variant can't be resolved, no Crucible can
 * take the run, or the alignment fails there.
 */
export async function runEpubAlign(
  jobId: string,
  win: BrowserWindow,
  config: GenerateSentencesConfig,
): Promise<{ vttPath: string; cues: number; warning?: string }> {
  if (!config.epubVariantId) throw new Error('epub-align requires an ebook variant id');

  // 1. Resolve the ebook variant → absolute epub path. (The file-based work lives in
  // runEpubAlignOnFiles so the headless CLI can align an arbitrary epub+audio pair
  // without a project manifest.)
  const mf = await manifestService.getManifest(config.projectId);
  if (!mf.success || !mf.manifest) {
    throw new Error(mf.error || `Project not found: ${config.projectId}`);
  }
  const { variants } = manifestService.getVariants(mf.manifest);
  const variant = variants.find((v) => v.id === config.epubVariantId);
  if (!variant) throw new Error(`Ebook variant not found: ${config.epubVariantId}`);
  /*
   * `kind === 'ebook'` WAS THE WHOLE TEST AND IT LET A PDF THROUGH. An archive
   * PDF is an ebook version of the book, so it passed here and was handed to
   * `loadEpubForComparison` — which is a zip reader. The refusal is by FORMAT
   * now, and it is worded for a person because that is who reads it: the file is
   * visible on the versions page, and "why is it not in the dropdown" is the
   * question this sentence answers. See shared/document/alignable-text.ts for
   * why a PDF's text layer is not the book's words.
   *
   * IN THE BRIDGE, not only in the picker. The dropdown no longer offers a PDF,
   * but this door is also reached by a queue row restored from before the fix
   * and by the CLI, and neither goes past the picker.
   */
  const refusal = alignableTextRefusal(variant, config.epubVariantId);
  if (refusal) throw new Error(refusal);
  const epubPath = manifestService.resolveManifestPath(config.projectId, variant.path);
  if (!fs.existsSync(epubPath)) throw new Error(`Ebook file not found: ${epubPath}`);

  /*
   * THE VENUE THE QUEUE ASSIGNED, passed through rather than re-decided. The row
   * already carries it (`GenerateSentencesConfig.runVenue`, written by the pump
   * at admission), and asking again here would be a second answer to "which
   * machine is this book on" — the thing §4.4 exists to make one answer. A
   * caller-named server (`config.crucible`) must agree with it.
   */
  return runEpubAlignOnFiles(jobId, win, epubPath, config.m4bPath, config.language, {
    ...(config.runVenue === undefined ? {} : { runVenue: config.runVenue }),
    ...(config.crucible === undefined ? {} : { crucibleServer: config.crucible.server }),
  });
}

/**
 * The ebook's sentences in reading order, exactly as every alignment reads them —
 * the whole-book run below and the clips run (runEpubAlignOnClips) both come
 * through here, so a clip gets the same sentence boundaries a book would.
 */
async function extractAlignSentences(epubPath: string, paragraphAware: boolean): Promise<AlignSentence[]> {
  glog(`[epub-align] extracting sentences from ${epubPath}`);
  // markHeadings: <h1>-<h6> come back stamped, so the classifier never has to
  // infer for a real heading tag. keepFootnoteMarkers stays false (the default) —
  // this path wants markers gone.
  const { chapters } = await loadEpubForComparison(epubPath, false, true);
  // '\n\n', not '\n': a chapter seam is a block boundary like any other, and the
  // paragraph-aware splitter reads blank lines. Joining on a single newline let
  // the last sentence of one chapter fuse with the first heading of the next.
  const fullText = chapters.map((c) => c.text).join('\n\n');
  const sentences = splitSentences(fullText, paragraphAware);
  if (sentences.length === 0) throw new Error('No sentences extracted from the ebook');
  const headingCount = sentences.filter((s) => s.kind === 'heading').length;
  glog(`[epub-align] extracted ${sentences.length} sentences (${headingCount} heading-like, ` +
    `paragraph-aware=${paragraphAware})`);
  return sentences;
}

/**
 * GENERATE SENTENCES FOR CLIPS (Owen, 2026-09-25): "make sure bookforge-cli's
 * generate-sentences can run on clips and find the original text if given the
 * source epub." Many short clips whose places in the book are unknown; each gets
 * the book's exact text, per-sentence times, and its edge-cut sentences reported
 * as partial. Crucible only - the ASR and the aligner are its jobs and the logic
 * is `crucible/clip-sentence-align.ts`; there is no local road for this mode.
 */
export async function runEpubAlignOnClips(
  epubPath: string,
  clips: readonly { id: string; path: string }[],
  language: string | undefined,
  opts: {
    crucibleServer: string;
    outDir: string;
    paragraphAware?: boolean;
    signal?: AbortSignal;
    onProgress?: (p: { stage: string; fraction: number; message: string }) => void;
    onLog?: (line: string) => void;
  },
): Promise<{ jsonPath: string; tsvPath: string; vttDir: string; stats: Record<string, number> }> {
  if (!fs.existsSync(epubPath)) throw new Error(`Ebook file not found: ${epubPath}`);
  const sentences = await extractAlignSentences(epubPath, opts.paragraphAware ?? DEFAULT_PARAGRAPH_AWARE);
  const { runClipSentenceAlign } = await import('./crucible/clip-sentence-align.js');
  glog(`[epub-align/clips] on crucible "${opts.crucibleServer}": ${clips.length} clip(s) against ${sentences.length} sentence(s)`);
  const r = await runClipSentenceAlign({
    server: opts.crucibleServer,
    clips,
    sentences: sentences.map((s) => ({ text: s.text, kind: s.kind })),
    language: crucibleAsrLanguage(language),
    ffmpegPath: getFfmpegPath(),
    outDir: opts.outDir,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    onLog: (line) => { glog(`[epub-align/clips] ${line}`); opts.onLog?.(line); },
  });
  return { jsonPath: r.jsonPath, tsvPath: r.tsvPath, vttDir: r.vttDir, stats: r.stats };
}

/**
 * File-based epub→audio forced alignment: everything runEpubAlign does AFTER the
 * manifest lookup. Takes explicit paths so the headless CLI (and any future caller
 * without a project) can drive the REAL alignment pipeline. `win` is only an event
 * sink (sendProgress guards isDestroyed) — a headless caller passes a stub.
 *
 * WHERE IT RUNS is decided once, the way a render's and a transcription's venue
 * is (`venueForRunStep`): the run's venue when it has one, else the caller's
 * named server, else the routing record. With no server reachable this THROWS
 * with the reason; there is no local aligner to fall back to.
 *
 * `opts.reportPath`: where the run's report goes (stats, notPlaced, extraAudio,
 * flaggedCues — `crucible/sentence-align.ts`); default beside the audio.
 * `opts.roughCachePath`: keep (or reuse) the ASR transcript there, so a re-run on
 * the same audio skips the one long GPU pass.
 * `opts.paragraphAware`: default true — see DEFAULT_PARAGRAPH_AWARE.
 */
export async function runEpubAlignOnFiles(
  jobId: string,
  win: BrowserWindow,
  epubPath: string,
  audioPath: string,
  language?: string,
  opts?: {
    reportPath?: string; roughCachePath?: string; paragraphAware?: boolean;
    /** The run's already-resolved venue (a queue row's `waitForResolved`). */
    runVenue?: { where: 'crucible'; server: string };
    /** The caller's own server NAME (the CLI's `--crucible-server`); must agree with `runVenue`. */
    crucibleServer?: string;
  },
): Promise<{ vttPath: string; cues: number; warning?: string; reportPath?: string }> {
  const reportPath = opts?.reportPath;
  if (!fs.existsSync(epubPath)) throw new Error(`Ebook file not found: ${epubPath}`);
  if (!fs.existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);

  // Extract sentences from the ebook in reading order.
  const paragraphAware = opts?.paragraphAware ?? DEFAULT_PARAGRAPH_AWARE;
  const sentences = await extractAlignSentences(epubPath, paragraphAware);

  const { venueForRunStep } = await import('./crucible/step-venue.js');
  const { processVenueHost } = await import('./crucible/generation-venue.js');
  const venue = await venueForRunStep({
    ...(opts?.runVenue === undefined ? {} : { runVenue: opts.runVenue, runVenueSource: 'the queue row' }),
    ...(opts?.crucibleServer === undefined ? {} : { callerNamed: { server: opts.crucibleServer } }),
    host: processVenueHost(),
  });

  /*
   * ONLY THE SENTENCES AND THE AUDIO CROSS. The EPUB stays here — it is this
   * app's book, and what the server needs from it is text, which the extraction
   * above has already produced with its headings stamped.
   */
  const { runSentenceAlign } = await import('./crucible/sentence-align.js');
  glog(`[epub-align] on crucible "${venue.server}" (${venue.origin}: ${venue.because}): `
    + `${sentences.length} sentence(s), ${path.basename(audioPath)} (qwen3-asr + qwen3-aligner, BookForge diff)`);
  const outDir = path.dirname(reportPath ?? audioPath);
  const stop = new AbortController();
  activeAligns.set(jobId, { where: 'crucible', stop });
  try {
    const r = await runSentenceAlign({
      server: venue.server,
      audioPath,
      sentences: sentences.map((s) => ({ text: s.text, kind: s.kind })),
      language: crucibleAsrLanguage(language),
      ffmpegPath: getFfmpegPath(),
      outVttPath: path.join(outDir, 'alignment.vtt'),
      reportPath: reportPath ?? path.join(outDir, 'align-report.json'),
      ...(opts?.roughCachePath ? { transcriptCachePath: opts.roughCachePath } : {}),
      signal: stop.signal,
      onProgress: (p) => sendProgress(win, jobId, Math.round(p.fraction * 100), p.message || stageMessage(p.stage)),
      onLog: (line) => glog(`[epub-align/crucible] ${line}`),
    });
    glog(`[epub-align] crucible "${venue.server}": ${r.cues} cue(s) placed`);
    return { vttPath: r.vttPath, cues: r.cues, reportPath: r.reportPath };
  } finally {
    activeAligns.delete(jobId);
  }
}
