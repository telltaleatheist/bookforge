/**
 * narration-prep-step.js — the narration door, called from a CLI adapter.
 *
 * The door itself is `prepareNarrationInput` in the compiled
 * parallel-tts-bridge: the caption/footnote cut and the number pass the app's
 * queue runs, one exported function, no second implementation here. Owen,
 * 2026-09-02: *"high level so it runs the same code the app would, so we can
 * catch bugs that way"* — a CLI running its own prep could not catch the app's
 * bugs, so this file adds nothing but the ONE LINE a headless run prints about
 * what happened.
 *
 * Every adapter that hands text to `renderRangeHeadless` calls this first and
 * passes the RESULT in. `renderRangeHeadless` is untouched by design: its
 * index-seeded FLAC resume depends on reading exactly what it is handed.
 */
'use strict';

/**
 * Prep one input and say, in one line, what the voice will now read.
 *
 * A failure THROWS — an unreachable Ollama, a missing model, a book whose cut
 * would not write. There is deliberately no path here that renders the raw
 * digits anyway: e2a has no number transform of its own any more, so a prep that
 * was skipped is a book narrated as "twenty three slash three slash nineteen
 * thirty three" with nothing in the log to say so.
 *
 * @param {object} bridge   the required dist/electron/parallel-tts-bridge.js
 * @param {string} inputPath  the .epub or .txt the render was asked for
 * @param {string} jobId    the adapter's own job id, so the door's log lines join it
 * @param {{skipAssembly: boolean}} opts
 * @returns {Promise<object>} the door's NarrationPrepResult
 */
async function runNarrationPrep(bridge, inputPath, jobId, opts) {
  if (typeof bridge.prepareNarrationInput !== 'function') {
    throw new Error(
      'parallel-tts-bridge.prepareNarrationInput missing — rebuild BookForge '
      + '(npx tsc -p tsconfig.electron.json)');
  }
  if (typeof opts.skipAssembly !== 'boolean') {
    throw new Error('runNarrationPrep needs skipAssembly (the job\'s own flag), not a guess');
  }

  const prep = await bridge.prepareNarrationInput(inputPath, jobId, {
    skipAssembly: opts.skipAssembly,
  });

  if (prep.recordPath === null) {
    console.log('[prep] no digits a narrator reads — input passes through untouched');
  } else {
    console.log(
      `[prep] ${prep.appliedSpans} number(s) read as words by ${prep.model} `
      + `(copy reused: ${prep.reused ? 'yes' : 'no'}) → ${prep.inputPath}`);
  }
  return prep;
}

module.exports = { runNarrationPrep };
