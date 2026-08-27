/**
 * capture — photographs become a project the rest of this app can read.
 *
 * A capture project arrives as pictures of a bound volume rather than as a file
 * (docs/CAPTURE.md). This module owns everything that happens to those pictures
 * BEFORE a PDF exists: copying them in, hashing them, decoding them once, and
 * keeping the recipe of splits and quads that says how they become pages. The
 * mint that turns the recipe into a PDF is the other half and lands later; from
 * the minted PDF onward nothing in this app knows this stage happened.
 *
 * ── THE LAYOUT, AND WHICH HALF OF IT HAS A DOOR ──────────────────────────────
 *
 *   capture/originals/<sha>.<ext>    the bank. Never written, NEVER SERVED
 *   capture/derived/<sha>.png        the upright working copy
 *   capture/derived/<sha>.640.jpg    the thumbnail the grid draws
 *   capture/recipe.json              the splits, quads, strikes and order
 *
 * ONE SERVED DIRECTORY, FLAT NAMES. The renderer reaches pixels only through
 * `foundry-file://capture/<token>/<name>`, whose token maps to `derived/` and
 * whose name must be a plain basename — the same allow-list shape as the book
 * host next door (`bookFigureFile`, electron/book.ts), kept character for
 * character rather than replaced with a cleverer path check that has to stay
 * right forever.
 *
 * The consequence is the reason the layout is this one: NO STRING A RENDERER CAN
 * COMPOSE REACHES THE ORIGINALS. The irreplaceable half of this stage — often
 * the only copy of an afternoon in an archive that does not lend its books — is
 * not merely un-served, it is unaddressable through the scheme. A second host
 * segment, or a token that reached `capture/` itself, would have left the bank
 * one accepted path component away from being readable, guarded by a check
 * instead of by arithmetic.
 *
 * `derived/` and not `working/`, which was the first proposal: `working/` is
 * already a project directory (`WORKING`, electron/projects.ts) holding the live
 * PDF, and one word may not mean two things one folder apart. The name is also
 * true of the contents — everything in it is reconstructible from the originals
 * plus the recipe, which is this stage's first truth, and it makes the deletion
 * rule readable without a comment.
 *
 * ── UPRIGHT IS THE DECODER'S DEFAULT, AND APPLYING ORIENTATION IS A BUG ──────
 *
 * libheif applies the container's `irot` while decoding, so the buffer comes
 * back already upright and this module writes it out unchanged. Applying EXIF
 * Orientation on top would be a DOUBLE ROTATION: measured on the acceptance
 * shoot, it would have turned 26 of 27 photographs 90° wrong — uniformly enough
 * to look deliberate rather than broken. The dependency is pinned to an exact
 * `libheif-js@1.19.8` for that reason: this is decoder behaviour, not format
 * truth, and a caret would let a routine install change it without a person
 * deciding to.
 *
 * DIMENSIONS COME FROM THE DECODER, NEVER FROM EXIF. EXIF says 4032x3024 for a
 * file the decoder hands back as 3024x4032; both are correct about different
 * grids. The recipe, the editor and the mint all live on the DECODED grid, and
 * there is no orientation field anywhere to disagree with it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import { nativeImage } from 'electron';

import { PDFDocument } from 'pdf-lib';

import type {
  CaptureIntakeProgress,
  CaptureLines,
  CaptureMintBegun,
  CaptureMintPage,
  CaptureOpened,
  CapturePage,
  CapturePhoto,
  CapturePoint,
  CapturePrepared,
  CaptureQuad,
  CaptureRecipe,
  CaptureSplit,
  CaptureStanding,
  CaptureTimeSource,
  LedgerStep,
} from '../shared/types';
import {
  arrangementOf,
  CAPTURE_RECIPE_PAYLOAD,
  cutOf,
  emptyRecipe,
  joinedQuad,
  mintPlan,
  PHOTOGRAPH_TYPES,
  recipeBytes,
  sameShape,
  splitFromFraction,
  WHOLE_FRAME,
} from '../shared/capture';
import { beginMint, cancelHere, mintCancelled, noteMintPage, settleMint } from './job-queue';
import { currentArrangement, ledgerOf, readManifest, recordMint } from './projects';
import { writeAtomically } from './atomic';

// Re-exported so a caller that already imports this module does not need to
// know the constant lives one directory over.
export { CAPTURE_RECIPE_PAYLOAD };

const CAPTURE = 'capture';
const ORIGINALS = 'originals';
const DERIVED = 'derived';
const RECIPE = 'recipe.json';
// Staging for a mint in progress. NOT served: the door reaches `derived/`
// and nothing else, and a half-finished book is nobody's business but
// this module's.
const MINTS = 'mints';

/** Refusals from this module, named so a caller can tell them from an fs error. */
export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureError';
  }
}

export function captureDir(projectDir: string): string {
  return path.join(projectDir, CAPTURE);
}

function originalsDir(projectDir: string): string {
  return path.join(captureDir(projectDir), ORIGINALS);
}

function derivedDir(projectDir: string): string {
  return path.join(captureDir(projectDir), DERIVED);
}

function recipeFile(projectDir: string): string {
  return path.join(captureDir(projectDir), RECIPE);
}

// ─────────────────────────────────────────────────────────────────────────────
// The door
// ─────────────────────────────────────────────────────────────────────────────

/*
 * `foundry-file://capture/<token>/<name>` — ONE FLAT DIRECTORY of this stage's
 * pictures, and nothing else on this disk.
 *
 * Minted per directory and reused, exactly like the book host's: the map stays
 * the size of the library rather than growing with every project open. The token
 * is the whole authorisation — a URL the renderer composes for a directory
 * nothing registered meets a 403 rather than a read.
 *
 * ── ONE DIRECTORY AGAIN, AND THE SECOND ONE IS A GRAVESTONE (Wave 41) ──────
 *
 * For two days this served `derived/` AND a mint's `archive/<stem> pages/`,
 * because the mint wrote page images and no container, so the page view had to
 * be handed the pictures themselves. The mint writes a PDF again (`mintCommit`,
 * `recordMint`), the page view is deleted, and this host is back to the one
 * layer it began with: the decoded working copies and thumbnails the light table
 * draws.
 *
 * The MECHANISM is untouched and stays general on purpose — a caller inside this
 * module asks for a token for a directory it named, and nothing outside can ask
 * for a token at all. What retired is the second CALLER, not the second
 * directory's right to exist.
 *
 * THE ORIGINALS STILL HAVE NO HOST AND CANNOT BE GIVEN ONE FROM OUTSIDE. The
 * served directory holds files this app MADE — decoded working copies,
 * thumbnails — every one of them remakeable from the photographs plus the
 * recipe. The photographs themselves, which for an archive shoot may be the only
 * copies that exist, are addressable through no host here.
 */
const captureTokens = new Map<string, string>();
const captureDirs = new Map<string, string>();

function tokenForServing(dir: string): string {
  const known = captureTokens.get(dir);
  if (known !== undefined) return known;
  const token = randomUUID();
  captureTokens.set(dir, token);
  captureDirs.set(token, dir);
  return token;
}

/**
 * The file behind `foundry-file://capture/<token>/<name>`, or null for anything
 * this process never agreed to serve.
 *
 * THE NAME MUST BE A PLAIN BASENAME, on `bookFigureFile`'s argument and with its
 * refusals: the served directory is FLAT — intake writes `derived/` flat — so a
 * separator in the name is not a file this app made. It is a traversal, and it
 * meets the same null an unknown token does rather than a `resolve()` that might
 * climb.
 */
export function captureServedFile(token: string, name: string): string | null {
  const dir = captureDirs.get(token);
  if (dir === undefined) return null;
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return null;
  }
  return path.join(dir, name);
}

// ─────────────────────────────────────────────────────────────────────────────
// The recipe, on disk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One recipe write at a time, per project.
 *
 * `recipe.json` is rewritten WHOLE (it is kilobytes even for hundreds of
 * photographs), so a save that crossed an intake would drop whichever landed
 * first. A promise chain per directory is the smallest thing that makes that
 * impossible — the same answer `withManifest` gives for the catalogue, for the
 * same reason, and it is a separate chain because a recipe edit must not queue
 * behind an unrelated manifest write.
 */
const recipeEdits = new Map<string, Promise<unknown>>();

function withRecipe<T>(projectDir: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectDir).toLowerCase();
  const previous = recipeEdits.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => { /* a failed edit must not poison the ones queued behind it */ })
    .then(work);
  recipeEdits.set(key, next);
  return next;
}

// `emptyRecipe` and `recipeBytes` come from shared/ — see the argument there.
export { emptyRecipe };

/*
 * ── HOW AN INTAKE SAYS WHERE IT HAS GOT TO ──────────────────────────────────
 *
 * One listener, replaced rather than appended, exactly as `onEnvInstallProgress`
 * does it: this module's business is photographs on disk, not who is hosting
 * the app, and the one place that knows whether anybody is listening
 * (electron/ipc.ts) wires it to a broadcast.
 */
let intakeProgress: (progress: CaptureIntakeProgress) => void = () => { /* set by ipc */ };

export function onIntakeProgress(listener: (progress: CaptureIntakeProgress) => void): void {
  intakeProgress = listener;
}

/**
 * Hand the event loop back, so the window stays alive between photographs.
 *
 * ── THE FREEZE THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * Decoding a HEIC is wasm running IN THIS PROCESS and it does not yield. Owen
 * dropped 27 photographs and could not move the window for the better part of a
 * minute: every IPC reply, every paint, every drag of the title bar was behind
 * work that never let go. `setImmediate` between files is not a fix for that —
 * it is the difference between one unbroken minute and twenty-seven two-second
 * pauses with a progress line moving in between.
 *
 * THE REAL ANSWER IS A UTILITY PROCESS and it is deferred out loud in
 * docs/CAPTURE.md rather than built at midnight while somebody is mid-run.
 */
