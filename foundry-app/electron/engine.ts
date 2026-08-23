/**
 * engine — the one place that knows how to run foundry.
 *
 * foundry is a STANDALONE UNIT. This app never imports a line of it; it spawns
 * it, reads its stderr, and believes its exit code (0 ok, 1 the run failed,
 * 2 the command line was wrong). Everything about *which* program that is lives
 * in `engineCommand()` below and nowhere else, so replacing the dev checkout
 * with a packaged binary is one function.
 *
 * Cribbed from BookForge's electron/foundry-bridge.ts: the argument-array spawn
 * (never a shell string — a binary under `C:\Program Files\…` interpolated into
 * a command line becomes the program `C:\Program`), the line-buffered stderr
 * reader (a progress callback fired on half a line is a UI showing half a page
 * number), and returning a nonzero exit rather than throwing on it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

import { hosted } from './host';
import { fold } from '../shared/original';
import type {
  DocumentMetadata,
  DoctorResult,
  EngineInfo,
  JobProgress,
  MetadataOutcome,
} from '../shared/types';

// ─────────────────────────────────────────────────────────────────────────────
// Which program
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineCommand {
  command: string;
  /** Fixed leading arguments — `run <cli.ts>` for the dev checkout, none for a binary. */
  args: string[];
  source: string;
}

/** dist/electron -> dist -> app -> the foundry checkout this app lives in. */
function repoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

let cached: EngineCommand | null = null;

/**
 * THE constant. Three answers, in precedence order:
 *
 *   1. `FOUNDRY_BIN` — an operator pointing at a build of their own.
 *   2. A binary shipped beside a packaged app (resources/foundry[.exe]).
 *   3. The dev checkout: `bun run <repo>/src/cli.ts`.
 *
 * (3) is derived from __dirname rather than hardcoded, so a clone anywhere
 * works. When foundry ships a binary with the installer, only (2) changes.
 *
 * HOSTED, (3) IS REFUSED. This file is vendored into the host's tree, so
 * "three levels up" is the host's checkout — the cli.ts there is somebody
 * else's code or nobody's, and spawning it would be the silent wrong-engine
 * failure that is worse than no engine at all. A host owes us FOUNDRY_BIN or
 * a packaged binary (docs/BOOKFORGE-HANDOFF.md); missing both is its bug,
 * and this throw is the sentence that names it.
 */
export function engineCommand(): EngineCommand {
  if (cached) return cached;

  const declared = process.env['FOUNDRY_BIN']?.trim();
  if (declared) {
    cached = { command: declared, args: [], source: 'FOUNDRY_BIN' };
    return cached;
  }

  const binaryName = process.platform === 'win32' ? 'foundry.exe' : 'foundry';
  const packaged = path.join(process.resourcesPath ?? '', binaryName);
  if (app.isPackaged && fs.existsSync(packaged)) {
    cached = { command: packaged, args: [], source: 'packaged binary' };
    return cached;
  }

  const cliPath = path.join(repoRoot(), 'src', 'cli.ts');
  if (hosted()) {
    throw new Error(
      `no engine: FOUNDRY_BIN is unset and no packaged binary was found, and ` +
      `the dev-checkout fallback (${cliPath}) resolves inside the host's ` +
      `repository, not foundry's. The host must set FOUNDRY_BIN before ` +
      `mountFoundry().`,
    );
  }
  cached = {
    command: 'bun',
    args: ['run', cliPath],
    source: 'dev checkout',
  };
  return cached;
}

/** `foundry --version`, or null. Asked once, at startup, for the settings screen. */
export function engineInfo(): EngineInfo {
  const cmd = engineCommand();
  let version: string | null = null;
  try {
    const probe = spawnSync(cmd.command, [...cmd.args, '--version'], {
      timeout: 30_000,
      windowsHide: true,
      encoding: 'utf8',
    });
    if (probe.status === 0) version = (probe.stdout || '').trim() || null;
  } catch {
    version = null;
  }
  return { ...cmd, version };
}

// ─────────────────────────────────────────────────────────────────────────────
// Running it
// ─────────────────────────────────────────────────────────────────────────────

export interface RunHandle {
  /** Resolves when the child exits, however it exits. */
  done: Promise<{ code: number; stdout: string; stderr: string }>;
  /** Take the whole tree down. A cancel that left the model loaded is not a cancel. */
  cancel(): void;
}

