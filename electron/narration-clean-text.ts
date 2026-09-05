/**
 * narration-clean-text.ts — the FAILSAFE door onto the narration text cleanup,
 * and the file gate that reads what it left behind.
 *
 * ── The ruling ──────────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-05: *"the cleaning step can be done on an epub because the user
 * might forget it should be done at all, and they'll be asked to do it again. it
 * should replace the epub that's currently there if one already exists. if the
 * user deletes the epub and re-exports, the cleaning job will be lost. that's
 * the cost of doing it to an epub. the user can be informed of it. the bookforge
 * clean text action outside of foundry is a failsafe in case the user forgets
 * and just wants to get it done immediately. it won't be treated as the standard
 * method."*
 *
 * So there are two doors onto ONE pass, and only one of them is standard:
 *
 *   THE STANDARD METHOD — press **Clean text** in the hosted Foundry window. It
 *   is a ledger STEP on the document chain, so everything the user does after it
 *   carries the cleanup along, and every EPUB exported from at-or-under that step
 *   carries the stamp.
 *
 *   THE FAILSAFE — this file. It cleans a finished EPUB and REPLACES IT, for the
 *   user who forgot and wants it done now. A file remembers nothing about how it
 *   was made, so deleting the export and re-exporting from the project loses the
 *   cleanup. That is the cost, it is stated to the user before the run
 *   (`NARRATION_TEXT_FAILSAFE_NOTICE`, shared/processing/narration-text-notice.ts),
 *   and it is why this is a failsafe rather than a method.
 *
 * ── There is ONE implementation of the pass, and it is not here ─────────────
 *
 * Owen ruled on 2026-09-05 that the pass itself moves into the Foundry engine as
 * `foundry clean-text` — Foundry owns `NORMALIZER_VERSION` and
 * `PUNCTUATION_SPEC_VERSION` and is the source the training corpora vendor from.
 * BookForge USED to carry its own copy (`electron/narration-text-pass.ts`,
 * deleted with this change) because the engine had no way to clean an arbitrary
 * EPUB in place. Foundry 1.2.0 (`d6509e7`) shipped that door:
 *
 *   foundry clean-text --epub <in.epub> --out <out.epub>
 *                      --endpoint <url> --model <name>
 *
 * It cleans at TEXT-NODE level and preserves the container, the ids, the spine,
 * the file names, `dc:identifier`, every `data-bf-*` attribute and every unedited
 * byte by construction; the `bookforge:narration-text` OPF meta is its only
 * change to the package document. So this module is a SPAWN and nothing else,
 * and BookForge keeps only what reads the result.
 *
 * ── What is still BookForge's ───────────────────────────────────────────────
 *
 *   - the stamp shape and its parser (`electron/epub-processor.ts`);
 *   - {@link narrationTextGate} below — a FILE's own answer, which is what the
 *     render door and the CLI are handed;
 *   - `narrationTextReadiness` (electron/narration-text-readiness.ts) — a
 *     PROJECT's answer, out of the ledger;
 *   - the ledger row itself (`electron/processing-passes.ts`).
 *
 * The engine has no applied-passes model, so none of that could have gone with
 * the pass.
 */
import { promises as fs } from 'fs';
import * as path from 'path';

import { foundryVersionAtLeast } from '../shared/vlm/readings-bank.js';

// ─────────────────────────────────────────────────────────────────────────────
// The settings — the SAME ones the hosted Clean text press uses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The model and the Ollama endpoint a cleanup runs against.
 *
 * READ OUT OF FOUNDRY'S OWN SETTINGS FILE, `userData/app-settings.json`, which
 * is where the hosted **Clean text** dialog gets them: it seeds its two fields
 * from `llm:defaults`, and that handler answers with
 * `{ model: settings.defaultLlmModel, ollama: settings.ollamaUrl }`
 * (foundry-app/electron/ipc.ts). Hosted, Foundry's userData IS BookForge's, so
 * this reads the identical file the identical way and the two doors cannot run a
 * cleanup against different models.
 *
 * MIRRORED, NOT IMPORTED, on `standaloneFoundryProjectsRoot`'s precedent
 * (electron/foundry-adopt.ts): `foundry-app/` is built output of a separate
 * program with its own tsconfig, and importing into it is the subtree merge the
 * seal exists to prevent. So `clampModelTag` and `clampOllamaUrl`
 * (foundry-app/electron/app-settings.ts) are mirrored below, byte-for-byte in
 * behaviour, and their defaults are Foundry's own published constants
 * (`DEFAULT_TRANSLATE_MODEL`, `DEFAULT_OLLAMA_ENDPOINT`, foundry-app/shared/pipeline.ts).
 *
 * THE CLAMPS' DEFAULTS ARE NOT A FALLBACK PAPERING OVER A MISSING VALUE. The
 * question this answers is "what would the hosted press run", and for a settings
 * file with the key absent or malformed the hosted press runs exactly these. A
 * different answer here would be this module having an opinion about somebody
 * else's setting.
 */
