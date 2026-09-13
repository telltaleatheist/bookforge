/**
 * THE ONE RECORD OF WHAT THE GUARD DECIDED ABOUT A CHUNK.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Owen's ruling, 2026-09-13 (crucible/docs/PHASE6-REMOTE-RENDER.md): *the model
 * and its inference own the guard AND the retake decision.* narrator's retake
 * ladder reaches a verdict about every chunk it renders — `clean`, `short`,
 * `long`, `hole`, `rerolled`, `resplit`, `accepted-off-length` — and that verdict
 * is the conclusion of a decision the engine has already made. BookForge's job is
 * to RECORD it, never to re-derive it and never to re-litigate it.
 *
 * Until this file, BookForge had nowhere to record it. The only thing that
 * happened to a guard fire was `logger.log('WARN', jobId, …)` in
 * parallel-tts-bridge.ts — one line appended to `<library>/logs/audiobook-
 * YYYY-MM-DD.log`, a per-DAY, per-LIBRARY text file shared by every job that ran
 * that day. Nothing counted it, nothing attached it to the render, and
 * `job-analytics.json` — the app's actual durable per-render report — carried
 * zero guard fields (measured 2026-09-13: `TTSJobAnalytics` in
 * src/app/core/models/analytics.types.ts holds throughput and timing only).
 *
 * crucible/docs/ARCHITECTURE.md R4: **a log line is never load-bearing.** A
 * defect record that lives only in a daily text log is a defect record that
 * cannot be counted, summarised, resumed against, or shown to anyone. So the log
 * line stays — it is good human evidence and Owen reads it — and it stops being
 * the only copy.
 *
 * ── R1: one fact, one owner ─────────────────────────────────────────────────
 *
 * The fact is "what the guard decided about chunk N". Its owner is
 * `narrator/engine/higgs/truncation.py` — `GuardPlan._build_verdict`. This
 * module is a LEDGER, not a judge:
 *
 *  - It never invents a verdict word. `byVerdict` is an OPEN map keyed by
 *    whatever string narrator sent, because the ladder's vocabulary is free to
 *    grow (`hole` was discovered missing from the written list on 2026-09-13,
 *    while the Crucible half was being wired) and a reader here that knew the
 *    words would be a second owner of them.
 *  - It never reads inside `takes` or `band`. Those are the EVIDENCE, carried
 *    verbatim for analytics and for Owen's eye. A client that acts on `takes`
 *    instead of `verdict` is re-deciding something the model already decided.
 *  - It never derives a verdict from take records. It would be easy — the stdout
 *    guard-event lines are the same records, and `verdict = records[-1].action`
 *    is a one-liner — and it would put the derivation in two languages, which is
 *    exactly the shape ARCHITECTURE.md says every defect in this system turned
 *    out to be. See {@link recordGuardEvent}.
 *
 * ── UNKNOWN IS NOT CLEAN ────────────────────────────────────────────────────
 *
 * The hard rule of this file, and the reason `verdict` is `string | null` rather
 * than defaulting to `'clean'`. An older narrator pin genuinely cannot say what
 * the ladder decided; a chunk it did not say anything about is a chunk we know
 * NOTHING about, which is not the same news as "the ladder looked and found
 * nothing wrong". This is the same discipline the Crucible SDK applies to
 * `capped` — "a client that read that null as `false` would report every runaway
 * as a long sentence, silently" — applied one level up.
 *
 * A null is never softened, and the REASON for it is recorded by name
 * ({@link ChunkGuardUnknownReason}) so a summary that is 90% unknown says WHICH
 * kind of ignorance it is rather than reading like a clean book.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which path rendered the chunk, and therefore which channel the record came
 * down. Kept per-record rather than per-render because a resumed book can be
 * half local and half remote, and a summary that averaged over both without
 * saying so would hide it.
 */
export type ChunkGuardSource =
  /** narrator's `[ORPHEUS][ORPHEUS_GUARD_EVENT]` / `[HIGGS3][HIGGS_GUARD_EVENT]`
   *  lines, scraped off the worker's stdout by parallel-tts-bridge.ts. */
  | 'narrator-stdout'
  /** A Crucible `tts` job's `chunk` event, whose `guard` is narrator's own
   *  verdict object forwarded verbatim by the server. */
  | 'crucible-chunk';

/**
 * Why a chunk's verdict is `null`. Three genuinely different pieces of news, and
 * merging them would turn "we are not wired up to hear it" into "the render was
 * fine", which is the one mistake this whole file exists to prevent.
 */
