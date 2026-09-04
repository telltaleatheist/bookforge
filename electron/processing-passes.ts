/**
 * processing-passes — one pass over the project's book, run as a queue job.
 *
 * There is ONE book per project — `manifest.outputs.epub` — and a pass reads it,
 * transforms it, and writes it back to THE SAME PATH. Nothing here produces a
 * `cleaned.epub` or a `translated.epub` for a later step to hunt for: the stage
 * directories hold a pass's working files and its diff, never the book.
 *
 * ── WHY IN PLACE ─────────────────────────────────────────────────────────────
 *
 * The stage copies were a per-stage snapshot of a pipeline with a fixed shape.
 * Passes have no fixed shape — translate → simplify → translate back is legal,
 * and the user orders them — so "which file is the book now?" stops having a
 * static answer and every consumer that guessed one was wrong for some ordering.
 * One path, one book, and `appliedPasses` says what happened to it.
 *
 * ── WHY EACH PASS STILL LEAVES A DIFF ────────────────────────────────────────
 *
 * Writing in place is what makes the diffs necessary rather than optional: after
 * the third pass, the text the second pass ended at exists nowhere. So a pass
 * diff carries its own after-text (see writePassDiff) and is readable forever,
 * long after the book has moved on.
 *
 * ── WHERE THE BOOK COMES FROM ────────────────────────────────────────────────
 *
 * Not from here. `foundry vlm-convert` (electron/vlm-convert.ts) reads the pages
 * and assembles them, which is a document STAGE rather than a pass — a book's
 * origin is not a transformation of a book. A run over a project with no
 * `outputs.epub` is refused by the planner, by name.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// A type here, and only a type: this module holds the one window the queue's
// progress rows go to, and it must not reach for `electron` at load.
import type { BrowserWindow } from 'electron';

import * as manifestService from './manifest-service';
import { publishBridgeEvent } from './bridge-events';
import { writePassDiff, type PassDiffUnit } from './diff-cache';
import { loadEpubForComparison } from './epub-processor';
import { removeEpubContainer, stagedContainerKindFor } from './epub-container';
import { bookDigest } from './sidecar-binding';
import { bookDigestHex } from '../shared/book-digest';
import { narrationCarryRefusal, type NarrationDeletionsCarry } from '../shared/vlm/narration-deletions';
import type { AppliedPass } from './manifest-types';
import type {
  PassJobConfig,
  PassJobResult,
} from '../shared/processing/pass-types';

// ─────────────────────────────────────────────────────────────────────────────
// The job's shape
// ─────────────────────────────────────────────────────────────────────────────

export type {
  PassJobConfig,
  PassJobResult,
  SimplifyPassParams,
  TranslatePassParams,
} from '../shared/processing/pass-types';

// ─────────────────────────────────────────────────────────────────────────────
// The book
// ─────────────────────────────────────────────────────────────────────────────

const STAGING_DIR = path.join(os.tmpdir(), 'bookforge-staging');

/**
 * The project's book EPUB, or a refusal naming the project.
 *
 * `manifestService.ensureBookEpub` is the one answer, and it is the SAME call
 * the narration strikes make: a project imported as an EPUB has no book until
 * something needs one, at which point the archive original is copied to
 * `source/<Book Title>.epub` and recorded. A pass therefore never writes to an
 * archive original — the file the user handed us stays exactly as it arrived —
 * and never refuses an EPUB-born project for a reason the user cannot act on.
 *
 * A PDF project with no book is still refused, by name: converting the pages is
 * what makes a book, and no amount of copying gets you one.
 */
export async function requireBookEpub(
  projectDir: string,
  familyId?: string,
): Promise<string> {
  const record = await manifestService.ensureBookEpub(projectDir, familyId);
  return record.absPath;
}

/**
 * Put a pass's output in the book's place, and say what the book then IS.
 *
 * When the two are the same kind of container the produced book is renamed ONTO
 * the recorded path — one filesystem operation, so a reader (or Syncthing) sees
 * the old book or the new one and never a half-written one. The rename also
 * takes the produced copy away, which is what keeps a stage directory from
 * becoming a second place a book lives.
 *
 * ── When they are NOT the same kind ─────────────────────────────────────────
 *
 * The working copy is a folder of the book's parts and some passes produce an
 * archive: `cleanupEpub` writes `stages/01-simplify/out.epub` out of an hour of
 * model time, and a renderer-built book arrives as zip bytes. `moveIntoPlace` is
 * a MOVE and is deliberately blind to what it is moving, so landing a zip on a
 * tree that way would leave a file standing where the working copy belongs —
 * the container downgrade nothing downstream would notice until the next edit.
 *
 * So the conversion is done HERE, deliberately, through the one copy in this app
 * that proves its result entry by entry, and the produced book is removed only
 * once that proof has passed. The book's identity comes back with it: it was
 * measured by the code that guarantees the landing, which is the only place it
 * can be measured and mean something.
 */
async function replaceBookEpub(
  projectDir: string,
  producedAbsPath: string,
  familyId?: string
): Promise<{ bookPath: string; digest: string }> {
  const bookPath = await requireBookEpub(projectDir, familyId);
  if (!fs.existsSync(producedAbsPath)) {
    throw new Error(`The pass reported success but wrote no file at ${producedAbsPath}.`);
  }
  const producedKind = await stagedContainerKindFor(producedAbsPath);
  const bookKind = await stagedContainerKindFor(bookPath);
  if (producedKind === bookKind) {
    await moveIntoPlace(producedAbsPath, bookPath);
  } else {
    // Converted BESIDE the produced book, never onto the book: a refused
    // conversion removes what it wrote, and the book has to still be there
    // afterwards. The landing is `moveIntoPlace` either way, so the book is
    // replaced by one filesystem operation with something already proved.
    const staged = `${producedAbsPath}.bookforge-as-${bookKind}`;
    await removeEpubContainer(staged);
    await manifestService.copyBookIntoContainer(
      producedAbsPath, staged, bookKind, `the book this pass produced`);
    await moveIntoPlace(staged, bookPath);
    await removeEpubContainer(producedAbsPath);
  }
  return { bookPath, digest: (await bookDigest(bookPath)).digest };
}