const breathe = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/**
 * Deflate off the main thread.
 *
 * `deflateSync` was ~600 ms of unbroken main-thread work per photograph, on top
 * of the decode — a third of the freeze, and the third that did not have to be
 * there at all. The async form hands the compression to libuv’s pool, so the
 * event loop keeps turning while a 36 MiB raster is squeezed.
 */
const deflate = promisify(zlib.deflate);


/**
 * The recipe this project holds.
 *
 * A MISSING FILE IS A REFUSAL AND NOT AN EMPTY RECIPE. `capture:create` writes
 * `recipe.json` before it returns, so a capture project without one is damaged
 * rather than new — and answering "no photographs" for a project whose
 * `originals/` is full of them would invite the surface to save that answer back
 * over the file, which is how one missing read becomes a real loss.
 */
export async function readRecipe(projectDir: string): Promise<CaptureRecipe> {
  const file = recipeFile(projectDir);
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    throw new CaptureError(
      `${file} could not be read, so this project's photographs have no recipe: `
      + `${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CaptureError(`${file} is not JSON (${(err as Error).message}).`);
  }
  return validRecipe(parsed, file);
}

/**
 * Write the recipe, whole, or refuse it.
 *
 * VALIDATED ON THE WAY IN even though the renderer composed it, because "the
 * renderer would not send that" is a claim about code that does not exist yet.
 * A recipe that reaches disk malformed is not a bug that throws — it is a
 * project that will not open tomorrow, and its photographs are the one thing
 * here nobody can remake.
 */
export async function writeRecipe(projectDir: string, recipe: CaptureRecipe): Promise<void> {
  const checked = validRecipe(recipe, recipeFile(projectDir));
  await withRecipe(projectDir, async () => {
    await writeAtomically(recipeFile(projectDir), Buffer.from(recipeBytes(checked)));
  });
}

function fail(file: string, what: string): never {
  throw new CaptureError(`${file} is not a recipe this app can read: ${what}.`);
}

function validPoint(value: unknown, file: string, where: string): CapturePoint {
  if (!Array.isArray(value) || value.length !== 2) fail(file, `${where} is not a pair`);
  const [x, y] = value as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    fail(file, `${where} is not two finite numbers`);
  }
  // The same bounds `validQuad` gives its corners, for the same reason: the
  // unit is a fraction of the working copy, and outside [0,1] is off the
  // photograph.
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    fail(file, `${where} is outside the photograph (${x}, ${y}) — coordinates are fractions`);
  }
  return [x, y];
}

function validQuad(value: unknown, file: string, where: string): CaptureQuad {
  if (!Array.isArray(value) || value.length !== 4) fail(file, `${where} is not four corners`);
  const corners = value.map((corner, index) => {
    if (!Array.isArray(corner) || corner.length !== 2) fail(file, `${where} corner ${index} is not a pair`);
    const [x, y] = corner as unknown[];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      fail(file, `${where} corner ${index} is not two finite numbers`);
    }
    /*
     * FRACTIONS, AND THE BOUNDS ARE PART OF THE UNIT. Every coordinate in this
     * file is a fraction of the working copy's grid; a value outside [0,1] is
     * either pixels that took a wrong turn at the bridge or a corner dragged off
     * the photograph, and both produce black edges in a minted page rather than
     * an error anybody sees.
     */
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      fail(file, `${where} corner ${index} is outside the photograph (${x}, ${y}) — coordinates are fractions`);
    }
    return [x, y] as const;
  });
  return corners as unknown as CaptureQuad;
}

/**
 * Work out which pages were set by hand, for a recipe that never said.
 *
 * ── IT IS NOT A GUESS. NOTHING BUT A HAND COULD HAVE MOVED A CORNER ───────
 *
 * A page arrives at the WHOLE FRAME and nothing but a person changes that. A
 * crop stamped over the shoot copies `source.pages[index].quad` across
 * verbatim, so every page a stamp touched holds the IDENTICAL floats. That
 * leaves exactly three states a quad can be in, and only one of them is hands:
 *
 *   the whole frame                    nobody has touched this page
 *   the crop most of its shape share   a stamp put it there
 *   anything else                      A HAND DRAGGED IT
 *
 * ── THE FIRST VERSION ASKED THE SECOND QUESTION ONLY, AND MISSED A SHOOT ──
 *
 * It marked a page whose quad DIFFERED FROM THE MAJORITY, which quietly
 * assumes there is a stamp to differ from. Measured on the project Owen
 * actually has: 25 photographs, 25 DISTINCT QUADS, no two alike — he cropped
 * every page by hand, one at a time, and the largest disagreement between two
 * of them is a tenth of the frame. With no majority anywhere, nothing was
 * marked, and the first APPLY TO ALL of the editor that finally understands
 * hand-work would have erased all twenty-five without naming one of them.
 *
 * The whole frame is what the majority question was reaching for and could not
 * see: an untouched page has a KNOWN quad, so a page can be told from a stamp
 * even when there is no stamp in the project at all. The majority test stays
 * beside it, because a stamped crop is not the whole frame either.
 *
 * ── ONLY WHEN THE FILE HAS NOT SPOKEN, WHICH KEEPS IT A MIGRATION ────────
 *
 * The moment ANY page in the recipe carries the field, the file is one the
 * staged editor has written and every mark in it is a statement rather than
 * an absence. Deriving past that would let an inference overwrite a fact:
 * somebody who hand-sets a page back to exactly the global crop has still set
 * it by hand, and a rule reading only the geometry would quietly unmark it on
 * the next read. So this runs on the way in, like the `{x}` migration beside
 * it, and stops running the first time the file answers for itself.
 *
 * ── EXACT EQUALITY, PER PAGE SLOT, WITHIN ONE SHAPE ──────────────────────
 *
 * Exact, because these floats were copied rather than computed and a
 * tolerance would be inventing a question nobody asked. Per page SLOT,
 * because a stamp copies slot to slot — comparing the halves of split
 * spreads against each other would find the left halves in the majority and
 * mark every right half as hand-set. Within one shape, for the reason
 * apply-to-all skips: a landscape frame’s crop differing from a portrait
 * one’s says nothing about anybody’s hands.
 *
 * ── AND WHERE IT IS UNSURE IT OVER-MARKS ─────────────────────────────────
 *
 * A group with no single most-common quad is left alone entirely; a group
 * with several roughly equal crops marks everything outside the largest of
 * them, including pages a stamp did put there. THE TWO ERRORS ARE NOT
 * COMPARABLE: over-marking costs a named skip in a notice and one press of
 * the include-them override, and under-marking costs the evening of cropping
 * that the mark exists to protect.
 */
function handsRead(photos: CapturePhoto[]): CapturePhoto[] {
  const spoken = photos.some((photo) => photo.pages.some((page) => page.byHand !== undefined));
  if (spoken) return photos;

  // Photographs of one shape, since a crop only travels between those.
  const groups: CapturePhoto[][] = [];
  for (const photo of photos) {
    const group = groups.find((held) => {
      const first = held[0];
      return first !== undefined && sameShape(first, photo);
    });
    if (group === undefined) groups.push([photo]);
    else group.push(photo);
  }

  const stamped = new Map<CapturePhoto, Map<number, string>>();
  for (const group of groups) {
    const slots = new Map<number, Map<string, number>>();
    for (const photo of group) {
      photo.pages.forEach((page, slot) => {
        const counts = slots.get(slot) ?? new Map<string, number>();
        const key = JSON.stringify(page.quad);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        slots.set(slot, counts);
      });
    }
    const majority = new Map<number, string>();
    for (const [slot, counts] of slots) {
      let best: string | null = null;
      let bestCount = 1;
      let tied = false;
      for (const [key, count] of counts) {
        if (count > bestCount) {
          best = key;
          bestCount = count;
          tied = false;
        } else if (count === bestCount && best !== null) {
          tied = true;
        }
      }
      // No crop shared by more than one page, or two sharing the lead: there
      // is no stamp to have differed from, so nothing here was set by hand
      // in any sense this can see.
      if (best !== null && !tied) majority.set(slot, best);
    }
    for (const photo of group) stamped.set(photo, majority);
  }

  const untouched = JSON.stringify(WHOLE_FRAME);
  return photos.map((photo) => {
    const majority = stamped.get(photo) ?? new Map<number, string>();
    return {
      ...photo,
      pages: photo.pages.map((page, slot) => {
        const quad = JSON.stringify(page.quad);
        // Nobody has touched this page, whether or not anything else here has
        // been stamped — which is the whole reason this question comes first.
        if (quad === untouched) return page;
        // A stamp put it here, and a stamp is not a hand.
        if (quad === majority.get(slot)) return page;
        return { ...page, byHand: true };
      }),
    };
  });
}

function validRecipe(value: unknown, file: string): CaptureRecipe {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(file, 'it is not an object');
  const row = value as Record<string, unknown>;
  if (row['version'] !== 1) fail(file, `it is version ${String(row['version'])} and this app reads version 1`);
  const photos = row['photos'];
  const order = row['order'];
  if (!Array.isArray(photos)) fail(file, 'it names no photographs');
  if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) fail(file, 'its order is not a list of ids');

  const seen = new Set<string>();
  const checked: CapturePhoto[] = photos.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) fail(file, `photograph ${index} is not an object`);
    const photo = entry as Record<string, unknown>;
    const text = (key: string): string => {
      const held = photo[key];
      if (typeof held !== 'string' || held.length === 0) fail(file, `photograph ${index} names no ${key}`);
      return held;
    };
    const count = (key: string): number => {
      const held = photo[key];
      if (typeof held !== 'number' || !Number.isFinite(held) || held <= 0) {
        fail(file, `photograph ${index} has no positive ${key}`);
      }
      return held;
    };
    const id = text('id');
    if (seen.has(id)) fail(file, `two photographs share the id ${id}`);
    seen.add(id);
    const source = photo['takenAtSource'];
    if (source !== 'exif-offset' && source !== 'exif-local' && source !== 'mtime') {
      fail(file, `photograph ${index} says its time came from ${String(source)}`);
    }
    const pages = photo['pages'];
    if (!Array.isArray(pages)) fail(file, `photograph ${index} names no pages`);
    const checkedPages: CapturePage[] = pages.map((page, pageIndex) => {
      if (typeof page !== 'object' || page === null) fail(file, `page ${pageIndex} of photograph ${index} is not an object`);
      const held = page as Record<string, unknown>;
      const pageId = held['id'];
      if (typeof pageId !== 'string' || pageId.length === 0) fail(file, `page ${pageIndex} of photograph ${index} has no id`);
      if (typeof held['struck'] !== 'boolean') fail(file, `page ${pageId} does not say whether it is struck`);
      /*
       * CARRIED, NEVER CONSULTED — and carrying is the whole job.
       *
       * Nothing in main reads `byHand`: not the mint, not a rule in this file.
       * But this function REBUILDS every page field by field, so a field it
       * did not name would be dropped here — and since `writeRecipe` validates
       * on the way out too, the mark would not survive one save. The thing it
       * exists to protect is an evening of per-page crops, so it is written
       * down here rather than assumed to flow through.
       *
       * Absent is legal and means false (every recipe before Wave 21). Present
       * and not a boolean is a writer that thinks it marked a page and did
       * not, which is worth refusing for the same reason an empty name is.
       */
      const byHand = held['byHand'];
      if (byHand !== undefined && typeof byHand !== 'boolean') {
        fail(file, `page ${pageId} says it was set by hand in something that is not a yes or a no`);
      }
      return {
        id: pageId,
        quad: validQuad(held['quad'], file, `page ${pageId}`),
        struck: held['struck'] as boolean,
        ...(typeof byHand === 'boolean' ? { byHand } : {}),
      };
    });
    /*
     * A PHOTOGRAPH IS ONE PAGE OR TWO, and a split means two.
     *
     * The split line is the gesture that DERIVES the second quad, so a recipe
     * claiming a split over one page has lost one of them somewhere between the
     * editor and here — and the mint would print a spread as a single page
     * without ever noticing the other was gone. The converse is deliberately
     * NOT checked: two quads and no split line is a person who cropped both
     * halves by hand, which is allowed.
     */
    if (checkedPages.length < 1 || checkedPages.length > 2) {
      fail(file, `photograph ${index} has ${checkedPages.length} pages, and a photograph is one page or two`);
    }

    /*
     * ── THE SPLIT IS READ AGAINST THE PAGES, WHICH IS WHY IT IS READ HERE ───
     *
     * It was parsed before them for as long as it was one number. A segment
     * is two points ON THE EDGES OF THE PAGE IT CUTS, so it cannot be checked
     * — or migrated — without the sheet those pages make.
     *
     * MIGRATION HAPPENS ON EVERY READ, not in a pass somebody remembers to
     * run. A recipe holding `{ x }` is the normal case on this machine right
     * now, and a one-shot migration is a migration that can be missed: read
     * it as the vertical segment it always meant, and the next save writes
     * the segment. The fraction was measured ALONG THE QUAD, so it is turned
     * into points against the sheet rather than against the photograph.
     */
    const held = photo['split'];
    let split: CaptureSplit | null = null;
    if (held !== null && held !== undefined) {
      if (typeof held !== 'object' || Array.isArray(held)) fail(file, `photograph ${index} has a split that is not a line`);
      const asked = held as Record<string, unknown>;
      const sheet = joinedQuad(checkedPages.map((page) => page.quad), null);
      if (asked['a'] === undefined && asked['b'] === undefined) {
        const x = asked['x'];
        if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) {
          fail(file, `photograph ${index} has a split at ${String(x)}, which is not a fraction of its width`);
        }
        split = splitFromFraction(sheet, x);
      } else {
        split = {
          a: validPoint(asked['a'], file, `photograph ${index}'s split starts where it`),
          b: validPoint(asked['b'], file, `photograph ${index}'s split ends where it`),
        };
      }
      /*
       * OPPOSITE EDGES OR NOTHING. A segment between neighbouring edges takes
       * a corner off — a triangle and a pentagon — and the mint prints four
       * corners or nothing at all. No drag can produce it (`seatSplit` builds
       * every dragged segment opposite by construction), so reaching this
       * means a hand-edited file, which is exactly what the refusal says.
       */
      if (cutOf(sheet, split) === null) {
        fail(file, `photograph ${index} has a split running between neighbouring edges, which cuts a corner off the page rather than cutting it in two`);
      }
    }
    if (split !== null && checkedPages.length !== 2) {
      fail(file, `photograph ${index} is split but holds ${checkedPages.length} page(s)`);
    }
    /*
     * ABSENT IS LEGAL, EMPTY IS NOT. A recipe from before the field existed has
     * no name and cannot be given one (see `CapturePhoto.name`); a recipe that
     * carries the key with nothing in it is a writer that thinks it set a name
     * and did not, and that is worth refusing rather than rendering as a blank.
     */
    const dropped = photo['name'];
    if (dropped !== undefined && (typeof dropped !== 'string' || dropped.length === 0)) {
      fail(file, `photograph ${index} has a name that is not a name`);
    }

    /*
     * THE BOOK STOPS MOVING THIS ONE — carried, never consulted, and carrying
     * is again the whole job.
     *
     * `byHand`'s contract for the fourth time, and it earns the fourth telling
     * because the two fields fail differently. A dropped `byHand` loses a mark
     * that could be re-derived from the quads (`handsRead`, above). A dropped
     * `complete` loses an answer NOTHING can re-derive: the say-so is a person
     * speaking about a page they decided not to move, so it leaves no trace in
     * the geometry, and a release leaves a page whose lines still look
     * hand-placed. Both would silently revert to the derive on the next save.
     *
     * ABSENT IS LEGAL AND IS NOT A FALSE. It means "ask the pages" — see
     * `CapturePhoto.complete`. Present and not a boolean is a writer that
     * thinks it recorded a decision and did not.
     */
    const said = photo['complete'];
    if (said !== undefined && typeof said !== 'boolean') {
      fail(file, `photograph ${index} says it is complete in something that is not a yes or a no`);
    }

    return {
      id,
      file: text('file'),
      ...(typeof dropped === 'string' ? { name: dropped } : {}),
      workingCopy: text('workingCopy'),
      thumb: text('thumb'),
      width: count('width'),
      height: count('height'),
      takenAt: text('takenAt'),
      takenAtSource: source as CaptureTimeSource,
      split,
      pages: checkedPages,
      ...(typeof said === 'boolean' ? { complete: said } : {}),
    };
  });

  /*
   * ── THE ORDER AND THE PAGES MUST BE THE SAME SET ──────────────────────────
   *
   * `order` is the only stored truth about arrangement, and the mint walks IT
   * rather than the photographs. So a page id missing from it is a leaf that is
   * never printed and never drawn — invisible on the grid, so nobody can even
   * see that it is gone — and a repeated id mints the same page twice.
   *
   * FOUND ON P2’S READ-BACK, and not hypothetically: their reverse() dropped an
   * id it could not resolve instead of preserving it, so an inconsistent recipe
   * accepted here would have had a page silently deleted by the next press of a
   * button. Each half of that was nearly unreachable alone. Together they were a
   * path, which is what most real losses are made of.
   */
  const pageIds = checked.flatMap((photo) => photo.pages.map((page) => page.id));
  const listed = new Set(order as string[]);
  if (listed.size !== order.length) fail(file, 'its order lists the same page twice');
  if (listed.size !== pageIds.length || pageIds.some((id) => !listed.has(id))) {
    const missing = pageIds.filter((id) => !listed.has(id));
    const unknown = (order as string[]).filter((id) => !pageIds.includes(id));
    fail(file, 'its order does not list every page exactly once'
      + (missing.length > 0 ? ` (missing ${missing.length})` : '')
      + (unknown.length > 0 ? ` (naming ${unknown.length} that do not exist)` : ''));
  }

  /*
   * ── THE TICKS: CARRIED, REFUSED IF WRONGLY TYPED, CONSULTED BY NOTHING ────
   *
   * `byHand`'s contract one level up, and for `byHand`'s exact reason: this
   * function rebuilds the recipe field by field and `writeRecipe` validates on
   * the way out too, so a field main "ignores" is erased on the next save and
   * would not survive one round trip. Nothing in main reads these — not the
   * mint, which is deliberate: the gate belongs to the rail, and a person who
   * mints from the keyboard has not lied to anybody.
   *
   * ABSENT IS LEGAL AT BOTH LEVELS. No `prepared` at all is every recipe ever
   * written; a `prepared` naming one verb is somebody who has ticked one box,
   * which is the ordinary state for most of the time this field exists. Present
   * and not a boolean is a writer that thinks it recorded an answer and did not,
   * and that is worth refusing rather than reading as a no.
   *
   * THE UNTICKED VERBS ARE DROPPED RATHER THAN WRITTEN FALSE, so the file says
   * what somebody answered and stays silent about what they have not been asked.
   */
  const prepared = row['prepared'];
  let ticks: CapturePrepared | undefined;
  if (prepared !== undefined && prepared !== null) {
    if (typeof prepared !== 'object' || Array.isArray(prepared)) {
      fail(file, 'it records what has been prepared in something that is not a set of answers');
    }
    const answers = prepared as Record<string, unknown>;
    const verbs = ['turned', 'cropped', 'split'] as const;
    for (const verb of verbs) {
      const answer = answers[verb];
      if (answer !== undefined && typeof answer !== 'boolean') {
        fail(file, `it says the pages were ${verb} in something that is not a yes or a no`);
      }
    }
    const kept = verbs.filter((verb) => answers[verb] === true);
    if (kept.length > 0) {
      ticks = Object.fromEntries(kept.map((verb) => [verb, true])) as CapturePrepared;
    }
  }

  const standing = validStanding(row['book'], file);

  /*
   * WHICH PASS THE PROJECT IS IN — carried for the reason everything optional
   * here is carried, and refused for a reason of its own.
   *
   * `'split'` OR ABSENT, AND NOTHING ELSE. Absent is the crop pass and is every
   * recipe ever written; there is deliberately no `'crop'` to write, so a file
   * saying one is a file written against a model this app does not have. A pass
   * this side accepted and did not understand would be read as "not the split
   * pass" and would silently reopen somebody's crops.
   */
  const pass = row['pass'];
  if (pass !== undefined && pass !== 'split') {
    fail(file, `it says the project is in the ${String(pass)} pass, and a project is in the split pass or in neither`);
  }

  return {
    version: 1,
    photos: handsRead(checked),
    order: order as string[],
    ...(ticks === undefined ? {} : { prepared: ticks }),
    ...(standing === undefined ? {} : { book: standing }),
    ...(pass === 'split' ? { pass } : {}),
  };
}