export type ChunkGuardUnknownReason =
  /**
   * The server sent `guard: null` — it looked, and narrator did not say. This is
   * the honest null of an older narrator pin behind a current Crucible, and it
   * is the only one of the three that is a statement BY the server.
   */
  | 'narrator-did-not-say'
  /**
   * The record arrived down the stdout channel, which carries take records and
   * never the conclusion. `truncation.GuardPlan` reaches a verdict and then
   * WRITES A FILE — the audiobook world's driver has no wire to put it on, so
   * the only thing that reaches BookForge is the per-fire event lines. The
   * evidence is in `takes`; the conclusion is not, and this module refuses to
   * manufacture it (see the R1 note above). narrator owes the local path a
   * verdict the way it already owes it to the serve path.
   */
  | 'events-only'
  /**
   * A `chunk` event arrived with no `guard` KEY AT ALL. Per the SDK's own
   * doctrine a present-but-null key means "narrator did not say" and an ABSENT
   * key means "this server, or this client, does not speak the field" — two
   * different things, and only one of them is something the server stated.
   *
   * Measured 2026-09-13: `@crucible/client` v0.4.0 — the newest RELEASED
   * tarball, and the one package.json pins — builds its `ChunkData` in
   * `readChunk()` from a fixed field list that does not include `guard`, so the
   * field is discarded inside the SDK before BookForge can see it. The server
   * sends it; the client drops it. Unblocking this is a release of
   * `@crucible/client` containing crucible commit b232e3a and a pin bump — no
   * BookForge code change.
   */
  | 'sdk-drops-the-field';

/** What the ledger knows about one chunk. ONE shape, whichever path rendered it. */
export interface ChunkGuardRecord {
  /** The book's own chunk index — the same number that names `<index>.flac`. */
  readonly index: number;
  /**
   * The ladder's own last action, verbatim, or `null` meaning UNKNOWN. Never
   * `'clean'` by default: see the file header.
   */
  readonly verdict: string | null;
  /** Set exactly when `verdict` is null. Never both, never neither. */
  readonly unknownReason: ChunkGuardUnknownReason | null;
  /** narrator's `task.clean`, or null when unknown for the same reason. */
  readonly clean: boolean | null;
  /** How many text units the ladder finally rendered this chunk as (splits). */
  readonly parts: number | null;
  /** narrator's band at the moment it judged, VERBATIM AND UNREAD. */
  readonly band: unknown;
  /** The per-fire take records, VERBATIM AND UNREAD. Empty on a clean take 0. */
  readonly takes: readonly unknown[];
  readonly source: ChunkGuardSource;
}

