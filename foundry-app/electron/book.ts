/**
 * book — the book file, made if it is not there, read, and handed to the pane.
 *
 * ── Why this is a module and not four lines in main.ts ──────────────────────
 *
 * Because it is three separate pieces of knowledge that each belong to somebody
 * else, and the only thing this file adds is the ORDER they go in. Where the file
 * lives is `projects.ts`'s (every path in a project is composed there, once, so a
 * branch read cannot end up answering for the other reading's bank). How to run
 * the engine is `engine.ts`'s (this app never imports foundry; it spawns it). What
 * the file's grammar is belongs to `shared/book.ts`, which mirrors the engine's own
 * writer. main.ts registers the door and knows none of it — which is the shape
 * `workspace.ts` already has.
 *
 * ── ENSURING THE FILE IS ALSO THE MIGRATION, AND THAT IS DELIBERATE ─────────
 *
 * Every project in the library predates this format: they hold a bank and no book
 * file at all. Nothing has to be migrated for them, because the book file is
 * DERIVED — the bank is the reset point and the reflow is seconds of arithmetic
 * over it — so "open a read position" and "produce the book file for the first
 * time" are one code path and there is no second one to keep true
 * (docs/RENDERER.md §9, R2).
 *
 * IT IS MADE ONLY WHEN IT IS ABSENT. A book file that exists is the one the ops
 * are keyed to, and re-running the reflow over it because a pane was opened would
 * be this process rewriting the document somebody is editing every time they look
 * at it. Regenerating on purpose is a different gesture and it is not this one.
 *
 * ── AND A TRANSLATION HAS A BOOK FILE OF ITS OWN ────────────────────────────
 *
 * *"When a translate lands, main materializes parent book file + chain ops +
 * records → readings/<key>.<lang>.book.jsonl — same format, parent ids kept
 * verbatim, struck rows absent, text replaced from records. Downstream positions
 * read the NEAREST ancestor book file, so replay is always one short hop."*
 * (docs/RENDERER.md §4.) That file is written HERE, three ways: by the landing
 * the moment the records exist, by a correction appended to those records, and —
 * the ensure posture again — by the first open of a translation recorded before
 * either of those doors existed. The ops replayed on top of it are only the ones
 * made SINCE it (`editsSinceTransform`, shared/ledger.ts); everything above it
 * was baked in when it was written, and replaying those a second time would
 * strike rows that are already gone.
 *
 * ── THE BANK'S IDENTITY IS CHECKED ON EVERY OPEN ────────────────────────────
 *
 * The book file is a pure function of the receipt, and its header carries the
 * receipt's identity (`source.bankSha`, docs/BOOK-FILE.md §2). A loader that
 * finds the bank has changed under the book is holding ids that may name
 * nothing, and the contract's answer is the one given here: REFUSE BY NAME, as
 * a sentence, and let the one door that may rebuild do it as an announced
 * action. That door is the read-landing orchestration's, not this open.
 *
 * ── Every failure is a sentence, and it carries no path ─────────────────────
 *
 * What comes back from here goes onto the paper (RENDERER-DESIGN.md §5: errors
 * render as main's own sentence on the sheet, never a toast), and the house rule
 * is that a filename never appears in copy a person reads. So the sentence names
 * the BOOK's problem and the terminal gets the path — which is where somebody
 * debugging their own library goes looking, and the one place it is any use.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { writeBookFile, writeEpubBook } from './engine';
import { writeAtomically } from './atomic';
import { CurateBridgeError, rekeyCuration } from '../shared/curate-bridge';
import {
  bookAtPosition,
  imagesDirFor,
  ledgerOf,
  opsDir,
  opsPayloadFor,
  ProjectError,
  projectDirOf,
  readManifest,
  readStepLedger,
  recordBookEdit,
  recordBookEditAmend,
  recordCorrection,
  translationBookFileFor,
  type LedgerView,
} from './projects';
import {
  BookFileError,
  formatBookFile,
  parseBookFile,
  type BookFile,
  type BookOutcome,
} from '../shared/book';
import {
  editsSinceTransform,
  positionOf,
  translationInEffect,
  translationRecordsOf,
} from '../shared/ledger';
import { materialize, translated } from '../shared/materialize';
import { BookOpsError, formatOpsFile, parseOpsFile, type BookOp } from '../shared/ops';
import {
  parseRecordsFile,
  RecordsFileError,
  translationWords,
  type TranslationRow,
} from '../shared/records';
import type { LedgerStep } from '../shared/types';

/** Does this path exist? Nothing else about it is asked. */
async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/*
 * ── The figures door ─────────────────────────────────────────────────────────
 *
 * A Picture row names its crop by NAME, and the renderer is a page under a CSP
 * that loads images off the `foundry-file:` scheme and nowhere else on disk. So
 * a successful
 * load REGISTERS the book's image directory under an opaque token, hands the
 * pane `foundry-file://book/<token>/` as a prefix, and the protocol handler
 * (electron/mount.ts) asks this table before it serves a byte. An ALLOW-LIST, not a path
 * scheme: a URL the renderer invents for a directory nothing registered is a
 * 403 rather than a read.
 *
 * The token is minted per DIRECTORY and reused across reloads, so the map stays
 * the size of the library rather than growing with every glance at a pane.
 */
const figureTokens = new Map<string, string>();
const figureDirs = new Map<string, string>();

function figuresPrefixFor(imagesDir: string): string {
  const known = figureTokens.get(imagesDir);
  if (known !== undefined) return `foundry-file://book/${known}/`;
  const token = randomUUID();
  figureTokens.set(imagesDir, token);
  figureDirs.set(token, imagesDir);
  return `foundry-file://book/${token}/`;
}

/**
 * The file behind `foundry-file://book/<token>/<name>`, or null for anything
 * this process never agreed to serve.
 *
 * THE NAME MUST BE A PLAIN BASENAME. The engine writes the crops flat into one
 * directory (`p<page>-<order>.png`), so a separator in the name is not a figure
 * this app cut — it is a traversal, and it meets the same null as an unknown
 * token rather than a resolve() that might climb.
 */
export function bookFigureFile(token: string, name: string): string | null {
  const dir = figureDirs.get(token);
  if (dir === undefined) return null;
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return null;
  }
  return path.join(dir, name);
}

/**
 * The book file at the position, parsed, with the chain of ops that stands on it.
 *
 * ── ONE WALK, THREE READERS, AND THE OTHERS ARE WHY THIS EXISTS ─────────────
 *
 * `loadBook` below draws this for a person; `materializeBook` writes the same
 * answer out as a file for the engine to compile or to translate
 * (docs/RENDERER.md §6); `writeTranslationBook` builds the parent half of a
 * derived translation out of it (§4). All three need the identical sequence —
 * find the book file this position is about, ensure it, read it, prove the bank
 * has not moved under its ids, then walk the edit steps still to be replayed and
 * read every payload — and every one of those steps has a refusal attached to it
 * that is written to be read. Spelling it three times would be three answers to
 * "what is this book and what has been done to it", which is exactly the failure
 * the single replay exists to make impossible.
 *
 * NEVER ANSWERS EMPTY, and never throws for anything a person can be told about:
 * every way this can fail comes back carrying words to put on the paper.
 *
 * IT STILL REJECTS FOR A DIRECTORY THAT IS NOT A PROJECT. That is the security
 * gate refusing, not the book being unavailable, and it must not be renderable as
 * a polite sentence in a pane.
 */
