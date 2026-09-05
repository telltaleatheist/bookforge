/**
 * WhisperX force-alignment bridge — aligns a project's EPUB text to its audiobook
 * to produce ACCURATE read-along subtitles.
 *
 * Unlike the whisper transcription path (generate-sentences-bridge), which infers
 * the words from the audio (and so inherits ASR spelling/word errors), this path
 * takes the ebook as ground truth: it extracts the ebook's sentences in reading
 * order, hands them to `align_audiobook.py` (WhisperX rough-transcribe → coarse
 * DTW align → per-sentence forced alignment), and gets back a VTT whose text is
 * the ebook's own words with real audio timings.
 *
 * The heavy lifting runs in the CPU-only `whisperx-env` conda env; this bridge
 * resolves the env's python + the packaged script, spawns it, and translates the
 * script's STDOUT progress protocol into 'generate-sentences:progress' events.
 * The caller (startGenerateSentences) owns embed + manifest linking + completion.
 */

import { BrowserWindow, app } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { loadEpubForComparison, HEADING_MARKER } from './epub-processor.js';
import { componentManager } from './components/component-manager.js';
import { namedCondaEnvCandidates } from './components/conda-env-detect.js';
import * as manifestService from './manifest-service.js';
import { toUnpackedPath } from './narrator-paths.js';
import { getFfmpegPath } from './tool-paths.js';
import { GenerateSentencesConfig, sendProgress, glog, gerror } from './generate-sentences-bridge.js';
import { StageTracker, type StageSpec } from './job-stages.js';

/** Managed-component id for the CPU-only WhisperX alignment env. */
export const WHISPERX_ENV_ID = 'whisperx-env';

/**
 * Live align children, keyed by jobId, so a queue cancel can actually REACH them.
 *
 * BUG (2026-07-24): the align child was spawned into a local variable with no
 * registry and no kill path. generate-sentences' cancel is COOPERATIVE — it sets a
 * flag checked *between* stages — but the align stage is the long one and never
 * checks it, so cancelling mid-align left WhisperX running to completion, holding
 * the GPU. Owen hit this: two orphaned align_audiobook.py trees survived the queue
 * X and had to be taskkill'd by hand.
 */
const activeAlignChildren = new Map<string, ChildProcess>();

/**
 * Kill the align child for a job, whole tree. WhisperX spawns multiprocessing
 * workers, so signalling only the parent orphans them (measured: the forked
 * children kept the GPU after the parent died) — Windows needs taskkill /T.
 * Safe to call for an unknown//already-finished jobId.
 */