export function runEngine(
  args: string[],
  onLine?: (line: string) => void,
): RunHandle {
  const cmd = engineCommand();
  let child: ChildProcess | null = null;
  let cancelled = false;

  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    child = spawn(cmd.command, [...cmd.args, ...args], {
      env: process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let pending = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (!onLine) return;
      // Line-buffered, deliberately: see the module note.
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim().length > 0) onLine(line);
    });

    child.on('error', (err) => {
      resolve({
        code: 127,
        stdout,
        stderr: `${stderr}\n${cmd.command} could not be started (${cmd.source}): ${err.message}`,
      });
    });
    child.on('close', (code) => {
      if (pending.trim().length > 0 && onLine) onLine(pending);
      resolve({ code: cancelled ? -1 : (code ?? 1), stdout, stderr });
    });
  });

  return {
    done,
    cancel(): void {
      cancelled = true;
      killTree(child);
    },
  };
}

/**
 * Kill the child AND everything it started.
 *
 * `bun run src/cli.ts` is a shell of a process in front of the real work, and
 * the real work spawns Python that holds a GPU. `child.kill()` reaches the
 * first of those and none of the rest, so a cancelled job would go on rendering
 * pages with nothing left listening — on Windows the only reliable answer is
 * taskkill's tree flag.
 */
function killTree(child: ChildProcess | null): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      return;
    } catch {
      // fall through to the signal
    }
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One stderr line -> a page count, or null.
 *
 * Cribbed verbatim in shape from BookForge's shared/vlm/conversion.ts
 * `parseVlmProgressLine`, including the ORDER of the three patterns, which is
 * load-bearing:
 *
 *   `page 3/317: rendered`        the rasteriser's own line, forwarded through
 *                                 foundry, with NO `vlm-convert:` prefix — which
 *                                 is why the prefix test cannot come first;
 *   `vlm-convert: … page 12 (5/317)`   the endpoint route, checked before the
 *                                 local pattern because it also contains
 *                                 "page N" and would be read as a count;
 *   `vlm-convert: … page 5/317`   the local route.
 */