/** The render-level roll-up, built for the analytics entry and for a person. */
export interface ChunkGuardSummary {
  /** How many distinct chunk indices the ledger heard anything about. */
  readonly chunks: number;
  /**
   * Verdict word → how many chunks got it. An OPEN map: the keys are whatever
   * narrator said, never a list this file knows.
   */
  readonly byVerdict: Readonly<Record<string, number>>;
  /** Chunks whose verdict is unknown. NOT folded into any verdict word. */
  readonly unknown: number;
  /** Which kind of ignorance, by name. Sums to `unknown`. */
  readonly unknownBy: Readonly<Record<string, number>>;
  /** Which channels fed this render, in first-seen order. */
  readonly sources: readonly ChunkGuardSource[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Strict readers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A malformed guard object is a REFUSAL, not a default.
 *
 * An earlier draft of PHASE6-REMOTE-RENDER.md invented plausible field names for
 * this object — `chars_per_sec`, `outcome`, a band of `{reference, short, long}`
 * — and every one of them was wrong. A reader that filled a missing field in
 * with a default would have sailed straight past that and reported a clean book.
 * So each field is required, typed, and named in the refusal.
 */
class ChunkGuardShapeError extends Error {
  constructor(where: string, detail: string) {
    super(`${where}: ${detail}. This is narrator's GuardPlan.verdict() object, `
      + 'forwarded verbatim; a field that is missing or the wrong type means the '
      + 'engine and this reader disagree about the shape, and guessing it would '
      + 'report the wrong thing about a render.');
    this.name = 'ChunkGuardShapeError';
  }
}

function readVerdictObject(guard: Record<string, unknown>, where: string): {
  verdict: string; clean: boolean; parts: number; band: unknown; takes: readonly unknown[];
} {
  const verdict = guard['verdict'];
  if (typeof verdict !== 'string' || verdict.length === 0) {
    throw new ChunkGuardShapeError(where, `"verdict" is ${JSON.stringify(verdict)}, not a word`);
  }
  const clean = guard['clean'];
  if (typeof clean !== 'boolean') {
    throw new ChunkGuardShapeError(where, `"clean" is ${JSON.stringify(clean)}, not a boolean`);
  }
  const parts = guard['parts'];
  if (typeof parts !== 'number' || !Number.isInteger(parts) || parts < 1) {
    throw new ChunkGuardShapeError(where, `"parts" is ${JSON.stringify(parts)}, not a count of 1 or more`);
  }
  const takes = guard['takes'];
  if (!Array.isArray(takes)) {
    throw new ChunkGuardShapeError(where, `"takes" is ${JSON.stringify(takes)}, not an array`);
  }
  // `band` is carried and never read, so its only requirement is that it is
  // there: an absent band would mean this is not the object we think it is.
  if (!('band' in guard)) {
    throw new ChunkGuardShapeError(where, 'there is no "band" key');
  }
  return { verdict, clean, parts, band: guard['band'], takes };
}

// ─────────────────────────────────────────────────────────────────────────────
// The ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per render, by the render's own id — `session.jobId` for a local render, and
 * the same job id for a remote one, so a resumed book that switched paths lands
 * in one ledger.
 *
 * In memory and POPPED at the end of a render ({@link takeChunkGuards}), the way
 * `GuardPlan.verdict()` pops: a book is not a small number of chunks, and the
 * records are kept only until the thing that asked for them has them.
 */
const ledgers = new Map<string, Map<number, ChunkGuardRecord>>();

function ledgerFor(renderId: string): Map<number, ChunkGuardRecord> {
  if (typeof renderId !== 'string' || renderId.length === 0) {
    throw new Error('chunk-guard-ledger: a record needs the render it belongs to; '
      + 'an empty renderId would pool every book\'s chunks into one ledger');
  }
  let ledger = ledgers.get(renderId);
  if (!ledger) {
    ledger = new Map<number, ChunkGuardRecord>();
    ledgers.set(renderId, ledger);
  }
  return ledger;
}

function requireIndex(index: unknown, where: string): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new ChunkGuardShapeError(where, `"index" is ${JSON.stringify(index)}, not a chunk index`);
  }
  return index;
}

/**
 * THE REMOTE FEED. One `chunk` event off a Crucible `tts` job.
 *
 * `guard` is narrator's verdict object, which Crucible forwards verbatim and
 * reads nothing inside. Three cases, and all three are distinct news:
 *
 *  - an object → the conclusion, recorded whole;
 *  - `null`    → the server said narrator did not say → `narrator-did-not-say`;
 *  - ABSENT    → nobody said anything about the field at all → whoever is between
 *    us and the server does not speak it → `sdk-drops-the-field`.
 *
 * The third case is not hypothetical and is not an error to throw on: the pinned
 * `@crucible/client` v0.4.0 discards `guard` inside `readChunk()`. Throwing
 * would take down a render over a diagnostic, which is the opposite of Owen's
 * 2026-09-05 ruling that the audit REPORTS and never blocks. So it is recorded,
 * by name, and a summary made entirely of it is unmistakable.
 */
export function recordCrucibleChunkGuard(
  renderId: string,
  chunk: { readonly index: number } & Record<string, unknown>,
): void {
  const where = `crucible chunk event for render ${renderId}`;
  const index = requireIndex(chunk.index, where);
  const ledger = ledgerFor(renderId);

  if (!('guard' in chunk)) {
    ledger.set(index, {
      index, verdict: null, unknownReason: 'sdk-drops-the-field',
      clean: null, parts: null, band: null, takes: [], source: 'crucible-chunk',
    });
    return;
  }
  const guard = chunk['guard'];
  if (guard === null) {
    ledger.set(index, {
      index, verdict: null, unknownReason: 'narrator-did-not-say',
      clean: null, parts: null, band: null, takes: [], source: 'crucible-chunk',
    });
    return;
  }
  if (typeof guard !== 'object' || Array.isArray(guard)) {
    throw new ChunkGuardShapeError(`${where} chunk ${index}`,
      `"guard" is ${JSON.stringify(guard)}, neither an object nor null`);
  }
  const read = readVerdictObject(guard as Record<string, unknown>, `${where} chunk ${index}`);
  ledger.set(index, {
    index, verdict: read.verdict, unknownReason: null, clean: read.clean,
    parts: read.parts, band: read.band, takes: read.takes, source: 'crucible-chunk',
  });
}

