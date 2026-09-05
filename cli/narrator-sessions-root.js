/**
 * narrator-sessions-root.js — where a headless run keeps its sessions, resolved
 * the way the APP resolves it.
 *
 * The app (electron/main.ts `applyNarratorScratchRoot`) points the sessions root
 * at the Settings override `narratorScratchPath` when one is stated, else at
 * `<library>/tmp`. The narration cuts and the number-normalized copies live under
 * that tmp, in `narration-cuts/`, content-addressed — so a `--prep` that resolved
 * the directory differently from the app would write a copy the app never finds,
 * and the app would pay for the model pass again. Measured 2026-09-02: the CLI's
 * first `--prep` landed in `<e2a>/tmp` while the app's own run had used
 * `Z:\bookforge\tmp`.
 *
 * One function, the same two rules, in the same order. A headless run that has
 * no library root (`--prep --input file.txt`, `--tts --text …`) cannot make the
 * second choice and is left on the default, which the door logs.
 *
 * WHY THIS MATTERS MORE AFTER THE NARRATOR CUT-OVER. `setNarratorScratchRoot`
 * decides the value of `NARRATOR_SESSIONS_ROOT`, which
 * `narrator.render.session_store.sessions_root` reads — and narrator has no
 * default sessions root at all. e2a survived a wrong answer here because
 * `lib/conf.py` fell back to `<e2a_root>/tmp`; narrator refuses to guess, and
 * every spawn now carries `--session_dir` derived from this directory. A headless
 * run that resolved it differently from the app used to cost a duplicate model
 * pass; now it names a session directory that is simply not the one the app
 * would use.
 *
 * The config key is read here under its CURRENT name only. `tool-paths.ts`
 * renames a stored `ttsScratchPath` to `narratorScratchPath` once, on load, and
 * writes the file back — so by the time this reads the config there is exactly
 * one spelling, and reading both would be the second reader that keeps a retired
 * key alive.
 */
'use strict';
const path = require('path');

/**
 * @param {string} libraryRoot  the library the project belongs to
 * @returns {string} the scratch directory now in force
 */
function applyNarratorSessionsRoot(libraryRoot) {
  const toolPaths = require('../dist/electron/tool-paths.js');
  const narratorPaths = require('../dist/electron/narrator-paths.js');
  for (const [obj, fn] of [[toolPaths, 'getConfig'], [narratorPaths, 'setNarratorScratchRoot']]) {
    if (typeof obj[fn] !== 'function') {
      throw new Error(`compiled bridge missing ${fn} — rebuild (npx tsc -p tsconfig.electron.json)`);
    }
  }
  const override = toolPaths.getConfig().narratorScratchPath;
  const dir = typeof override === 'string' && override.trim() !== ''
    ? override.trim()
    : path.join(libraryRoot, 'tmp');
  narratorPaths.setNarratorScratchRoot(dir);
  return dir;
}

module.exports = { applyNarratorSessionsRoot };