export function parseProgressLine(line: string): JobProgress | null {
  const trimmed = line.trim();

  const rendered = /^page\s+(\d+)\/(\d+):\s+rendered$/.exec(trimmed);
  if (rendered) {
    return { phase: 'render', page: Number(rendered[1]), total: Number(rendered[2]) };
  }

  /*
   * `translate: block 412/2081 (EPUB/text/c0003.xhtml)`.
   *
   * Matched before the `vlm-convert:` gate because it is a different command
   * with its own prefix, and matched on `block` specifically so the engine's
   * OTHER translate lines — the rejected-answer notices, which also carry a
   * fraction (`attempt 2/3`) — cannot be read as progress. A bar that jumped to
   * 67% because an answer was retried would be a bar reporting the wrong
   * quantity entirely.
   */
  const block = /^translate:\s+block\s+(\d+)\/(\d+)\b/.exec(trimmed);
  if (block) {
    return { phase: 'translate', page: Number(block[1]), total: Number(block[2]) };
  }

  /*
   * `vlm-read:` AND `vlm-convert:`, the same shape under two names.
   *
   * Reading the pages left `vlm-convert` and became a command of its own, and the
   * lines it writes are the ones this function was built for — they ARE the page
   * counts; the conversion is what stopped emitting them. Gated on the prefix at
   * all (rather than matching any `page n/m`) for the reason the gate has always
   * existed: the engine says a great many things with numbers in them, and a bar
   * that read `attempt 2/3` as progress would jump to 67% because an answer was
   * retried.
   *
   * `vlm-convert:` stays because a rendering still counts its pages as it writes
   * them, and because dropping it would silently un-bar every conversion the day
   * this file changed.
   */
  if (!trimmed.startsWith('vlm-read:') && !trimmed.startsWith('vlm-convert:')) return null;

  const viaEndpoint = /\bpage\s+\d+\s+\((\d+)\/(\d+)\)/.exec(trimmed);
  if (viaEndpoint) {
    return { phase: 'read', page: Number(viaEndpoint[1]), total: Number(viaEndpoint[2]) };
  }

  const local = /\bpage\s+(\d+)\/(\d+)\b/.exec(trimmed);
  if (local) {
    return { phase: 'read', page: Number(local[1]), total: Number(local[2]) };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// epub-stamp
// ─────────────────────────────────────────────────────────────────────────────

/** What `foundry epub-stamp` did, or the sentence saying why it would not. */
export interface StampOutcome {
  ok: boolean;
  /** Blocks given a `data-bf-cat` by this run. Zero on a book already stamped. */
  blocks: number;
  /** `data-bf-id` written where there was none. */
  ids: number;
  /** Spine documents the engine read. */
  documents: number;
  /** The engine's own words, when it refused. Never paraphrased. */
  reason: string | null;
}

/**
 * The completion line's contract, and it IS a contract.
 *
 * `epub-stamp`'s first report line is written to be read from here — see the
 * comment on `runEpubStamp` in src/commands.ts — the same way
 * `parseProgressLine` above reads the conversion's page counts off stderr. The
 * three phrases are the interface; the prose around them is free to change.
 *
 * A line that does not match is not an error: the run exited 0, so the book WAS
 * stamped, and the only thing lost is the app's ability to say how much. The
 * numbers are used to decide whether to reload a rendered chapter, and reloading
 * one that did not need it costs a scroll position.
 */
function readStampLine(stderr: string): { blocks: number; ids: number; documents: number } {
  const number = (pattern: RegExp): number => {
    const match = pattern.exec(stderr);
    return match === null ? 0 : Number(match[1]);
  };
  return {
    blocks: number(/(\d+) blocks stamped/),
    ids: number(/(\d+) ids written/),
    documents: number(/epub-stamp: (\d+) documents?\b/),
  };
}

/**
 * Stamp a book: `foundry epub-stamp --epub <tree|file> [--out <file>]`.
 *
 * `target` is a working tree — a DIRECTORY, which the command stamps in place,
 * because that copy is ours and mutating it is the point — or an `.epub` file,
 * which requires `outPath` because foundry never writes over an input.
 *
 * NEVER THROWS. Both callers want a book either way: the import path opens a
 * book that could not be stamped and says so in the notice strip, and select
 * mode turns the refusal into its own sentence. A stamping failure is a fact
 * about the book, not a reason to lose it.
 */
export async function stampEpub(target: string, outPath?: string): Promise<StampOutcome> {
  const args = ['epub-stamp', '--epub', target];
  if (outPath !== undefined) args.push('--out', outPath);

  const run = runEngine(args);
  // A whole book's markup, parsed and rewritten. Minutes is wrong; two of them
  // is a hung process, and a hang here would hold an import open forever.
  const timer = setTimeout(() => run.cancel(), 120_000);
  const result = await run.done.finally(() => clearTimeout(timer));

  if (result.code !== 0) {
    const said = result.stderr.trim() || result.stdout.trim();
    const unknown = result.code === 2 && /unknown command/i.test(said);
    return {
      ok: false,
      blocks: 0,
      ids: 0,
      documents: 0,
      reason: unknown
        ? `epub-stamp is not in this engine build (${engineCommand().source}).`
        : said || `The engine exited ${result.code} with nothing to say.`,
    };
  }

  return { ok: true, ...readStampLine(result.stderr), reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// epub-final
// ─────────────────────────────────────────────────────────────────────────────

/** What `foundry epub-final` did, or the sentence saying why it would not. */
export interface FinalOutcome {
  ok: boolean;
  /** The engine's own words, when it refused. Never paraphrased. */
  reason: string | null;
}

/**
 * Turn a book into the EDITION: `foundry epub-final --epub <book> --out <file>`.
 *
 * WHAT THE COMMAND IS FOR, in one line, because this app now has two doors onto
 * it: `generated/` is a workbench and keeps a curator's marks, and anything that
 * lands in `final/` is an edition — struck elements really removed, the notes and
 * contents entries they orphaned tidied, the reference numbers they left dangling
 * demoted back to the digit the page printed, and foundry's editing attributes
 * stripped. The fresh-cast route asks the engine for the same thing one stage
 * earlier (`vlm-convert --final`); this is the route for a book that already
 * exists.
 *
 * `--out` MAY NEVER BE `--epub`. The command refuses it — a tidy in place cannot
 * be run twice, because the second run would have nothing left to read — so every
 * caller here writes through a path of its own and the input survives untouched.
 *
 * NEVER THROWS, on `stampEpub`'s rule: this is one step of a save or of a queued
 * job, and both have a place to put a sentence. What the CALLER must not do is
 * treat a refusal as a success — a save that did not write the edition has not
 * saved, and `epub:save` rejects across IPC for exactly that reason.
 */
export async function finalizeEpub(epubPath: string, outPath: string): Promise<FinalOutcome> {
  const run = runEngine(['epub-final', '--epub', epubPath, '--out', outPath]);
  // A whole book's markup, parsed, tidied and rezipped. The same two minutes
  // `stampEpub` allows for the same work over the same book, and for the same
  // reason: past that, nothing is happening and a modal is waiting on it.
  const timer = setTimeout(() => run.cancel(), 120_000);
  const result = await run.done.finally(() => clearTimeout(timer));

  if (result.code !== 0) {
    const said = result.stderr.trim() || result.stdout.trim();
    const unknown = result.code === 2 && /unknown command/i.test(said);
    return {
      ok: false,
      reason: unknown
        ? `epub-final is not in this engine build (${engineCommand().source}).`
        : said || `The engine exited ${result.code} with nothing to say.`,
    };
  }
  return { ok: true, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// vlm-book
// ─────────────────────────────────────────────────────────────────────────────

/** What `foundry vlm-book` did, or the sentence saying why it would not. */
export interface BookOutcome {
  ok: boolean;
  /** The engine's own words, when it refused. Never paraphrased. */
  reason: string | null;
}

/**
 * ONE WRITER PER BOOK FILE — the lock that was missing, and whose absence cost a
 * user their figures on 2026-08-19.
 *
 * ── The defect, exactly ─────────────────────────────────────────────────────
 *
 * Two places in this app write the same book file and neither knew about the
 * other. `remakeBookFile` (electron/job-queue.ts) rebuilds it the moment a
 * reading lands, because a fresh bank makes the old book stale by definition.
 * `ensureReadingBook` (electron/book.ts) builds it when somebody opens the book
 * and there is no file yet. Those two events are ONE EVENT in ordinary use: the
 * read finishes, the window is told, the person clicks straight into the book
 * that just appeared. `ensureReadingBook`'s only guard was
 * \`if (await exists(at.book)) return\` — a check-then-act with an await in the
 * middle of it, which is the classic shape of a race and not a lock at all. The
 * file does not exist until the FIRST engine renames its temp file into place at
 * the very end of its run, so for the whole minute that run takes, `exists`
 * answers false and a second engine is spawned over the same target.
 *
 * Two engines over one target is not merely wasteful. `cutFigures`
 * (src/vlm/book-run.ts) clears `readings/<key>.images/` at the top of its run,
 * deliberately, so that a regeneration cannot leave the crop of a figure that is
 * now named something else sitting beside the one that is. The second engine
 * reached that rm while the first was still writing crops into the directory,
 * and Windows — which will not unlink a file another process holds open — raised
 * EBUSY partway through. With different timing it would not have raised anything
 * at all: it would simply have deleted crops the first run had already finished,
 * and the book would have come out naming plates that are not on the disk.
 *
 * ── Why the fix is HERE and not at the two call sites ───────────────────────
 *
 * Because a lock at the call sites is a lock two future callers can forget to
 * take, and there is already a third writer of book files in this module
 * (`writeEpubBook`) reached through the same check-then-act. The contended
 * resource is the OUT PATH, so the gate belongs where the out path is named,
 * which is here. A second caller for a path already being written AWAITS THE
 * FIRST RUN and answers with its outcome — which is the true answer to their
 * question, because a book file is a pure function of the receipt it is made
 * from and one run over that receipt is what both of them wanted.
 *
 * AND WHY A RETRY LADDER WOULD HAVE BEEN THE WRONG FIX. It was the first thing
 * proposed on the channel, when the lock was assumed to be somebody else's — a
 * network share, an antivirus scanner. It is not: the lock was OURS, held by our
 * own second process, and a retry would have let the second engine win the rm a
 * few hundred milliseconds later and delete the first run's finished crops with
 * no error anywhere. It would have hidden a data race behind a green tick. The
 * ladder is still worth having, and it is in `cutFigures` where a genuinely
 * external holder would be met — labelled there as defence in depth, and only as
 * that.
 *
 * FOLDED, on the house rule every path key in this app obeys: on Windows one
 * file arrives spelled three ways and two spellings of one path would be two
 * entries in this map, which is no gate at all. Resolved first, because a
 * relative path and its absolute twin are the same file too.
 *
 * THE ENTRY IS CLEARED WHEN THE RUN SETTLES, FAILURE INCLUDED. A refusal that
 * left its promise in the map would answer every future open of that book with
 * the same stale sentence for the life of the process, and the ordinary cure for
 * a refused reflow — fix whatever it complained about and open the book again —
 * would stop working.
 */
const writingBook = new Map<string, Promise<BookOutcome>>();

/** See `writingBook`. One run per target path; everybody else awaits it. */
function oneWriterOf(outPath: string, write: () => Promise<BookOutcome>): Promise<BookOutcome> {
  const key = fold(path.resolve(outPath));
  const running = writingBook.get(key);
  if (running !== undefined) {
    console.log(
      `[engine] ${outPath} is already being written by a run in flight, so this caller waits for `
      + 'that run instead of starting a second engine over the same file.',
    );
    return running;
  }
  const started = write().finally(() => { writingBook.delete(key); });
  writingBook.set(key, started);
  return started;
}

/**
 * Reflow a readings bank into the book file:
 * `foundry vlm-book --readings <bank.jsonl> --out <book.jsonl>`.
 *
 * WHAT THE COMMAND IS FOR, in one line: the bank is one row per PAGE holding the
 * model's answer for it, and it knows nothing about a paragraph — so this is the
 * pass that fuses the hyphens, joins the paragraphs the printer broke across a
 * leaf, cuts the footnote areas into notes and mints an id for every block. The
 * result is the document every op in the project is keyed to (docs/RENDERER.md
 * §1), and it is REGENERABLE: the bank is the reset point, and running this again
 * over the same bank produces the same ids for the same blocks.
 *
 * `--out` MAY NOT BE `--readings`. The bank is the irreplaceable thing in a
 * project — hours of GPU with no second copy anywhere — and the engine writes the
 * book beside it under a name of its own (`bookFileFor`, electron/projects.ts).
 *
 * NEVER THROWS, on `stampEpub`'s and `finalizeEpub`'s rule: this runs on the way
 * into a pane, and a bank the engine could not reflow is a fact about that
 * project that belongs on the sheet in words. What the CALLER MUST NOT DO is
 * treat a refusal as a success — there is no book file after one, so parsing what
 * is at the path would either fail on nothing or read a stale file from an
 * earlier run, and both are worse than the sentence.
 *
 * SERIALISED PER TARGET PATH by `oneWriterOf`, whose docblock carries the whole
 * argument. Two callers for one book file get one engine and one answer, and the
 * caller who arrived second waits rather than racing the first one's figures out
 * from under it.
 *
 * THE PAGES AND `--language` ARE PASSED ONLY WHERE THE CALLER HAS THEM. The pages
 * buy one thing — the figure crops, cut once into `readings/<key>.images/` — and
 * without them the engine cuts nothing and says so; the language goes in the
 * book's header, and the engine's default (`en`) is the engine's own documented
 * rule rather than a spelling this side repeats.
 *
 * ── ONE FIELD FOR THE PAGES AGAIN (Wave 41), AND THE ENGINE KEEPS TWO ───────
 *
 * A `pagesPath` stood beside `pdfPath` from Wave 37 to Wave 41, naming a
 * DIRECTORY of page photographs, because a capture project's archive WAS a
 * folder — `--pdf` was the reflow's only face until Wave 37, so such a project
 * reflowed with no source at all and every Picture block in it refused at export.
 *
 * The app no longer has such a project to describe: a mint writes a PDF and
 * `healMintedArchive` gives one to every project made before it, so
 * `bookAtPosition` answers `pdf` for a photographed book exactly as it does for
 * an imported scan. Owen: *"the system isnt trying to sift through images, it's
 * using the original pdf just like it normally would."*
 *
 * `vlm-book --pages` IS UNTOUCHED AND STAYS. It is engine surface area — a
 * capability the command has, documented on the command, usable from a terminal
 * — and Wave 37's work behind it is exactly as good as it was. What retired is
 * the APP's selection of it, which is a different thing from the ability.
 */
export function writeBookFile(
  readingsPath: string,
  outPath: string,
  opts: { pdfPath: string | null; language: string | null },
): Promise<BookOutcome> {
  return oneWriterOf(outPath, async () => {
    const args = ['vlm-book', '--readings', readingsPath, '--out', outPath];
    if (opts.pdfPath !== null) args.push('--pdf', opts.pdfPath);
    if (opts.language !== null) args.push('--language', opts.language);
    const run = runEngine(args);
    /*
     * The same two minutes `stampEpub` and `finalizeEpub` allow, for work of the
     * same order over the same book — a few hundred pages of banked answers parsed,
     * reflowed and written once. Past that nothing is happening and a pane is
     * waiting on it with `Opening the book…` on screen.
     *
     * THE CLOCK STARTS WHEN THIS RUN STARTS, which is why the gate is outside the
     * timer and not inside it. A caller that waits for somebody else's run is not
     * being timed out at two minutes into its own wait; it is riding a run that
     * has its own two minutes and will answer when that run answers.
     */
    const timer = setTimeout(() => run.cancel(), 120_000);
    const result = await run.done.finally(() => clearTimeout(timer));

    if (result.code !== 0) {
      const said = result.stderr.trim() || result.stdout.trim();
      const unknown = result.code === 2 && /unknown command/i.test(said);
      return {
        ok: false,
        reason: unknown
          ? `vlm-book is not in this engine build (${engineCommand().source}).`
          : said || `The engine exited ${result.code} with nothing to say.`,
      };
    }
    return { ok: true, reason: null };
  });
}

/**
 * Explode an imported EPUB into the book file:
 * `foundry vlm-book --epub <archive.epub> --out <book.jsonl>`.
 *
 * ── The same command, the other source ──────────────────────────────────────
 *
 * A project that arrived as an EPUB has no bank and will never have one: a bank
 * models pages, an EPUB has none, and reading real text back through a vision
 * model would trade exact data for a guess at it (docs/RENDERER.md §6, the
 * refinement paragraph). So the container IS the receipt, `book = f(epub)`, and
 * the engine writes the same book file out of it — the spine is the order, the
 * publisher's markup is the category, its own noteref anchors are the reference
 * markers and its nav is the divisions. Everything downstream — the ops, the
 * panels, the Edition, the export — is identical by construction.
 *
 * NO `--language`, AND THAT IS THE DIFFERENCE FROM `writeBookFile`. The bank
 * route's language is what the person running the read declared, so this side
 * passes it on. An EPUB's package DECLARES its language, and the engine reads it
 * from there; sending a language would overrule the publisher's own statement
 * with a field this project does not have (`bookAtPosition` answers null for an
 * EPUB project, because no reading recorded one).
 *
 * NO `--pdf` EITHER: the figures are copied out of the container, not cut out of
 * a page, because they are already files somebody made.
 *
 * NEVER THROWS, on `writeBookFile`'s rule and for its reason — this runs on the
 * way into a pane.
 *
 * SERIALISED PER TARGET PATH THROUGH THE SAME GATE, and it needs it for the same
 * reason rather than by symmetry: `ensureReadingBook`'s check-then-act guards
 * BOTH of its branches, so two windows opening one imported-EPUB project at once
 * spawn two explodes over one file; and `viewExportedBook` has the same shape
 * over a temp cache two tabs can want at the same instant. A project is never
 * both a bank and a container, so a caller can never be handed the other
 * command's answer for its path — and if that ever stopped being true, one book
 * at one path is still the only correct outcome.
 */
export function writeEpubBook(epubPath: string, outPath: string): Promise<BookOutcome> {
  return oneWriterOf(outPath, async () => {
    const run = runEngine(['vlm-book', '--epub', epubPath, '--out', outPath]);
    // The same two minutes the reflow allows, for work of the same order: one
    // container unzipped, a few dozen documents parsed, one file written.
    const timer = setTimeout(() => run.cancel(), 120_000);
    const result = await run.done.finally(() => clearTimeout(timer));

    if (result.code !== 0) {
      const said = result.stderr.trim() || result.stdout.trim();
      const unknown = result.code === 2 && /unknown (command|option)|--epub/i.test(said);
      return {
        ok: false,
        reason: unknown
          ? `vlm-book cannot explode an EPUB in this engine build (${engineCommand().source}).`
          : said || `The engine exited ${result.code} with nothing to say.`,
      };
    }
    return { ok: true, reason: null };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// doctor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `foundry doctor --json`, or a sentence saying why there is no report.
 *
 * Never throws. `doctor` is newer than some engine builds and the app is older
 * than some others: an unknown command exits 2, a missing binary never starts,
 * and both are states the settings screen renders rather than crashes on.
 */
export async function runDoctor(endpointUrl?: string): Promise<DoctorResult> {
  const args = ['doctor', '--json'];
  if (endpointUrl && endpointUrl.trim().length > 0) args.push('--endpoint', endpointUrl.trim());

  const run = runEngine(args);
  const timer = setTimeout(() => run.cancel(), 120_000);
  const result = await run.done.finally(() => clearTimeout(timer));

  if (result.code !== 0) {
    const said = result.stderr.trim() || result.stdout.trim();
    // Exit 2 is foundry's "the command line was wrong", which for a command
    // that does not exist yet is exactly what it means.
    const unknown = result.code === 2 || /unknown command/i.test(said);
    return {
      ok: false,
      reason: unknown
        ? `doctor unavailable in this engine build.\n${said}`
        : said || `The engine exited ${result.code} with nothing to say.`,
    };
  }

  try {
    return { ok: true, report: JSON.parse(result.stdout) };
  } catch (err) {
    return {
      ok: false,
      reason:
        `foundry doctor --json answered, but not with JSON (${(err as Error).message}). `
        + `First 200 characters: ${result.stdout.slice(0, 200)}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// epub-meta / pdf-meta
// ─────────────────────────────────────────────────────────────────────────────

/*
 * NOTHING IN THIS SECTION THROWS, for `stampEpub`'s reason turned around: the
 * metadata dialog is a thing somebody opened on a book they are already
 * reading, and a package with two `dc:creator` elements in it — which the
 * engine refuses to write and says so about, by name — must land as a sentence
 * beside the fields rather than as an unhandled rejection somewhere behind the
 * modal. `MetadataOutcome` (shared/types.ts) is that shape.
 */

/**
 * The engine's `--json`, run and parsed.
 *
 * The only OTHER place this app parses the engine's stdout is `runDoctor`, and
 * the shape is deliberately identical: stdout is the result, stderr is the
 * progress, and a run that exits 0 with something that is not JSON on stdout is
 * reported with the first 200 characters of whatever it did say. Guessing at a
 * half-printed object would put invented metadata into a dialog whose Save
 * button writes it straight back into somebody's book.
 */
async function runMetaCommand(
  args: string[],
  /**
   * Reading a package is milliseconds and rewriting a PDF is seconds, so sixty
   * is far past either and a hang would leave a modal with a spinner in it.
   *
   * It is an argument because ONE command here is not of that order:
   * `vlm-blocks` over a bank that recorded no render sizes measures every page
   * of the PDF again, which for a three-hundred-page scan is minutes. A timeout
   * that fits a metadata read would kill it every time, and the failure would
   * look exactly like an engine that does not have the command.
   */
  timeoutMs = 60_000,
): Promise<{ ok: true; json: unknown } | { ok: false; reason: string }> {
  const run = runEngine(args);
  const timer = setTimeout(() => run.cancel(), timeoutMs);
  const result = await run.done.finally(() => clearTimeout(timer));

  if (result.code !== 0) {
    const said = result.stderr.trim() || result.stdout.trim();
    return {
      ok: false,
      reason: said.length > 0 ? said : `foundry ${args[0]} exited ${result.code} and said nothing.`,
    };
  }
  try {
    return { ok: true, json: JSON.parse(result.stdout) as unknown };
  } catch (err) {
    return {
      ok: false,
      reason:
        `foundry ${args[0]} --json answered, but not with JSON (${(err as Error).message}). `
        + `First 200 characters: ${result.stdout.slice(0, 200)}`,
    };
  }
}

/** A field the engine reported, as a string or null. Anything else reads as absent. */
function metaField(fields: Record<string, unknown>, name: string): string | null {
  const value = fields[name];
  return typeof value === 'string' ? value : null;
}

function asEpubMetadata(json: unknown): DocumentMetadata {
  const root = (json ?? {}) as Record<string, unknown>;
  const fields = (root['fields'] ?? {}) as Record<string, unknown>;
  return {
    kind: 'epub',
    fields: {
      title: metaField(fields, 'title'),
      creator: metaField(fields, 'creator'),
      language: metaField(fields, 'language'),
      publisher: metaField(fields, 'publisher'),
      date: metaField(fields, 'date'),
      identifier: metaField(fields, 'identifier'),
    },
    uniqueIdentifier: typeof root['uniqueIdentifier'] === 'string' ? root['uniqueIdentifier'] : null,
    counts: (root['counts'] ?? {}) as Record<string, number>,
  };
}

function asPdfMetadata(json: unknown): DocumentMetadata {
  const root = (json ?? {}) as Record<string, unknown>;
  const fields = (root['fields'] ?? {}) as Record<string, unknown>;
  return {
    kind: 'pdf',
    fields: {
      title: metaField(fields, 'title'),
      author: metaField(fields, 'author'),
      subject: metaField(fields, 'subject'),
      keywords: metaField(fields, 'keywords'),
    },
    pages: typeof fields['pages'] === 'number' ? fields['pages'] : 0,
    creator: metaField(fields, 'creator'),
    producer: metaField(fields, 'producer'),
  };
}

/**
 * A patch turned into flags, dropping every field nobody typed into.
 *
 * ONLY WHAT CHANGED IS SENT. The engine touches only the fields it is given, so
 * a dialog that posted all six back on every save would re-splice a `dc:title`
 * nobody looked at, and would turn a `dc:publisher` the dialog showed as empty
 * into a refusal about blank values. A field left alone is a field the command
 * line never mentions.
 */
function metaFlags(patch: Record<string, string | undefined>): string[] {
  const args: string[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    args.push(`--${field}`, value);
  }
  return args;
}

/**
 * Read a book's Dublin Core record: `foundry epub-meta --epub <file> --json`.
 *
 * `epubPath` IS AN EPUB FILE, and it used to be a directory. The argument was
 * the WORKING TREE — the unpacked copy this app edited in place — and the tree,
 * the reader over it and the tab kind that held it are deleted
 * (docs/RENDERER.md §7). What is left that has a `dc:` package in it is a
 * FINISHED EXPORT in a project's `final/` tray, so that is what these two are
 * pointed at, and `exportInTray` (electron/projects.ts) is what decides whether
 * a given path is one.
 *
 * The engine reads either form, so nothing here refuses a directory — it simply
 * is not a thing this app has one of any more.
 */
export async function readEpubMetadata(epubPath: string): Promise<MetadataOutcome> {
  const result = await runMetaCommand(['epub-meta', '--epub', epubPath, '--json']);
  return result.ok ? { ok: true, metadata: asEpubMetadata(result.json) } : result;
}

/**
 * Write a book's Dublin Core fields — THROUGH A SIDE FILE, then over the export.
 *
 * ── WHY THIS GREW A TEMPORARY FILE IT DID NOT USED TO NEED ──────────────────
 *
 * This passed no `--out` and the engine edited the argument where it stood,
 * which is the DIRECTORY form: `epub-meta` splices the OPF inside an unpacked
 * tree and leaves everything else exactly as it was. Against a `.epub` FILE the
 * same call is refused by name — a container is a zip, changing one member means
 * emitting the whole archive again, and writing that archive into the file it is
 * still reading members out of would destroy the book mid-read. So the engine
 * demands `--out`, and it demands one that is not the input.
 *
 * `writePdfMetadata` below met this exact wall for the exact reason and answered
 * it the same way, so this is deliberately its shape line for line: write beside,
 * then ONE rename over the top, so an interrupted save leaves either the old
 * container or the new one and never half of either.
 *
 * ── AND REWRITING AN EXPORT IS NOT THIS APP OVERWRITING AN INPUT ────────────
 *
 * The rule is that Foundry never writes to a document it did not make. A file in
 * `final/` is one it did make: it was cast from the bank minutes ago and can be
 * cast again, and the metadata step this write is recorded as is replayed onto
 * every book made from that position afterwards (`metadataForProduct`). The
 * container on disk is the copy the person is looking at; the step is the part
 * that survives. Nothing the user brought in is touched by either.
 *
 * A RUN THAT CHANGED NOTHING WRITES NOTHING. Every field already saying what it
 * was asked to say is a read wearing a Save button — the engine reports that as
 * `written: false` and emits no archive, so there is no file to move and the
 * export keeps its own bytes rather than being replaced by an identical copy at
 * a new mtime.
 */
export async function writeEpubMetadata(
  epubPath: string,
  patch: Record<string, string | undefined>,
): Promise<MetadataOutcome> {
  const flags = metaFlags(patch);
  if (flags.length === 0) return readEpubMetadata(epubPath);

  const beside = path.join(path.dirname(epubPath), `.${path.basename(epubPath)}.meta-tmp`);
  const result = await runMetaCommand(['epub-meta', '--epub', epubPath, '--out', beside, '--json', ...flags]);
  if (!result.ok) {
    await fs.promises.rm(beside, { force: true });
    return result;
  }
  const wrote = (result.json as Record<string, unknown>)['written'] === true;
  if (!wrote) {
    await fs.promises.rm(beside, { force: true });
    return { ok: true, metadata: asEpubMetadata(result.json) };
  }
  try {
    await fs.promises.rename(beside, epubPath);
  } catch (err) {
    await fs.promises.rm(beside, { force: true });
    return {
      ok: false,
      reason:
        `The metadata was written, but the new book could not be put in place of ${epubPath} `
        + `(${(err as Error).message}). The export is unchanged.`,
    };
  }
  return { ok: true, metadata: asEpubMetadata(result.json) };
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read a PDF's Info dictionary: `foundry pdf-meta --pdf <file> --json`. */
export async function readPdfMetadata(pdfPath: string): Promise<MetadataOutcome> {
  const result = await runMetaCommand(['pdf-meta', '--pdf', pdfPath, '--json']);
  return result.ok ? { ok: true, metadata: asPdfMetadata(result.json) } : result;
}

/**
 * Write a PDF's Info dictionary — THROUGH A SIDE FILE, then over the original.
 *
 * `pdf-meta` refuses an `--out` equal to its `--pdf`, and is right to: it
 * re-emits the whole document through pdf-lib rather than patching it, so
 * writing into the file it is parsing would destroy the document mid-read. The
 * app wants the working PDF edited in place all the same, so the engine writes
 * beside it and this renames the result over the top — one filesystem
 * operation, so an interrupted save leaves either the old file or the new one
 * and never half of either.
 *
 * Rewriting the working PDF at all is acceptable because `archive/` still holds
 * the file that came in, byte for byte, and the working copy can be made again
 * from it.
 */
export async function writePdfMetadata(
  pdfPath: string,
  patch: Record<string, string | undefined>,
): Promise<MetadataOutcome> {
  const flags = metaFlags(patch);
  if (flags.length === 0) return readPdfMetadata(pdfPath);

  const beside = path.join(path.dirname(pdfPath), `.${path.basename(pdfPath)}.meta-tmp`);
  const result = await runMetaCommand(['pdf-meta', '--pdf', pdfPath, '--out', beside, '--json', ...flags]);
  if (!result.ok) {
    await fs.promises.rm(beside, { force: true });
    return result;
  }
  // A run whose every field already said what it was asked to say writes no
  // file at all — the engine reports that, and there is nothing to move.
  const wrote = (result.json as Record<string, unknown>)['written'] === true;
  if (!wrote) {
    await fs.promises.rm(beside, { force: true });
    return { ok: true, metadata: asPdfMetadata(result.json) };
  }
  try {
    await fs.promises.rename(beside, pdfPath);
  } catch (err) {
    await fs.promises.rm(beside, { force: true });
    return {
      ok: false,
      reason:
        `The metadata was written, but the new PDF could not be put in place of ${pdfPath} `
        + `(${(err as Error).message}). The document is unchanged.`,
    };
  }
  return { ok: true, metadata: asPdfMetadata(result.json) };
}
