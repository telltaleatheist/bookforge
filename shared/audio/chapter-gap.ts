/**
 * THE SILENCE BETWEEN CHAPTERS — one number, stated once.
 *
 * A finished audiobook joins its chapters butt-to-butt: the last word of one
 * chapter and the first word of the next are separated by whatever trailing
 * silence the last sentence happened to carry, which is under a second. Owen,
 * 2026-09-09: *"can we artificially insert 3 seconds of silence at the end of
 * every chapter so its easier to tell when it moves from one to the next"*.
 *
 * WHERE IT IS REALIZED: narrator's assembler, `--chapter_gap` (see
 * `python/narrator/assemble/run.py`). Not the render, and not a pass over the
 * cached sentences — the gap is a property of the BOOK, not of any sentence, and
 * assembly is the one place where a chapter BookForge pre-encoded during the
 * render and a chapter the assembler encodes itself get the same treatment.
 * It reaches the chapter markers and BOTH transcripts from there, so the
 * subtitle track sealed into the m4b stays on the audio.
 *
 * NEVER AFTER THE LAST CHAPTER. The end of the book is not a boundary between
 * anything.
 *
 * WHY THE DEFAULT LIVES HERE AND NOT IN NARRATOR. narrator's own default is 0.0
 * — it is a general assembler and a CLI run that did not ask for a gap must not
 * get one. 3 seconds is BOOKFORGE'S choice, and every door that assembles a book
 * (the reassembly job, the inline assembly at the end of a TTS run, the
 * Correct Sentences re-assembly) reads it from here so a book cannot come out
 * differently depending on which door built it.
 */

/** Seconds of silence BookForge leaves between chapters when nothing says otherwise. */
export const DEFAULT_CHAPTER_GAP = 3.0;

/**
 * The largest gap the UI offers. Not a limit narrator enforces — it will realize
 * any non-negative number — but a slider that runs to a minute is a slider
 * nobody can set to three seconds.
 */
export const MAX_CHAPTER_GAP = 10.0;

/**
 * The value to hand `--chapter_gap` for a run, from whatever the caller stated.
 *
 * `undefined` means "the caller did not choose", which is the default and NOT
 * zero: a config written before this existed, or a door that never grew a
 * control, still gets the gap. An explicit 0 is a real answer — somebody who
 * wants the old butt-joined book — and is honoured.
 *
 * Anything that is not a finite number at or above zero is REFUSED BY NAME
 * rather than quietly defaulted: it means a caller computed a gap and got it
 * wrong, and silently substituting 3 would hide that until somebody listened to
 * the book.
 */
export function resolveChapterGap(stated: number | undefined): number {
  if (stated === undefined) return DEFAULT_CHAPTER_GAP;
  if (!Number.isFinite(stated) || stated < 0) {
    throw new Error(
      `chapterGap must be a number of seconds at or above zero, got ${stated}`,
    );
  }
  return stated;
}