/**
 * Move a finished file to where it belongs, atomically at the destination.
 *
 * The last step is always a rename WITHIN the destination's filesystem, which is
 * the only step Syncthing (and any reader) is guaranteed to see as all-or-nothing.
 * A plain rename does that already when both paths share a filesystem; when they
 * do not — a pass working in /tmp, a library on another volume — the copy lands
 * beside the destination first and the rename happens there.
 */
export async function moveIntoPlace(fromAbsPath: string, toAbsPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(toAbsPath), { recursive: true });

  // A book is about to stop always being a FILE: the working copy becomes an
  // exploded directory so that editing one chapter writes one entry. The move is
  // the same move either way — copy beside the destination, land it with one
  // rename — but the two steps that assumed a file (`copyFile`, `unlink`) have to
  // know which they are looking at. For a FILE nothing below changes: the fast
  // path is the same single rename it has always been, and every failure is the
  // same failure.
  // Stat'd BEFORE the move: whichever path below runs, the source is gone by the
  // time the cleanup at the bottom has to know which kind it was.
  const source = await statOrNull(fromAbsPath);

  if (await renameLanded(fromAbsPath, toAbsPath, await statOrNull(toAbsPath))) return;

  const sibling = `${toAbsPath}.bookforge-tmp`;
  await copyArtifact(fromAbsPath, sibling);
  try {
    await landOnDestination(sibling, toAbsPath);
  } catch (err) {
    // The book was not replaced, so nothing beside it may claim it was
    // half-way: a stranded sibling would be adopted by nothing and synced by
    // everything.
    await fs.promises.rm(sibling, { recursive: true, force: true });
    throw err;
  }
  if (source?.isDirectory() === true) {
    await fs.promises.rm(fromAbsPath, { recursive: true });
  } else {
    await fs.promises.unlink(fromAbsPath);
  }
}

/** Copy a book to `toAbsPath`, whether it is one file or a tree of them. */
async function copyArtifact(fromAbsPath: string, toAbsPath: string): Promise<void> {
  const source = await fs.promises.stat(fromAbsPath);
  if (!source.isDirectory()) {
    await fs.promises.copyFile(fromAbsPath, toAbsPath);
    return;
  }
  // A stale sibling from a previous crashed move would otherwise merge with the
  // new one, producing a "copy" holding entries of two different books.
  await fs.promises.rm(toAbsPath, { recursive: true, force: true });
  await fs.promises.cp(fromAbsPath, toAbsPath, { recursive: true });
}

/**
 * The last step: the staged copy becomes the destination.
 *
 * For a file landing on a file — or on nothing — this is the one rename it always
 * was, hold-retries and all. Every other shape ASKS the kernel before assuming:
 * a rename that lands is always better than a rename that steps aside first, and
 * which shapes land is a property of the filesystem, not something this file can
 * predict (see `renameLanded`). Only when the kernel refuses is the old book
 * stepped aside and put back if the landing fails; the moment that matters is
 * still a single rename, and there is never a window in which the destination
 * holds half of each book.
 */
async function landOnDestination(fromAbsPath: string, toAbsPath: string): Promise<void> {
  const source = await statOrNull(fromAbsPath);
  const destination = await statOrNull(toAbsPath);
  if (renameCanLand(source, destination)) {
    await renameOntoDestination(fromAbsPath, toAbsPath);
    return;
  }
  if (await renameLanded(fromAbsPath, toAbsPath, destination)) return;

  const displaced = `${toAbsPath}.bookforge-old`;
  await fs.promises.rm(displaced, { recursive: true, force: true });
  await renameOntoDestination(toAbsPath, displaced);
  try {
    await renameOntoDestination(fromAbsPath, toAbsPath);
  } catch (err) {
    // Nothing is at the destination and the caller is about to be told the move
    // failed, so the book that WAS there goes back before that sentence is true.
    await renameOntoDestination(displaced, toAbsPath);
    throw err;
  }
  await fs.promises.rm(displaced, { recursive: true, force: true });
}

/**
 * Is a plain rename the DESIGNED path for this shape — the one whose refusal is
 * worth waiting out — or merely something the filesystem might allow?
 *
 * Nothing at the destination, or neither side a tree: that rename is the whole
 * design, it is expected to succeed, and a refusal is the transient hold
 * `renameOntoDestination` retries for two seconds. Anything else is a maybe,
 * and `renameLanded` asks rather than predicts.
 */
function renameCanLand(source: fs.Stats | null, destination: fs.Stats | null): boolean {
  if (destination === null) return true;
  return source?.isDirectory() !== true && !destination.isDirectory();
}

/**
 * Try to land the move in ONE rename. True if it landed.
 *
 * Whether a rename can replace something of the OTHER kind is a property of the
 * filesystem, and this file had it wrong in both directions. POSIX refuses a
 * directory onto a non-directory with ENOTDIR; Win32's MoveFileEx with
 * REPLACE_EXISTING performs exactly that move in 2 ms. So this predicts
 * nothing — it asks, and every shape gets its attempt.
 *
 * What it decides is only whether to WAIT on a refusal, and that is a different
 * question with a measured answer. On win32 EPERM is overloaded: it means both
 * "somebody has this open right now" and "this move is impossible". The PC
 * session pinned which is which by retrying an unheld rename 40 times over
 * 4.3 s (2026-08-22) — `dir onto dir` and `file onto dir` answered EPERM every
 * single time, while `dir onto file` landed on attempt 1. Both of the hopeless
 * shapes are the same shape: THE DESTINATION IS A DIRECTORY THAT ALREADY
 * EXISTS, which no rename replaces on either platform (POSIX answers ENOTEMPTY
 * or EISDIR, and its one legal case — an EMPTY destination directory —
 * succeeds immediately or not at all).
 *
 * So: waiting can only help when the destination is absent or is not a
 * directory. Everywhere else the ladder would be waiting out a condition that
 * never clears, and it was measurably doing so — 4.2 s per move, twice over
 * (here and again in `landOnDestination` on the sibling), on `tree onto tree`,
 * which is where EVERY phase-2 pass lands its book. That is 0.397 s of keeper
 * suite becoming 12.998 s.
 */
