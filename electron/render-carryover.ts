/**
 * CAN THIS RUN KEEP THE SENTENCES THE LAST ONE RENDERED?
 *
 * ── The finding (Owen, 2026-09-20) ────────────────────────────────────────
 *
 * *"the continue button on rendered sentences is supposed to continue the
 * render where it left off. finish the unrendered sentences, keeping the ones
 * that are done. it doesnt do that right now. it starts over."*
 *
 * He was right, and the cause was a seam rather than the resume itself. The
 * resume road exists and works: `findResumableProjectSession` finds the
 * project's partial cache, `checkResumeStatusFromProcessDir` says which chunk
 * indices it still owes, and the render skips every index whose FLAC is already
 * on disk. What broke it was the `prepare` row (2026-09-19): every narration now
 * has one, `tts-conversion`'s cached-session resume is gated on
 * `prepared === undefined` — correctly, because the chunks a render is about are
 * the ones its own parent packed — and so the road was never taken again. The
 * prepare row packed a brand-new, empty session and the book was read from the
 * beginning.
 *
 * So the carry-over belongs to PREP, which is where this module is asked. Prep
 * packs the book as it always did, and then — unless the user chose "Start over"
 * — seeds the fresh session with the chunks the project's cache already holds.
 * Everything downstream is then an ordinary render that happens to owe fewer
 * chunks: the Crucible submit skips what is on disk, the progress bar counts
 * from the carried baseline, and the publish merges back into the same cache.
 *
 * ── The rule: IDENTICAL PACK, IDENTICAL VOICE, OR NOTHING ──────────────────
 *
 * A rendered chunk is audio filed under an INDEX. Carrying it into a run whose
 * chunk #412 is different text would put the wrong words at the wrong minute of
 * the book and nothing downstream could ever notice. So the two sides are
 * compared on what they are: the chunk texts, in order, and the engine and voice
 * that read them. Both sides are read from the SAME file — narrator's
 * `session-state.json`, written by prep for every session there has ever been —
 * so this compares a pack against a pack and not a pack against somebody's
 * memory of the settings.
 *
 * A mismatch is not an error and not a silence: it is a SENTENCE, reported on
 * the prepare row and written to the log, naming which of the four things
 * changed. Starting over was always what happened; what was missing was anyone
 * saying so.
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as path from 'node:path';

import { COPY_CONCURRENCY, retryWeather, runBounded } from './bounded-copy';
import { findCachedSessionLayout } from './session-cache-layout';

/**
 * WHEN A CHUNK COUNTS AS RENDERED — narrator's `RESUME_MIN_BYTES`, said once.
 *
 * A `{i}.flac` smaller than this is a truncated write (a killed worker, a full
 * disk) and narrator's own resume re-renders it; every reader on this side has
 * to agree with that, or the seed, the count and the submit would disagree
 * about what a session still owes.
 */
export const RESUME_MIN_BYTES = 1024;

/**
 * What a session says about the pack it holds.
 *
 * Read from `session-state.json`, whose field names are narrator's and are
 * therefore snake_case; this is the one place they are spelled.
 */
export interface SessionPackFacts {
  /** `total_sentences` — the CHUNK count (the field's name predates the packer). */
  readonly totalChunks: number;
  /** `chapter_sentences`, flattened exactly as the render flattens it. */
  readonly chunkTexts: readonly string[];
  /** `tts_engine`, e.g. `higgs-v3`. */
  readonly engine: string;
  /** `higgs_voice` when the engine states one, else `fine_tuned`. */
  readonly voice: string;
  /** `language_iso1` when present, else `language`. */
  readonly language: string;
}

