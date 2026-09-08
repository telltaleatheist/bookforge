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
 * without a report" — nothing refuses it.
 *
 * ── AND IT NO LONGER DECIDES WHETHER A RUN ALIGNS (2026-09-07) ────────────
 *
 * Owen: *"is it going to generate a VTT for it as well? that should be part of
 * the assembly process, and should automatically happen... put a pre-checked
 * checkbox in the assembly modal that creates the alignment step and the
 * assembly step."* So the align is a stage of the RUN now
 * (`NarrationRunStages.align`), ticked by default on every assembly whatever the
 * engine — the aligner is whisperx CTC over the book's own text and is
 * engine-agnostic; the gate here was ever only about Higgs's missing duration
 * guard, not about what the aligner can measure.
 *
 * What this table still says is what narrator says: which engines' books are
 * AUDITED as a matter of policy. That is the `audited` field narrator stamps
 * into every coverage report (`align/run.py`, `coverage_gate.py`), which is what
 * makes a report readable as "this engine is checked every time" versus "somebody
 * asked for this one". BookForge no longer gates anything on it, and the mirror
 * below is what keeps its knowledge of narrator's profiles from going stale.
 *
 * ── Why the table is HERE ────────────────────────────────────────
 *
 * It is `shared/` — compiled into main AND the renderer, importing nothing from
 * `electron/` and touching no disk — and it is a MIRROR of
 * `assemble/engine_profiles.py`: the Python side owns the thresholds and the
 * policy; this owns only the yes/no, kept honest by
 * `tools/test-coverage-policy-mirror.js`, which reads the Python table and
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
 * Does NARRATOR consider this engine's books audited as a matter of policy?
 *
 * NOT "does this run align" any more — the run says that for itself
 * (`NarrationRunStages.align`, ticked by default on every assembly since
 * 2026-09-07). This is the mirror of `engine_profiles.PROFILES[...].coverage
 * .audited`: the flag narrator stamps into the report it writes, and the thing
 * `tools/test-coverage-policy-mirror.js` holds the two sides to.
 *
 * NO FALLBACK, for `profile_for`'s reason: answering for an id we do not
 * recognise would be BookForge inventing a policy narrator has not declared, on
 * the strength of a string.
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
 * The refusal a run gets when it is set to align and the aligner is not on this
 * machine.
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
 *
 * NO ENGINE IN IT ANY MORE. Aligning is the user's choice per run rather than a
 * property of the engine (2026-09-07), so the remedy is now two doors wide:
 * install the add-on, or untick Align and accept the estimated transcript.
 */
export function alignerMissingRefusal(): string {
  return (
    'This run is set to align the narration to the text: every rendered chunk is force-aligned '
    + 'against its own words, which is what produces the word-timed transcript and the report '
    + 'saying which chunks came out wrong. The aligner is the "Ebook Alignment (WhisperX)" '
    + 'add-on and it is not installed on this machine. Install it from Settings → Add-ons, or '
    + 'untick Align — the audiobook is then assembled with an estimated transcript and nothing '
    + 'measuring the render.'
  );
}