export interface CleanTextEngineSettings {
  /** `--model`. */
  model: string;
  /** `--endpoint`. */
  endpoint: string;
  /** Where the answer came from, for the log. */
  source: string;
}

/** Foundry's own default model tag. `DEFAULT_TRANSLATE_MODEL`, their pipeline.ts. */
const FOUNDRY_DEFAULT_MODEL = 'qwen3.8:27b';
/** Foundry's own default Ollama origin. `DEFAULT_OLLAMA_ENDPOINT`, their pipeline.ts. */
const FOUNDRY_DEFAULT_ENDPOINT = 'http://localhost:11434';

/** `clampModelTag`, mirrored: a non-empty single token, or the standing default. */
function clampModelTag(value: unknown): string {
  if (typeof value !== 'string') return FOUNDRY_DEFAULT_MODEL;
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return FOUNDRY_DEFAULT_MODEL;
  return trimmed;
}

/** `clampOllamaUrl`, mirrored: an http(s) origin, or ollama's own. */
function clampOllamaUrl(value: unknown): string {
  if (typeof value !== 'string') return FOUNDRY_DEFAULT_ENDPOINT;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return FOUNDRY_DEFAULT_ENDPOINT;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return FOUNDRY_DEFAULT_ENDPOINT;
    return trimmed;
  } catch {
    return FOUNDRY_DEFAULT_ENDPOINT;
  }
}

/**
 * Read `<userDataDir>/app-settings.json` the way Foundry reads it.
 *
 * `userDataDir` is PASSED IN rather than derived from `app.getPath` for
 * `standaloneFoundryProjectsRoot`'s reason: a keeper has to be able to point it
 * at a temp folder, and deriving it here would make that impossible. The
 * production caller is {@link cleanTextEngineSettings}.
 */
export async function cleanTextEngineSettingsIn(
  userDataDir: string,
): Promise<CleanTextEngineSettings> {
  const settingsPath = path.join(userDataDir, 'app-settings.json');
  let raw: unknown = null;
  try {
    raw = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  } catch {
    // Foundry itself reads an absent or unparsable file as its defaults
    // (`readAppSettings` → the clamps with no value), so this is what the hosted
    // press would run. Said in the answer's `source` rather than swallowed.
    return {
      model: FOUNDRY_DEFAULT_MODEL,
      endpoint: FOUNDRY_DEFAULT_ENDPOINT,
      source: `${settingsPath} could not be read, so this is what the hosted Clean text press `
        + 'would run: Foundry at its own defaults',
    };
  }
  const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    model: clampModelTag(record['defaultLlmModel']),
    endpoint: clampOllamaUrl(record['ollamaUrl']),
    source: settingsPath,
  };
}

/**
 * The settings the hosted Clean text press uses, from Electron's own userData.
 *
 * `require`, NOT `await import`. Under `module: NodeNext` tsc PRESERVES a
 * dynamic `import()` in a CommonJS emit, so it goes through Node's ESM loader
 * and past `Module._load` — which is what `cli/electron-stub.js` overrides. A
 * headless run (the CLI, a keeper) would get the real, absent Electron and read
 * `app` off `undefined`. `require` is the call the stub can see.
 */
export async function cleanTextEngineSettings(): Promise<CleanTextEngineSettings> {
  const { app } = require('electron') as typeof import('electron');
  return cleanTextEngineSettingsIn(app.getPath('userData'));
}

// ─────────────────────────────────────────────────────────────────────────────
// The receipt and the sidecars foundry writes beside --out
// ─────────────────────────────────────────────────────────────────────────────

/** One punctuation span the pass could read but was not allowed to apply. */
export interface PunctuationRefusal {
  key: string;
  file: string;
  find: string;
  replace: string;
  reason: string;
}

/** What `clean-text`'s punctuation stage did, out of `<out>.receipt.json`. */
export interface PunctuationStageRecord {
  spec: string;
  targetsChanged: number;
  spansApplied: number;
  counts: Record<string, number>;
  refused: PunctuationRefusal[];
}

