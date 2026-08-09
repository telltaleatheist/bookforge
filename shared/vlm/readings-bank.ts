/**
 * readings-bank — what is already banked for a book, and what the user said to
 * do about it.
 *
 * `foundry vlm-convert --readings <file>` writes every page's answer as it lands
 * and re-reads only what is missing. That is a RESUME, it is worth hours, and it
 * is why a conversion killed at page 280 is an inconvenience rather than a
 * disaster. It is also, until this module existed, the reason a conversion that
 * had ALREADY FINISHED could be ordered again and quietly answer itself out of
 * the bank: the same code path served "finish what you started" and "do it
 * again", and only the first of those was ever asked for.
 *
 * Owen, 2026-08-09: "i told it to run the VLM by scheduling the job in the queue,
 * and instead of doing what i told it to do, it used an unexpected codepath to
 * completely ignore my order and do something different. fallbacks are bugs."
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * The discriminator is COMPLETION, and it is never guessed at: it is asked, once,
 * at the moment the user commits to the conversion. Adding a book to the queue
 * with a bank present puts up a dialog naming what is banked and whether the run
 * that banked it finished, and the answer is RECORDED ON THE JOB. From then on
 * nothing re-decides — pressing Start on a queued row honours what the row was
 * enqueued expecting, a retry inherits the same answer, and the run says which in
 * one line of the job log.
 *
 * Owen, on the timing: "if its already in the queue and i hit start, it means it
 * was expecting the cache to be there and should rely on it. if i add it to the
 * queue and theres a cache present, it should ask if i want to use the cached
 * path or overwrite it/delete it before starting."
 *
 * ── Nothing is deleted ──────────────────────────────────────────────────────
 *
 * "Read all pages fresh" ARCHIVES: foundry rotates the bank into
 * `archived-<timestamp>/` beside it and reads the book again. A page costs
 * GPU-minutes and a book costs hours, so the answers stay on disk where a person
 * can find them. What the user gets is the live bank gone, which is the whole of
 * what "clear the cache" has to mean for the trap to be gone.
 *
 * This module is PURE — main measures the bank, the renderer shows the dialog,
 * and both read the same sentences from here so they cannot describe the same
 * bank differently.
 */

/**
 * The foundry that understands `--fresh-readings` / `--reuse-readings` and
 * writes the completion marker they key off.
 *
 * BookForge adopts the newest foundry release at launch, so an older binary is a
 * real state — and a run that quietly dropped these flags against one would be
 * the exact bug this module exists to close, with the user's order ignored and a
 * cache replayed. So it is a REFUSAL naming the version, never a silent
 * omission. Bumped in lockstep with foundry's package.json.
 */
export const FOUNDRY_VERSION_FOR_READINGS_FLAGS = '0.9.0';

/**
 * What is banked for one PDF, as main found it on disk, plus what BookForge's
 * own records say about it.
 *
 * Two independent witnesses to "this conversion already completed", because
 * neither one covers every book:
 *
 *  - `completedAt` is foundry's own `completed.json`, written beside the
 *    readings the moment an EPUB lands. Authoritative, and absent from every
 *    bank written before foundry had markers.
 *  - `recordedConversionAt` is BookForge's provenance — the `vlm-convert` pass
 *    on `manifest.outputs.epub`, matched on the PDF's sha256. It is the ONLY
 *    evidence a legacy bank leaves, and it is why the app passes an explicit
 *    flag rather than trusting foundry to work it out alone.
 */
export interface VlmReadingsBank {
  /** Absolute path to `readings.jsonl` — named in the dialog and the job log. */
  path: string;
  /** Distinct pages with an answer banked. 0 means there is no bank at all. */
  pages: number;
  /** When foundry's own marker says the conversion finished, or null. */
  completedAt: string | null;
  /** When BookForge's provenance says a conversion from this PDF finished, or null. */
  recordedConversionAt: string | null;
  /**
   * Pages in the book, where anything recorded it — foundry's marker or the
   * previous conversion's provenance. NULL when nothing did, and the sentences
   * below then say "N pages banked" rather than inventing a denominator.
   */
  totalPages: number | null;
}