/**
 * THE BOOK'S STANDING CROP AND CUT — carried, refused if malformed, read by
 * nothing in main.
 *
 * `byHand`'s contract for the third time and for the third time it is not
 * politeness: `validRecipe` rebuilds the recipe field by field and `writeRecipe`
 * validates on the way out too, so a field main "ignores" is DELETED on the next
 * save. The thing this one protects is the answer to "what do the rest of the
 * pages look like", which a person set once and expects to still be there next
 * week.
 *
 * ── Absent at every level, and each absence means something different ──────
 *
 * No `book` at all is every recipe written before Wave 24 and every project
 * before its first *Crop all*. A `book` with no `crop` is a book whose pages are
 * uncropped and cut anyway — a shoot of spreads photographed edge to edge, which
 * is a real thing somebody can do. A `crop` with no `cut` is the ordinary book
 * of single pages. So none of the three is required and none of them implies
 * another.
 *
 * ── AND THE TWO SIDES OF THE BOOK, SINCE WAVE 51b ─────────────────────────
 *
 * `odd` and `even` are the same pair of lines again, for the photographs on one
 * side of a recto/verso shoot (`CaptureStanding`). They are carried through the
 * same body as the book's own, which is the whole reason the body was split out:
 * three standings validated by three transcriptions of one rule is the drift
 * shape this feature has paid for by name. Absent is "that side never asked",
 * which is every recipe written before this wave — so there is nothing to
 * migrate and nothing to guess.
 *
 * ── WHAT IT REFUSES, AND THE ONE THING IT DOES NOT CHECK ───────────────────
 *
 * A quad that is not four points, a frame with no positive size, a cut that is
 * not two points: all refused, because each is a writer that believes it
 * recorded a standing and did not. What is NOT checked is whether the cut lands
 * on opposite edges of the crop — the per-photograph split is checked for that
 * (a corner cut off is a shape the mint cannot print), but the standing is never
 * printed. It is re-seated by `halvesOf` against whatever sheet it is applied
 * to, and a standing that resolves to nothing simply offers no cut. Refusing to
 * OPEN a project over a line that only ever proposes would be the validator
 * spending a person's whole recipe on a suggestion.
 */
