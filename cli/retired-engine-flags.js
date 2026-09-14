#!/usr/bin/env node
/**
 * retired-engine-flags — the flags `foundry` used to take, refused BY NAME.
 *
 * ── Why a refusal and not a silent drop ─────────────────────────────────────
 *
 * Foundry `646e8a1` (v1.3.0, tag `engine-one-door`) deleted the Ollama dialect
 * — `src/translate/ollama.ts` is gone, `src/translate/transport.ts` stands in
 * its place — and `--server`, `--ollama` and `--keep-model` went with it rather
 * than behind a compatibility flag. Owen's ruling, in his words: *"everything
 * compute intensive must go through crucible. if theres no crucible server,
 * theres no foundry."*
 *
 * So BookForge's own doors stopped composing them. That leaves the question of
 * a PERSON who types one, from muscle memory or from a copied command line, and
 * there are exactly three things this can do:
 *
 *   1. pass it through — the engine answers `foundry: unknown option --server`
 *      and the run dies, which is honest but names Foundry's argument parser
 *      rather than the decision that removed the flag;
 *   2. DROP it — which is the one genuinely bad answer, and it is bad in the way
 *      this repository's standing rule says fallbacks are bad: `--ollama
 *      http://otherbox:11434` would be accepted and the run would go to a
 *      completely different machine, silently, having been told not to;
 *   3. refuse it here, naming the flag, the commit that retired it, and what to
 *      write instead.
 *
 * This is (3). The refusal is BEFORE any work — no temp directory, no book
 * file, no spawn — because a person who mistyped a flag wants the sentence, not
 * a half-finished working directory.
 *
 * ── The sha lives in ONE place ──────────────────────────────────────────────
 *
 * Three doors take these flags (`cli/clean-step.js`, `cli/clean-lines.js`,
 * `cli/clean-lines-step.js`). A copy of `646e8a1` in each is three facts that
 * can disagree, which is the shape of defect the Foundry vendor notes are full
 * of. One module, one sentence, three callers.
 */
'use strict';

/** The Foundry commit that deleted the dialect these flags belonged to. */
const RETIRING_COMMIT = '646e8a1';
/** The release it was cut as, which is what a `--version` will say. */
const RETIRING_RELEASE = 'v1.3.0 (83d7b66)';

/**
 * Every retired flag, with what a caller should write instead.
 *
 * `instead` is not optional and is not a link: a refusal that says only "that
 * is gone" makes the reader go and find out what replaced it, and two of these
 * three have a direct replacement that fits in a clause.
 */
const RETIRED = Object.freeze({
  'server': 'there is one dialect now, so there is nothing to choose. Delete the flag.',
  'ollama': 'use --endpoint <url>, which is the same URL under the name the one door gave it.',
  'keep-model': 'the engine never loads and never unloads — the operator makes a model resident '
    + 'before a pass is spawned, and a pass ending is not a reason to take it off. Delete the '
    + 'flag. (BookForge\'s own --keep-server is a different thing and still works: it keeps '
    + 'BookForge\'s text server up between runs.)',
});

/**
 * Throw if the parsed argv carries any retired flag. Returns nothing; the
 * absence of a throw is the pass.
 *
 * `args` is the plain object every one of these CLIs' `parseArgs` produces, so
 * the key is the flag without its dashes. EVERY retired flag present is named
 * in one message rather than the first one found — a person who pasted an old
 * command line usually pasted all of them, and three runs to learn three
 * sentences is three chances to give up.
 */
function refuseRetiredEngineFlags(args, doorName) {
  const found = Object.keys(RETIRED).filter((flag) => args[flag] !== undefined);
  if (found.length === 0) return;
  const lines = found.map((flag) => `  --${flag}: ${RETIRED[flag]}`);
  throw new Error(
    `${doorName}: ${found.map((f) => `--${f}`).join(', ')} `
    + `${found.length === 1 ? 'was' : 'were'} retired from the foundry engine by ${RETIRING_COMMIT} `
    + `(${RETIRING_RELEASE}), which deleted the Ollama dialect. Nothing was spawned.\n`
    + `${lines.join('\n')}\n`
    + '  Passing it through would die as `foundry: unknown option`, and dropping it would run the '
    + 'job against something other than what you asked for — so it is refused here.',
  );
}

module.exports = { refuseRetiredEngineFlags, RETIRED, RETIRING_COMMIT, RETIRING_RELEASE };
