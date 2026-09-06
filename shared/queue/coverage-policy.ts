/**
 * WHICH ENGINES ARE AUDITED BY POST-RENDER FORCED ALIGNMENT — one table.
 *
 * ── What the audit is ─────────────────────────────────────────────
 *
 * `narrator align` force-aligns every rendered chunk against the text it was
 * given and writes `coverage.json`. `python/narrator/assemble/coverage_gate.py`
 * reads that report at assembly and LOGS what it found — every chunk whose audio
 * did not say its text, the words it dropped, and the retake command that fixes
 * them — and then assembles the book.
 *
 * ── It used to be a GATE, and Owen ruled it out (2026-09-05) ──────────────
 *
 *     there will always be truncations or errors of some sort. thats the nature
 *     of tts. nothing is going to come out perfect. we try our best to detect
 *     and reduce the number of errors but assembly will never function, ever, if
 *     we expect it to come out the other side flawless. we need to base assembly
 *     on the expected text and the actual real length of the audio.
 *
 * So `coverageAuditedFor` no longer answers "will assembly refuse this book
 * without a report" — nothing refuses it. It answers "does a run of this engine
 * carry an Align row", which is the question BookForge actually has to act on: a
 * v3 book is measured as a matter of course, an Orpheus book is measured when
 * somebody asks.
 *
 * ── Why the table is HERE ────────────────────────────────────────
 *
 * Three programs need the same answer and none of them can ask the others:
 *
 *   - the run description (`narration-run.ts`) decides whether a run carries an
 *     Align step at all — it is `shared/`, compiled into main AND the renderer,
 *     and it can import nothing from `electron/`;
 *   - the narration dialog refuses a run whose aligner is not installed;
 *   - `main.ts` answers the same question for the renderer.
 *
 * A hard-coded `=== 'higgs-v3'` in each of those is three answers to one
 * question, and they drift the day a third engine lands. This is the one answer,
 * and it is a MIRROR of `assemble/engine_profiles.py` — the Python side owns the
 * thresholds; this owns only the yes/no that BookForge has to act on, kept honest
 * by `tools/test-coverage-policy-mirror.js`, which reads the Python table and
 * asserts the two agree.
 *
 * THE ASSEMBLY SPAWNS NO LONGER ASK. They pass `--coverage_report` whenever the
 * report FILE EXISTS, whatever the engine: a report that was written should be
 * read out, and one that was not is no longer a reason to withhold a flag.
 *
 * ── Both spellings of an engine id, on purpose ────────────────────────
 *
 * BookForge says `higgs` (a picker entry) and narrator says `higgs-v3` (a model
 * generation) — `narrator-spawn.ts:narratorEngineId` owns that mapping, and this
 * file cannot import it (that file is `electron/`). So this accepts either
 * spelling and normalises, exactly as `reassembly-bridge.ts:narratorEngineForSession`
 * already has to. It is not a second mapping table: nothing here turns one
 * spelling into the other, it only recognises both as naming the same engine.
 */

/**
 * The engines this build knows a coverage policy for, keyed by NARRATOR's
 * spelling — the same keys as `engine_profiles.PROFILES`, and the same value as
 * each policy's `audited`.
 *
 * `orpheus` is false and that is a measured decision, not an omission: Orpheus
 * keeps its own chars/sec guard and its resplit ladder, so an alignment there is
 * something an operator asks for rather than CPU every book pays for.
 *
 * `higgs-v3` is true because it has no duration guard worth the name — a chunk
 * measured a duration ratio of 0.99 while dropping 22 % of its text — so a v3
 * book nobody aligned is a book nobody checked, and the operator should at least
 * be TOLD which chunks to look at.
 */
const COVERAGE_AUDITED: Readonly<Record<string, boolean>> = {
  orpheus: false,
  'higgs-v3': true,
};

/**
 * Every alias that names one of those engines, in either program's spelling.
 *
 * `higgs` is BookForge's picker id and is an ENGINE_NEAR_MISS to narrator, which
 * refuses it by name on the routes that resolve an engine. It is listed here
 * because THIS question is not "which model do I load" — it is "does this run
 * need a coverage report", and both spellings mean the same run.
 */
const ENGINE_ALIASES: Readonly<Record<string, string>> = {
  orpheus: 'orpheus',
  higgs: 'higgs-v3',
  'higgs-v3': 'higgs-v3',
};

/**
 * Is this engine's book force-aligned after every render?
 *
 * NO FALLBACK, for `profile_for`'s reason: answering `false` for an id we do not
 * recognise ships an audiobook that nobody checked under an audit that was
 * supposed to check it, and answering `true` spends CPU aligning an engine that
 * has no policy at all. Neither is a thing to decide silently on the strength of
 * a string.
 *
 * XTTS reaches here from a session-state.json written by a retired build and is
 * refused with the rest: it cannot render and cannot be assembled by narrator
 * either, so a coverage answer for it would be an answer to a question that
 * cannot be asked.
 */
export function coverageAuditedFor(engineId: string): boolean {
  const id = ENGINE_ALIASES[engineId.trim().toLowerCase()];
  if (id === undefined) {
    throw new Error(
      `No coverage policy is declared for TTS engine '${engineId}', so BookForge cannot say `
      + 'whether a book it rendered is force-aligned after the render. Known: '
      + `${Object.keys(ENGINE_ALIASES).sort().join(', ')}.`,
    );
  }
  return COVERAGE_AUDITED[id]!;
}

/**
 * What `narrator align --report` writes when nothing names a file, and what
 * assembly looks for beside a session — `coverage_gate.DEFAULT_REPORT_NAME`.
 *
 * Named here rather than spelled in each of the four places that build the path,
 * because the align step and the two assembly spawns have to name the SAME file
 * and a typo in any one of them reads as "align never ran".
 */
export const COVERAGE_REPORT_NAME = 'coverage.json';

/**
 * The refusal a run gets when its engine is audited and the aligner is not on
 * this machine.
 *
 * A SENTENCE RATHER THAN A SKIP. The alternative — queue the run and let the
 * Align step fail hours later — spends the GPU first and says so afterwards,
 * which is the shape this whole description exists to prevent ("everything that
 * can fail, fails before anything is queued").
 *
 * IT IS NOT "THE BOOK WOULD BE REFUSED" ANY MORE. Assembly assembles whatever
 * was rendered (Owen, 2026-09-05). What a missing aligner costs is the
 * MEASUREMENT — nothing would say which chunks came out wrong, and the sentence
 * transcript would be proportional estimates instead of real word timings — and
 * that is what this sentence has to say, because a user who reads a threat that
 * never happens stops reading the ones that do.
 */
export function alignerMissingRefusal(engineId: string): string {
  return (
    `${engineId} books are checked after the render: every rendered chunk is force-aligned `
    + 'against its own text, so the queue can tell you which ones came out wrong. The aligner '
    + 'is the "Ebook Alignment (WhisperX)" add-on and it is not installed on this machine, so '
    + 'this run would render for hours and nothing would check it. Install it from '
    + 'Settings → Add-ons and queue the run again.'
  );
}