interface OpenedBook {
  at: Awaited<ReturnType<typeof bookAtPosition>>;
  /**
   * The file this book was read out of — the reading's reflow, or a translation's
   * derived book. Carried so that a log line names the file that was actually
   * opened rather than the one at the foot of the chain.
   */
  path: string;
  parsed: BookFile;
  /**
   * Every change still to be replayed — the edits made since the file above was
   * written, which is since the reading for an ordinary position and since the
   * TRANSLATION for one standing under a transform. See `editsSinceTransform`.
   */
  ops: BookOp[];
  /**
   * The AMENDABLE TIP's own ops, or null where the position has none — see the
   * comment where it is decided. Not in `ops`: the pane replays these under the
   * chain itself, because they are still its stack.
   */
  tip: BookOp[] | null;
  /**
   * The translate step this position stands under, or null.
   *
   * CARRIED RATHER THAN ASKED AGAIN. It is what decided which file was opened
   * three fields up, and every caller that needs to know "are these words a
   * translation's" needs the SAME answer that decision was made with — the
   * aligned view's source column, and the correction door that will not let a
   * text op fork a translated block. Walking the ledger a second time would be a
   * second opinion about a question this function has already answered.
   */
  transform: LedgerStep | null;
  /**
   * What a `curate` step on this path decided and this book has nowhere to put —
   * absent when there is nothing to say, which is every chain made of `edit`
   * rows. See `BookLoad.unplaced`, which is where these sentences are going.
   */
  unplaced?: string[];
}

async function openBookAtPosition(
  projectDir: string,
  /**
   * THE STEP TO ANSWER FOR, when it is not the position — `nearestUpward`'s own
   * parameter, arriving here for the reason it exists. A translation's derived
   * book is materialised by a LANDING, and a landing runs while the pointer is
   * wherever the person happens to be standing; a book built for that step out of
   * whatever position they had clicked onto would be another branch's book under
   * this step's name. Null and absent both mean the position.
   */
  from: LedgerStep | null = null,
): Promise<{ ok: true; opened: OpenedBook } | { ok: false; reason: string }> {
  const at = await bookAtPosition(projectDir, from);
  const ledger = ledgerOf(at.manifest);

  /*
   * ── WHICH BOOK FILE THIS POSITION IS ABOUT ─────────────────────────────────
   *
   * *"Downstream positions read the NEAREST ancestor book file, so replay is
   * always one short hop."* (docs/RENDERER.md §4.) Standing anywhere under a
   * translation, the book is that translation's DERIVED file — same ids, struck
   * rows already absent, the words in the language that was asked for — and the
   * ops replayed on top are only the ones made since it, because everything above
   * it was baked in when it was written (`editsSinceTransform`, shared/ledger.ts).
   * With no translation on the path the nearest ancestor is the reading's own
   * reflow, which is what this has always opened.
   */
  const transform = translationInEffect(ledger, from);
  const source = transform === null
    ? await ensureReadingBook(at)
    : await ensureTranslationBook(at, ledger, transform);
  if (!source.ok) return source;

  let text: string;
  try {
    text = await fsp.readFile(source.path, 'utf8');
  } catch (err) {
    console.error(`[book] ${source.path} could not be read: ${(err as Error).message}`);
    return { ok: false, reason: 'This book was made and then could not be read back.' };
  }

  try {
    const parsed = parseBookFile(text);
    /*
     * THE RECEIPT'S IDENTITY, CHECKED AGAINST THE RECEIPT — see the module
     * header. Hashed here, on this side of the wall, because the claim is the
     * book file's and the evidence is the bank's, and only the process holding
     * both can put them side by side. The same sixteen hex the engine writes
     * (`bankSha`, src/vlm/book-run.ts), by the grow-together rule.
     *
     * IT IS THE SAME CHECK ON A DERIVED FILE, AND IT IS STILL THE RIGHT ONE. A
     * derived book carries the source's `source` block verbatim, sha and all
     * (`materialize`, and `translated` beside it), because the bank underneath did
     * not move when somebody replayed a strike or translated a paragraph — the ids
     * in a translated file still name blocks of that reading's answers. So a bank
     * that HAS moved invalidates the translation's ids exactly as it invalidates
     * the reading's, and it is caught here, once, for both.
     *
     * AND THE RECEIPT IS NOT ALWAYS A BANK. A project that arrived as an EPUB has
     * none: its book is exploded out of the container, so the CONTAINER is what
     * `source.bankSha` is a hash of (docs/RENDERER.md §6 — the EPUB is the
     * receipt, archived immutable, `book = f(epub)`). `bookAtPosition` names
     * whichever it is, so this check reads one field and stays one check —
     * splitting it in two would be two answers to "has the foundation moved".
     */
    const sha = createHash('sha256')
      .update(await fsp.readFile(at.receipt))
      .digest('hex')
      .slice(0, 16);
    if (parsed.header.source.bankSha !== sha) {
      console.error(
        `[book] ${source.path} was made from a receipt whose sha-256 began `
        + `${parsed.header.source.bankSha}, and ${at.receipt} now begins ${sha}.`,
      );
      return {
        ok: false,
        reason: 'What this book was made from has changed since it was made, so its blocks may no '
          + 'longer name what is really there. It is not opened over a moved foundation; making the '
          + 'book again from the original remakes it.',
      };
    }
    /*
     * THE CHAIN, AND IT IS A REFUSAL RATHER THAN A BEST EFFORT.
     *
     * Every edit step on the path from this reading to the position retained a
     * file of ops, and what the person is looking at is that book with all of them
     * replayed over it, in order (docs/RENDERER.md §3). A step whose file will not
     * open or will not parse leaves this process holding two thirds of somebody's
     * history — and drawing the book from the two thirds is the worst outcome
     * available, because the sheet would look perfectly ordinary while the strikes
     * from one Apply were silently absent and the next Apply recorded a delta
     * against a state that never existed. So the whole load refuses, by the step's
     * own name, and the sentence keeps the path out of it.
     */
    const chain: BookOp[] = [];
    /**
     * WHAT AN OLD SAVE COULD NOT SAY ABOUT THIS BOOK, gathered as the chain is
     * built and handed up with it. Empty for every project made under the op
     * grammar, which is why it is a list rather than a flag: the sheet says one
     * sentence per decision it could not place, and says nothing at all when
     * there is nothing to say (`rekeyCuration`, shared/curate-bridge.ts).
     */
    const unplaced: string[] = [];
    const steps = editsSinceTransform(ledger, from);
    /*
     * ── THE TIP — the one step whose ops are still the person's to change ─────
     *
     * An edit step the position stands ON with nothing landed under it is not
     * history yet: nothing depends on it, so a further Apply AMENDS it rather
     * than stacking a sibling row (user ruling, 2026-08-16), and the undo stack
     * reaches back through what it recorded. Its ops are therefore handed up
     * SEPARATELY — the pane hydrates its stack from them and replays them under
     * the chain itself — and they are not in `ops`, or they would replay twice.
     * The moment anything lands under the step (a translate, a child edit), it
     * freezes into the chain like every row above it, because rewriting a file
     * another step was made from would be editing history someone stood on.
     */
    const standing = positionOf(ledger);
    const last = steps[steps.length - 1];
    const amendable = last !== undefined
      && last.action === 'edit'
      && standing !== null && standing.id === last.id
      && !ledger.steps.some((step) => step.parent === last.id);
    let tip: BookOp[] | null = null;
    for (const step of steps) {
      const file = path.join(at.dir, ...step.payload.split('/'));
      let said: string;
      try {
        said = await fsp.readFile(file, 'utf8');
      } catch (err) {
        console.error(`[book] ${file} is the payload of step ${step.id} and could not be read: ${(err as Error).message}`);
        return {
          ok: false,
          reason: `The changes recorded as “${step.label}” could not be read, so this book cannot be `
            + 'drawn honestly — everything applied after them depends on them. Its own history is '
            + 'intact; the file behind that row is not.',
        };
      }
      /*
       * ── A SAVE MADE BEFORE THE OP GRAMMAR IS READ THROUGH THE BRIDGE ────────
       *
       * A `curate` step's payload is `curations/<uuid>.json`: a frozen curation,
       * keyed by the model's own `(page, order)` coordinates, written by a system
       * that no longer exists. Its decisions are the same decisions — struck
       * blocks, retyped lines, a chapter spine — so they are re-keyed onto this
       * book through the `src` column the format carries for exactly this and
       * replayed as ops (docs/RENDERER.md §8; `rekeyCuration`).
       *
       * NOTHING IS REWRITTEN ON DISK BY THIS. The snapshot is that row's payload
       * and it is irreplaceable (`RETENTION_OF`); re-keying at the moment the
       * book is opened means the ledger keeps saying exactly what it always said
       * and the person sees the book that row is about. The alternative — walking
       * everybody's library converting payloads in place — would be this app
       * editing history to make its own reading easier.
       */
      if (step.action === 'curate') {
        let snapshot: unknown;
        try {
          snapshot = JSON.parse(said);
        } catch (err) {
          console.error(`[book] ${file} is the payload of step ${step.id} and is not JSON: ${(err as Error).message}`);
          return {
            ok: false,
            reason: `The decisions recorded as “${step.label}” could not be read, so this book cannot `
              + 'be drawn honestly — everything applied after them depends on them.',
          };
        }
        try {
          const rekeyed = rekeyCuration(snapshot, parsed);
          chain.push(...rekeyed.ops);
          for (const one of rekeyed.unplaced) {
            unplaced.push(`“${step.label}” holds ${one}.`);
          }
        } catch (err) {
          if (!(err instanceof CurateBridgeError)) throw err;
          console.error(`[book] ${file} is the payload of step ${step.id}: ${err.message}`);
          return {
            ok: false,
            reason: `“${step.label}” is a row this build cannot read: ${err.message}.`,
          };
        }
        continue;
      }
      try {
        const read = parseOpsFile(said);
        if (amendable && step.id === last.id) tip = read;
        else chain.push(...read);
      } catch (err) {
        if (!(err instanceof BookOpsError)) throw err;
        console.error(`[book] ${file} is the payload of step ${step.id} and is not a list of changes: ${err.message}`);
        return {
          ok: false,
          reason: `The changes recorded as “${step.label}” are not changes this build can read: ${err.message}`,
        };
      }
    }
    return {
      ok: true,
      opened: {
        at, path: source.path, parsed, ops: chain, tip, transform,
        ...(unplaced.length > 0 ? { unplaced } : {}),
      },
    };
  } catch (err) {
    if (err instanceof BookFileError) {
      console.error(`[book] ${source.path} is not a book this app can read: ${err.message}`);
      // The parser's sentences are written to be read by a person and name blocks
      // rather than files, so this passes them through instead of paraphrasing.
      return { ok: false, reason: `This book could not be opened: ${err.message}` };
    }
    throw err;
  }
}