async function renameLanded(
  fromAbsPath: string,
  toAbsPath: string,
  destination: fs.Stats | null,
): Promise<boolean> {
  try {
    if (waitingCouldHelp(destination)) await renameOntoDestination(fromAbsPath, toAbsPath);
    else await fs.promises.rename(fromAbsPath, toAbsPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Could waiting out a refusal change the answer? Only if the destination is not
 * a directory that already exists — see `renameLanded` for the measurement.
 *
 * This is NOT the same question as `renameCanLand`, which asks whether a plain
 * rename is the DESIGNED path. `tree onto file` is not designed-for and still
 * worth waiting on: it lands in one rename where it is supported, so an EPERM
 * there is a holder rather than a refusal, and the fallback is a copy of the
 * whole book.
 */
function waitingCouldHelp(destination: fs.Stats | null): boolean {
  return destination === null || !destination.isDirectory();
}

/** `stat`, with "nothing is there" as an answer rather than an exception. */
async function statOrNull(absPath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    // Windows only: a file whose LAST unlink ran while some process still held
    // it open is in delete-pending limbo — the name exists, and every stat on
    // it answers EPERM until that holder exits. Raw "EPERM: operation not
    // permitted, stat ..." names the syscall and not the state (Owen hit it
    // 2026-08-12, deleting the narration copy mid-preview), so the state is
    // named instead, with the way out.
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY')) {
      throw new Error(
        `${absPath} is stuck half-deleted or exclusively held: Windows answers ${code} even to `
        + 'measuring it. Something still holds it open — a viewer window showing it, or a scanner '
        + 'mid-file. Close whatever is showing it (or restart BookForge) and try again.'
      );
    }
    throw err;
  }
}

/**
 * The one rename that lands a file on its destination, with the Windows truth
 * about it: renaming ONTO a file fails with EPERM while ANY process holds the
 * destination open — and on a library that Syncthing replicates, Defender
 * scans, and the indexer walks, "any process" is a coin toss measured in
 * milliseconds. (Live hit 2026-08-10: a relabel of the freshly-converted
 * Nuremberg refused on EPERM because the working copy was being hashed at that
 * exact moment; the identical rename succeeded on the next click.)
 *
 * So a share-violation-shaped error is retried, briefly and boundedly, and then
 * thrown as itself — the holder that matters (an editor with the book open, a
 * worker mid-read) outlives two seconds, and THAT refusal should be seen, not
 * papered over. Everything not shaped like a transient hold throws immediately:
 * EXDEV still means "copy beside the destination instead", ENOENT still means
 * the caller lied about the source.
 *
 * EXPORTED for `foundry-adopt`, whose staged copy lands the same way and hit the
 * same refusal for real: Owen's "star gods" adoption died on
 * `EPERM: … rename '<projects>/.adopting-star-gods-…' -> '<projects>/star-gods-…'`
 * (2026-08-22, onto a library on Z:, an SMB share to the NAS). Nothing was at the
 * destination, so that rename was the designed path rather than a maybe — the
 * shape this ladder is for. Measured afterwards on the same share, with the same
 * 1.03 GiB source: the identical copy-then-rename landed in 10 ms, so the refusal
 * was a hold and not a structural no. Adoption had no ladder at all, so one
 * unlucky instant became a failed adoption.
 */
export async function renameOntoDestination(fromAbsPath: string, toAbsPath: string): Promise<void> {
  const HOLDS = new Set(['EPERM', 'EACCES', 'EBUSY']);
  const DELAYS_MS = [50, 100, 200, 400, 600, 700];
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(fromAbsPath, toAbsPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = process.platform === 'win32' && code !== undefined && HOLDS.has(code);
      if (!transient || attempt >= DELAYS_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, DELAYS_MS[attempt]));
    }
  }
}

/**
 * Record the pass in the book's LEDGER, so the user can take it back on its own.
 *
 * One act with the rewrite, and it runs immediately after the `appliedPasses`
 * record is appended: the snapshot it takes is the book this pass produced, and
 * a moment later that book is one the user has been editing again.
 *
 * A refusal is SAID and not thrown. The pass succeeded — the book is rewritten,
 * its provenance records it, its diff is on disk — and what could not be
 * promised is only that it is undoable in isolation. Failing the job here would
 * report an hour of model time as wasted when it was not. See
 * electron/book-ledger.ts for the cases (a structural rewrite, an unreadable
 * result, a project with no archive-grade base).
 */