export function cancelEpubAlign(jobId: string): void {
  const child = activeAlignChildren.get(jobId);
  if (!child) return;
  const pid = child.pid;
  glog(`[epub-align] cancel requested job=${jobId} pid=${pid ?? 'none'}`);
  try {
    if (pid && os.platform() === 'win32') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('child_process').execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else if (pid) {
      try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* already exited — the close handler clears the registry */
  }
  activeAlignChildren.delete(jobId);
}

/**
 * Resolve the python executable inside a conda env root (mirrors
 * component-manager's envPython).
 *
 * EXPORTED for `coverage-align-job.ts`, which spawns `narrator align --python
 * <this>` and must name the same interpreter this bridge does. A second copy of
 * the resolution there would be a second answer to "where is WhisperX" — and the
 * one that goes stale is always the copy, not the original.
 */
export function whisperxEnvPython(envRoot: string): string {
  return envPython(envRoot);
}

function envPython(envRoot: string): string {
  if (os.platform() === 'win32') {
    const direct = path.join(envRoot, 'python.exe');
    if (fs.existsSync(direct)) return direct;
    const scripts = path.join(envRoot, 'Scripts', 'python.exe');
    if (fs.existsSync(scripts)) return scripts;
    return direct; // best guess
  }
  return path.join(envRoot, 'bin', 'python');
}

/**
 * Resolve the WhisperX env root, in order of preference:
 *   1. the installed managed component (production),
 *   2. WHISPERX_ENV_PATH (explicit dev override),
 *   3. a local `whisperx` conda env auto-detected on disk (dev convenience).
 * Each candidate is only accepted if its python actually exists.
 *
 * EXPORTED for `coverage-align-job.ts` — see `whisperxEnvPython`. The two align
 * paths (this bridge's whole-m4b alignment, and narrator's per-chunk coverage
 * pass) must find the SAME env, including the dev auto-detect, or a machine that
 * can do one can mysteriously not do the other.
 */
export function resolveWhisperxEnvRoot(): string | null {
  const managed = componentManager.resolveEntry(WHISPERX_ENV_ID);
  if (managed && fs.existsSync(envPython(managed))) return managed;

  const override = process.env.WHISPERX_ENV_PATH;
  if (override && fs.existsSync(envPython(override))) return override;

  for (const c of namedCondaEnvCandidates('whisperx')) {
    if (c.platform === process.platform && fs.existsSync(envPython(c.path))) {
      glog(`[epub-align] auto-detected whisperx env at ${c.path}`);
      return c.path;
    }
  }
  return null;
}

/** Locate align_audiobook.py in dev (electron/scripts) or packaged (dist/electron/scripts, asarUnpack'd). */
function resolveAlignScript(): string {
  const candidates = [
    path.join(app.getAppPath(), 'electron', 'scripts', 'align_audiobook.py'),
    path.join(__dirname, '..', '..', 'electron', 'scripts', 'align_audiobook.py'),
    path.join(__dirname, 'scripts', 'align_audiobook.py'),
  ];
  const found = candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
  // Packaged: the spawned python can't read inside app.asar — hand it the
  // asarUnpack'd real file (dist/electron/scripts/** is unpacked).
  return toUnpackedPath(found);
}

/**
 * THE DEFAULTS FOR EVERY CALLER THAT PASSES NO OPTIONS — the app's Generate
 * Sentences button included. Named and gathered here because these three changed
 * the GUI's output in 2026-09-03 with no switch in the UI, and a default that
 * silently alters a shipped artifact deserves to be a decision someone can find.
 *
 *  * paragraph-aware segmentation: ON. It fixes a real defect (headings fused into
 *    the first prose cue) and the read-along text is strictly better for it.
 *  * silence snapping at 0.6 s: ON. Measured on McKinley, boundaries inside a
 *    detected pause went 18.6% -> 95.4% with drift unchanged. Bounded, so the
 *    worst case is a no-op.
 *  * report hole threshold: UNSET, i.e. it follows --hole-min-s (30 s) exactly as
 *    before. Lowering it changes what `audioNotInEpub` MEANS (see
 *    align_audiobook.py find_holes — it measures "cue longer than a slow reading
 *    of its text", not literal unmatched audio), so it is opt-in per run and the
 *    default report is unchanged.
 */
export const DEFAULT_PARAGRAPH_AWARE = true;
export const DEFAULT_SNAP_SILENCE_S = 0.6;

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
    .split(/(?<=[.!?…]["”'’]?|["”])\s+(?:[*⁂•#]+\s+)*(?=[A-Z“"'‘“])/)
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
 * The five pipeline stages, in order, each rendered as its own stacked bar. The
 * `weight` values are the stage's share of wall-clock time (they sum to 1) and
 * drive the headline master bar as a duration-weighted average of the per-stage
 * fractions — so it tracks real elapsed progress instead of lurching when the two
 * near-instant stages (prepare/coarse-align/write) snap to 100%. A flat average
 * would jump the master bar 40% for ~2s of actual work; these weights don't.
 */
const ALIGN_STAGES: ReadonlyArray<StageSpec> = [
  { name: 'prepare', label: 'Preparing audio', weight: 0.03 },
  { name: 'transcribe', label: 'Transcribing narration', weight: 0.45 },
  { name: 'coarse-align', label: 'Matching text to audio', weight: 0.04 },
  { name: 'align', label: 'Fine-aligning', weight: 0.46 },
  { name: 'write', label: 'Writing subtitles', weight: 0.02 },
];

interface AlignResult {
  ok: boolean;
  vtt?: string;
  cues?: number;
  fallbackCues?: number;
  trimmedHead?: number;
  trimmedTail?: number;
  aligned?: number;
  /** ok:false — the script's terminal error message. */
  error?: string;
  /** Rough-transcribe slices that errored (each ≈10 min of audio missing from the anchor stream). */
  failedSlices?: number;
  totalSlices?: number;
  /** Align chunks that errored (their sentences carry coarse timing, not forced alignment). */
  failedChunks?: number;
  totalChunks?: number;
  /** Drift self-check: cues verified against the rough transcript / worst pre-fix offset / cues corrected. */
  driftChecked?: number;
  driftMaxAbs?: number;
  driftFixed?: number;
  /** Boundary snapping: cue seams moved onto the middle of a detected silence / total seams considered. */
  snappedBoundaries?: number;
  totalBoundaries?: number;
  /** Cues carrying a `NOTE heading` tag (headings the segmenter gave their own cue). */
  headingCues?: number;
  /** Path of the coverage report the script wrote (only when --report was passed). */
  report?: string | null;
}

/**
 * Force-align the ebook variant identified by `config.epubVariantId` to the
 * audiobook at `config.m4bPath`. Returns the produced VTT path + cue count.
 * Throws with a clear message if the engine is missing, the variant can't be
 * resolved, or the script fails — the caller catches and falls back to whisper.
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
  if (variant.kind !== 'ebook') {
    throw new Error(`Variant ${config.epubVariantId} is not an ebook (kind=${variant.kind})`);
  }
  const epubPath = manifestService.resolveManifestPath(config.projectId, variant.path);
  if (!fs.existsSync(epubPath)) throw new Error(`Ebook file not found: ${epubPath}`);

  return runEpubAlignOnFiles(jobId, win, epubPath, config.m4bPath, config.language);
}

/**
 * File-based epub→audio forced alignment: everything runEpubAlign does AFTER the
 * manifest lookup. Takes explicit paths so the headless CLI (and any future caller
 * without a project) can drive the REAL alignment pipeline. `win` is only an event
 * sink (sendProgress guards isDestroyed) — a headless caller passes a stub.
 *
 * `opts.reportPath`: also write a coverage-report JSON there — which epub
 * sentence runs were never narrated and which audio ranges have no epub match
 * (ads/intros/disc breaks), each with text + timestamp anchors. The script fills
 * everything except the epub path (it only sees extracted sentences), which is
 * patched in here after a successful run.
 * `opts.holeMinS`: minimum unmatched-audio duration (s) treated as a hole — both
 * for the report and for whisper-fallback cue filling. 0 = every positive gap.
 * `opts.roughCachePath`: opt-in — cache the rough whisper transcript (words + segs
 * + lang) at this path so re-runs skip the ~30-40 min transcribe pass. Absent =
 * no caching (no behavior change). The caller supplies an explicit path.
 * `opts.alignWorkers`: opt-in override for the parallel align worker count. Absent
 * = the script auto-sizes (conservative: reserves 12 GB headroom for a concurrent
 * WSL vLLM lane, so it may pick 1 worker even with RAM free). Pass a positive int
 * only when the GPU/WSL lane is known idle; each worker budgets ~5 GB and the pool
 * self-shrinks under memory pressure regardless.
 * `opts.paragraphAware`: default true — segment the ebook on block boundaries as
 * well as punctuation, so unpunctuated headings stop being glued onto the prose
 * that follows them (see splitSentences). Pass false for the pre-2026-09-03
 * punctuation-only segmentation.
 * `opts.snapSilenceS`: default 0.6 — bounded window (s) for snapping each cue
 * boundary to the middle of a detected silence. 0 disables snapping.
 * `opts.reportHoleMinS`: minimum unmatched-audio duration (s) LISTED IN THE
 * REPORT, decoupled from `holeMinS` (which still governs whisper-fallback cue
 * filling and so changes the VTT). Default 3 — short stings, credits and applause
 * beds surface without inserting a single ASR cue.
 */
export async function runEpubAlignOnFiles(
  jobId: string,
  win: BrowserWindow,
  epubPath: string,
  audioPath: string,
  language?: string,
  opts?: {
    reportPath?: string; holeMinS?: number; roughCachePath?: string; alignWorkers?: number; device?: string;
    paragraphAware?: boolean; snapSilenceS?: number; reportHoleMinS?: number;
  },
): Promise<{ vttPath: string; cues: number; warning?: string; reportPath?: string }> {
  const reportPath = opts?.reportPath;
  if (!fs.existsSync(epubPath)) throw new Error(`Ebook file not found: ${epubPath}`);
  if (!fs.existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);

  // 2. Extract sentences from the ebook in reading order.
  glog(`[epub-align] extracting sentences from ${epubPath}`);
  // markHeadings: <h1>-<h6> come back stamped, so the classifier never has to
  // infer for a real heading tag. keepFootnoteMarkers stays false (the default) —
  // this path wants markers gone.
  const { chapters } = await loadEpubForComparison(epubPath, false, true);
  // '\n\n', not '\n': a chapter seam is a block boundary like any other, and the
  // paragraph-aware splitter reads blank lines. Joining on a single newline let
  // the last sentence of one chapter fuse with the first heading of the next.
  const fullText = chapters.map((c) => c.text).join('\n\n');
  const paragraphAware = opts?.paragraphAware ?? DEFAULT_PARAGRAPH_AWARE;
  const sentences = splitSentences(fullText, paragraphAware);
  if (sentences.length === 0) throw new Error('No sentences extracted from the ebook');
  const headingCount = sentences.filter((s) => s.kind === 'heading').length;
  glog(`[epub-align] extracted ${sentences.length} sentences (${headingCount} heading-like, ` +
    `paragraph-aware=${paragraphAware})`);

  // 3. Resolve the whisperx env python.
  const envRoot = resolveWhisperxEnvRoot();
  if (!envRoot) {
    throw new Error(
      'WhisperX alignment engine is not installed. Install it in Settings → Add-ons (or set WHISPERX_ENV_PATH for dev).',
    );
  }
  const python = envPython(envRoot);
  const scriptPath = resolveAlignScript();

  // 4. Write the sentences to a temp JSON file (cleaned up in finally).
  const sentsJsonPath = path.join(os.tmpdir(), `bookforge-align-${jobId}-${Date.now()}.json`);
  fs.writeFileSync(sentsJsonPath, JSON.stringify(sentences), 'utf-8');

  // VTT is a temporary build artifact. Generate Sentences embeds it into the m4b
  // and removes it; no persistent sidecar belongs in the project output folder.
  const m4bPath = audioPath;
  const outVtt = path.join(os.tmpdir(), `bookforge-align-${jobId}-${Date.now()}.vtt`);

  const langCode = language && language !== 'auto' ? language : 'en';

  // Managed torch cache so the wav2vec2 align model (~378 MB, fetched on first
  // use) persists in the app's runtime folder instead of the user's ~/.cache.
  // torch stores it at <TORCH_HOME>/hub/checkpoints/.
  const torchHome = path.join(app.getPath('userData'), 'runtime', 'whisperx-cache');
  try { fs.mkdirSync(torchHome, { recursive: true }); } catch { /* best-effort */ }

  // Put the app's bundled ffmpeg/ffprobe on PATH so the script's slicing calls
  // AND whisperx.load_audio's internal ffmpeg resolve correctly (packaged apps
  // don't have ffmpeg on the system PATH).
  let ffmpegDir = '';
  try { ffmpegDir = path.dirname(getFfmpegPath()); } catch { /* fall back to system ffmpeg */ }
  const spawnPath = ffmpegDir ? `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}` : (process.env.PATH || '');

  glog(`[epub-align] spawning python=${python} script=${scriptPath} lang=${langCode} out=${outVtt}`);

  try {
    return await new Promise<{ vttPath: string; cues: number; warning?: string; reportPath?: string }>((resolve, reject) => {
      const args = [
        scriptPath,
        '--audio', m4bPath,
        '--sentences', sentsJsonPath,
        '--out', outVtt,
        '--rough-model', 'base',
        '--lang', langCode,
      ];
      if (reportPath) args.push('--report', reportPath);
      // Explicit compute device (cpu|mps|cuda|auto). Absent -> align_audiobook.py
      // auto-selects (CUDA -> MPS -> CPU). Pass 'cpu' to keep align off a busy GPU.
      if (opts?.device) args.push('--device', opts.device);
      if (opts?.roughCachePath) args.push('--rough-cache', opts.roughCachePath);
      if (opts?.alignWorkers !== undefined) {
        if (!Number.isInteger(opts.alignWorkers) || opts.alignWorkers < 1) {
          reject(new Error(`alignWorkers must be a positive integer (got ${opts.alignWorkers})`));
          return;
        }
        args.push('--workers', String(opts.alignWorkers));
      }
      if (opts?.holeMinS !== undefined) {
        if (!Number.isFinite(opts.holeMinS) || opts.holeMinS < 0) {
          reject(new Error(`holeMinS must be a finite number >= 0 (got ${opts.holeMinS})`));
          return;
        }
        args.push('--hole-min-s', String(opts.holeMinS));
      }
      if (opts?.snapSilenceS !== undefined) {
        if (!Number.isFinite(opts.snapSilenceS) || opts.snapSilenceS < 0) {
          reject(new Error(`snapSilenceS must be a finite number >= 0 (got ${opts.snapSilenceS})`));
          return;
        }
        args.push('--snap-silence-s', String(opts.snapSilenceS));
      }
      if (opts?.reportHoleMinS !== undefined) {
        if (!Number.isFinite(opts.reportHoleMinS) || opts.reportHoleMinS < 0) {
          reject(new Error(`reportHoleMinS must be a finite number >= 0 (got ${opts.reportHoleMinS})`));
          return;
        }
        args.push('--report-hole-min-s', String(opts.reportHoleMinS));
      }

      let child: ChildProcess;
      try {
        child = spawn(python, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: spawnPath,
            PYTHONIOENCODING: 'UTF-8',
            TOKENIZERS_PARALLELISM: 'false',
            TORCH_HOME: torchHome,
          },
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      let result: AlignResult | null = null;
      let errorLine = '';
      let stderr = '';
      let buf = '';
      // Five stacked stage bars. The script reports a live fraction only for the
      // two long stages (transcribe/align) via SUBPROGRESS; the near-instant
      // stages are filled to 100% here the moment the next STAGE begins. The
      // headline percentage is the duration-weighted average (ALIGN_STAGES.weight),
      // which is naturally monotonic since every stage pct only ever increases.
      const stages = new StageTracker([...ALIGN_STAGES]);
      let stageMsg = stageMessage('prepare');
      const emitStages = () => {
        sendProgress(win, jobId, stages.master(), stageMsg, stages.snapshot());
      };

      const handleLine = (raw: string) => {
        const line = raw.trim();
        if (!line) return;
        const stage = /^STAGE\s+(\S+)/.exec(line);
        if (stage) {
          if (stages.has(stage[1])) {
            stages.start(stage[1]);
            stageMsg = stageMessage(stage[1]);
            emitStages();
          }
          return;
        }
        const sub = /^SUBPROGRESS\s+(\S+)\s+(\d+)/.exec(line);
        if (sub) {
          if (stages.has(sub[1])) {
            stages.set(sub[1], parseInt(sub[2], 10));
            emitStages();
          }
          return;
        }
        // Raw PROGRESS lines are now redundant for the align path — the master bar
        // is derived from the weighted stage fractions above — so they're ignored.
        if (/^PROGRESS\s+\d+/.test(line)) return;
        const res = /^RESULT\s+(.+)$/.exec(line);
        if (res) {
          try { result = JSON.parse(res[1]) as AlignResult; }
          catch { gerror('[epub-align] failed to parse RESULT line', { line }); }
          return;
        }
        const err = /^ERROR\s+(.+)$/.exec(line);
        if (err) { errorLine = err[1]; return; }
      };

      child.stdout?.on('data', (d: Buffer) => {
        buf += d.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });
      // stderr carries the script's diagnostic log (coarse match rate, dropped
      // runs, chunk failures) — stream it line-by-line so a CLI/console watcher
      // sees WHAT the aligner is doing, not just the progress percentage; the
      // rolling buffer stays for error reporting.
      let errBuf = '';
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString();
        stderr = (stderr + text).slice(-4000);
        errBuf += text;
        let nl: number;
        while ((nl = errBuf.indexOf('\n')) >= 0) {
          const line = errBuf.slice(0, nl).trimEnd();
          errBuf = errBuf.slice(nl + 1);
          if (line) glog(`[epub-align] ${line}`);
        }
      });

      // Register BEFORE any await point so a cancel arriving mid-align can reach it.
      activeAlignChildren.set(jobId, child);

      child.on('error', (err) => {
        activeAlignChildren.delete(jobId);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      child.on('close', (code) => {
        activeAlignChildren.delete(jobId);
        if (buf.trim()) handleLine(buf);
        if (code === 0 && result && result.ok === true && result.vtt) {
          stages.completeAll();
          emitStages();
          glog(`[epub-align] script DONE cues=${result.cues} fallbackCues=${result.fallbackCues ?? 0} trimmedHead=${result.trimmedHead} trimmedTail=${result.trimmedTail} failedSlices=${result.failedSlices ?? 0}/${result.totalSlices ?? 0} failedChunks=${result.failedChunks ?? 0}/${result.totalChunks ?? 0} driftChecked=${result.driftChecked ?? 0} driftMaxAbs=${result.driftMaxAbs ?? 0}s driftFixed=${result.driftFixed ?? 0} snapped=${result.snappedBoundaries ?? 0}/${result.totalBoundaries ?? 0} headingCues=${result.headingCues ?? 0}`);
          // Partial failures still complete (coverage exists) but must be SEEN:
          // each failed slice is ~10 min of audio absent from the anchor stream,
          // each failed chunk leaves its sentences on coarse timing.
          const warnings: string[] = [];
          if (result.failedSlices) {
            warnings.push(`${result.failedSlices} of ${result.totalSlices} transcription slice(s) failed — roughly ${result.failedSlices * 10} min of audio had no transcript to anchor against`);
          }
          if (result.failedChunks) {
            warnings.push(`${result.failedChunks} of ${result.totalChunks} alignment chunk(s) failed — their sentences carry rough timing instead of forced alignment`);
          }
          const warning = warnings.length ? warnings.join('; ') : undefined;
          if (warning) gerror(`[epub-align] completed WITH FAILURES: ${warning}`);
          if (reportPath) {
            // The script wrote the report (or died — we wouldn't be here); patch
            // in the epub path it couldn't know. A missing/corrupt report is a
            // real failure, not something to shrug past.
            try {
              const rep = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
              rep.epub = epubPath;
              fs.writeFileSync(reportPath, JSON.stringify(rep, null, 2), 'utf-8');
            } catch (e) {
              reject(new Error(`epub-align succeeded but the coverage report at ${reportPath} is unreadable: ${e instanceof Error ? e.message : e}`));
              return;
            }
            glog(`[epub-align] coverage report -> ${reportPath}`);
          }
          resolve({ vttPath: result.vtt, cues: result.cues ?? 0, warning, reportPath: reportPath || undefined });
          return;
        }
        // The script's terminal self-report (RESULT ok:false carries the most
        // specific message, e.g. "all slices failed"); then its ERROR line;
        // then raw stderr.
        const detail = (result && result.ok === false && result.error)
          || errorLine || stderr.trim().slice(-500) || `align script exited with code ${code}`;
        reject(new Error(`epub-align failed: ${detail}`));
      });
    });
  } catch (error) {
    try { fs.unlinkSync(outVtt); } catch { /* absent/no partial output */ }
    throw error;
  } finally {
    try { fs.unlinkSync(sentsJsonPath); } catch { /* best-effort cleanup */ }
  }
}