function validStanding(value: unknown, file: string): CaptureStanding | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(file, 'it records the book\'s crop in something that is not a crop and a cut');
  }
  const row = value as Record<string, unknown>;
  const book = validLines(row, file, 'the book\'s');
  const odd = validSide(row['odd'], file, 'the book\'s odd-page');
  const even = validSide(row['even'], file, 'the book\'s even-page');

  // A standing holding nothing at any level is a standing that says nothing, and
  // writing the empty object back would be a key that means "somebody pressed
  // the button and nothing came of it". Silence says that better.
  if (book === undefined && odd === undefined && even === undefined) return undefined;
  return {
    ...(book ?? {}),
    ...(odd === undefined ? {} : { odd }),
    ...(even === undefined ? {} : { even }),
  };
}

/**
 * ONE SIDE OF THE BOOK'S OWN LINES, or nothing.
 *
 * Separate from `validLines` below only to name the container: `odd` has to BE
 * an object before its crop can be looked for, and the sentence a person reads
 * should say which side of the book their file is wrong about.
 */
function validSide(value: unknown, file: string, whose: string): CaptureLines | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(file, `${whose} lines are recorded in something that is not a crop and a cut`);
  }
  return validLines(value as Record<string, unknown>, file, whose);
}

/**
 * A CROP AND A CUT, wherever they are written — the book's own, or one side's.
 *
 * The ONE body for all three, because "what a standing looks like" must not have
 * three transcriptions free to drift the day a fourth caller exists. `whose`
 * only decides the words in the refusal, so the file's complaint names the thing
 * that is wrong rather than a field name three levels up.
 *
 * Undefined for a block holding neither, which is what lets the caller drop it
 * rather than write a key meaning nothing.
 */