/**
 * THE LOCAL FEED. One `[…_GUARD_EVENT] {json}` line off the worker's stdout.
 *
 * **This is evidence, and it is NOT a verdict.** The line is one take record —
 * `{index, depth, side, rung, action, chars, seconds, chars_per_second, …}` —
 * emitted the moment the ladder does something, and `GuardPlan` emits several of
 * them for one chunk. The conclusion is `_build_verdict`'s, which the audiobook
 * driver reaches and then spends on writing a FLAC; it never reaches a wire.
 *
 * So the record this makes keeps every take and leaves `verdict` null with the
 * reason `events-only`. It would take one line to write `records[-1].action`
 * here and it would usually be right, and it would make BookForge a second owner
 * of a rule `truncation.py` owns (R1) — the same shape as the caps-fold keep-set
 * and the Higgs safe band, the two defects found on 2026-09-13 that were each
 * "a fact with two owners and nothing comparing them".
 *
 * The honest fix is narrator's: the local driver should carry its verdict the
 * way the serve path now does. Until it does, this says so out loud instead of
 * reporting a book as clean because nothing shouted.
 *
 * A chunk that never fires a guard produces no line at all, so a local render's
 * ledger holds only the chunks that DID something — which is why
 * {@link summarizeChunkGuards} reports `chunks`, never a percentage of the book.
 */
export function recordGuardEvent(
  renderId: string,
  event: Record<string, unknown>,
): void {
  const where = `narrator guard event for render ${renderId}`;
  // The take record's own key. Orpheus's guards.py names it `sentence_index`;
  // higgs/truncation.py names it `index`. BOTH are load-bearing and neither is
  // preferred — a record with neither is not addressed to a chunk and there is
  // nothing true to file it under.
  const raw = 'index' in event ? event['index'] : event['sentence_index'];
  const index = requireIndex(raw, where);
  const ledger = ledgerFor(renderId);
  const existing = ledger.get(index);
  // A verdict that has already arrived down a wire is the conclusion, and a take
  // record is the evidence behind it. Evidence never overwrites a conclusion.
  if (existing && existing.verdict !== null) {
    ledger.set(index, { ...existing, takes: [...existing.takes, event] });
    return;
  }
  ledger.set(index, {
    index,
    verdict: null,
    unknownReason: 'events-only',
    clean: null,
    parts: null,
    band: null,
    takes: existing ? [...existing.takes, event] : [event],
    source: 'narrator-stdout',
  });
}

/** Every record for a render, by index, in index order. Does not pop. */
export function chunkGuards(renderId: string): readonly ChunkGuardRecord[] {
  const ledger = ledgers.get(renderId);
  if (!ledger) return [];
  return [...ledger.values()].sort((a, b) => a.index - b.index);
}

/**
 * The roll-up for a render's analytics entry.
 *
 * `unknown` is its own number and is never added to a verdict word's count. A
 * caller that wants "how many chunks were fine" has to read `byVerdict['clean']`
 * and see `unknown` sitting beside it.
 */
export function summarizeChunkGuards(renderId: string): ChunkGuardSummary {
  const records = chunkGuards(renderId);
  const byVerdict: Record<string, number> = {};
  const unknownBy: Record<string, number> = {};
  const sources: ChunkGuardSource[] = [];
  let unknown = 0;
  for (const record of records) {
    if (!sources.includes(record.source)) sources.push(record.source);
    if (record.verdict === null) {
      unknown += 1;
      const reason = record.unknownReason;
      if (reason === null) {
        // Unreachable by construction — every writer above sets exactly one of
        // the pair. Stated rather than assumed, because a record with neither
        // would be counted as unknown and named nothing, which is the silent
        // shape this module exists to refuse.
        throw new Error(`chunk-guard-ledger: chunk ${record.index} of render ${renderId} `
          + 'has no verdict and no reason for not having one');
      }
      unknownBy[reason] = (unknownBy[reason] ?? 0) + 1;
      continue;
    }
    byVerdict[record.verdict] = (byVerdict[record.verdict] ?? 0) + 1;
  }
  return { chunks: records.length, byVerdict, unknown, unknownBy, sources };
}

/**
 * The summary, and the ledger is dropped.
 *
 * POPS, like `GuardPlan.verdict()`. A render that ends without anyone asking
 * would otherwise keep a 1,400-entry map — with every take record in it — alive
 * for the life of the process.
 */
export function takeChunkGuards(renderId: string): ChunkGuardSummary {
  const summary = summarizeChunkGuards(renderId);
  ledgers.delete(renderId);
  return summary;
}

/** Drop a render's records without reading them (a cancel, a failed start). */
export function forgetChunkGuards(renderId: string): void {
  ledgers.delete(renderId);
}