/**
 * The reading's own reflow, made if nothing has made it — the module header's
 * "ENSURING THE FILE IS ALSO THE MIGRATION", unchanged and now named.
 */
async function ensureReadingBook(
  at: Awaited<ReturnType<typeof bookAtPosition>>,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (await exists(at.book)) return { ok: true, path: at.book };
  /*
   * ── A PROJECT THAT ARRIVED AS A BOOK IS EXPLODED, NOT READ ─────────────────
   *
   * There is no bank under an imported EPUB and there never will be: a bank
   * models pages and an EPUB has none, so re-reading its real text through a
   * vision model would trade exact data for a guess at it (docs/RENDERER.md §6,
   * the refinement paragraph). The container is the receipt, `book = f(epub)`,
   * and the engine writes the same book file out of it — same format, same ids,
   * same everything downstream. It lands at the same path for the same reason:
   * `bookAtPosition` names it after the bank that would have been there, so
   * nothing else in this process has to know which kind of book it is holding.
   */
  if (at.epub !== null) {
    if (!await exists(at.epub)) {
      return {
        ok: false,
        reason: 'The book this project was made from is not in its archive, so there is nothing to '
          + 'open. It is the one file here that cannot be made again.',
      };
    }
    console.warn(`[book] ${at.book} is not there and ${at.epub} is, so the book is being exploded now.`);
    const made = await writeEpubBook(at.epub, at.book);
    if (!made.ok) {
      console.error(`[book] ${at.epub} could not be exploded into ${at.book}: ${made.reason ?? ''}`);
      return {
        ok: false,
        reason: 'The book this project was made from could not be taken apart into blocks. The engine '
          + 'refused, and its own words are in the terminal.',
      };
    }
    return { ok: true, path: at.book };
  }
  /*
   * THE BANK IS PROVEN BEFORE THE ENGINE IS SPAWNED, so that "this project has
   * never been read" is answered in words rather than as whatever the command
   * says about a file it could not open. It is the ordinary state of a project
   * somebody imported five minutes ago and it is not a failure of anything.
   */
  if (!await exists(at.bank)) {
    return {
      ok: false,
      reason: 'This book has not been read yet, so there is nothing to open. Read its pages '
        + 'first and the book is made from them.',
    };
  }
  const made = await writeBookFile(at.bank, at.book, { pdfPath: at.pdf, language: at.language });
  if (!made.ok) {
    // The engine's own words to the terminal, with the paths that make them
    // actionable; the sentence the person reads says what happened to the book.
    console.error(`[book] ${at.bank} could not be reflowed into ${at.book}: ${made.reason ?? ''}`);
    /*
     * ── A REFUSAL WITH A BOOK ON THE DISK IS A DIFFERENT FACT, AND THE OLD
     *    SENTENCE TOLD SOMEBODY THE OPPOSITE OF IT ────────────────────────────
     *
     * There are two ways to arrive here with a file at `at.book` even though the
     * check at the top of this function found none. The reflow is written
     * atomically — a temp file beside the target, then a rename (src/vlm/book-run
     * writes it that way on purpose) — so a run that fails leaves WHATEVER WAS
     * THERE BEFORE completely intact. And the window between that `exists` and
     * this call is real: `remakeBookFile` may land its own rename inside it, in
     * which case the file this run then failed to overwrite is the good one that
     * landing just wrote.
     *
     * The sentence that used to be here — "the pages this book was read from
     * could not be turned into a book" — is a statement about the READING, and it
     * is false in this branch. A person who reads it about a project whose book is
     * sitting right there concludes that hours of GPU produced nothing and goes
     * and runs them again. That is the most expensive wrong answer this app is
     * capable of giving.
     *
     * SO THE BOOK ON THE DISK IS OPENED, and the refusal goes to the terminal
     * beside the engine's own words — which is exactly `remakeBookFile`'s posture
     * (electron/job-queue.ts) for the same event on the other side of the wall,
     * and it is safe for a reason that is not "probably fine": the loader hashes
     * the receipt and refuses any book whose `bankSha` no longer matches it, by
     * name, a few lines further down. If this file is the reflow of a bank that
     * has since moved, the person gets that refusal and its accurate sentence
     * rather than a stale book drawn as a current one. If it matches, it IS the
     * current book, and refusing to draw it because a redundant second attempt to
     * make it again failed would be this app arguing with a file it had already
     * finished making.
     */
    if (await exists(at.book)) {
      console.error(
        `[book] ${at.book} could not be made again, so the one already on the disk is what is being `
        + 'shown. Nothing about the reading is lost; if that book was made from an older bank the '
        + 'load refuses it by name a moment from now.',
      );
      return { ok: true, path: at.book };
    }
    return {
      ok: false,
      reason: 'The pages this book was read from could not be turned into a book. The engine '
        + 'refused, and its own words are in the terminal.',
    };
  }
  return { ok: true, path: at.book };
}

