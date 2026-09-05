/**
 * WHICH ENGINES ARE GUARDED BY POST-RENDER FORCED ALIGNMENT — one table.
 *
 * ── What the guard is ───────────────────────────────────────────────────────
 *
 * `narrator align` force-aligns every rendered chunk against the text it was
 * given and writes `coverage.json`. `python/narrator/assemble/coverage_gate.py`
 * reads that report at assembly and, for an engine whose policy is ENFORCED,
 * refuses the book when a chunk did not say its text — and refuses just as
 * loudly when there is no report at all:
 *
 *     engine 'higgs-v3' is guarded by post-render forced alignment and there is
 *     no coverage report at <path>. A duration ratio cannot see a chunk that
 *     dropped a fifth of its text, so assembly will not proceed on one.
 *
 * That refusal is correct and deliberate. What was missing until this file
 * existed was the STEP that produces the report, so every app-driven Higgs v3
 * book ended at assembly quoting a command line nobody had run.
 *
 * ── Why the table is HERE ───────────────────────────────────────────────────
 *
 * Three programs need the same answer and none of them can ask the others:
 *
 *   - the run description (`narration-run.ts`) decides whether a run carries an
 *     Align step at all — it is `shared/`, compiled into main AND the renderer,
 *     and it can import nothing from `electron/`;
 *   - the narration dialog refuses a run whose aligner is not installed;
 *   - the two assembly spawns (`parallel-tts-bridge.ts`, `reassembly-bridge.ts`)
 *     decide whether to pass `--coverage_report`.
 *
 * A hard-coded `=== 'higgs-v3'` in each of those is three answers to one
 * question, and they drift the day a third engine lands. This is the one answer,
 * and it is a MIRROR of `assemble/engine_profiles.py` — the Python side owns the
 * thresholds and the enforcement; this owns only the yes/no that BookForge has to
 * act on, kept honest by `tools/test-coverage-policy-mirror.js`, which reads the
 * Python table and asserts the two agree.
 *
 * ── Both spellings of an engine id, on purpose ──────────────────────────────
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
 * spelling — the same keys as `engine_profiles.PROFILES`.
 *
 * `orpheus` is false and that is a measured decision, not an omission: Orpheus
 * keeps its own chars/sec guard and its resplit ladder, so its coverage is
 * measured and REPORTED and blocks nothing. Turning it on would re-litigate a
 * guard that already works, on a corpus nobody has swept.
 *
 * `higgs-v3` is true because it has no duration guard worth the name — a chunk
 * measured a duration ratio of 0.99 while dropping 22 % of its text — so
 * "nobody checked" and "it is fine" are the same book, and only one of them is
 * honest.
 */
const COVERAGE_ENFORCED: Readonly<Record<string, boolean>> = {
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
 * Is this engine's book refused at assembly without a fresh coverage report?
 *
 * NO FALLBACK, for `profile_for`'s reason: answering `false` for an id we do not
 * recognise ships an audiobook that nobody checked under a guard that was
 * supposed to check it, and answering `true` demands a report for an engine that
 * has no policy at all. Neither is a thing to decide silently on the strength of
 * a string.
 *
 * XTTS reaches here from a session-state.json written by a retired build and is
 * refused with the rest: it cannot render and cannot be assembled by narrator
 * either, so a coverage answer for it would be an answer to a question that
 * cannot be asked.
 */
export function coverageEnforcedFor(engineId: string): boolean {
  const id = ENGINE_ALIASES[engineId.trim().toLowerCase()];
  if (id === undefined) {
    throw new Error(
      `No coverage policy is declared for TTS engine '${engineId}', so BookForge cannot say `
      + 'whether a book it rendered has to be forced-aligned before it is assembled. Known: '
      + `${Object.keys(ENGINE_ALIASES).sort().join(', ')}.`,
    );
  }
  return COVERAGE_ENFORCED[id]!;
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
 * The refusal a run gets when its engine is guarded and the aligner is not on
 * this machine.
 *
 * A SENTENCE RATHER THAN A SKIP. The alternative — queue the run and let the
 * align step fail hours later, or quietly drop it and let assembly refuse — both
 * spend the GPU first and say so afterwards, which is the shape this whole
 * description exists to prevent ("everything that can fail, fails before
 * anything is queued").
 */
export function alignerMissingRefusal(engineId: string): string {
  return (
    `${engineId} books are guarded by post-render forced alignment: every rendered chunk is `
    + 'aligned against its own text, and assembly refuses a book that has not been checked. '
    + 'The aligner is the "Ebook Alignment (WhisperX)" add-on and it is not installed on this '
    + 'machine, so this run would render for hours and then stop at assembly. Install it from '
    + 'Settings → Add-ons and queue the run again.'
  );
}