/**
 * What the user chose, recorded on the job. There is no third value and no
 * absent-means-something: a job with no choice on it is a job enqueued before
 * this existed, and {@link readingsChoiceOfJob} says what that means.
 */
export type VlmReadingsChoice =
  /** Archive the bank and read every page from the model again. */
  | 'fresh'
  /** Answer out of the bank — resume an interrupted run, or replay a finished one. */
  | 'reuse';

/** Did a conversion over these readings already finish? Either witness will do. */
export function bankIsFromCompletedRun(bank: VlmReadingsBank): boolean {
  return bank.completedAt !== null || bank.recordedConversionAt !== null;
}

/**
 * Which button the dialog opens on.
 *
 * FRESH after a conversion that completed, because ordering a conversion that
 * finished is ordering the work. REUSE after an interruption, because that bank
 * is a debt already paid and re-paying it is hours of GPU for nothing. Neither
 * is applied without asking — this is where the cursor sits, not what happens.
 */
export function defaultReadingsChoice(bank: VlmReadingsBank): VlmReadingsChoice {
  return bankIsFromCompletedRun(bank) ? 'fresh' : 'reuse';
}

/** `47 of 317 pages` — or `47 pages` where nothing ever recorded a total. */
function pageCount(bank: VlmReadingsBank): string {
  return bank.totalPages === null
    ? `${bank.pages} page(s)`
    : `${bank.pages} of ${bank.totalPages} page(s)`;
}

/**
 * The dialog's message: the facts, and nothing about what will be done with them.
 *
 * It names WHICH run banked these — finished or interrupted — because that is the
 * whole basis of the choice underneath, and a dialog that offered two buttons
 * without saying why one is highlighted is a dialog people click through.
 */
export function describeReadingsBank(bank: VlmReadingsBank): string {
  if (bankIsFromCompletedRun(bank)) {
    const at = bank.completedAt ?? bank.recordedConversionAt;
    return (
      `A conversion of this book already finished on ${at}, and the ${pageCount(bank)} it read are `
      + 'still banked on this machine.'
    );
  }
  return (
    `An earlier conversion of this book was interrupted. ${pageCount(bank)} it had already read are `
    + 'banked on this machine.'
  );
}

/**
 * The detail under it: what each button costs, in the terms that decide it.
 *
 * Both are said plainly because the trade is real in both directions — a fresh
 * read is hours of GPU, and a reuse of a finished run does no work at all, which
 * is exactly the surprise this dialog exists to stop being a surprise.
 */
export function describeReadingsChoices(bank: VlmReadingsBank): string {
  return [
    'Read all pages fresh — the vision model reads the whole book again. The banked answers are '
    + 'moved into a timestamped folder beside them, never deleted.',
    bankIsFromCompletedRun(bank)
      ? 'Use the banked readings — the book is rebuilt from the answers already on disk. No page '
        + 'is read and no GPU is used.'
      : 'Use the banked readings — the conversion picks up where it stopped and reads only the '
        + 'pages that are missing.',
  ].join('\n\n');
}

/**
 * The dialog's two buttons and what each of them means.
 *
 * The DEFAULT is always the primary button, so the highlighted action and the
 * one Enter takes are the same thing — after a completed conversion that is
 * "read it again", and after an interruption it is "carry on". The other choice
 * sits beside it as an equal, not buried: reusing a finished run's answers is a
 * legitimate thing to want (rebuild the book with a newer assembler for free),
 * and reading a book again after an interruption is too.
 */
export function readingsChoiceButtons(bank: VlmReadingsBank): {
  /** The primary button — the default for this bank's state. */
  primaryLabel: string;
  primaryChoice: VlmReadingsChoice;
  /** The other choice, beside it. */
  alternateLabel: string;
  alternateChoice: VlmReadingsChoice;
} {
  const freshLabel = 'Read all pages fresh';
  const reuseLabel = bankIsFromCompletedRun(bank)
    ? 'Use the banked readings'
    : 'Resume from the banked readings';
  return defaultReadingsChoice(bank) === 'fresh'
    ? {
      primaryLabel: freshLabel, primaryChoice: 'fresh',
      alternateLabel: reuseLabel, alternateChoice: 'reuse',
    }
    : {
      primaryLabel: reuseLabel, primaryChoice: 'reuse',
      alternateLabel: freshLabel, alternateChoice: 'fresh',
    };
}