/**
 * `<out>.receipt.json`, as the engine writes it (src/clean/epub.ts).
 *
 * Declared here against Foundry's published shape rather than inferred, for the
 * mount contract's reason: the two repositories do not compile against each
 * other, and a field renamed there must show up as a named refusal rather than
 * as an `undefined` in a ledger row.
 */
export interface CleanTextReceipt {
  normalizerVersion: string;
  punctuationSpec: string;
  model: string;
  at: string;
  /** The EPUB the engine read. */
  source: string;
  punctuation: PunctuationStageRecord;
  /**
   * One row per block, with every proposed edit and the verdict it got —
   * `NumberUnitRecord[]`, the shape `electron/tts-number-normalizer.ts` declares
   * and the engine's vendored copy still writes.
   */
  units: ReadonlyArray<{
    key: string;
    file: string;
    status: string;
    edits: ReadonlyArray<{ find: string; replace: string; status: string; editClass?: string }>;
  }>;
  /** Blocks left exactly as printed, each with the reason. */
  keptAsPrinted: string[];
  unitsAsked: number;
  unitsParseFailed: number;
}

/** Where the stamp sidecar lands. `cleanEpubStampPath`, src/clean/epub.ts. */
export function cleanTextStampSidecar(outPath: string): string {
  return `${path.resolve(outPath)}.stamp.json`;
}

/** Where the receipt lands. src/clean/epub.ts writes `${outPath}.receipt.json`. */
export function cleanTextReceiptPath(outPath: string): string {
  return `${path.resolve(outPath)}.receipt.json`;
}

