/**
 * electron/narration-stamp — KEEPING A CLEANUP'S RECEIPT TRUE WHEN A PERSON
 * CORRECTS ONE OF ITS PARAGRAPHS BY HAND.
 *
 * ── The gap this closes, as it was measured ─────────────────────────────────
 *
 * Owen's Pokemon book, 2026-09-18. `vlm-compile --narration-stamp` refused an
 * export naming three blocks, and two of them — b35-1 and b39-9 — had never been
 * edited by an op at all. The records file's last two lines were
 * `{"parts":"b39-9","text":"Nidoran","author":"user"}` and its neighbour, appended
 * on 11 September; the stamp beside them was written on 8 September. He had
 * corrected two headings the cleanup got wrong (`NíBORÁN` → `Nidoran`) through the
 * aligned view, `recordCorrection` appended the rows, `materializeTextPass` rewrote
 * the derived book from them — and nothing told the stamp. The refusal was correct
 * about the FACT and wrong about the story: the book had drifted from its receipt
 * because the app moved the book and left the receipt where it was.
 *
 * ── AND THE RULE IT IMPLEMENTS WAS ALREADY WRITTEN DOWN ─────────────────────
 *
 * `clean-text` hashes `records.rowFor(parts)?.text`, which is the newest row at
 * that position whoever wrote it, and says so in as many words (src/clean/run.ts):
 * *"A HAND-CORRECTED row is the newest row like any other and is therefore what is
 * hashed: the person's words are what the narrator gets, so the person's words are
 * what the stamp has to be a claim about."* So a correction made BEFORE the run is
 * already stamped correctly, and only a correction made AFTER it was unanswered.
 * This is not a new ruling; it is the existing one applied at the one door that
 * can change a records file once the run that stamped it has finished.
 *
 * ── THE TEXT FORM IS THE ENGINE'S, MIRRORED ON `shared/records.ts`' RULE ────
 *
 * The app never imports the engine, so `DIGEST_FORMAT` and the shape of the hash
 * are written here a second time — *"the two files change in the same commit or
 * the format has two dialects"* — and the dialect that matters is the one
 * `blockDigest` produces. If src/clean/digest.ts' text form ever moves, this moves
 * with it; the version string in the hash is what makes a failure to do so loud
 * rather than silent, because every digest on disk stops matching at once.
 *
 * THIS FILE IS MAIN'S AND NOT `shared/`'s, for the ordinary reason: `shared/` is
 * compiled into the renderer as well and holds no `node:` import, and a hash needs
 * one. Nothing in the pane has any business restamping anything.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';

import { writeAtomically } from './atomic';

/**
 * Stamped into every block digest — `DIGEST_FORMAT`, src/clean/digest.ts, and it
 * is the same string there or this whole file is a no-op that reports success.
 */
const DIGEST_FORMAT = 'clean/blocktext/v1';

/** Joined with NUL so no field's content can spell another's boundary. */
const NUL = String.fromCharCode(0);

/** One block's text, as one hex string. `blockDigest`, src/clean/digest.ts. */
export function blockDigest(text: string): string {
  return createHash('sha256').update([DIGEST_FORMAT, text].join(NUL), 'utf8').digest('hex');
}

/**
 * Every block digest as ONE order-independent digest — `textDigestOf`,
 * src/clean/digest.ts, including the sort, which is what makes it independent of
 * whatever order a `Record`'s keys happen to come back in.
 */
export function textDigestOf(blocks: Readonly<Record<string, string>>): string {
  const lines = Object.entries(blocks)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([position, digest]) => `${position}${NUL}${digest}`);
  return createHash('sha256').update([DIGEST_FORMAT, ...lines].join('\n'), 'utf8').digest('hex');
}

/**
 * Re-derive one position's digest in the stamp beside a records file, after a
 * person corrected that position's words by hand.
 *
 * ── Every way out of here is a return and none of them is a refusal ─────────
 *
 * NO STAMP FILE: a translation and a rewrite have none — this door is the whole
 * text-pass family's and only a cleanup is stamped — and so does a cleanup that
 * landed before the engine wrote stamps. `planRendering`'s own rule covers what
 * happens next: *"a missing file is an absent flag, not a refusal"*.
 *
 * A STAMP WITH NO `blocks`: the v1 shape, which says only that a pass ran. There
 * is nothing per-position to keep true, and inventing a `blocks` map holding one
 * entry would turn a stamp that claims nothing checkable into one claiming this
 * book is a single corrected heading.
 *
 * A POSITION THE STAMP DOES NOT NAME: a block the cleanup's plan never covered —
 * a formula, a picture, a blank — corrected by hand like any other. It is not
 * added: the stamp names what the cleanup produced, and a position it never
 * covered appearing in it would claim model time nobody spent.
 *
 * AND A STAMP THAT WILL NOT PARSE IS LEFT EXACTLY AS IT IS. It is somebody's
 * receipt; the honest failure is the compile refusing over a stamp this app could
 * not read, which is loud and recoverable, rather than this door quietly replacing
 * it with one built from a single correction.
 *
 * ── IT IS THE CALLER'S JOB TO SERIALISE IT ──────────────────────────────────
 *
 * This is a read-modify-write of a file two corrections a second apart both touch,
 * exactly as the records append is, so it runs inside `recordCorrection`'s own
 * per-file lock rather than taking a second one. Two locks over two files written
 * by one gesture is how the records file and its receipt come to disagree again.
 */
export async function restampCorrection(
  stampPath: string,
  parts: string,
  text: string,
): Promise<'restamped' | 'no-stamp' | 'not-claimed' | 'unreadable'> {
  let raw: string;
  try {
    raw = await fsp.readFile(stampPath, 'utf8');
  } catch {
    return 'no-stamp';
  }

  let stamp: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'unreadable';
    }
    stamp = parsed as Record<string, unknown>;
  } catch {
    return 'unreadable';
  }

  const blocks = stamp['blocks'];
  if (blocks === null || typeof blocks !== 'object' || Array.isArray(blocks)) return 'no-stamp';
  const named = blocks as Record<string, unknown>;
  if (typeof named[parts] !== 'string') return 'not-claimed';

  const digest = blockDigest(text);
  if (named[parts] === digest) return 'restamped'; // Corrected back to the cleaned words.

  const updated: Record<string, string> = {};
  for (const [position, held] of Object.entries(named)) {
    if (typeof held === 'string') updated[position] = held;
  }
  updated[parts] = digest;

  /*
   * THE WHOLE-BOOK FIELD MOVES WITH THE BLOCK, because a reader comparing two
   * files has only this one string to look at (`textDigestOf`, src/clean/digest.ts)
   * and a `textDigest` left standing over a changed `blocks` map is the one lie
   * this file could tell that nothing downstream would ever catch.
   */
  const next = { ...stamp, blocks: updated, textDigest: textDigestOf(updated) };
  await writeAtomically(stampPath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8'));
  return 'restamped';
}