/**
 * A TRANSLATION'S OWN BOOK FILE, made if nothing has made it.
 *
 * ── The ensure posture, and why a translation gets it too ───────────────────
 *
 * A derived book file is written by the LANDING — the moment the records file
 * exists, main materialises the book beside it (`materializeTranslation`, and the
 * translate arm of electron/job-queue.ts) — so in the ordinary course this finds
 * the file and returns. What it is here for is every translation recorded BEFORE
 * that was true: the records are on disk, the book that would have been made from
 * them is not, and the alternative to making it now is a pane that cannot draw a
 * step somebody paid hours of GPU for. It is exactly `ensureReadingBook`'s
 * argument one transform along, and it is announced in the log for the same
 * reason: a file appearing in `readings/` is something the person's own terminal
 * should be able to account for.
 *
 * A TRANSLATION WITH NO RECORDS CANNOT BE SHOWN, and that is a sentence rather
 * than a repair. `translationRecordsOf` answers null for a row made by the old
 * EPUB→EPUB translator, whose words exist only inside the book that run wrote —
 * there is no per-block anything to materialise from, and inventing one would
 * mean re-parsing an EPUB into blocks that were never named. The step still has
 * its own book and the EPUB pane still opens it; what this surface cannot do is
 * draw it.
 */
async function ensureTranslationBook(
  at: Awaited<ReturnType<typeof bookAtPosition>>,
  ledger: LedgerView['ledger'],
  transform: LedgerStep,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const records = translationRecordsOf(transform);
  if (records === null) {
    return {
      ok: false,
      reason: `“${transform.label}” was made before Foundry kept a translation as words it can put `
        + 'back block by block, so there is no book of it to draw. Its own document is still here, '
        + 'and translating again from the step it was made from puts it on the proof sheet.',
    };
  }
  const recordsFile = path.join(at.dir, ...records.split('/'));
  const book = translationBookFileFor(recordsFile);
  if (await exists(book)) return { ok: true, path: book };
  console.warn(
    `[book] ${book} is not there and ${recordsFile} is, so the translated book is being made now — `
    + 'this translation landed before Foundry materialised one beside its answers.',
  );
  return writeTranslationBook(at.dir, ledger, transform);
}

/**
 * MATERIALISE A TRANSLATION — parent book file + chain ops + records, written out
 * as a book file of its own.
 *
 * ── The three terms, and why main is the one that holds them ────────────────
 *
 * *"When a translate lands, main materializes parent book file + chain ops +
 * records → readings/<key>.<lang>.book.jsonl."* (docs/RENDERER.md §4.) The engine
 * has never heard of the op grammar and never will — the replay lives once, in
 * this process, because the renderer draws from it too (§9, R1) — and it has no
 * ledger to walk for the parent. So the assembly is here, and it is three
 * functions that each already exist: `openBookAtPosition` for the parent's own
 * book and the ops on the way to it, `materialize` for the replay, `translated`
 * for the words and the header (shared/materialize.ts).
 *
 * IT IS KEYED TO THE STEP AND NEVER TO THE POSITION. The parent is the row this
 * translation was made FROM, read off the ledger, and the recursion is what makes
 * a chain work: translating an English translation into Hungarian materialises
 * over the ENGLISH derived file, because that is what `openBookAtPosition`
 * answers standing on the English row. One short hop, at every link.
 *
 * WRITTEN ATOMICALLY, beside the records file it is named after
 * (`translationBookFileFor`), because half a book file is a compile that refuses
 * on a row that was cut in two.
 */