/** Where the cost cache lands. `cleanEpubBankPath`, src/clean/epub.ts. */
export function cleanTextBankPath(outPath: string): string {
  return `${path.resolve(outPath)}.clean-bank.jsonl`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The spawn
// ─────────────────────────────────────────────────────────────────────────────

export interface CleanTextEpubOptions {
  /** The finished EPUB to clean. Read, never written. */
  epubPath: string;
  /** Where the cleaned EPUB is written. Refused when it is `epubPath`. */
  outPath: string;
  /** Blocks done / blocks total, from the engine's own `clean-text: N/M` line. */
  onProgress?: (done: number, total: number, label: string) => void;
  signal?: AbortSignal;
}

export interface CleanTextEpubResult {
  outPath: string;
  receipt: CleanTextReceipt;
  /** The stamp the engine wrote into `outPath`'s OPF, read back off the file. */
  stamp: import('./epub-processor.js').NarrationTextStamp;
  /** What ran it, for the log and the ledger. */
  settings: CleanTextEngineSettings;
}

/**
 * `clean-text: N/M` — the engine's block counter, and nothing else.
 *
 * The same pattern `foundry-host-queue.ts` already parses for a hosted `clean`
 * row (`parseFoundryProgressLine`), and it is deliberately narrow: `clean-text`
 * writes many other lines on the same prefix — refusals, the bank's line, its
 * final `N blocks, M changed, K edits refused in Ts` — and matching a count out
 * of any of them would draw a bar off a sentence.
 */
export function parseCleanTextProgress(line: string): { done: number; total: number } | null {
  const match = /^clean-text:\s+(\d+)\/(\d+)$/.exec(line.trim());
  if (match === null) return null;
  return { done: Number(match[1]), total: Number(match[2]) };
}

/**
 * Clean a finished EPUB through the engine, and hand back what it wrote.
 *
 * THIS FUNCTION WRITES `outPath` AND NOTHING ELSE. Replacing the export is the
 * caller's act, deliberately: it is the caller that knows which file the ledger
 * names, and a helper that renamed on its own behalf could land a cleaned book
 * over a file nobody asked about.
 *
 * A nonzero exit is thrown WITH THE ENGINE'S OWN STDERR in it. Its refusals are
 * written for a person — "this EPUB carries no foundry stamps, run
 * `foundry epub-stamp`" is the one a publisher's book gets — and paraphrasing
 * them here would cost the user the remedy.
 */
export async function cleanTextEpub(opts: CleanTextEpubOptions): Promise<CleanTextEpubResult> {
  const epubPath = path.resolve(opts.epubPath);
  const outPath = path.resolve(opts.outPath);

  // The engine refuses this too, and so does this side: the input is what a
  // second run would have to read, and a pass that consumed it would make its
  // own result impossible to check. Refused HERE so it costs no spawn.
  if (epubPath === outPath) {
    throw new Error(
      `The narration text cleanup was asked to write its result over the book it is reading `
      + `(${outPath}). The book it read is what every refusal in the receipt is measured against. `
      + 'Nothing was written.');
  }

  const {
    ensureFoundryPath, foundryVersion, runFoundry,
  } = await import('./foundry-bridge.js');
  const { readNarrationTextStamp } = await import('./epub-processor.js');

  // Downloaded here rather than at the spawn, so the wait belongs to the job the
  // user is watching. `runFoundry`'s own resolution stays synchronous.
  await ensureFoundryPath();

  // ── THE VERSION GATE ──────────────────────────────────────────────────────
  //
  // The `--epub` failsafe arrived in foundry 1.2.0 (`d6509e7`, "the stamp proves
  // itself, and the pass gets its failsafe door"). An older engine has
  // `clean-text` but not this door, so it would die on `unknown option --epub`
  // wearing a message about argv rather than about what is missing. Refused by
  // name, naming the release, and nothing is spawned.
  //
  // The comparator is `foundryVersionAtLeast` — the one in this app — and the
  // constant sits beside `FOUNDRY_VERSION_FOR_CLEAN_TEXT` in
  // `electron/foundry-host-queue.ts`, which is where every foundry version floor
  // this app enforces is written down.
  //
  // The floor is required LAZILY — `foundry-host-queue` reaches the queue engine
  // at module scope, and this module is loadable from the CLI harness and from a
  // keeper, where that engine is neither wanted nor mounted.
  const {
    FOUNDRY_VERSION_FOR_CLEAN_TEXT_EPUB, foundryTooOldForCleanTextEpub,
  } = await import('./foundry-host-queue.js');
  const installed = await foundryVersion();
  if (!foundryVersionAtLeast(installed.version, FOUNDRY_VERSION_FOR_CLEAN_TEXT_EPUB)) {
    throw new Error(foundryTooOldForCleanTextEpub(installed.version));
  }

  const settings = await cleanTextEngineSettings();

  // A stale sidecar from a previous run at this name would be read back as this
  // run's receipt if the engine died before writing its own. Removed first, so
  // "the receipt is missing" is reachable and means what it says.
  await fs.rm(cleanTextReceiptPath(outPath), { force: true });
  await fs.rm(cleanTextStampSidecar(outPath), { force: true });
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const args = [
    'clean-text',
    '--epub', epubPath,
    '--out', outPath,
    '--endpoint', settings.endpoint,
    '--model', settings.model,
  ];
  console.log(
    `[NARRATION-TEXT] ${installed.path} ${args.join(' ')} — model and endpoint from `
    + `${settings.source}`);

  const result = await runFoundry(args, {
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    onProgress: (line) => {
      const counted = parseCleanTextProgress(line);
      if (counted !== null) {
        opts.onProgress?.(counted.done, counted.total, 'Cleaning the text');
        return;
      }
      // Everything else the engine says goes to the log verbatim: its refusals
      // name a block and a reason, and summarising them here would lose the one
      // thing a person reviewing a cleanup needs.
      console.log(`[NARRATION-TEXT] ${line}`);
    },
  });

  if (result.code !== 0) {
    throw new Error(
      `foundry clean-text exited ${result.code} and cleaned nothing. What it said:\n`
      + `${(result.stderr || result.stdout).trim()}`);
  }

  const receiptPath = cleanTextReceiptPath(outPath);
  let receipt: CleanTextReceipt;
  try {
    receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')) as CleanTextReceipt;
  } catch (err) {
    throw new Error(
      `foundry clean-text reported success and its receipt at ${receiptPath} cannot be read `
      + `(${(err as Error).message}). The receipt is what the ledger row is written from, so `
      + 'nothing is recorded for a run nobody can review.');
  }
  if (typeof receipt.normalizerVersion !== 'string'
    || typeof receipt.punctuationSpec !== 'string'
    || typeof receipt.punctuation !== 'object' || receipt.punctuation === null) {
    throw new Error(
      `foundry clean-text's receipt at ${receiptPath} does not carry the versions and the `
      + 'punctuation record this app records a cleanup by. The engine\'s receipt shape has moved; '
      + 'read foundry\'s src/clean/epub.ts and electron/narration-clean-text.ts together.');
  }

  // THE OPF STAMP, READ BACK OFF THE FILE the engine actually wrote, not off the
  // sidecar beside it. The sidecar is informational (its positions are the
  // archive's own); the OPF meta is what every consumer downstream reads, and
  // this is where a field renamed on the far side of the seam becomes a named
  // failure rather than a book that reads `stale` forever.
  const stamp = await readNarrationTextStamp(outPath);
  if (stamp === null) {
    throw new Error(
      `foundry clean-text wrote ${outPath} and it carries no bookforge:narration-text stamp. `
      + 'The stamp is the whole of what makes the cleanup persist; a book without one would be '
      + 'offered for cleaning again forever.');
  }

  return { outPath, receipt, stamp, settings };
}

// ─────────────────────────────────────────────────────────────────────────────
// The gate — what a consumer asks of a book before it narrates it
// ─────────────────────────────────────────────────────────────────────────────

/** Why a book may not be narrated yet, or null when it may. */
export type NarrationTextGate =
  | {
    ok: true;
    stamp: {
      normalizerVersion: string;
      punctuationSpec: string;
      model: string;
      /**
       * How many spans the pass could not reach. NOT a refusal — a refused span
       * is a permanent property of that markup and re-running would refuse it
       * again — but a fact every consumer should be able to see rather than
       * infer from a book that reads as clean.
       */
      punctuationRefused: number;
    };
  }
  | { ok: false; state: 'missing' | 'stale'; reason: string };

/**
 * Has this book been through the narration text cleanup, at the versions this
 * build reads text by?
 *
 * The stamp on the file, and nothing else. The ledger says a pass ran on a
 * PROJECT; the render door is handed a FILE — by the queue, by the CLI, by a
 * batch chain on another machine — and the file has to be able to answer for
 * itself.
 *
 * A stamp from an older version is 'stale' and not 'missing', and the difference
 * is the whole of the message: "run it" and "run it again" are different
 * instructions to a user who believes they already did.
 *
 * MOVED HERE from the deleted `electron/narration-text-pass.ts` unchanged. It
 * reads `NORMALIZER_VERSION` and `PUNCTUATION_SPEC_VERSION` out of the two
 * vendored modules that stayed in this repository, which are pinned against
 * Foundry's own copies by `tools/test-foundry-clean-text-vendor.js` — so the
 * versions this gate demands are the versions the engine stamps.
 */
export async function narrationTextGate(bookPath: string): Promise<NarrationTextGate> {
  const { NARRATION_TEXT_STAMP_VERSION, readNarrationTextStamp } =
    await import('./epub-processor.js');
  const { NORMALIZER_VERSION } = await import('./tts-number-normalizer.js');
  const { PUNCTUATION_SPEC_VERSION } = await import('./tts-punctuation.js');
  const book = path.basename(bookPath);
  // A MALFORMED STAMP IS A STALE ONE, not an exception. The reader throws with a
  // precise sentence about the damage — which is right for a reader — but this
  // is a GATE, and a gate that propagates a raw exception out of
  // `prepareNarrationInput` gives the user a stack trace where the actionable
  // sentence belongs (the adversarial review, 2026-09-04). The damage is kept in
  // the reason, so nothing is hidden.
  let stamp;
  try {
    stamp = await readNarrationTextStamp(bookPath);
  } catch (err) {
    return {
      ok: false,
      state: 'stale',
      reason: `${book} carries a narration-text stamp this build cannot read — `
        + `${(err as Error).message} Press "Clean text…" on this book’s version row to clean it again.`,
    };
  }
  if (stamp === null) {
    return {
      ok: false,
      state: 'missing',
      reason: `${book} has not been through the narration text cleanup, so its punctuation is `
        + 'whatever the book printed and its numbers are still digits. '
        + 'Press "Clean text…" on this book’s version row first — it is the step that makes the text the voice reads.',
    };
  }
  if (stamp.stampVersion !== NARRATION_TEXT_STAMP_VERSION) {
    return {
      ok: false,
      state: 'stale',
      reason: `${book} carries a narration-text stamp of shape ${stamp.stampVersion}; this build `
        + `writes shape ${NARRATION_TEXT_STAMP_VERSION}, in which a reading has to be a reading `
        + 'of the token it replaced. Run "Clean text…" on this version row again.',
    };
  }
  if (stamp.normalizerVersion !== NORMALIZER_VERSION
    || stamp.punctuationSpec !== PUNCTUATION_SPEC_VERSION) {
    return {
      ok: false,
      state: 'stale',
      reason: `${book} was cleaned by an older narration text pass `
        + `(${stamp.normalizerVersion}/${stamp.punctuationSpec}; this build runs `
        + `${NORMALIZER_VERSION}/${PUNCTUATION_SPEC_VERSION}), so parts of it would be narrated by `
        + 'rules this build no longer uses. Press "Clean text…" on this book’s version row to '
        + 'clean it again.',
    };
  }
  return {
    ok: true,
    stamp: {
      normalizerVersion: stamp.normalizerVersion,
      punctuationSpec: stamp.punctuationSpec,
      model: stamp.model,
      punctuationRefused: stamp.punctuationRefused,
    },
  };
}