/** Where the numbers in a sentence come from, so a reader can count them. */
function count(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Read a session's pack facts off its `session-state.json`.
 *
 * Throws, naming the file: a session whose state cannot be read is not a
 * session, and the two callers each have their own thing to say about that.
 */
export async function readSessionPackFacts(processDir: string): Promise<SessionPackFacts> {
  const statePath = path.join(processDir, 'session-state.json');
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(await fs.readFile(statePath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${statePath} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const chapterChunks = state['chapter_sentences'];
  if (!Array.isArray(chapterChunks)) {
    throw new Error(`${statePath} has no chapter_sentences, so it states no chunks.`);
  }
  const chunkTexts = (chapterChunks as unknown[]).flat() as string[];
  const totalChunks = typeof state['total_sentences'] === 'number'
    ? state['total_sentences'] as number
    : chunkTexts.length;
  const voice = typeof state['higgs_voice'] === 'string' && state['higgs_voice'] !== ''
    ? state['higgs_voice'] as string
    : String(state['fine_tuned'] ?? '');
  const language = typeof state['language_iso1'] === 'string' && state['language_iso1'] !== ''
    ? state['language_iso1'] as string
    : String(state['language'] ?? '');
  return {
    totalChunks,
    chunkTexts,
    engine: String(state['tts_engine'] ?? ''),
    voice,
    language,
  };
}

/**
 * WHY THE CACHED SENTENCES CANNOT BE CARRIED, or `null` when they can.
 *
 * Pure. `cached` is the render that already exists; `fresh` is the pack this run
 * just made. The order of the checks is the order a person would want them: the
 * voice first (it makes a two-voice book, which is the worst outcome), then the
 * language, then the shape of the pack, then the text itself.
 */
export function carryOverRefusal(
  cached: SessionPackFacts,
  fresh: SessionPackFacts,
): string | null {
  if (cached.engine !== fresh.engine || cached.voice !== fresh.voice) {
    return `the sentences already rendered for this book were read by ${
      cached.engine || 'an unnamed engine'}/${cached.voice || 'an unnamed voice'} and this run reads it in ${
      fresh.engine || 'an unnamed engine'}/${fresh.voice || 'an unnamed voice'}, so keeping them would finish the book in two voices`;
  }
  if (cached.language !== fresh.language) {
    return `the sentences already rendered for this book are in ${
      cached.language || 'an unnamed language'} and this run reads it in ${fresh.language || 'an unnamed language'}`;
  }
  if (cached.totalChunks !== fresh.totalChunks
    || cached.chunkTexts.length !== fresh.chunkTexts.length) {
    return `this run packs the book into ${count(fresh.totalChunks)} chunks and the sentences already `
      + `rendered for it were packed into ${count(cached.totalChunks)}, so their numbering no longer `
      + 'names the same words';
  }
  for (let i = 0; i < fresh.chunkTexts.length; i++) {
    if (cached.chunkTexts[i] !== fresh.chunkTexts[i]) {
      return `the book's text has changed since those sentences were rendered — chunk ${
        count(i)} of ${count(fresh.totalChunks)} is not the same words`;
    }
  }
  return null;
}

/**
 * COPY THE RENDERED CHUNKS OF ONE SESSION INTO ANOTHER'S SENTENCES DIR.
 *
 * `{i}.flac` for `i < total`, larger than {@link RESUME_MIN_BYTES}, and only
 * where the destination has none — so it is safe to run over a session that is
 * already partly rendered, and it never overwrites this run's own work.
 * Returns how many arrived.
 *
 * Clone-on-write where the filesystem supports it (APFS/ReFS), falling back to
 * a real copy automatically anywhere else — and since 2026-09-21 the fall-back
 * is the ordinary road: the scratch is machine-local and the cache is on the
 * shared library, so this seed is a real download of what has already been
 * rendered. That is the trade taken deliberately (`narrator-paths.ts` header):
 * the chunks travel ONCE, before the render, instead of every new chunk landing
 * on the share as it is made.
 *
 * COPYING, NOT POINTING, is the choice worth stating: the render then runs in
 * its OWN session — its ids, its band, its `packedFor`, the ones it is checked
 * against — and the publish that follows merges back into the cache by the
 * union rule, exactly as a first render's does.
 */
export async function seedRenderedChunks(
  fromDir: string,
  toDir: string,
  total: number,
): Promise<number> {
  let entries: string[];
  try { entries = await fs.readdir(fromDir); } catch { return 0; }
  await fs.mkdir(toDir, { recursive: true });
  const wanted = entries.filter((name) => {
    const m = /^(\d+)\.flac$/.exec(name);
    return m !== null && parseInt(m[1]!, 10) < total;   // a chunk file, in range
  });
  // BOUNDED, because this is a download now: four at a time, each waiting out
  // weather on the share. See `bounded-copy.ts` for both numbers.
  const placed = await runBounded<string, number>(wanted, COPY_CONCURRENCY, async (name) => {
    const src = path.join(fromDir, name);
    const dst = path.join(toDir, name);
    try {
      if ((await fs.stat(src)).size <= RESUME_MIN_BYTES) return 0;  // truncated — re-render it
      try { await fs.access(dst); return 0; } catch { /* absent — copy it */ }
      await retryWeather(() => fs.copyFile(src, dst, fsConstants.COPYFILE_FICLONE));
      return 1;
    } catch { return 0; /* skip unreadable */ }
  });
  return placed.reduce((a, b) => a + b, 0);
}

/**
 * HOW MANY OF A SESSION'S CHUNKS ALREADY HAVE AUDIO.
 *
 * The same question the submit asks per index, asked once for the whole
 * session, so a run can say at the start how much of the book it is not going
 * to read. Files only — a count carried in a config would be a second opinion
 * about a directory both of them can see, and the file is the one that decides.
 */
export async function countRenderedChunks(
  sentencesDir: string,
  total: number,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(sentencesDir);
  } catch {
    return 0;   // not created yet — nothing is rendered
  }
  let n = 0;
  for (const name of entries) {
    const m = /^(\d+)\.flac$/.exec(name);
    if (!m || parseInt(m[1], 10) >= total) continue;
    try {
      if ((await fs.stat(path.join(sentencesDir, name))).size > RESUME_MIN_BYTES) n++;
    } catch { /* vanished between readdir and stat — not rendered */ }
  }
  return n;
}

/** What a carry-over did, and — either way — why. One sentence, always. */
export interface RenderCarryOver {
  readonly carried: number;
  readonly line: string;
}

/**
 * THE ACT: carry a part-finished render into the session prep just packed.
 *
 * The caller has already found the project's part-finished render (the prepare
 * row asks `findResumableProjectSession`, which is also what the narration
 * dialog counts on its Continue row, so the offer and the act cannot disagree).
 * What happens here is the comparison and the copy.
 *
 * NEVER THROWS. A cache that cannot be read is a sentence, exactly as a cache
 * that does not match is; the book is then read from the beginning, which is
 * what always happened — the difference is that somebody says so.
 */
export async function carryOverIntoSession(where: {
  /** The `ebook-<uuid>` of the project's part-finished render. */
  readonly cachedSessionDir: string;
  /** The freshly packed session: the dir holding its `session-state.json`. */
  readonly freshProcessDir: string;
  /** The freshly packed session's `chapters/sentences`. */
  readonly freshSentencesDir: string;
  /** How many chunks this run packs the book into. */
  readonly totalChunks: number;
}): Promise<RenderCarryOver> {
  const layout = await findCachedSessionLayout(where.cachedSessionDir).catch(() => null);
  if (!layout) {
    return {
      carried: 0,
      line: `the part-finished render at ${where.cachedSessionDir} has no chapters/sentences under `
        + 'it, so there is nothing in it to carry',
    };
  }

  let refusal: string | null;
  try {
    const cached = await readSessionPackFacts(layout.processDir);
    const fresh = await readSessionPackFacts(where.freshProcessDir);
    refusal = carryOverRefusal(cached, fresh);
  } catch (err) {
    return {
      carried: 0,
      line: "the part-finished render could not be compared with this run's pack, so none of it "
        + `is carried: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (refusal !== null) {
    return { carried: 0, line: `${refusal}, so the book is read from the beginning` };
  }

  const carried = await seedRenderedChunks(
    layout.sentencesDir, where.freshSentencesDir, where.totalChunks);
  if (carried === 0) {
    return {
      carried: 0,
      line: `the part-finished render at ${layout.sentencesDir} holds no chunk this run can use`,
    };
  }
  return {
    carried,
    line: `${count(carried)} of ${count(where.totalChunks)} chunks were already rendered and are `
      + 'kept; only the rest will be read',
  };
}