async function recordInLedger(
  config: PassJobConfig,
  label: string,
  pass: AppliedPass
): Promise<{ ledgerEntryId?: string; note?: string }> {
  const { registerLedgerPass } = await import('./book-ledger.js');
  const recorded = await registerLedgerPass(
    config.projectDir, { kind: pass.kind, label, pass, familyId: config.familyId });
  if (recorded.refusal !== null) {
    console.warn(`[processing-pass] ${recorded.refusal}`);
    return { note: recorded.refusal };
  }
  return { ledgerEntryId: recorded.entry.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Carrying the narration strikes across a pass
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The verdict on the strike record, made BEFORE the book is replaced — because
 * afterwards the book the strikes were made against does not exist any more.
 *
 * ── What is proved ──────────────────────────────────────────────────────────
 *
 * That the book the pass wrote enumerates exactly what the book it read did:
 * same documents, same keys, same tags, element for element
 * (`narrationCarryRefusal`). It is the SAME invariant `registerLedgerPass`
 * checks, measured between the two ends of this pass rather than against the
 * archive-grade base — so a pass that earns a ledger row and one that carries
 * its strikes are, by construction, the same passes.
 *
 * ── What a refusal costs, which is why it is safe to be exact ───────────────
 *
 * Nothing is destroyed by a refusal. The record stays exactly as it is, its
 * stamp stays pointing at the book it was made against, and every strike in it
 * is checked against the text it remembers striking the next time it is used.
 * So this can afford to be strict: the price of "could not prove it" is a
 * per-strike check at use, not an evening of the user's work.
 *
 * ── What it costs to ask ────────────────────────────────────────────────────
 *
 * Two walks of the book — a parse of every spine document on each side — and
 * only when there is a record to carry. A project with no strikes pays nothing.
 * A simplify that took an hour pays a second; the footnote-reference pass,
 * which is the fast one, roughly doubles its own runtime and is still seconds.
 */
export async function verifyNarrationCarry(
  projectDir: string,
  beforeAbsPath: string,
  afterAbsPath: string,
  familyId?: string,
): Promise<{ outcome: 'none' } | { outcome: 'refused'; reason: string }
  | { outcome: 'provable'; fromSha256: string }> {
  const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
  if (recorded === null) return { outcome: 'none' };

  // Through `bookDigest`, which measures a book in whichever container it is —
  // this one is the working copy, a folder of its parts.
  const { digest: fromSha256 } = await bookDigest(beforeAbsPath);
  if (recorded.epubSha256 !== fromSha256) {
    return {
      outcome: 'refused',
      reason: 'the strikes on file were already stamped with a different book than the one this '
        + 'pass read, so there was nothing to carry them from.',
    };
  }

  const { narrationDocumentShapes } = await import('./quire-stamp.js');
  const [before, after] = await Promise.all([
    narrationDocumentShapes(beforeAbsPath, `${path.basename(projectDir)} before the pass`),
    narrationDocumentShapes(afterAbsPath, `${path.basename(projectDir)} after the pass`),
  ]);
  const refusal = narrationCarryRefusal(recorded.elements, before, after);
  if (refusal !== null) return { outcome: 'refused', reason: refusal };
  return { outcome: 'provable', fromSha256 };
}

/**
 * Seal the verdict against the book that is now on disk.
 *
 * The proof was made about the book the pass PRODUCED; the stamp has to name
 * the book the project CALLS its book. `replaceBookEpub` puts one in the other's
 * place and measures what it landed — by a rename when the two are the same kind
 * of container, and by a copy proved entry for entry when they are not — and
 * this re-measures rather than asserting, because the stamp is the thing every
 * later reader trusts and something else writing the book in between is exactly
 * what it would be trusting through. The fingerprints come off the same book, so
 * the carried strikes describe the one they are about to name.
 */
async function sealNarrationCarry(
  verdict: Awaited<ReturnType<typeof verifyNarrationCarry>>,
  bookAbsPath: string,
  landedDigest: string,
): Promise<NarrationDeletionsCarry> {
  if (verdict.outcome !== 'provable') return verdict;
  const { digest: toSha256, hex } = await bookDigest(bookAbsPath);
  if (toSha256 !== landedDigest) {
    return {
      outcome: 'refused',
      reason: `the book on disk (${hex.slice(0, 12)}) is not the one this pass landed `
        + `(${bookDigestHex(landedDigest).slice(0, 12)}), so the proof describes a book nobody has.`,
    };
  }
  const { narrationFingerprintsOfBook } = await import('./quire-stamp.js');
  return {
    outcome: 'carried',
    fromSha256: verdict.fromSha256,
    toSha256,
    fingerprints: await narrationFingerprintsOfBook(bookAbsPath, path.basename(bookAbsPath)),
  };
}

/**
 * The whole carry, from the two files to the value the transaction takes.
 *
 * One helper so the three passes cannot drift into three orderings of it: the
 * proof happens while both books exist, the seal happens once the new one is in
 * place, and the value goes into the same manifest write as the pass record.
 */
async function carryNarrationAcrossPass(
  config: PassJobConfig,
  beforeAbsPath: string,
  producedAbsPath: string,
): Promise<{ carry: NarrationDeletionsCarry; bookAfter: string }> {
  // THE WHOLE WAY DOWN. Threading the family into the pass and then dropping it
  // here only moved the family-less resolvers' refusal to AFTER the model pass,
  // which is the most expensive place in the run to discover it (the second
  // adversarial review, 2026-09-04).
  const verdict = await verifyNarrationCarry(
    config.projectDir, beforeAbsPath, producedAbsPath, config.familyId);
  const landed = await replaceBookEpub(config.projectDir, producedAbsPath, config.familyId);
  return {
    carry: await sealNarrationCarry(verdict, landed.bookPath, landed.digest),
    bookAfter: landed.bookPath,
  };
}

function absStage(config: PassJobConfig): string {
  return path.join(config.projectDir, config.stageRelDir.split('/').join(path.sep));
}

function diffPaths(config: PassJobConfig): { rel: string; abs: string } {
  return {
    rel: `${config.stageRelDir}/diff.json`,
    abs: path.join(absStage(config), 'diff.json'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The passes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simplify — the one AI rewrite left in the pipeline.
 *
 * Runs the SAME `cleanupEpub` the old AI-cleanup job ran; there is no second
 * implementation. What changed is where the result goes: cleanupEpub writes into
 * the pass's stage directory (which keeps its checkpoint, its cover embedding and
 * its resume behaviour intact, all of which key off that directory), and the
 * finished file is then moved onto the book.
 */
async function runSimplifyPass(
  jobId: string,
  config: PassJobConfig,
  mainWindow: BrowserWindow | null | undefined
): Promise<PassJobResult> {
  const params = config.simplify;
  if (!params) throw new Error('A simplify pass was queued without its settings (mode, provider, model).');

  const bookPath = await requireBookEpub(config.projectDir, config.familyId);
  const stageDir = absStage(config);
  await fs.promises.mkdir(stageDir, { recursive: true });

  // The before-text, read now: the pass is about to overwrite the file it came
  // from, and the diff is computed against this.
  const before = await loadEpubForComparison(bookPath);

  const { aiBridge } = await import('./ai-bridge.js');
  const result = await aiBridge.cleanupEpub(
    bookPath,
    jobId,
    mainWindow,
    undefined,
    {
      provider: params.aiProvider,
      ollama: params.aiProvider === 'ollama'
        ? { baseUrl: params.ollamaBaseUrl || 'http://localhost:11434', model: params.aiModel }
        : undefined,
      claude: params.aiProvider === 'claude'
        ? { apiKey: params.claudeApiKey || '', model: params.aiModel }
        : undefined,
      openai: params.aiProvider === 'openai'
        ? { apiKey: params.openaiApiKey || '', model: params.aiModel }
        : undefined,
    },
    {
      simplifyForChildren: true,
      // Simplify ONLY. cleanupEpub defaults enableAiCleanup to true, so omitting
      // this silently bolted the OCR-cleanup prompt onto the simplify prompt and
      // put this pass on the legacy combined chunk pipeline — the pipeline has a
      // SEPARATE cleanup pass for that work, and this one is not it. Stated
      // explicitly, the pass takes the block-group path: groups of consecutive
      // body blocks, validated and written back to their own elements 1:1
      // (see simplifyBlockMode in ai-bridge.ts).
      enableAiCleanup: false,
      simplifyMode: params.mode,
      customInstructions: params.customInstructions,
      testMode: params.testMode,
      testModeChunks: params.testModeChunks,
      outputDir: stageDir,
    }
  );
  if (!result.success || !result.outputPath) {
    return { success: false, error: result.error || 'Simplify produced no EPUB and gave no reason.' };
  }

  const produced = result.outputPath;
  const after = await loadEpubForComparison(produced);
  const diff = diffPaths(config);
  await writePassDiff(diff.abs, pairChapters(before.chapters, after.chapters));

  // Simplify REWRITES every paragraph and leaves the element list alone —
  // `cleanupEpub` replaces the text inside each chapter's elements. That is a
  // claim about a model's output, not a guarantee, which is exactly why it is
  // proved per run rather than trusted: a simplify that restructured the book
  // fails this check and fails `registerLedgerPass`'s for the same reason.
  const { carry, bookAfter } = await carryNarrationAcrossPass(config, bookPath, produced);
  const applied: AppliedPass = {
    kind: 'simplify',
    at: new Date().toISOString(),
    params: { mode: params.mode, provider: params.aiProvider, model: params.aiModel },
    diff: diff.rel,
  };
  const recorded = await manifestService.appendAppliedPass(config.projectDir, applied, carry, config.familyId);
  const ledger = await recordInLedger(config, 'Simplify', applied);
  return {
    success: true,
    outputPath: bookAfter,
    ...(ledger.ledgerEntryId ? { ledgerEntryId: ledger.ledgerEntryId } : {}),
    ...(ledger.note ? { ledgerRefusal: ledger.note } : {}),
    ...(recorded.narrationNote ? { narrationCarryNote: recorded.narrationNote } : {}),
  };
}

/**
 * Translate the whole book, in place.
 *
 * No diff: a translation shares no words with what it replaced, so a word diff of
 * it is a wall of red and green that tells a reader nothing they did not already
 * know. The provenance record names the languages, which is the useful fact.
 */
async function runTranslatePass(
  jobId: string,
  config: PassJobConfig,
  mainWindow: BrowserWindow | null | undefined
): Promise<PassJobResult> {
  const params = config.translate;
  if (!params) throw new Error('A translate pass was queued without its languages and model.');

  const bookPath = await requireBookEpub(config.projectDir, config.familyId);
  const stageDir = absStage(config);
  await fs.promises.mkdir(stageDir, { recursive: true });

  const { runMonoTranslation } = await import('./ll-jobs.js');
  const result = await runMonoTranslation(
    jobId,
    {
      cleanedEpubPath: bookPath,
      sourceLang: params.sourceLang,
      targetLang: params.targetLang,
      aiProvider: params.aiProvider,
      aiModel: params.aiModel,
      ollamaBaseUrl: params.ollamaBaseUrl,
      claudeApiKey: params.claudeApiKey,
      openaiApiKey: params.openaiApiKey,
      translationPrompt: params.translationPrompt,
      customInstructions: params.customInstructions,
      outputEpubPath: path.join(stageDir, 'translated.epub'),
    },
    mainWindow ?? null
  );
  if (!result.success || !result.outputPath) {
    return { success: false, error: result.error || 'Translation produced no EPUB and gave no reason.' };
  }

  // Translation replaces the WORDS of every element and keeps the elements: the
  // mono translator walks the book chapter by chapter and writes each one back
  // in place. The strikes are positions, and a position survives having its
  // sentence rendered in another language — so they carry, when the walk agrees
  // that nothing moved.
  const { carry, bookAfter } = await carryNarrationAcrossPass(
    config, bookPath, result.outputPath);
  const applied: AppliedPass = {
    kind: 'translate',
    at: new Date().toISOString(),
    params: {
      from: params.sourceLang,
      to: params.targetLang,
      provider: params.aiProvider,
      model: params.aiModel,
    },
  };
  const recorded = await manifestService.appendAppliedPass(config.projectDir, applied, carry, config.familyId);
  // No diff to freeze — a translation shares no words with what it replaced, so
  // the entry's receipt is null and the row says so rather than offering a review
  // of a wall of red and green.
  const ledger = await recordInLedger(config, `Translate to ${params.targetLang}`, applied);
  return {
    success: true,
    outputPath: bookAfter,
    ...(ledger.ledgerEntryId ? { ledgerEntryId: ledger.ledgerEntryId } : {}),
    ...(ledger.note ? { ledgerRefusal: ledger.note } : {}),
    ...(recorded.narrationNote ? { narrationCarryNote: recorded.narrationNote } : {}),
  };
}

/**
 * Remove footnote REFERENCE NUMBERS from the book itself.
 *
 * ── The question this answers ───────────────────────────────────────────────
 *
 * Owen: "if the user opens the working file and footnote reference numbers were
 * removed, will it show the change in the epub? will it show that the numbers
 * are actually gone? i.e. does it actually edit the text? we need a way to edit
 * the text directly." Until now the strip happened only on the write of the
 * narration copy, so the numbers left the file the NARRATOR read and stayed in
 * the file the USER read. This pass edits the book, and the numbers are gone
 * from the page the moment it opens.
 *
 * It is the reference NUMBERS and nothing else. The footnote blocks themselves —
 * the notes at the end of a chapter — are struck out by the user like any other
 * text and are ordinary working changes; this pass never removes an element.
 *
 * ── Not an AI pass, and not the retired one ─────────────────────────────────
 *
 * The transform is `stripFootnoteMarkerSups`, the same digits-only rule the
 * narration copy has always been cut by, applied to the same content documents.
 * There is no model, no GPU and no network: it is a string replace over a zip
 * and it finishes in seconds. The `footnotes` kind it superficially resembles
 * was an AI pass that decided for itself what a footnote was, and it is retired.
 *
 * ── Nothing to do is a REFUSAL, not a vacuous entry ─────────────────────────
 *
 * A book with no markers left — because it never had any, or because this pass
 * has already run over it — gets a sentence saying so and NOTHING is recorded.
 * The alternative is a ledger row whose snapshot is byte-identical to the one
 * before it and whose diff shows no change: a row the user can delete to undo
 * nothing, sitting in the history of their book forever. The strip is idempotent
 * by construction (shared/text/sup-markers.ts), so a second run genuinely has
 * nothing to do, and saying that is the whole of the right answer.
 */
async function runFootnoteRefsPass(config: PassJobConfig): Promise<PassJobResult> {
  const bookPath = await requireBookEpub(config.projectDir, config.familyId);
  const stageDir = absStage(config);
  await fs.promises.mkdir(stageDir, { recursive: true });

  // The before-text, read now: the pass is about to overwrite the file it came
  // from, and the diff is computed against this.
  //
  // WITH THE MARKERS LEFT IN, on both sides. The text extractor strips exactly
  // the markers this pass removes, so reading either side the ordinary way hands
  // the diff two identical strings and the frozen receipt records a book against
  // itself — which is what made Review changes on this pass's line show nothing
  // (Owen, 2026-08-10). This is the one pass whose diff is about the markers, so
  // it is the one caller that asks to see them.
  const before = await loadEpubForComparison(bookPath, true);

  const { stripFootnoteReferencesFromBook } = await import('./epub-processor.js');
  const produced = path.join(stageDir, 'footnote-refs.epub');
  const strip = await stripFootnoteReferencesFromBook(bookPath, produced);

  if (strip.removed === 0) {
    // The staged book is a byte-for-byte re-zip of one that is already correct.
    // It is removed rather than moved into place: rewriting the book with its
    // own contents would move its timestamp and invalidate every analysis cache
    // keyed on it, for a pass that changed nothing.
    // Whichever container the pass staged it in: a produced book is a folder of
    // its parts whenever the book it was read from is one, and a non-recursive
    // rm cannot take one away.
    await removeEpubContainer(produced);
    return {
      success: false,
      error: 'No footnote reference markers remain in this book, so nothing was changed and nothing '
        + 'was recorded. Either it never had digits-only superscript references, or this pass has '
        + 'already been run over it — check the book\'s ledger.',
    };
  }

  const after = await loadEpubForComparison(produced, true);
  const diff = diffPaths(config);
  await writePassDiff(diff.abs, pairChapters(before.chapters, after.chapters));

  // ── The strikes, carried ──────────────────────────────────────────────────
  //
  // This pass CANNOT move an element: a `<sup>` is inline, inside a block the
  // export walk enumerates, so removing one takes characters out of a block and
  // leaves every block where it was — and the one way a text-only edit could
  // still move the walk, an element whose entire text WAS the marker, is
  // repaired by `keepEmptiedUnitsAudible` giving it a `[break]`. That is the
  // per-pass knowledge this file is allowed to have, and it is ASSERTED rather
  // than trusted: the walk is compared anyway, so a future change to the strip
  // that broke the claim would refuse the carry instead of shifting the user's
  // strikes by one paragraph.
  //
  // It is also the pass that made this necessary. Owen struck an evening of
  // narration deletions, ran this, reopened the book, and was told they had
  // been cleared (2026-08-10).
  const { carry, bookAfter } = await carryNarrationAcrossPass(config, bookPath, produced);
  const applied: AppliedPass = {
    kind: 'footnote-refs',
    at: new Date().toISOString(),
    params: { removed: strip.removed, files: strip.files.length, breaks: strip.breaks },
    diff: diff.rel,
  };
  const recorded = await manifestService.appendAppliedPass(config.projectDir, applied, carry, config.familyId);
  const ledger = await recordInLedger(config, 'Remove footnote references', applied);
  return {
    success: true,
    outputPath: bookAfter,
    summary: `${strip.removed} footnote reference number(s) removed from ${strip.files.length} `
      + 'document(s).'
      + (strip.breaks > 0
        ? ` ${strip.breaks} paragraph(s) held nothing but a marker and now say [break] — a pause, `
          + 'which is what they always were.'
        : ''),
    ...(ledger.ledgerEntryId ? { ledgerEntryId: ledger.ledgerEntryId } : {}),
    ...(ledger.note ? { ledgerRefusal: ledger.note } : {}),
    ...(recorded.narrationNote ? { narrationCarryNote: recorded.narrationNote } : {}),
  };
}

/**
 * The narration copy, re-cut from the book as it stands.
 *
 * The strikes live in `ensureNarrationEpub`, not in the book, so a chained
 * narration handed the raw book reads every passage the user struck out. That is
 * why BOTH exits of the pass go through here — the one that did work, and the
 * one that found nothing to do (the second adversarial review, 2026-09-04: the
 * "already clean" success returned the book and lost the strikes).
 *
 * A failure is SAID, not swallowed, and it is not the pass's failure: the book
 * is written and recorded either way. The caller then names the book itself,
 * which `prepareNarrationInput` cuts on its way in — what is lost is the user's
 * own strikes, and the note is what says so.
 */
async function recutNarrationCopy(
  config: PassJobConfig,
  bookPath: string,
): Promise<{ narrationInputPath: string; note: string | null }> {
  try {
    const { ensureNarrationEpub } = await import('./narration-export.js');
    const cut = await ensureNarrationEpub(config.projectDir, undefined, config.familyId);
    console.log(
      '[processing-pass] narration copy re-cut from the cleaned book'
      + `${cut.cutReason === null ? ' (the one on record still described it)' : `: ${cut.cutReason}`}`
      + ` — ${cut.epubPath}`);
    return { narrationInputPath: cut.epubPath, note: null };
  } catch (err) {
    const note = 'The book was cleaned, but its narration copy could not be re-cut from it: '
      + `${(err as Error).message} Anything narrated from here reads the book itself, so the `
      + 'passages struck out for narration will be read aloud until the copy is remade.';
    console.warn(`[processing-pass] ${note}`);
    return { narrationInputPath: bookPath, note };
  }
}


/**
 * The narration text cleanup, as a pass on the book's chain.
 *
 * ── The ruling ──────────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-04: *"We should make this its own intentional step that the user
 * runs and persists, so we don't have to run it again… This should be a foundry
 * step that's necessary before it goes to TTS."* And, on where it sits: *"a step
 * that can be performed at any point, including on an epub, but it's a
 * computationally expensive step that needs to take place somewhere along the
 * line, and everything after it is finalized/fixed… a step that goes in just
 * like translate/simplify."*
 *
 * So it is offered, planned, queued and recorded exactly as those are, and it
 * may be run at any point in the chain. What makes it different is the STAMP:
 * `electron/narration-text-pass.ts` writes it into the book's OPF, and
 * `prepareNarrationInput` refuses a render whose book has none — which is what
 * "everything after it is finalized" means in code. A later simplify or
 * translate rewrites the cleaned text and is recorded after this one in the
 * ledger, so the gate calls the stamp STALE rather than missing.
 *
 * ── Not a string replace, and it still belongs here ─────────────────────────
 *
 * Unlike `footnote-refs` this loads a model: the deterministic stages read what
 * they can guarantee and the model reads the residue. That is why it takes the
 * GPU pool like a simplify does, and why it reports progress. Everything else
 * about the ROW is the same, and the shared `passModule` runs it.
 *
 * ── Nothing to do is a REFUSAL ──────────────────────────────────────────────
 *
 * `footnote-refs`' rule, with one difference that matters. A book that is
 * ALREADY STAMPED at this version has genuinely nothing to gain, and a second
 * row would be a ledger entry the user can delete to undo nothing. But a book
 * that merely prints no curly quote and no digit still needs the stamp — it is
 * what unlocks the render — so a text-unchanged run over an UNSTAMPED book is a
 * real pass with a real row, and says so.
 */
async function runNarrationTextPass(
  jobId: string,
  config: PassJobConfig
): Promise<PassJobResult> {
  const bookPath = await requireBookEpub(config.projectDir, config.familyId);
  const { runNarrationTextPass: runPass } = await import('./narration-text-pass.js');
  const { narrationTextReadiness } = await import('./narration-text-readiness.js');

  // ── ALREADY DONE? Asked of the LEDGER, which is the authority the UI used ──
  //
  // This guarded itself with the FILE STAMP until the adversarial review of
  // 2026-09-04 traced what that costs. `simplify` copies the OPF byte for byte,
  // so a book cleaned and then simplified still carries a current stamp while
  // its text is no longer the text that was cleaned — which is precisely why
  // `narrationTextReadiness` reports `stale` and why the Narrate gate offers
  // "Run cleanup again, then narrate". The stamp said `ok`, this returned a
  // refusal, the step failed, and the chained narration never ran: the offer the
  // design document describes could not complete, ever.
  //
  // Two authorities answering one question is the defect. There is one now.
  const already = narrationTextReadiness(
    await manifestService.readAppliedPasses(config.projectDir, config.familyId));

  // ── AND "NOTHING TO DO" IS A SUCCESS, because work may be chained behind it ──
  //
  // `runFootnoteRefsPass` returns `success:false` for its own no-op and that is
  // right for it: nothing is ever queued behind it, so the red row IS the
  // message. This pass stands in front of a narration run, and a step that fails
  // takes the run with it. So it succeeds, records nothing, and says so.
  if (already.ok) {
    // THE COPY IS STILL RE-CUT. A no-op that handed a chained narration the raw
    // book would narrate every passage the user struck out, because the strikes
    // live in the cut and not in the book (the second adversarial review).
    const recut = await recutNarrationCopy(config, bookPath);
    return {
      success: true,
      outputPath: bookPath,
      narrationInputPath: recut.narrationInputPath,
      summary: 'This book had already been through the narration text cleanup at this version '
        + `(read by ${already.model}), so nothing was changed and nothing was recorded. It is `
        + 'ready to narrate; the ledger of this version names the run that did it.'
        + (recut.note === null ? '' : ` ${recut.note}`),
    };
  }

  // Made only now, so a refusal above leaves no empty stage directory behind.
  const stageDir = absStage(config);
  await fs.promises.mkdir(stageDir, { recursive: true });

  // The before-text, read now: the pass is about to replace the file it came
  // from, and the diff is computed against this.
  const before = await loadEpubForComparison(bookPath, false);

  const { createOllamaNormalizerRunner, numberNormalizerModel } =
    await import('./tts-number-normalizer-runner.js');
  const { loadNarrationTextPrompt } = await import('./ai-bridge.js');
  const { narrationCutsDir } = await import('./parallel-tts-bridge.js');
  // Read ONCE and carried: the tag is part of the cache path AND of the stamp,
  // so a run that read it twice could name the copy after one model and make it
  // with another.
  const model = numberNormalizerModel();

  const produced = path.join(stageDir, 'narration-text.epub');
  const outcome = await runPass({
    epubPath: bookPath,
    outPath: produced,
    // The SAME scratch the render door looks in, so the copies this pass makes
    // are the copies a later render finds instead of paying for them again.
    cacheDir: narrationCutsDir(),
    systemPrompt: await loadNarrationTextPrompt(),
    model,
    runner: createOllamaNormalizerRunner(model),
    onProgress: (done, total, label) => {
      // The same `queue:progress` bridge event the row's step module is already
      // listening on (electron/queue-steps/pass.ts), so the bar this draws is
      // the bar every other pass draws.
      publishBridgeEvent('queue:progress', {
        jobId,
        message: label,
        progress: total > 0 ? Math.round((done / total) * 100) : 0,
      });
    },
  });

  const after = await loadEpubForComparison(produced, false);
  const diff = diffPaths(config);
  await writePassDiff(diff.abs, pairChapters(before.chapters, after.chapters));

  // The full record beside the diff: per-rule punctuation counts, every model
  // edit and the verdict the validator gave it, everything refused. The diff is
  // what Review changes shows; this is what a disagreement is settled from.
  const receiptRel = `${config.stageRelDir}/narration-text.receipt.json`;
  await fs.promises.writeFile(
    path.join(stageDir, 'narration-text.receipt.json'),
    `${JSON.stringify(outcome.receipt, null, 2)}\n`, 'utf8');

  // The strikes, carried. This pass CANNOT move an element — it rewrites text
  // nodes by offset and never adds, removes or reorders one — but that is
  // asserted rather than trusted: the walk is compared anyway, so a future change
  // that broke the claim refuses the carry instead of shifting a user's strikes
  // by one paragraph.
  const { carry, bookAfter } = await carryNarrationAcrossPass(config, bookPath, produced);

  const punctuation = outcome.receipt.punctuation;
  const numbers = outcome.receipt.numbers;
  const byClass = numbers === null ? {} : numbers.appliedByClass;
  const classSummary = Object.entries(byClass)
    .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ');
  const applied: AppliedPass = {
    kind: 'narration-text',
    at: outcome.receipt.at,
    params: {
      normalizerVersion: outcome.receipt.normalizerVersion,
      punctuationSpec: outcome.receipt.punctuationSpec,
      model,
      punctuationSpans: punctuation.spansApplied,
      punctuationRules: punctuation.counts,
      punctuationRefused: punctuation.refused.length,
      numbersApplied: numbers === null ? 0 : numbers.appliedSpans,
      numbersByRules: numbers === null ? 0 : numbers.appliedByRules,
      numbersByModel: numbers === null ? 0 : numbers.appliedByModel,
      // What the pass actually DID, by kind of reading — the number a reviewer
      // looks at first now that the model is asked about more than digits.
      appliedByClass: numbers === null ? {} : numbers.appliedByClass,
      receipt: receiptRel,
    },
    diff: diff.rel,
  };
  const recorded = await manifestService.appendAppliedPass(config.projectDir, applied, carry, config.familyId);
  const ledger = await recordInLedger(config, 'Narration text cleanup', applied);

  // The narration copy, re-cut from the book this pass just wrote — and named
  // as this step's artifact, because the queue gives a chained step its PARENT'S
  // artifact and nothing else.
  const recut = await recutNarrationCopy(config, bookAfter);
  const narrationInputPath = recut.narrationInputPath;
  const recutNote = recut.note;

  return {
    success: true,
    outputPath: bookAfter,
    narrationInputPath,
    summary: `${punctuation.spansApplied} punctuation span(s) canonicalized and `
      + `${numbers === null ? 0 : numbers.appliedSpans} number(s) read as words `
      + `(${numbers === null ? 0 : numbers.appliedByRules} by rule, `
      + `${numbers === null ? 0 : numbers.appliedByModel} by ${model}`
      + `${classSummary === '' ? '' : `; ${classSummary}`}). The book is stamped `
      + `${outcome.receipt.normalizerVersion}/${outcome.receipt.punctuationSpec} and is ready to `
      + 'narrate.'
      + (recutNote === null ? '' : ` ${recutNote}`)
      + (punctuation.refused.length > 0
        ? ` ${punctuation.refused.length} span(s) were left as printed because canonicalizing them `
          + 'would have meant flattening an <em> or a <sup>; the receipt names each one.'
        : ''),
    ...(ledger.ledgerEntryId ? { ledgerEntryId: ledger.ledgerEntryId } : {}),
    ...(ledger.note ? { ledgerRefusal: ledger.note } : {}),
    ...(recorded.narrationNote ? { narrationCarryNote: recorded.narrationNote } : {}),
  };
}

/**
 * Pair two chapter lists by id for diffing.
 *
 * A pass rewrites a chapter's text and leaves the spine alone, so ids match. One
 * that does not match is reported as wholly new rather than silently dropped —
 * an unpaired chapter means the pass restructured the book, which the diff should
 * show rather than hide.
 */
function pairChapters(
  before: Array<{ id: string; title: string; text: string }>,
  after: Array<{ id: string; title: string; text: string }>
): PassDiffUnit[] {
  const beforeById = new Map(before.map((c) => [c.id, c]));
  return after.map((c) => ({
    id: c.id,
    title: c.title,
    before: beforeById.get(c.id)?.text ?? '',
    after: c.text,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A pass kind this build no longer runs, and the sentence that explains it.
 *
 * queue.json outlives the code that wrote it, so a row naming one of these
 * cannot be reasoned about — nothing knows what it would do — and it is refused
 * rather than mapped onto "the nearest live pass", which would spend hours
 * producing something the user did not ask for.
 *
 * Checked before the switch so the exhaustiveness `never` below stays a real
 * check on the LIVE kinds rather than a catch-all for retired ones.
 */
const RETIRED_PASS_KINDS: Record<string, string> = {
  'get-text':
    'Get Text is gone: BookForge no longer casts a working PDF with Tesseract. Converting a PDF '
    + 'to a book is one act now — Convert to EPUB.',
  blocks:
    'Detect blocks is gone: the block model and the layout pipeline it labelled for were retired '
    + 'when Convert to EPUB became the only PDF→EPUB conversion.',
  reflow:
    'Build the book is gone: Convert to EPUB writes the book directly from the pages, so there is '
    + 'no working document to reflow.',
  footnotes:
    'The AI footnote pass is gone. Digits-only footnote references are now removed '
    + 'deterministically as the narration copy is written, so no book is edited and nothing needs '
    + 'to be queued.',
  tesseract:
    'Tesseract is no longer part of this app: the pages are read by the document vision model '
    + 'Convert to EPUB runs.',
  'ocr-correction':
    'OCR correction is gone with the Tesseract pipeline it repaired.',
  detection:
    'Detection is gone with the Tesseract pipeline it labelled.',
};

/**
 * Run one pass. The queue job IS this call: it returns when the pass has
 * finished, and a failure is returned rather than thrown so the caller can put
 * the message on the job row.
 */
export async function runProcessingPass(
  jobId: string,
  config: PassJobConfig,
  mainWindow: BrowserWindow | null | undefined
): Promise<PassJobResult> {
  console.log(`[processing-pass] ${config.kind} on ${config.projectDir} (${config.stageRelDir})`);
  try {
    fs.mkdirSync(STAGING_DIR, { recursive: true });

    const gone = RETIRED_PASS_KINDS[config.kind as string];
    if (gone) {
      throw new Error(
        `${gone} This job was queued by an older build: remove it and plan the run again from the `
        + 'Process tab.'
      );
    }

    switch (config.kind) {
      case 'simplify':
        return await runSimplifyPass(jobId, config, mainWindow);
      case 'translate':
        return await runTranslatePass(jobId, config, mainWindow);
      // No jobId and no window: it reports no progress because it has none to
      // report — the whole pass is a string replace over a zip and is done
      // before a progress row could be drawn.
      case 'footnote-refs':
        return await runFootnoteRefsPass(config);
      // The jobId IS the progress channel: the deterministic stages finish in
      // seconds and the model pass is minutes, so the row reports.
      case 'narration-text':
        return await runNarrationTextPass(jobId, config);
      default: {
        const unknown: never = config.kind;
        throw new Error(`There is no ${unknown} pass.`);
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[processing-pass] ${config.kind} failed:`, err);
    return { success: false, error };
  }
}