/**
 * What a job's recorded choice means at the moment it runs.
 *
 * A job with NO recorded choice was enqueued before this existed, and the rule
 * for it is the user's own: "if its already in the queue and i hit start, it
 * means it was expecting the cache to be there and should rely on it." So it
 * REUSES — it does not get the fresh-on-completed default, because that default
 * belongs to a question this job was never asked. The log says so.
 */
export function readingsChoiceOfJob(recorded: VlmReadingsChoice | undefined): VlmReadingsChoice {
  return recorded === undefined ? 'reuse' : recorded;
}

/**
 * `foundry vlm-convert`'s readings flags for a choice, given what is on disk now.
 *
 * With NO bank there is nothing to act on and no flag is passed: foundry reads
 * the book, which is both choices' answer to an empty run directory, and
 * `--reuse-readings` against an empty bank is a refusal by design (foundry
 * src/vlm/readings.ts) rather than something to send it into.
 *
 * With a bank, the flag is ALWAYS explicit — never left to foundry's marker.
 * BookForge knows things the marker does not: a bank from before markers existed
 * carries none, and the app's own provenance is the only record that the
 * conversion finished. One contract, decided here, obeyed there.
 */
export function vlmReadingsArgs(choice: VlmReadingsChoice, bankedPages: number): string[] {
  if (bankedPages === 0) return [];
  return choice === 'fresh' ? ['--fresh-readings'] : ['--reuse-readings'];
}

/**
 * The ONE line the job log gets about this decision, before a page is read.
 *
 * Every path through the rule prints one of these, including the paths where
 * nothing happens — "there was no bank" and "the bank was used" are different
 * facts and the log that omits the second is the log this bug hid in.
 */
export function describeReadingsDecision(
  choice: VlmReadingsChoice,
  bank: VlmReadingsBank,
  /** True when the job carried no recorded choice: enqueued before the question existed. */
  fromLegacyJob: boolean,
): string {
  if (bank.pages === 0) {
    return `No page answers are banked at ${bank.path}, so every page is read by the vision model.`;
  }
  if (fromLegacyJob) {
    return (
      `Using the ${bank.pages} banked page answer(s) at ${bank.path}: this job was added to the `
      + 'queue before BookForge asked about banked readings, so it is run expecting them.'
    );
  }
  if (choice === 'fresh') {
    return (
      `Reading all pages fresh, as chosen when this job was added to the queue: the ${bank.pages} `
      + `banked page answer(s) at ${bank.path} are archived beside it and the vision model reads `
      + 'the whole book again.'
    );
  }
  return (
    `Using the ${bank.pages} banked page answer(s) at ${bank.path}, as chosen when this job was `
    + `added to the queue${bankIsFromCompletedRun(bank) ? ' — the book is rebuilt from them and no page is read' : ''}.`
  );
}

/**
 * The refusal for a foundry too old to be told any of this.
 *
 * Named rather than worked around: dropping the flag would let the binary fall
 * back on its own resume behaviour, which for a completed conversion is the
 * silent cache replay this whole change exists to end.
 */
export function foundryTooOldForReadingsFlags(installed: string, flag: string): string {
  return (
    `This book has banked page readings and BookForge needs to tell foundry what to do with them `
    + `(${flag}), but the installed foundry is ${installed} and that flag arrived in `
    + `${FOUNDRY_VERSION_FOR_READINGS_FLAGS}. Update foundry in Settings → Add-ons and run this `
    + 'again. Nothing was converted — running without the flag would let foundry decide on its own, '
    + 'which is how a conversion you ordered turns into a replay of one you already had.'
  );
}

/**
 * Is `installed` at least `required`? Numeric dot-separated compare, and a
 * version that is not that shape is NOT quietly treated as new enough.
 */
export function foundryVersionAtLeast(installed: string, required: string): boolean {
  const parts = (raw: string): number[] | null => {
    const bits = raw.trim().split('.');
    const numbers = bits.map((bit) => Number(/^\d+/.exec(bit)?.[0]));
    return numbers.some((n) => !Number.isFinite(n)) ? null : numbers;
  };
  const a = parts(installed);
  const b = parts(required);
  if (a === null || b === null) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}