function validLines(
  row: Record<string, unknown>,
  file: string,
  whose: string,
): CaptureLines | undefined {
  let crop: CaptureLines['crop'];
  const held = row['crop'];
  if (held !== undefined && held !== null) {
    if (typeof held !== 'object' || Array.isArray(held)) fail(file, `${whose} crop is not a crop`);
    const asked = held as Record<string, unknown>;
    const side = (key: string): number => {
      const measure = asked[key];
      if (typeof measure !== 'number' || !Number.isFinite(measure) || measure <= 0) {
        fail(file, `${whose} crop was drawn for a frame with no ${key}`);
      }
      return measure;
    };
    crop = {
      quad: validQuad(asked['quad'], file, `${whose} crop`),
      width: side('width'),
      height: side('height'),
    };
  }

  let cut: CaptureSplit | undefined;
  const line = row['cut'];
  if (line !== undefined && line !== null) {
    if (typeof line !== 'object' || Array.isArray(line)) fail(file, `${whose} cut is not a line`);
    const ends = line as Record<string, unknown>;
    cut = {
      a: validPoint(ends['a'], file, `${whose} cut starts where it`),
      b: validPoint(ends['b'], file, `${whose} cut ends where it`),
    };
  }

  if (crop === undefined && cut === undefined) return undefined;
  return { ...(crop === undefined ? {} : { crop }), ...(cut === undefined ? {} : { cut }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening — the recipe plus the token that makes its pictures loadable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the light table needs to draw itself, in one round trip.
 *
 * The token is minted HERE rather than by a door of its own because the two
 * arrive together every time: a recipe whose pictures cannot be addressed is a
 * grid of broken images, and a token for a recipe nobody has read has nothing to
 * point at.
 */
export async function openCapture(projectDir: string): Promise<CaptureOpened> {
  const dir = derivedDir(projectDir);
  await fsp.mkdir(dir, { recursive: true });
  return {
    recipe: await readRecipe(projectDir),
    token: tokenForServing(dir),
    // Resolved in projects.ts against the catalogue's chain, so this and the
    // step list's `current` marker are one answer to one question.
    mintedFrom: await currentArrangement(projectDir),
  };
}

/*
 * ── GRAVESTONE: `loadMintedPages` AND `SERVED_PAGE_TYPES` (Wave 41) ────────
 *
 * A door stood here that listed a mint's page images in reading order and minted
 * a token to serve them, because the mint wrote pictures and no container and
 * the minted row had to open SOMETHING. Owen ended the class at the source:
 * *"maybe we should mint a pdf from the pages after theyre fully arranged and
 * complete… the pdf is just the images on each page"*, and *"the system isnt
 * trying to sift through images, it's using the original pdf just like it
 * normally would"*.
 *
 * So the minted row opens a PDF through the ordinary document path, pdf.js draws
 * it, and there is nothing left for this to answer. The IPC door
 * (`capture:pages-load`), its preload arm, its `FoundryApi` member, the
 * `CaptureMintedPages` payload and `app-pages-view` retired with it.
 */


/**
 * The same thing, for a project that does not have a recipe yet.
 *
 * SEPARATE FROM `openCapture` BECAUSE THE REFUSAL IS THE POINT OF THAT ONE. A
 * missing `recipe.json` means damage everywhere except here, at the single
 * moment a capture project is created and there is genuinely nothing to read
 * yet. Folding the two would make every later load answer "no photographs" for
 * a project whose `originals/` is full of them, and invite the surface to save
 * that answer back over the file.
 */
export async function ensureCapture(projectDir: string): Promise<CaptureOpened> {
  await fsp.mkdir(originalsDir(projectDir), { recursive: true });
  await fsp.mkdir(derivedDir(projectDir), { recursive: true });
  const file = recipeFile(projectDir);
  try {
    await fsp.access(file);
  } catch {
    await writeAtomically(file, Buffer.from(recipeBytes(emptyRecipe())));
  }
  return openCapture(projectDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Decoding — HEIC in, upright RGBA out
// ─────────────────────────────────────────────────────────────────────────────

interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/*
 * `libheif-js` ships a wasm build and no types. Loaded through `require` at the
 * moment of use rather than imported at the top: the wasm module costs real
 * memory to instantiate, and an app that never opens a capture project should
 * never pay for it.
 */
interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(into: { data: Uint8ClampedArray; width: number; height: number }, done: (out: unknown) => void): void;
}
interface HeifModule { HeifDecoder: new () => { decode(bytes: Buffer): HeifImage[] } }

let heif: HeifModule | null = null;

/**
 * The decoder, or a refusal that says the APP is missing something.
 *
 * ── WHY THIS FAILURE IS NOT A PER-FILE REFUSAL ─────────────────────────────
 *
 * `intakePhotos` reports what it could not read file by file, which is exactly
 * right for a truncated HEIC among twenty-seven good ones — that is what the
 * refusal list is for. It is exactly WRONG for an absent decoder, because that
 * condition fails every file: a person who dropped a folder is told twenty-seven
 * times that their photographs are unreadable, in a sentence containing a Node
 * require stack, and the true cause is nowhere in the message. They would report
 * it as "capture is broken" and be right about the symptom and helpless about the
 * reason.
 *
 * Found by P2 running this intake against real files on a worktree whose
 * `node_modules` predated the dependency (feature channel, seq 57). The
 * distinction is the one the pdf-lib note already made: a per-file refusal is
 * ABOUT THE FILE, and this is about the installation.
 *
 * IT IS ALSO THE PACKAGED-BUILD SHAPE. `libheif-js` is a real dependency of
 * app/package.json, so a packaged build carries it — but if that ever stops
 * being true, the failure a person meets must say so rather than blame the only
 * copies of an afternoon in an archive.
 */
function decoderModule(): HeifModule {
  if (heif === null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      heif = require('libheif-js') as HeifModule;
    } catch (err) {
      throw new CaptureError(
        'This copy of Foundry cannot read photographs: its HEIC decoder (libheif-js) is not '
        + 'installed beside the app. Nothing is wrong with your photographs and none of them '
        + `were read. (${err instanceof Error ? err.message.split(String.fromCharCode(10))[0] : String(err)})`,
      );
    }
  }
  return heif;
}

/**
 * Decode one HEIC, upright, and hand back the pixels.
 *
 * APPLIES NOTHING. See the header: the buffer that comes back has already had
 * the container's rotation applied, and the EXIF Orientation tag is a fact about
 * a grid this app never looks at.
 */
async function decodeHeic(bytes: Buffer, name: string): Promise<DecodedImage> {
  const images = new (decoderModule().HeifDecoder)().decode(bytes);
  const image = images[0];
  if (image === undefined) throw new CaptureError(`${name} holds no image the decoder could find.`);
  const width = image.get_width();
  const height = image.get_height();
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new CaptureError(`${name} decoded to ${width}x${height}, which is not a picture.`);
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  await new Promise<void>((resolve, reject) => {
    image.display({ data: rgba, width, height }, (out) => {
      if (out) resolve();
      else reject(new CaptureError(`${name} could not be decoded to pixels.`));
    });
  });
  return { width, height, rgba };
}

// ─────────────────────────────────────────────────────────────────────────────
// PNG, written here rather than encoded by somebody else
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ── WHY THIS IS HAND-WRITTEN AND NOT `nativeImage.createFromBitmap` ──────────
 *
 * Electron can encode a bitmap, but its buffer is BGRA or RGBA depending on the
 * platform and premultiplied on some of them — an ambiguity that would be
 * resolved by trying it, on the ONE file every page of the finished book is
 * sampled from. A PNG chunk writer is forty lines with no ambiguity in it at
 * all: these bytes, in this order, on every platform. The thumbnail below does
 * use Electron, and it is handed a PNG rather than a bitmap for exactly this
 * reason — there is no channel order to get wrong in a decoded file format.
 *
 * COLOUR TYPE 2 (RGB), NOT 6 (RGBA). The decoder hands back four channels and a
 * photograph's fourth is opaque everywhere; carrying it would add a quarter to a
 * file that is already ~12 MiB per photograph. A HEIC that genuinely carried
 * transparency would flatten to opaque here, which is the right answer for a
 * photograph of a page and the wrong one for nothing this stage accepts.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * RGBA pixels to PNG bytes.
 *
 * FILTER 1 (SUB) AND DEFLATE LEVEL 3, both measured on the acceptance shoot
 * rather than chosen: against filter 0 at the same level, Sub takes a 3024x4032
 * photograph from 16.7 MiB to 11.5 MiB for 77 ms more work, while raising the
 * deflate level to 6 buys 0.9 MiB for 172 ms. A lossless working copy is meant
 * to be big; it is not meant to be slow, and 27 of them are decoded in one
 * intake.
 */
async function encodePng(image: DecodedImage): Promise<Buffer> {
  const { width, height, rgba } = image;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 1; // Sub
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const here = row + x * 4;
      const left = x === 0 ? -1 : here - 4;
      raw[at++] = (rgba[here]! - (left < 0 ? 0 : rgba[left]!)) & 0xff;
      raw[at++] = (rgba[here + 1]! - (left < 0 ? 0 : rgba[left + 1]!)) & 0xff;
      raw[at++] = (rgba[here + 2]! - (left < 0 ? 0 : rgba[left + 2]!)) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // eight bits a channel
  header[9] = 2; // colour type 2 — RGB
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', await deflate(raw, { level: 3 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The long edge of a thumbnail, in pixels. */
const THUMB_EDGE = 640;

/**
 * The picture the grid draws — 640 px on its long edge, JPEG, display only.
 *
 * NEVER IN ANY QUALITY CHAIN. Nothing downstream of this stage ever sees this
 * file: the editor opens the full PNG for the one photograph it is showing, and
 * the mint samples full PNGs a page at a time. It exists so that opening a
 * project does not pull half a gigabyte of lossless PNG through the door and
 * decode it, every time, to draw twenty-seven cards.
 *
 * FED THE ENCODED PNG rather than the raw bitmap, which is the same decision the
 * encoder above explains: a decoded file format has no channel order to get
 * wrong, and this is the one place Electron's imaging is in the path at all.
 */
function encodeThumbnail(png: Buffer, image: { width: number; height: number }): Buffer {
  const wide = image.width >= image.height;
  const thumb = nativeImage.createFromBuffer(png).resize({
    ...(wide ? { width: THUMB_EDGE } : { height: THUMB_EDGE }),
    quality: 'best',
  });
  return thumb.toJPEG(85);
}

// ─────────────────────────────────────────────────────────────────────────────
// When the photograph was taken
// ─────────────────────────────────────────────────────────────────────────────

/** `Exif\0\0` — the payload marker, and NOT the item declaration that shares it. */
const EXIF_SIGNATURE = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);

/**
 * How far into the file the EXIF payload is allowed to be.
 *
 * Measured on the acceptance shoot: the payload begins between 31,653 and 35,731
 * bytes in, across all 27 files. 128 KiB is comfortably past that without
 * walking a 1.5 MiB file looking for a needle that is not there.
 */
const EXIF_LIMIT = 128 * 1024;

interface ExifTimes {
  dateTimeOriginal: string | null;
  offsetTimeOriginal: string | null;
}

/**
 * Find the EXIF payload and read the two time tags out of it.
 *
 * ── THE FIRST MATCH IS A DECOY, IN EVERY FILE, AND THAT IS THE FINDING ──────
 *
 * Searching for `Exif\0\0` and trusting the first hit reads garbage: in ALL 27
 * files of the acceptance shoot the first occurrence is at offset 1554 (or 1864
 * in one), inside the `infe` box where the container DECLARES it holds an Exif
 * item, and the bytes after it are zeroes rather than a TIFF header. The real
 * payload is ~32 KiB further in, and it is the only one of the two that is
 * followed by a byte-order marker and the number 42.
 *
 * So this VALIDATES rather than trusts: every occurrence is examined, and the
 * first one that is actually a TIFF header wins. Measured across the shoot, that
 * rule finds exactly one candidate per file — the decoy never validates and the
 * payload always does.
 *
 * A BOUNDED SCAN AND NOT A BOX WALK, deliberately. A full ISOBMFF walk is the
 * more correct program and a much longer one, and its failure mode on a file
 * this scan cannot read is the same as this one's: no time, `mtime` recorded as
 * the source, nothing silent. The scan is what the acceptance shoot needed; the
 * walk is written the day a camera arrives that this refuses.
 */
function readExifTimes(bytes: Buffer): ExifTimes {
  const none: ExifTimes = { dateTimeOriginal: null, offsetTimeOriginal: null };
  const hay = bytes.subarray(0, Math.min(bytes.length, EXIF_LIMIT));
  let tiff = -1;
  let bigEndian = false;
  for (let at = hay.indexOf(EXIF_SIGNATURE); at >= 0; at = hay.indexOf(EXIF_SIGNATURE, at + 1)) {
    const start = at + EXIF_SIGNATURE.length;
    if (start + 8 > bytes.length) break;
    const order = bytes.readUInt16BE(start);
    const be = order === 0x4d4d;
    if (!be && order !== 0x4949) continue;
    if ((be ? bytes.readUInt16BE(start + 2) : bytes.readUInt16LE(start + 2)) !== 42) continue;
    tiff = start;
    bigEndian = be;
    break;
  }
  if (tiff < 0) return none;

  const u16 = (at: number): number => (bigEndian ? bytes.readUInt16BE(at) : bytes.readUInt16LE(at));
  const u32 = (at: number): number => (bigEndian ? bytes.readUInt32BE(at) : bytes.readUInt32LE(at));

  /** The entries of one IFD, for the tags asked about and no others. */
  const readIfd = (at: number, wanted: readonly number[]): Map<number, string | number> => {
    const found = new Map<number, string | number>();
    if (at < 0 || at + 2 > bytes.length) return found;
    const entries = u16(at);
    for (let i = 0; i < entries; i++) {
      const entry = at + 2 + i * 12;
      if (entry + 12 > bytes.length) break;
      const tag = u16(entry);
      if (!wanted.includes(tag)) continue;
      const type = u16(entry + 2);
      const count = u32(entry + 4);
      const width = type === 3 ? 2 : type === 4 ? 4 : 1;
      const size = width * count;
      if (size > 1024) continue; // a time is twenty bytes; anything else is not one
      const value = size <= 4 ? entry + 8 : tiff + u32(entry + 8);
      if (value < 0 || value + size > bytes.length) continue;
      found.set(tag, type === 2
        ? bytes.toString('latin1', value, value + count).replace(/\0[\s\S]*$/, '').trim()
        : u32(value));
    }
    return found;
  };

  const EXIF_IFD_POINTER = 0x8769;
  const DATE_TIME_ORIGINAL = 0x9003;
  const OFFSET_TIME_ORIGINAL = 0x9011;

  const subAt = readIfd(tiff + u32(tiff + 4), [EXIF_IFD_POINTER]).get(EXIF_IFD_POINTER);
  if (typeof subAt !== 'number') return none;
  const sub = readIfd(tiff + subAt, [DATE_TIME_ORIGINAL, OFFSET_TIME_ORIGINAL]);
  const taken = sub.get(DATE_TIME_ORIGINAL);
  const offset = sub.get(OFFSET_TIME_ORIGINAL);
  return {
    dateTimeOriginal: typeof taken === 'string' && taken.length > 0 ? taken : null,
    offsetTimeOriginal: typeof offset === 'string' && offset.length > 0 ? offset : null,
  };
}

interface TakenAt {
  takenAt: string;
  takenAtSource: CaptureTimeSource;
}

/**
 * When this photograph was taken, as a UTC instant, and how sure we are.
 *
 * ── THE SORT IS THE CUSTOMER, AND IT IS WHY THE SOURCE IS RECORDED ──────────
 *
 * EXIF writes wall time with no zone: `2026:08:18 17:55:01` is what the clock in
 * the room said. The acceptance shoot also carries `OffsetTimeOriginal` (-04:00
 * on all 27), which turns that reading into an instant; a camera that omits it
 * leaves us interpreting the wall time in THIS machine's zone, which is right
 * for photographs taken here and wrong by hours for photographs that travelled.
 * Either way a single shoot sorts correctly, because every photograph in it is
 * wrong by the same amount.
 *
 * `takenAtSource` exists so that nothing downstream has to guess which of the
 * three answers it is holding, and so that a project whose order looks wrong can
 * be asked WHY rather than argued with. `mtime` is the honest last resort — a
 * file copied by a photo manager can carry a modification time that has nothing
 * to do with the shutter, and saying so is better than a confident wrong instant.
 */
function takenAtFrom(times: ExifTimes, modifiedAt: Date): TakenAt {
  const stamp = times.dateTimeOriginal;
  const match = stamp === null
    ? null
    : /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  if (match === null) {
    return { takenAt: modifiedAt.toISOString(), takenAtSource: 'mtime' };
  }
  const [, year, month, day, hour, minute, second] = match;
  const offset = times.offsetTimeOriginal;
  if (offset !== null && /^[+-]\d{2}:\d{2}$/.test(offset)) {
    const instant = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
    if (!Number.isNaN(instant.getTime())) {
      return { takenAt: instant.toISOString(), takenAtSource: 'exif-offset' };
    }
  }
  // No offset: the wall time is read in this machine's zone, and the record says
  // so rather than pretending the reading was UTC.
  const local = new Date(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  );
  if (Number.isNaN(local.getTime())) {
    return { takenAt: modifiedAt.toISOString(), takenAtSource: 'mtime' };
  }
  return { takenAt: local.toISOString(), takenAtSource: 'exif-local' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Intake
// ─────────────────────────────────────────────────────────────────────────────

/*
 * THE WHOLE FRAME MOVED TO `shared/capture.ts`, where the editor can import it
 * too. It was spelled here and again in the editor as `wholeFrame()`, which is
 * the shape this feature keeps paying for — and the chord needed a third
 * spelling for "no pages at all", which is one more than anybody should have to
 * keep in agreement.
 */

function pagesFor(photoId: string, from: CapturePhoto | null, decoded: { width: number; height: number }): {
  pages: CapturePage[];
  split: CaptureSplit | null;
  inherited: boolean;
} {
  if (from !== null && sameShape(from, decoded) && from.pages.length > 0) {
    return {
      pages: from.pages.map((page, index) => ({
        id: `${photoId}:${index}`,
        quad: page.quad,
        // A strike is a decision about a PAGE, never about a crop, so it is the
        // one thing a late arrival does not inherit: nobody has looked at this
        // photograph yet, and starting it struck would hide it in the grid.
        struck: false,
        // NOR THE HAND-SET MARK, for a sharper version of the same reason. It
        // says a person set THIS page themselves; a photograph that arrived
        // late and took its crop from a neighbour has been set by nobody. An
        // inherited mark would make the next global stamp skip the one
        // photograph on the table that has never been looked at, and name it
        // as work somebody would lose — which is the opposite of true.
      })),
      split: from.split,
      inherited: true,
    };
  }
  return {
    pages: [{ id: `${photoId}:0`, quad: WHOLE_FRAME, struck: false }],
    split: null,
    inherited: false,
  };
}

/** What intake did, beyond the recipe it hands back. */
export interface IntakeReport extends CaptureOpened {
  added: number;
  /** Files already in this project, by sha — dropped twice, copied once. */
  duplicates: string[];
  /** Files this stage will not read, and the reason, in words. */
  refused: { file: string; why: string }[];
}

/*
 * `READABLE` STOOD HERE AND IS NOW `PHOTOGRAPH_TYPES` IN shared/capture.ts,
 * with the whole of its argument — the HEIC/PNG/JPEG measurement, and the EXIF
 * double-rotation fear this stage answers by rotating NOTHING — moved intact
 * beside the definition rather than left behind as a summary.
 *
 * It moved because Wave 38 gave the RENDERER an opinion about what a photograph
 * is: Home's drop zone sorts a dropped file into the document door or into the
 * intake workspace before any of it crosses the bridge, and a second list of
 * five extensions over there would be two answers to the one question this
 * stage exists to answer. The refusal written below is now a refusal of exactly
 * the files the other side declined to keep.
 */

/** Which of the readable kinds goes through libheif rather than Electron. */
const HEIC_LIKE = new Set(['.heic', '.heif']);

/**
 * Copy photographs into the project, decode them once, and add them to the
 * recipe.
 *
 * ── ONE PHOTOGRAPH AT A TIME, ON PURPOSE ────────────────────────────────────
 *
 * A decoded 12-megapixel frame is 48 MiB of RGBA and its PNG is another 12; the
 * acceptance shoot is 27 of them. Held together that is a gigabyte and a half of
 * live heap in the main process for no reason at all, since nothing here needs
 * two photographs at once. Sequential also means an intake that fails halfway
 * leaves every photograph before the failure fully written and catalogued.
 */
export async function intakePhotos(projectDir: string, paths: readonly string[]): Promise<IntakeReport> {
  /*
   * ASKED FOR ONCE, BEFORE ANY DIRECTORY IS MADE OR ANY FILE IS COPIED. If the
   * decoder is missing this throws HERE — one loud failure about the app —
   * rather than inside the loop, where it would become one refusal per
   * photograph about the photographs. Failing before the first `mkdir` also
   * means an intake that cannot possibly work leaves nothing behind.
   */
  decoderModule();
  const originals = originalsDir(projectDir);
  const derived = derivedDir(projectDir);
  await fsp.mkdir(originals, { recursive: true });
  await fsp.mkdir(derived, { recursive: true });

  return withRecipe(projectDir, async () => {
    const recipe = await readRecipe(projectDir);
    const photos = [...recipe.photos];
    const order = [...recipe.order];
    const duplicates: string[] = [];
    /*
     * GUARDED, because a listener is somebody else’s code running inside our
     * loop: a throw from a window that closed mid-intake must not abandon a
     * photograph half-copied. The same argument `importLanded` makes at its own
     * settle, for the same reason.
     */
    const report = (progress: CaptureIntakeProgress): void => {
      try {
        intakeProgress(progress);
      } catch (err) {
        console.error(
          '[capture] the intake-progress listener threw: '
          + `${err instanceof Error ? err.message : String(err)}. The intake continues.`,
        );
      }
    };
    const refused: { file: string; why: string }[] = [];
    let added = 0;

    for (const each of paths) {
      const resolved = path.resolve(each);
      const name = path.basename(resolved);
      /*
       * SAID BEFORE THE WORK, NOT AFTER IT. A progress line that appears once a
       * photograph is finished names the one the person has already waited for;
       * this names the one they are waiting ON.
       *
       * And it is emitted for EVERY path, including those about to be refused or
       * recognised as duplicates: a total counting only successes would make the
       * count jump backwards the moment somebody drops a stray file in with the
       * photographs.
       */
      report({
        projectDir,
        done: added + duplicates.length + refused.length,
        total: paths.length,
        file: name,
      });
      // Between photographs, never inside one: the decode cannot be interrupted,
      // so this is the only place the window gets a chance to breathe.
      await breathe();
      const extension = path.extname(resolved).toLowerCase();
      if (!PHOTOGRAPH_TYPES.has(extension)) {
        refused.push({
          file: name,
          why: `${extension || 'a file with no extension'} is not a photograph this stage reads — HEIC, PNG or JPEG`,
        });
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await fsp.readFile(resolved);
      } catch (err) {
        refused.push({ file: name, why: `it could not be read: ${(err as Error).message}` });
        continue;
      }

      /*
       * CONTENT-ADDRESSED, so dropping the same folder twice copies nothing and
       * adds nothing. The id IS the hash, so a second copy could not be given an
       * id of its own without breaking the one rule the page ids rest on.
       */
      const id = createHash('sha256').update(bytes).digest('hex');
      if (photos.some((photo) => photo.id === id)) {
        duplicates.push(name);
        continue;
      }

      /*
       * TWO DECODERS, ONE INVARIANT: whatever comes out is the working grid,
       * with no rotation of this intake's own (`PHOTOGRAPH_TYPES`' docblock carries
       * the whole argument). HEIC goes through libheif exactly as before. PNG
       * and JPEG go through Electron's imaging — and a PNG's working copy is
       * THE BYTES THEMSELVES, byte for byte: it is already the lossless format
       * the working copy exists to be, and a decode-reencode of a lossless
       * file buys a chance to be wrong about channel order and nothing else.
       * A JPEG is transcoded once to PNG by the same imaging that decoded it,
       * so no hand-written encoder ever touches a channel order Electron chose.
       */
      let frame: { width: number; height: number };
      let png: Buffer;
      if (HEIC_LIKE.has(extension)) {
        let decoded: DecodedImage;
        try {
          decoded = await decodeHeic(bytes, name);
        } catch (err) {
          refused.push({ file: name, why: (err as Error).message });
          continue;
        }
        frame = { width: decoded.width, height: decoded.height };
        png = await encodePng(decoded);
      } else {
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) {
          refused.push({ file: name, why: 'it could not be decoded as an image — the file may be damaged' });
          continue;
        }
        frame = image.getSize();
        png = extension === '.png' ? bytes : image.toPNG();
      }

      const original = `${id}${extension}`;
      const workingCopy = `${id}.png`;
      const thumb = `${id}.${THUMB_EDGE}.jpg`;
      await writeAtomically(path.join(originals, original), bytes);
      await writeAtomically(path.join(derived, workingCopy), png);
      await writeAtomically(path.join(derived, thumb), encodeThumbnail(png, frame));

      const stat = await fsp.stat(resolved);
      const { pages, split } = pagesFor(id, photos[photos.length - 1] ?? null, frame);
      photos.push({
        id,
        file: `${ORIGINALS}/${original}`,
        // The name the person dragged in, kept because nothing else here
        // remembers it: the copy is named by hash and the source path is not
        // recorded. It is the only word a sentence about this photograph can use.
        name,
        workingCopy,
        thumb,
        // THE DECODER'S DIMENSIONS. EXIF's are about the other grid, and storing
        // them here would make the aspect rule above answer about a photograph
        // nobody is looking at.
        width: frame.width,
        height: frame.height,
        ...takenAtFrom(readExifTimes(bytes), stat.mtime),
        split,
        pages,
      });
      order.push(...pages.map((page) => page.id));
      added += 1;
    }

    // The last word: everything asked for is accounted for. Without it a modal
    // driven by this sits at 26 of 27 while the recipe is written.
    report({ projectDir, done: paths.length, total: paths.length, file: '' });

    /*
     * SPREAD, NOT REBUILT — and it was rebuilt until Wave 24, which quietly cost
     * something every time.
     *
     * This wrote `{ version: 1, photos, order }`, so an intake DELETED every
     * field it did not name: the prepare rail's ticks, and now the book's
     * standing crop. Dragging four more photographs into a project was enough to
     * un-answer three questions somebody had already answered, and nothing on
     * the surface said so — the rail simply had its boxes cleared.
     *
     * The two locals are the only things an intake changes. Everything else
     * about the recipe belongs to the person, and the way to keep it is to carry
     * the recipe rather than to remember each field.
     */
    const next: CaptureRecipe = { ...recipe, photos, order };
    await writeAtomically(recipeFile(projectDir), Buffer.from(recipeBytes(next)));
    return {
      recipe: next,
      token: tokenForServing(derived),
      // An intake answers with an opening, so it answers the same question an
      // opening does. Null on a project that has never minted, which is every
      // project an intake is normally run on -- and NOT undefined, which is a
      // field the surface would have to know to treat as silence.
      mintedFrom: await currentArrangement(projectDir),
      added,
      duplicates,
      refused,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The mint
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ── WHO DOES WHAT, AND WHY IT IS SPLIT THIS WAY ─────────────────────────────
 *
 * MAIN decides the list, the sizes and the order; THE RENDERER rasterizes
 * exactly that list and sends back one JPEG at a time; MAIN assembles the PDF.
 * The rectifying happens in the renderer because it is a WebGL shader the
 * editor already runs for its live preview — one implementation, native speed —
 * and doing it here would mean a second one in JavaScript, seconds a page.
 *
 * ONE PAGE AT A TIME ACROSS THE BRIDGE, and each one lands on disk before the
 * next is asked for. A shoot is hundreds of megabytes of JPEG; holding it in
 * one heap to assemble at the end would put the whole book in memory twice, in
 * a process that also has an app in it.
 *
 * THE PAGES ARE STAGED INSIDE THE PROJECT rather than in the system temp
 * directory. A mint interrupted by a crash leaves a numbered directory under
 * `capture/mints/` that nothing reads and the next mint does not touch. That is
 * a visible mess in one folder, which is better than an invisible one in
 * %TEMP% — and a project's own folder is where a person looking for a book that
 * did not finish would think to look. (For two days the commit was a RENAME out
 * of this directory rather than a read of it, and staging inside the project was
 * what kept that on one volume. The commit assembles again, so the staging is a
 * scratch area once more; it stays here because the first reason never depended
 * on the second.)
 */
interface MintSession {
  projectDir: string;
  /** The shelf row. The renderer never sees this; a cancel arrives through it. */
  jobId: string;
  staging: string;
  pages: CaptureMintPage[];
  /**
   * The fingerprint of the recipe THIS mint was begun from, carried to the step.
   *
   * Held on the session rather than re-read at commit for the reason
   * `recordMint` states: a mint takes minutes, the recipe is editable
   * throughout, and the arrangement recorded must be the one these pages were
   * rasterized from rather than whatever the file says when the last page lands.
   */
  arrangement: string;
  received: Set<number>;
}

const mints = new Map<string, MintSession>();

function sessionOf(mintId: string): MintSession {
  const session = mints.get(mintId);
  if (session === undefined) {
    throw new CaptureError(
      `There is no mint called ${mintId} in progress. It was finished, given up on, or belongs to a `
      + 'run of this app that has since closed.',
    );
  }
  return session;
}

async function forget(session: MintSession, mintId: string): Promise<void> {
  mints.delete(mintId);
  await fsp.rm(session.staging, { recursive: true, force: true }).catch(() => { /* best effort */ });
}

/**
 * Work out what this mint will print, and open a session for it.
 *
 * ── MAIN DENORMALIZES EXACTLY ONCE, AND THIS IS THE ONCE ────────────────────
 *
 * The recipe is fractions from end to end. Here they are multiplied by the
 * working copy's decoded dimensions and never again — the renderer is handed
 * `quadPx` in pixels beside the `sourceWidth`/`sourceHeight` they were computed
 * against, so it can ASSERT its decoded bitmap matches what main measured
 * rather than trusting it. There is no second conversion anywhere to disagree
 * with this one, which is the guarantee that makes `PixelQuad` being a mere
 * alias tolerable.
 *
 * ── THE ORDER IS THE ORDER, AND STRIKES ARE DROPPED HERE ────────────────────
 *
 * `recipe.order` lists every page id including struck ones, and this is the one
 * place they are filtered. The renderer receives a list that is already the
 * book: no strike logic on that side, no chance of the two sides disagreeing
 * about which leaf is in.
 */
export async function mintBegin(projectDir: string): Promise<CaptureMintBegun> {
  const recipe = await readRecipe(projectDir);
  /*
   * THE WHOLE LIST COMES FROM `shared/` NOW, not just the page ids — so the
   * number the footer promised, the number the editor read out, the pages this
   * prints AND the arrangement recorded on the step are one body of one rule
   * (see `mintPlan`, and `mintedPageIds` for the third time this rule had more
   * than one). The fingerprint is taken from THIS read of the recipe rather than
   * at commit, so it describes the book that was actually rasterized even if
   * somebody edits the file in the minutes a mint takes.
   */
  const { pages, missing } = mintPlan(recipe);
  const arrangement = arrangementOf(recipe);
  /*
   * STILL REFUSED HERE RATHER THAN TRUSTED. `mintedPageIds` drops an id that
   * names no page, which is the right answer for a COUNT on screen — a number
   * beside a button must not throw. It is the wrong answer for the mint: a
   * book quietly short a leaf is the failure the order cross-check exists to
   * prevent, so reaching this means the file changed under us between the load
   * and the mint, and that is worth stopping for.
   */
  if (missing.length > 0) {
    throw new CaptureError(
      `The recipe lists a page (${missing[0]}) that no photograph holds. Reopen the project before minting.`,
    );
  }

  if (pages.length === 0) {
    throw new CaptureError(
      'Every page in this project is struck, so there is nothing to mint. Restore a page first.',
    );
  }

  const mintId = randomUUID();
  const staging = path.join(captureDir(projectDir), MINTS, mintId);
  await fsp.mkdir(staging, { recursive: true });
  const manifest = await readManifest(projectDir).catch(() => null);
  mints.set(mintId, {
    projectDir,
    jobId: beginMint(projectDir, manifest?.title ?? path.basename(projectDir), pages.length),
    staging,
    pages,
    arrangement,
    received: new Set<number>(),
  });
  return { mintId, pages };
}

/**
 * One rectified page, as the renderer finished it.
 *
 * THE CANCEL IS CHECKED HERE and nowhere else. Pressing ✕ sets the shelf row to
 * cancelled in a microsecond, but the renderer is midway through a page and will
 * keep sending; nothing in main can reach across and stop it. So the first page
 * to arrive after a cancel is refused, the staging directory goes, and the
 * renderer learns the mint is over by being told no. Within one page, rather
 * than instantly — which for a stage measured in minutes is the same thing.
 */
export async function mintPage(mintId: string, index: number, jpeg: ArrayBuffer): Promise<void> {
  const session = sessionOf(mintId);
  if (mintCancelled(session.jobId)) {
    await forget(session, mintId);
    throw new CaptureError('This mint was cancelled, so its pages are no longer being collected.');
  }
  if (!Number.isInteger(index) || index < 0 || index >= session.pages.length) {
    throw new CaptureError(
      `Page ${index} is not one of the ${session.pages.length} pages this mint asked for.`,
    );
  }
  await writeAtomically(path.join(session.staging, `${index}.jpg`), Buffer.from(jpeg));
  session.received.add(index);
  noteMintPage(session.jobId, session.received.size);
}

/** Nominal dots per inch for the page box. 72 points to the inch. */
const MINT_DPI = 300;

/**
 * Assemble the PDF, file it as the project's imported original, answer with the
 * step.
 *
 * ── THE MINT PRODUCES A PDF, AND FROM THAT MOMENT THIS IS AN ORDINARY BOOK ──
 *
 * Owen, 2026-08-22, in two messages, and they are the whole of this wave:
 *
 *   *"maybe we should mint a pdf from the pages after theyre fully arranged and
 *   complete, and then we build the bank after that (not necessarily from the
 *   pdf, but the pdf can exist so it doesnt confuse bookforge or anything else).
 *   the pdf is just the images on each page."*
 *
 * and, when told this would also retire a night's worth of special paths:
 *
 *   *"this might fix our current problem as well. the system isnt trying to sift
 *   through images, it's using the original pdf just like it normally would."*
 *
 * A third message settled the read, and it is recorded again where the reading
 * is planned (`planReading`, electron/workspace.ts): *"if we're building the
 * bank from the images anyway maybe we should just build it from the pdf. why
 * not? it would help maintain provenance, and nothing will be lost."*
 *
 * ── WHAT THIS REVERSES, AND WHY THE REVERSAL IS NOT A REGRESSION ────────────
 *
 * At `ecbf238` the assembly was taken OUT on the argument that a PDF was a round
 * trip: the mint drew one JPEG per page into a container and the read rasterised
 * the container straight back into one image per page. That argument was true
 * about the READ and silent about everything else, and everything else is what
 * broke. A folder is not a file, so `manifest.archive.file` named a DIRECTORY,
 * and every consumer that asks a project "what were you made from" hit it in
 * turn: the three make-dialogs, the page viewer, the figure cutter, and finally
 * BookForge's adoption, which refuses a project whose *"catalogue's archive names
 * no file"*. Each was patched alone. The container is the answer to all of them
 * at once, and the round trip it costs is seconds against a read measured in
 * hours.
 *
 * ── AN IMAGE-ONLY PDF, WHICH IS THE ENTIRE OUTPUT OF THIS STAGE ─────────────
 *
 * One JPEG per page, drawn to fill its own page box, no text layer and no fonts —
 * *"the pdf is just the images on each page"*, verbatim. `embedJpg` takes the
 * encoded bytes as they are, so no page is decoded, resampled or re-encoded on
 * the way in: the pixels in the container are the pixels the renderer rectified.
 *
 * THE PAGE BOX IS THE PIXELS AT A NOMINAL 300 DPI. Nothing is resampled: the
 * JPEG goes in at its own resolution and the box is sized to suit it, so the
 * declared page is roughly the physical page it was photographed from. The read
 * stage rasterizes at its own budget later; this number never constrains it.
 *
 * ── THE STAGED PAGES ARE CONSUMED, AND NO FOLDER IS LEFT BEHIND ─────────────
 *
 * THE CALL, STATED: a new mint leaves NO `archive/<stem> pages/` directory. The
 * JPEGs go into the container byte for byte, so a folder beside it would be a
 * second complete copy of a shoot that runs to hundreds of megabytes, kept for
 * readers that no longer exist — the page view, the `--pages` read and the
 * `--pages` figure cut are all off the app's paths as of this wave. The record
 * of every rectified page is the PDF, which is the one thing Owen asked for.
 *
 * (The HEAL is the other way round and deliberately so: a project that already
 * holds a pages folder KEEPS it, because deleting somebody's data to tidy a
 * migration is not a thing this app does. See `healMintedArchive`.)
 *
 * ── THE READING ORDER IS THE MINT'S OWN PAGE NUMBERING ──────────────────────
 *
 * `session.pages` is the list `mintBegin` built from `recipe.order` with the
 * struck pages already dropped, in the order the book is read; the renderer
 * rasterised exactly that list and returned each page by its INDEX in it. So
 * walking the indices in ascending order is the book, and there is no second
 * ordering rule anywhere to disagree with it.
 *
 * REFUSES A BOOK WITH A HOLE IN IT. Every page main asked for must have come
 * back. A missing one would print a book quietly short a leaf, which is exactly
 * the failure the order cross-check exists to prevent one layer up.
 *
 * ── ONE HEAP'S WORTH, AND THAT IS THE COST OF A CONTAINER ───────────────────
 *
 * `MintSession` above explains why pages cross the bridge one at a time and land
 * on disk as they arrive: a shoot held whole in the main process is the book in
 * memory twice, in a process that also has an app in it. The assembly gives some
 * of that back — pdf-lib holds every embedded JPEG and then serialises the lot
 * into one array — and it is named here rather than discovered, because it is the
 * price of the container and the container is what the ruling asks for. Nothing
 * is DECODED, so the peak is the encoded book and not its pixels.
 */
export async function mintCommit(mintId: string): Promise<LedgerStep> {
  const session = sessionOf(mintId);
  if (mintCancelled(session.jobId)) {
    await forget(session, mintId);
    throw new CaptureError('This mint was cancelled before it could be finished.');
  }
  const missing = session.pages
    .map((_page, index) => index)
    .filter((index) => !session.received.has(index));
  if (missing.length > 0) {
    throw new CaptureError(
      `${missing.length} of ${session.pages.length} pages never arrived, so this book would be `
      + `short a leaf. Missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}.`,
    );
  }

  try {
    const step = await recordMint(
      session.projectDir,
      await assemblePdf(session),
      session.arrangement,
    );
    settleMint(session.jobId, { file: path.join(session.projectDir, ...step.payload.split('/')) });
    await forget(session, mintId);
    return step;
  } catch (err) {
    // The row must not sit at `running` for the rest of the session because an
    // embed threw. The staging pages are kept: the failure is worth looking at.
    settleMint(session.jobId, { error: err instanceof Error ? err.message : String(err) });
    mints.delete(mintId);
    throw err;
  }
}

/**
 * The staged pages, in order, as one image-only PDF.
 *
 * Split out of `mintCommit` so that the commit reads as what it is — refuse a
 * hole, assemble, record — and because the assembly is the one part of it that
 * touches a foreign library. `mintCommit`'s docblock carries the argument; this
 * carries the mechanics.
 *
 * THE SIZES ARE THE ONES MAIN ASKED FOR, not the ones the JPEG declares. Main
 * computed `outWidth`/`outHeight` at `mintBegin` and the renderer asserted its
 * bitmap against them, so they are the agreed dimensions of the page; asking
 * pdf-lib for the embedded image's own size instead would be a second
 * measurement of the same thing, taken from the far side of the bridge.
 */
async function assemblePdf(session: MintSession): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < session.pages.length; index++) {
    const asked = session.pages[index]!;
    const jpeg = await fsp.readFile(path.join(session.staging, `${index}.jpg`));
    const image = await pdf.embedJpg(jpeg);
    const width = (asked.outWidth * 72) / MINT_DPI;
    const height = (asked.outHeight * 72) / MINT_DPI;
    pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  return Buffer.from(await pdf.save());
}

/**
 * Take photographs out of the project — the recipe, the pixels and the bank.
 *
 * ── REMOVAL IS NOT A STRIKE, AND THE DIFFERENCE IS THE WHOLE FEATURE ────────
 *
 * A strike keeps the photograph and leaves it out of the mint: it is a decision
 * about the BOOK, and it is reversible by looking at the grid and changing your
 * mind. This is a decision about the PROJECT — Owen dragged in the wrong files
 * and wants them gone. So everything goes together: the recipe entry, its pages
 * out of `order`, the derived working copy and thumbnail, AND the original in
 * the bank. Leaving any of those behind would orphan it: a file no recipe names,
 * that nothing will ever delete, in a directory whose whole promise is that
 * everything in it is accounted for.
 *
 * ── DELETING THE BANK IS SAFE TO SAY OUT LOUD, WHICH IS WHY WE SAY IT ───────
 *
 * Everywhere else in this stage the bank is sacred — it is the irreplaceable
 * half, and the door cannot even address it. It is deletable HERE and only here
 * because it holds COPIES: the files the person dragged in still exist wherever
 * they dragged them from. The confirm dialog says exactly that, with the count,
 * before any of this runs. This function does not ask; the surface has already
 * asked, and a door that re-asked would be a second opinion about a decision
 * somebody already made.
 *
 * ── REFUSED MID-MINT ───────────────────────────────────────────────────────
 *
 * A mint holds a list of working copies it is part way through rasterizing. A
 * photograph vanishing under it would be a book quietly short a leaf, or a read
 * of a file that is no longer there — the first is invisible and the second is a
 * crash. Neither is worth allowing so that somebody can tidy up eight seconds
 * earlier.
 *
 * ── AN ID THAT NAMES NOTHING IS NOT AN ERROR ───────────────────────────────
 *
 * The surface sends ids off the grid it drew; by the time they arrive one may
 * already be gone (two windows, a repeated Delete). Deleting something already
 * deleted is SUCCESS — the world is in the state that was asked for. Refusing
 * the whole batch for one stale id would strand the other twenty-six.
 */
export async function removePhotos(
  projectDir: string,
  photoIds: readonly string[],
): Promise<CaptureRecipe> {
  const resolved = path.resolve(projectDir).toLowerCase();
  for (const session of mints.values()) {
    if (path.resolve(session.projectDir).toLowerCase() === resolved) {
      throw new CaptureError(
        'This project is being minted right now. Wait for it to finish, or stop it, before '
        + 'removing photographs — a mint that lost a page half way through would print a book '
        + 'with a leaf missing.',
      );
    }
  }

  return withRecipe(projectDir, async () => {
    const recipe = await readRecipe(projectDir);
    const going = new Set(photoIds);
    const doomed = recipe.photos.filter((photo) => going.has(photo.id));
    if (doomed.length === 0) return recipe;

    const orphanedPages = new Set(doomed.flatMap((photo) => photo.pages.map((page) => page.id)));
    // Spread for intake's reason: a removal decides which photographs are in
    // the project and nothing else, so the ticks and the book's standing crop
    // travel through it untouched rather than being dropped by omission.
    const next: CaptureRecipe = {
      ...recipe,
      photos: recipe.photos.filter((photo) => !going.has(photo.id)),
      order: recipe.order.filter((id) => !orphanedPages.has(id)),
    };

    /*
     * THE RECIPE FIRST, THEN THE FILES. If this crashes between the two, what is
     * left is a project whose recipe is correct and whose `derived/` holds a few
     * files nobody names — wasted disk, and everything on screen is still true.
     * The other order would leave the recipe naming pictures that no longer
     * exist, which is a grid of broken images and a mint that throws.
     */
    await writeAtomically(recipeFile(projectDir), Buffer.from(recipeBytes(next)));

    const derived = derivedDir(projectDir);
    const originals = originalsDir(projectDir);
    for (const photo of doomed) {
      // `force` on every one: a file already gone is the outcome we wanted, and
      // one missing thumbnail must not strand the twenty-six deletions after it.
      await fsp.rm(path.join(derived, photo.workingCopy), { force: true });
      await fsp.rm(path.join(derived, photo.thumb), { force: true });
      await fsp.rm(path.join(projectDir, CAPTURE, ...photo.file.split('/')), { force: true });
    }
    return next;
  });
}

/** Give up. Nothing is left behind and no step is appended. */
export async function mintAbort(mintId: string): Promise<void> {
  const session = mints.get(mintId);
  if (session === undefined) return; // giving up twice is giving up
  cancelHere(session.jobId);
  await forget(session, mintId);
}