async function writeTranslationBook(
  projectDir: string,
  ledger: LedgerView['ledger'],
  transform: LedgerStep,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const records = translationRecordsOf(transform);
  if (records === null) {
    return {
      ok: false,
      reason: `“${transform.label}” keeps no words this app can put back block by block, so there is `
        + 'no book to make from it.',
    };
  }
  const recordsFile = path.join(projectDir, ...records.split('/'));

  /*
   * THE ROW THIS TRANSLATION WAS MADE FROM. A step whose parent is not in the
   * ledger is a history this process cannot walk, and the honest answer is to say
   * so rather than fall back to the position — which is the exact substitution
   * that would build this book out of whichever branch somebody had clicked onto
   * while the run was going.
   */
  const parent = ledger.steps.find((step) => step.id === transform.parent) ?? null;
  if (parent === null) {
    console.error(`[book] step ${transform.id} names parent ${String(transform.parent)}, which this project's history does not hold.`);
    return {
      ok: false,
      reason: `The step “${transform.label}” was made from is not in this project's history, so `
        + 'there is no book for its words to be put into.',
    };
  }

  const read = await openBookAtPosition(projectDir, parent);
  if (!read.ok) return read;

  let made: ReturnType<typeof materialize>;
  try {
    made = materialize(read.opened.parsed, [...read.opened.ops, ...(read.opened.tip ?? [])]);
  } catch (err) {
    if (!(err instanceof BookOpsError)) throw err;
    console.error(`[book] the book under ${transform.id} could not be materialised: ${err.message}`);
    return {
      ok: false,
      reason: `The changes recorded under “${transform.label}” could not be replayed onto the book `
        + `it was translated from: ${err.message}`,
    };
  }
  if (made.missing.length > 0) {
    // Said out loud and not fatal — `Materialized.missing`'s ruling, and the same
    // sentence `materializeBook` prints for an export.
    console.error(
      `[book] ${made.missing.length} recorded change(s) could not be replayed under `
      + `${transform.id} — ${made.missing.map((one) => `${one.op.op} ${one.id}`).join(', ')}`,
    );
  }

  let rows: TranslationRow[];
  try {
    rows = parseRecordsFile(await fsp.readFile(recordsFile, 'utf8'));
  } catch (err) {
    if (!(err instanceof RecordsFileError) && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
    console.error(`[book] ${recordsFile} could not be read as records: ${(err as Error).message}`);
    return {
      ok: false,
      reason: `The words recorded as “${transform.label}” could not be read, so the translated book `
        + 'cannot be made. Its own history is intact; the file behind that row is not.',
    };
  }

  const words = translationWords(made.book, rows);
  /*
   * A RECORD ABOUT A BLOCK THIS BOOK DOES NOT HOLD IS NAMED. It is the ordinary
   * consequence of translating and then striking — the record is still in the
   * file, which is what an append-only payload is for — and it is also what a
   * records file from another reading would look like, so the count and the keys
   * go where somebody debugging their own library will find them.
   */
  if (words.stale.length > 0) {
    console.warn(
      `[book] ${words.stale.length} record(s) in ${recordsFile} answer for positions this book has `
      + `no block at — ${words.stale.slice(0, 12).join(', ')}`
      + (words.stale.length > 12 ? ', …' : ''),
    );
  }

  /*
   * THE LANGUAGE IS THE STEP'S, and a step that does not say is a book that
   * cannot be declared. `params.language` is recorded by the landing from what
   * the person asked for; nothing reads a language out of a file of sentences
   * (`translatedWords`, electron/workspace.ts, refuses the same thing in the same
   * words for the same reason).
   */
  const language = transform.params?.language?.trim() ?? '';
  if (language.length === 0) {
    return {
      ok: false,
      reason: `“${transform.label}” does not say which language it was made into, so there is `
        + 'nothing to declare its book as. It was recorded before Foundry kept that, and the way to '
        + 'get one is to translate again from the step it was made from.',
    };
  }

  const derived = translated(made.book, words.text, language);
  /*
   * THE PARTIAL IS HONEST AND IT IS NAMED. A row with no record keeps its source
   * text — the established rule (`Translated.untranslated`) — and the ids are
   * said here, which is the half the cast route never had: a book that comes out
   * with forty paragraphs still in the source language says which forty.
   */
  if (derived.untranslated.length > 0) {
    console.warn(
      `[book] ${derived.untranslated.length} of ${made.book.rows.length} block(s) have no `
      + `translation in ${recordsFile} and keep their source words — `
      + `${derived.untranslated.slice(0, 12).join(', ')}`
      + (derived.untranslated.length > 12 ? ', …' : ''),
    );
  }
  if (derived.untitled.length > 0) {
    console.warn(
      `[book] ${derived.untitled.length} chapter title(s) stay in the source language — their `
      + 'headings are not blocks this translation answers for: '
      + derived.untitled.join(', '),
    );
  }

  const file = translationBookFileFor(recordsFile);
  try {
    await writeAtomically(file, Buffer.from(formatBookFile(derived.book), 'utf8'));
  } catch (err) {
    console.error(`[book] ${file} could not be written: ${(err as Error).message}`);
    return {
      ok: false,
      reason: 'The translated book could not be written beside the words it was made from.',
    };
  }
  console.log(
    `[book] ${file} — ${derived.book.rows.length} block(s), `
    + `${words.text.size} translated, language ${language}.`,
  );
  return { ok: true, path: file };
}

/**
 * The derived book for a translation that has just landed, made now.
 *
 * ── Named by the file the run wrote, exactly as `ensureTranslateCast` is ────
 *
 * The settle holds the records path and nothing else: the step was minted by
 * `recordTranslation` a moment earlier, inside a manifest write the queue
 * deliberately does not reach into. So the row is looked up by the payload it
 * names — the same whole-project-relative-path rule every other lookup in this
 * app obeys, and emphatically not by reading anything back out of a filename.
 *
 * IT IS NOT FATAL TO THE LANDING. A translation that landed is hours of GPU
 * safely on disk in its records file, and the derived book is a pure function of
 * that file and the ledger — regenerable retention in the strongest sense, and
 * remade by the next open (`ensureTranslationBook`) if this could not write it
 * now. So a failure here is a console line and not a job reported as failed.
 */
export async function materializeTranslation(recordsPath: string): Promise<void> {
  const dir = projectDirOf(recordsPath);
  if (dir === null) {
    console.error(
      `[book] ${recordsPath} is outside any project, so no translated book was made from it.`,
    );
    return;
  }
  try {
    const view = await readStepLedger(dir);
    const relative = path.relative(dir, path.resolve(recordsPath)).split(path.sep).join('/');
    const step = view?.ledger.steps.find(
      (row) => row.action === 'translate' && row.payload === relative,
    );
    if (step === undefined) {
      console.warn(
        '[book] a translation landed and no step in that project\'s history names those answers, '
        + 'so no book was made from them.',
      );
      return;
    }
    const made = await writeTranslationBook(dir, view!.ledger, step);
    if (!made.ok) console.error(`[book] ${recordsPath}: ${made.reason}`);
  } catch (err) {
    console.error(
      `[book] a translation landed and its book could not be made `
      + `(${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

/**
 * The book at this project's position — reflowed first if nothing has reflowed
 * it, and handed to the pane with the two things the file itself cannot say.
 *
 * NEVER ANSWERS EMPTY (`BookOutcome`): a pane with no rows in it and no sentence
 * is indistinguishable from a book with nothing in it, and the two want opposite
 * things from the person looking at them.
 */
export async function loadBook(projectDir: string): Promise<BookOutcome> {
  return await bookFrom(projectDir, null);
}

/**
 * THE BOOK AS OF A NAMED STEP — Compare's read, and the only new question this
 * unit asks of main.
 *
 * ── It is `loadBook` with the row named instead of pointed at ───────────────
 *
 * Every piece of machinery this needs already existed and already took the
 * parameter: `openBookAtPosition` has carried a `from: LedgerStep | null` since
 * translations began materialising their derived books at the LANDING rather than
 * at the pointer, and `bookAtPosition` and `editsSinceTransform` take it for the
 * same reason. All that was missing was a door that turns an id into that step. So
 * this is not a second replay — it is the replay, asked about a different row, and
 * `bookFrom` below is the body both doors share so that it cannot become two.
 *
 * WHY THE COMPARISON NEEDS IT AT ALL. The compared column is locked to a step the
 * person picked out of their own history, and the position is somewhere else by
 * definition — that is what comparing means. `book:load` would answer with the
 * book at the POINTER, which is the book they are already looking at in the other
 * column, and the feature would draw the same page twice.
 *
 * A STEP THIS PROJECT DOES NOT HOLD IS A SENTENCE, NOT A THROW, because every
 * other way this call fails is a sentence the sheet draws (`BookOutcome`) and a
 * stale id is the ordinary consequence of a delete landing between the picker
 * being drawn and the answer arriving. The one thing that still rejects is the
 * directory gate, which is `bookAtPosition`'s and refuses before a byte is read.
 */
export async function loadBookAt(projectDir: string, stepId: string): Promise<BookOutcome> {
  /*
   * PROVEN FIRST, AND BY THE GATE THE REST OF THE FAMILY USES. `bookAtPosition`
   * runs `deletableProjectDir` before it touches the disk, so asking it for the
   * project is how this door refuses a directory that is not one of Home's — the
   * same refusal, in the same place, rather than a second check written here that
   * could come to disagree with it.
   */
  const at = await bookAtPosition(projectDir);
  const step = ledgerOf(at.manifest).steps.find((row) => row.id === stepId) ?? null;
  if (step === null) {
    return {
      ok: false,
      reason: 'That step is not in this book\'s history any more, so there is nothing to compare '
        + 'against. It was probably deleted while this column was open.',
    };
  }
  return await bookFrom(projectDir, step);
}

/**
 * The body `loadBook` and `loadBookAt` share — everything from the replay to the
 * pair, with the row it is about handed in.
 *
 * `from === null` IS THE POSITION and is what every viewer in the app asks for;
 * a step is Compare's read-only column. Nothing below branches on which of the two
 * it was, and that is the point: a compared step gets the same figures prefix, the
 * same unplaced sentences and the same aligned pair as standing on it would,
 * because it IS standing on it — read-only, in the other column.
 */
async function bookFrom(projectDir: string, from: LedgerStep | null): Promise<BookOutcome> {
  const read = await openBookAtPosition(projectDir, from);
  if (!read.ok) return read;
  const { at, parsed, ops, tip, transform } = read.opened;
  const unplaced = read.opened.unplaced ?? [];
  /*
   * The figures prefix is minted only when a row will ask for one. `null` is the
   * pane's ordinary answer for a book with no cut images — no --pdf at reflow, or
   * no pictures in the book — and the plate placeholder is what draws in that
   * silence.
   */
  const figures = parsed.rows.some((row) => row.image !== undefined)
    ? figuresPrefixFor(imagesDirFor(at.bank))
    : null;
  return {
    ok: true,
    // THE TITLE IS THE PROJECT'S. A book file is a list of blocks and has no idea
    // what the book is called; the catalogue is where that has lived for every
    // other surface in this app (`ProjectsService.nameFor`).
    title: at.manifest.title,
    language: parsed.header.language,
    rows: parsed.rows,
    chapters: parsed.header.chapters,
    typography: parsed.header.typography,
    seams: parsed.header.seams,
    loose: parsed.header.loose,
    figures,
    ops,
    tip,
    /*
     * The sentences an old save left behind, when there are any — carried on the
     * load so the sheet can say them where the book is, rather than raised as a
     * failure of a book that opened perfectly well. See `BookLoad.unplaced`.
     */
    ...(unplaced.length > 0 ? { unplaced } : {}),
    /*
     * AND THE PAIR, WHEN THERE IS ONE — *"two scroll-locked columns over two book
     * files with the same ids"* (docs/RENDERER.md §5), carried in the one answer
     * the pane already asks for. See `sourceOfTranslation` for what the left-hand
     * rows are and why they are rows and nothing else.
     */
    translation: transform === null
      ? null
      : {
        // The step's own param, which is where a translation's language has lived
        // since `recordTranslation` began writing it: nothing reads a language out
        // of a file of sentences. `parsed.header.language` says the same thing —
        // `translated` declares it from this very field — and this is the side of
        // the pair that is a fact about the STEP rather than about a file.
        language: transform.params?.language?.trim() ?? parsed.header.language,
        // AND WHICH REWRITE, WHERE THERE WAS ONE. A simplify is a translate step
        // carrying a mode, so this is the only thing on the step that says which
        // of the two acts the person actually ordered — and the pane has sentences
        // that name it. Absent is a translation, which is what `readParams`
        // guarantees: a `rewrite` that survived parsing is one this build can name.
        ...(transform.params?.rewrite !== undefined ? { rewrite: transform.params.rewrite } : {}),
        source: await sourceOfTranslation(at.dir, ledgerOf(at.manifest), transform),
      },
  };
}

/**
 * THE LEFT-HAND COLUMN — the parent book as the records answered it.
 *
 * ── It is `writeTranslationBook`'s own first half, and that is the point ────
 *
 * That function materialises `parent book file + chain ops` and then puts the
 * records' words into the result (docs/RENDERER.md §4). What comes back from here
 * is the state at the end of its first sentence: the same parent, opened the same
 * way, with the same chain replayed by the same `materialize`. So the ids in these
 * rows are the ids in the derived file BY CONSTRUCTION rather than by hope — the
 * two columns are one book twice, which is the only reason locking them together
 * by id is honest.
 *
 * ── ROWS, AND NO OPS ───────────────────────────────────────────────────────
 *
 * The chain is already IN them. Handing the pane an ops list beside these rows
 * would invite it to replay a second time, and a strike replayed twice takes out a
 * row the first one already removed. There is also nothing to edit here: the left
 * column is context (source edits stand above the translation, where they
 * invalidate the records by changing the question the cost cache is keyed on), so
 * there is no gesture on that sheet that could mint an op to carry.
 *
 * ── EVERY REFUSAL IS THE LEFT SHEET'S AND NEVER THE PANE'S ─────────────────
 *
 * See `BookTranslation.source`: the position is drawable without its context, so
 * nothing here is allowed to take the whole load down. Each way this fails already
 * has a sentence written to be read, and they are passed through rather than
 * paraphrased.
 */
async function sourceOfTranslation(
  projectDir: string,
  ledger: LedgerView['ledger'],
  transform: LedgerStep,
): Promise<{ ok: true; rows: BookFile['rows'] } | { ok: false; reason: string }> {
  const parent = ledger.steps.find((step) => step.id === transform.parent) ?? null;
  if (parent === null) {
    console.error(
      `[book] step ${transform.id} names parent ${String(transform.parent)}, which this project's `
      + 'history does not hold, so there is no source to show beside it.',
    );
    return {
      ok: false,
      reason: `The step “${transform.label}” was made from is not in this project's history, so there `
        + 'is no source to set beside these words.',
    };
  }
  const read = await openBookAtPosition(projectDir, parent);
  if (!read.ok) return read;
  let made: ReturnType<typeof materialize>;
  try {
    made = materialize(read.opened.parsed, [...read.opened.ops, ...(read.opened.tip ?? [])]);
  } catch (err) {
    if (!(err instanceof BookOpsError)) throw err;
    console.error(`[book] the source under ${transform.id} could not be materialised: ${err.message}`);
    return {
      ok: false,
      // NAMED BY THE ACT THAT WAS ORDERED, because a simplify is a translate step
      // and this sentence is read on the very sheet the pair is drawn on: telling
      // somebody their rewrite was "translated from" a book is the pane's own
      // vocabulary failure in main's voice. The label already says which it was.
      reason: `The changes recorded above “${transform.label}” could not be replayed onto the book it `
        + `was ${transform.params?.rewrite === undefined ? 'translated' : 'simplified'} from, so its `
        + `source cannot be set beside it: ${err.message}`,
    };
  }
  /*
   * A CHANGE THAT LANDED ON NOTHING IS SAID OUT LOUD AND IS NOT FATAL — the same
   * ruling `materializeBook` and `writeTranslationBook` both make about the same
   * list, and the same one for the same reason: the column is context, and
   * refusing to show any of it over one stale strike is the worst answer here too.
   */
  if (made.missing.length > 0) {
    console.error(
      `[book] ${made.missing.length} recorded change(s) could not be replayed for the source beside `
      + `${transform.id} — ${made.missing.map((one) => `${one.op.op} ${one.id}`).join(', ')}`,
    );
  }
  return { ok: true, rows: made.book.rows };
}

/**
 * A CORRECTED PARAGRAPH ON A TRANSLATED POSITION — the words go to the records,
 * never to a text op.
 *
 * ── The rule, and why it is not a preference ────────────────────────────────
 *
 * *"Translated edits are per-language record corrections."* (docs/RENDERER.md §5.)
 * The words of a translated block belong to the records file: that file is the
 * step's payload, it is the truth the derived book is a pure function of, and
 * every position under the translation is drawn from that derived book. A `text`
 * op over the same block would put the person's sentence in the ops chain while
 * the records still held the machine's — two accounts of one paragraph, which is
 * precisely the failure `translationWorldOf` was built to prevent one surface over
 * ("mirroring it into the source curation would write Hungarian over the German
 * bank, silently", electron/projects.ts). So the edit goes where the words live.
 *
 * ── THE ID MUST BE A ROW OF THE BOOK FILE, and this is where that is proven ──
 *
 * A record is keyed by a block id and read back by looking that id up in the book
 * being materialised (`translationWords`). The pane can hold ids that book has
 * never had — the halves of an unapplied cut, `b2-3/1` and `b2-3/2`, which exist
 * only in the replay — and a record filed under one of those would be a row that
 * every future materialisation reports as stale and no reader ever finds. It is
 * refused by name instead, with the sentence saying which gesture comes first.
 *
 * ── The order, and what the caller gets back ────────────────────────────────
 *
 * Append, re-materialise, re-read. The derived book is stale from the instant the
 * row is appended until it is made again (main's `translation:record-edit` door
 * makes the same pair of calls for the same reason), and the pane cannot draw the
 * corrected words until it is. So the answer is the WHOLE BOOK back — one question,
 * one answer, on `loadBook`'s own rule — rather than an acknowledgement the pane
 * would have to follow with a second round trip.
 *
 * IT REJECTS, on `applyBookOps`'s rule: the person's words are in front of them
 * and a refusal is something they can act on.
 */
export async function correctBookBlock(
  projectDir: string,
  id: string,
  text: string,
  /** The queue's answer to "is a run writing this file right now" — main holds both. */
  busy: (recordsFile: string) => string | null = () => null,
): Promise<BookOutcome> {
  const read = await openBookAtPosition(projectDir);
  if (!read.ok) {
    // The load's own sentence, thrown rather than returned: this is a write door,
    // and a book that cannot be opened is a correction that cannot be recorded.
    throw new ProjectError(read.reason);
  }
  const { at, parsed, transform } = read.opened;
  if (transform === null) {
    throw new BookOpsError(
      'These words are not a translation\'s, so there is no translation to record a correction in. '
      + 'An edit here is an ordinary change to the book.',
    );
  }
  if (!parsed.rows.some((row) => row.id === id)) {
    throw new ProjectError(
      'This paragraph is not one the translation answered for — it was made by a change that is '
      + 'still waiting to be applied. A translation keeps its words block by block, so apply the '
      + 'change first and the corrected words have somewhere to be recorded.',
    );
  }
  const records = await recordCorrection(at.dir, transform, id, text, busy);
  await materializeTranslation(records);
  return loadBook(projectDir);
}

/**
 * MATERIALISE — the position's book with its whole chain replayed into it,
 * written out as a book file of its own.
 *
 * ── What it is for, and why it is a file at all ─────────────────────────────
 *
 * *"Export → materialize (replay) → engine compiles EPUB/txt."* (docs/RENDERER.md
 * §6.) The engine has never heard of the op grammar and is never going to: the
 * replay lives once, in shared/, because the renderer needs it in-process, so
 * MAIN materialises and the engine compiles what it is handed (§9, R1). This is
 * the seam between those two sentences, and a file is what crosses it.
 *
 * ── IT IS SCRATCH, AND IT IS THE CALLER'S TO SWEEP ──────────────────────────
 *
 * A derived book file is `regenerable` retention in the strongest sense — it is a
 * pure function of a file on disk and a chain in the ledger, and remaking it costs
 * a read and a replay — so nothing catalogues it, nothing points at it, and the
 * job that asked for one removes it when it settles. `into` is the directory it
 * goes in, which the caller chooses precisely because THIS module has no business
 * deciding whether a scratch file belongs in the OS temp directory or beside the
 * project.
 *
 * WRITTEN ATOMICALLY, like every other file this app writes: a temp path and a
 * rename, so an interrupted write leaves nothing rather than half a book — and
 * half a book file is a compile that refuses on a row that was cut in two.
 */
export async function materializeBook(
  projectDir: string,
  into: string,
  /**
   * THE STEP TO BUILD FOR, when it is not the position — `openBookAtPosition`'s
   * own parameter, exposed because a caller can want a book for a row the pointer
   * is not standing on.
   *
   * The export that arrives from outside the window is the case that asked for
   * it: a host ordering an act from a step in the tree needs the EPUB of THAT
   * step, and the person may be standing three rows away (`exportEpubFromStep`,
   * electron/mount.ts). Null and absent both mean the position, which is every
   * export somebody pressed the button for.
   */
  from: LedgerStep | null = null,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const read = await openBookAtPosition(projectDir, from);
  if (!read.ok) return read;
  const { at, parsed, ops, tip } = read.opened;

  let made: ReturnType<typeof materialize>;
  try {
    /*
     * THE TIP'S OPS ARE PART OF THE BOOK. `openBookAtPosition` withholds the
     * amendable tip step's ops from `ops` and hands them back as `tip`,
     * because the PANE needs them separately — they hydrate its undo stack.
     * Every other consumer wants the concatenation, and this call site was
     * the one of three that forgot it: standing on a freshly applied edit
     * step, every op the person just made is in the tip and `ops` is empty,
     * so the book that went to the compiler was the unedited one — an EPUB
     * with every struck block still in it, exported from a workbench whose
     * Final version showed them gone.
     */
    made = materialize(parsed, [...ops, ...(tip ?? [])]);
  } catch (err) {
    if (!(err instanceof BookOpsError)) throw err;
    console.error(`[book] ${read.opened.path} could not be materialised: ${err.message}`);
    return {
      ok: false,
      reason: `The changes recorded for this book could not be replayed onto it: ${err.message}`,
    };
  }
  /*
   * AN OP THE REPLAY COULD NOT PERFORM IS SAID OUT LOUD AND IS NOT FATAL, which
   * is `Replayed.missing`'s own ruling: a chain can name a block a later reading
   * no longer has, and refusing to export a whole book over one stale strike is
   * the worst of the three answers available. The terminal gets the count and the
   * ids; the book that comes out carries everything that still landed.
   */
  if (made.missing.length > 0) {
    console.error(
      `[book] ${read.opened.path}: ${made.missing.length} recorded change(s) could not be replayed `
      + `for this export — ${made.missing.map((one) => `${one.op.op} ${one.id}`).join(', ')}`,
    );
  }

  const file = path.join(into, `${randomUUID()}.book.jsonl`);
  try {
    await writeAtomically(file, Buffer.from(formatBookFile(made.book), 'utf8'));
  } catch (err) {
    console.error(`[book] the derived book for ${at.dir} could not be written: ${(err as Error).message}`);
    return {
      ok: false,
      reason: 'The book with your changes in it could not be written out for the engine to compile.',
    };
  }
  return { ok: true, path: file };
}

/**
 * APPLY — the pane's stack, written down as a step.
 *
 * ── The order, which is the whole of the correctness here ───────────────────
 *
 * The ops are PROVEN, then the file is written ATOMICALLY, then the step lands.
 * Every other order has a failure that leaves the project describing something
 * that is not there: a step written first and a disk that then refuses leaves a
 * row in somebody's history naming a payload that does not exist, and
 * `loadBook` above rightly refuses the whole book for it — one full stop, forever,
 * over a transient write error. A file written first and a step that never lands
 * leaves eight kilobytes in `ops/` that nothing will ever mention again, which is
 * the smaller failure by a wide margin and is the one this order chooses.
 *
 * ATOMICALLY means a temp file beside the target and a rename (`writeAtomically`,
 * electron/atomic.ts): a rename is atomic on one volume, so an interrupted
 * Apply leaves no file rather than half of one — and half a file of ops is a book
 * that opens missing the second half of somebody's afternoon.
 *
 * ── Why the ops are re-read after being written out ─────────────────────────
 *
 * Because they arrived over IPC and a renderer is not a trusted author of a
 * payload format. This app's rule for anything crossing that seam is that the
 * receiving side proves it (`parseLedger`, `parseBookFile`, `parseTargetKey`), and
 * the proof available here is exactly the one every later reader will apply: put
 * it in the format and read it back with the format's own parser. A shape this
 * build cannot replay is refused BY NAME here, before it is on anybody's disk,
 * rather than by every open of the book from now on.
 *
 * ── It rejects, and that is deliberate ──────────────────────────────────────
 *
 * `loadBook` answers a sentence because there is nothing else to put on an empty
 * sheet. This is the other case: the person's changes are still on the stack in
 * front of them, so a refusal is something they can act on — and a resolve that
 * quietly did nothing would clear a stack that had not been recorded.
 */
export async function applyBookOps(projectDir: string, ops: readonly BookOp[]): Promise<LedgerView> {
  // The same gate every call in this family goes through, before anything is
  // read or written: `bookAtPosition` resolves it through `deletableProjectDir`.
  const at = await bookAtPosition(projectDir);
  if (ops.length === 0) {
    throw new BookOpsError(
      'There are no changes waiting to be applied, and a step recording nothing would be a row in '
      + 'this book\'s history that nobody can tell from the one above it.',
    );
  }
  const bytes = formatOpsFile(ops);
  // The round trip is the proof — see the header. It throws `BookOpsError` with a
  // sentence naming the line and the field, which is what the caller shows.
  parseOpsFile(bytes);

  /*
   * MINTED HERE, BEFORE THE FILE, because the file is named after it — the
   * reading's arrangement (`ReadRequest.stepId`) for the reading's reason. It is
   * spent on an append, which is every time: an edit is irreplaceable, so
   * `reRunTarget` can never resolve one and every Apply is a row of its own.
   */
  const stepId = randomUUID();
  const payload = opsPayloadFor(stepId);
  await fsp.mkdir(opsDir(at.dir), { recursive: true });
  await writeAtomically(path.join(at.dir, ...payload.split('/')), Buffer.from(bytes, 'utf8'));

  try {
    return await recordBookEdit(at.dir, payload, { ops: ops.length }, stepId);
  } catch (err) {
    /*
     * THE FILE GOES WITH THE ROW THAT NEVER HAPPENED. It is named after a step id
     * nothing else will ever mint, so leaving it would be bytes no screen in this
     * app could ever mention again — the exact state `planStepSweep` exists to
     * prevent at the other end of a step's life. `force` because the interesting
     * failure is the one being rethrown.
     */
    await fsp.rm(path.join(at.dir, ...payload.split('/')), { force: true });
    throw err;
  }
}

/**
 * AMEND — the tip edit step rewritten to what the pane now holds.
 *
 * ── Why this exists beside `applyBookOps` ───────────────────────────────────
 *
 * A second Apply while standing on an edit step with nothing under it used to
 * mint a sibling row, so five rounds of strike-and-apply read as five steps of
 * history about one sitting (user ruling, 2026-08-16). While the step is the
 * TIP — nothing landed under it, nothing made from it — its ops are still the
 * person's to change, so Apply rewrites the step's own file to the list the
 * pane holds now. That list can be SHORTER than what was recorded: the pane's
 * undo reaches back through applied ops precisely because this door can record
 * the removal. The moment anything lands under the step it freezes, this door
 * refuses by sentence, and the next Apply is a new row (`applyBookOps`).
 *
 * AN EMPTY LIST IS REFUSED. Undoing everything a step recorded and applying
 * that is deleting the step, and deletion has its own door in the tree with
 * its own question; a step whose file says nothing would be a row nobody can
 * tell from the one above it.
 *
 * WHO THE TIP IS IS MAIN'S ANSWER, NOT THE RENDERER'S. The pane asks to amend
 * "the position"; main re-derives that the position is an amendable tip at the
 * moment of the write (`recordBookEditAmend`, inside the manifest lock), so a
 * child that landed between the pane's load and its Apply meets a refusal
 * rather than a rewrite of a file that stopped being safe to rewrite.
 */
/**
 * VIEW A FINISHED EXPORT — the file exploded into a book file and handed to the
 * pane read-only, in the same shape `book:load` answers.
 *
 * ── The same derivation an imported EPUB gets, aimed at a temp cache ────────
 *
 * The iframe reader is deleted and stays deleted; what shows an EPUB now is the
 * proof sheet over `f(epub)`, which is honest in a way a rendering engine over
 * foreign markup never was — the pane draws exactly what the container holds,
 * through the one explode. The cache is keyed by the FILE'S OWN BYTES (sixteen
 * hex of sha-256), so a re-export at the same name views fresh and an unchanged
 * file explodes once; it lives in the OS temp directory because it is a viewing
 * artifact of a copy, not a fact about the project — the project's own book
 * files describe positions, and this file may be three Applies stale by design.
 *
 * GATED ON THE FINAL TRAY, exactly as `export:save-copy` is and for its reason:
 * this door exists so a person can look at the thing this app just filed, and
 * membership in a project's tray is the whole of that claim.
 */
export async function viewExportedBook(target: string): Promise<BookOutcome> {
  const resolved = path.resolve(target);
  const dir = projectDirOf(resolved);
  const inside = dir === null ? null : path.relative(dir, resolved).split(path.sep);
  if (dir === null || inside === null || inside.length !== 2 || inside[0] !== 'final'
    || !resolved.toLowerCase().endsWith('.epub')) {
    return { ok: false, reason: 'This tab can only show one of this library’s exported books.' };
  }
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(resolved);
  } catch (err) {
    console.error(`[book] ${resolved} could not be read for viewing: ${(err as Error).message}`);
    return { ok: false, reason: 'This export could not be read back from the tray.' };
  }
  const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const cave = path.join(os.tmpdir(), 'foundry-view');
  await fsp.mkdir(cave, { recursive: true });
  const book = path.join(cave, `${sha}.book.jsonl`);
  if (!await exists(book)) {
    const made = await writeEpubBook(resolved, book);
    if (!made.ok) {
      console.error(`[book] ${resolved} would not explode for viewing: ${made.reason ?? ''}`);
      return {
        ok: false,
        reason: 'This export could not be opened as a book. The engine refused, and its own words '
          + 'are in the terminal.',
      };
    }
  }
  let parsed: BookFile;
  try {
    parsed = parseBookFile(await fsp.readFile(book, 'utf8'));
  } catch (err) {
    if (!(err instanceof BookFileError)) throw err;
    // A stale or half-written cache entry is swept and the next open remakes
    // it; the cache is nobody's record of anything.
    await fsp.rm(book, { force: true });
    console.error(`[book] the view cache for ${resolved} would not parse: ${err.message}`);
    return { ok: false, reason: 'This export could not be opened as a book. Try it again.' };
  }
  const manifest = await readManifest(dir);
  const figures = parsed.rows.some((row) => row.image !== undefined)
    ? figuresPrefixFor(path.join(cave, `${sha}.images`))
    : null;
  return {
    ok: true,
    title: manifest.title,
    language: parsed.header.language,
    rows: parsed.rows,
    chapters: parsed.header.chapters,
    typography: parsed.header.typography,
    seams: parsed.header.seams,
    loose: parsed.header.loose,
    figures,
    ops: [],
    tip: null,
    translation: null,
  };
}

export async function amendBookOps(projectDir: string, ops: readonly BookOp[]): Promise<LedgerView> {
  const at = await bookAtPosition(projectDir);
  if (ops.length === 0) {
    throw new BookOpsError(
      'Applying this would leave the step recording nothing — every change it held has been '
      + 'undone. Deleting the step is the tree\'s gesture, with its own question.',
    );
  }
  const bytes = formatOpsFile(ops);
  parseOpsFile(bytes);
  return await recordBookEditAmend(at.dir, bytes, ops.length);
}
