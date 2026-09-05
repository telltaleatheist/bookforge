/**
 * correct-sentences.js — RETAKE a rendered sentence, headless.
 *
 * The app's Correct Sentences panel is five IPC handlers over five exported
 * functions in `electron/correct-sentences-bridge.ts` (main.ts:10163-10231), and
 * this adapter calls those same five:
 *
 *   --list      getCorrectSentencesSession(projectDir)   open the panel
 *   --retake    generateCandidates({projectDir, indices, takes, overrides, …})
 *   --commit    commitSentence({projectDir, index, sourceFlacPath, text?})
 *   --revert    revertSentence(projectDir, index)
 *   --cleanup   cleanupCandidates(sessionId)
 *
 * Nothing about the feature is re-implemented: the takes are rendered through
 * `parallel-tts-bridge.regenerateSentenceIndices` (the SAME lightweight worker a
 * book render uses, sample_fmt-matched so a take drops into the cache without
 * breaking assembly), the original is backed up to `.orig-backup/` exactly once,
 * and an edited sentence round-trips through `storedTextForCorrection` so the
 * chunk keeps its `[heading]` / `[item]` markers.
 *
 * There is no cancel export on the bridge — the app's IPC layer keeps its own
 * AbortController and passes `signal` in. So does this file, on SIGINT.
 *
 *   node --require ./cli/electron-stub.js cli/correct-sentences.js --project "<dir>" --list
 *   node --require ./cli/electron-stub.js cli/correct-sentences.js --project "<dir>" \
 *        --retake --indices 12,40 [--takes 3] [--text "the words to say instead"]
 *   node --require ./cli/electron-stub.js cli/correct-sentences.js --project "<dir>" \
 *        --commit --index 12 --take "<...>/take2/12.flac" [--text "..."]
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('./electron-stub.js');   // intercept require('electron') for the compiled bridge

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const body = t.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { a[body.slice(0, eq)] = body.slice(eq + 1); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { a[body] = argv[++i]; }
    else { a[body] = true; }
  }
  return a;
}

/** "12,40, 7" -> [12, 40, 7]. A non-integer is an ERROR, never dropped. */
function parseIndices(raw) {
  const parts = String(raw).split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 0) throw new Error('--indices names no sentence');
  return parts.map((s) => {
    if (!/^\d+$/.test(s)) throw new Error(`--indices: '${s}' is not a sentence index`);
    return parseInt(s, 10);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) throw new Error('--project <projectDir> is required');
  const projectDir = path.resolve(args.project);
  if (!fs.existsSync(path.join(projectDir, 'manifest.json'))) {
    throw new Error(`not a BookForge project (no manifest.json): ${projectDir}`);
  }

  const bridge = require('../dist/electron/correct-sentences-bridge.js');
  for (const fn of ['getCorrectSentencesSession', 'generateCandidates', 'commitSentence',
                    'revertSentence', 'cleanupCandidates', 'displayTextForStoredChunk']) {
    if (typeof bridge[fn] !== 'function') {
      throw new Error(
        `compiled correct-sentences-bridge missing ${fn} — rebuild (npx tsc -p tsconfig.electron.json)`);
    }
  }

  // EVERY verb starts here, exactly as the panel does: the session is what says
  // whether the feature is available at all, and its `reason` is the app's own
  // sentence for why not. Refusing with that reason rather than a guess of our
  // own is the point of calling the app's door.
  const session = await bridge.getCorrectSentencesSession(projectDir);
  if (!session.available) {
    throw new Error(`correct-sentences unavailable for ${path.basename(projectDir)}: ${session.reason}`);
  }

  const verbs = ['list', 'retake', 'commit', 'revert', 'cleanup'].filter((v) => args[v]);
  if (verbs.length !== 1) {
    throw new Error('pass exactly one of --list, --retake, --commit, --revert, --cleanup');
  }
  const verb = verbs[0];

  if (verb === 'list') {
    console.log(`[retake] session ${session.sessionId} — ${session.totalSentences} sentence(s), `
      + `${session.ttsEngine}/${session.voice}, sample_fmt ${session.sampleFmt}`);
    console.log(`[retake] cache:  ${session.sentencesDir}`);
    const from = args.from !== undefined && args.from !== true ? parseInt(args.from, 10) : 0;
    const count = args.count !== undefined && args.count !== true ? parseInt(args.count, 10) : 20;
    for (const cue of session.cues.slice(from, from + count)) {
      const secs = (ms) => (ms / 1000).toFixed(1);
      console.log(`  ${String(cue.index).padStart(5)}  ${secs(cue.startMs)}-${secs(cue.endMs)}s`
        + `${cue.heading ? '  [heading]' : ''}  ${cue.text}`);
    }
    process.exitCode = 0;
    return;
  }

  if (verb === 'cleanup') {
    await bridge.cleanupCandidates(session.sessionId);
    console.log(`[retake] cleaned the candidate scratch for session ${session.sessionId}`);
    process.exitCode = 0;
    return;
  }

  if (verb === 'revert') {
    if (args.index === undefined || args.index === true) throw new Error('--revert needs --index <n>');
    const index = parseInt(args.index, 10);
    if (!Number.isInteger(index)) throw new Error(`--index must be an integer, got: ${args.index}`);
    const r = await bridge.revertSentence(projectDir, index);
    if (!r.success) throw new Error(`revert failed: ${r.error}`);
    console.log(`[retake] sentence ${index} restored from .orig-backup/`);
    process.exitCode = 0;
    return;
  }

  if (verb === 'commit') {
    if (args.index === undefined || args.index === true) throw new Error('--commit needs --index <n>');
    if (!args.take) throw new Error('--commit needs --take <path to the approved .flac>');
    const index = parseInt(args.index, 10);
    if (!Number.isInteger(index)) throw new Error(`--index must be an integer, got: ${args.index}`);
    const sourceFlacPath = path.resolve(args.take);
    if (!fs.existsSync(sourceFlacPath)) throw new Error(`--take not found: ${sourceFlacPath}`);
    const params = { projectDir, index, sourceFlacPath };
    // The DISPLAY text the take was rendered from, when the sentence was edited.
    // Absent means the words did not change, which is a different act from
    // "changed to the same string" — so it is omitted, not passed as the old text.
    if (args.text !== undefined && args.text !== true) params.text = args.text;
    const r = await bridge.commitSentence(params);
    if (!r.success) throw new Error(`commit failed: ${r.error}`);
    console.log(`[retake] sentence ${index} committed from ${sourceFlacPath}`);
    process.exitCode = 0;
    return;
  }

  // --retake: render fresh takes into the candidate scratch. Real GPU work.
  if (args.indices === undefined || args.indices === true) {
    throw new Error('--retake needs --indices <n[,n...]>');
  }
  const indices = parseIndices(args.indices);
  const params = { projectDir, indices };
  if (args.takes !== undefined && args.takes !== true) {
    const takes = parseInt(args.takes, 10);
    if (!Number.isInteger(takes) || takes < 1) throw new Error(`--takes must be >= 1, got: ${args.takes}`);
    params.takes = takes;
  }
  if (args.text !== undefined && args.text !== true) {
    if (indices.length !== 1) {
      throw new Error('--text replaces ONE sentence\'s words; pass a single --indices value with it');
    }
    params.overrides = { [indices[0]]: args.text };
  }

  const ac = new AbortController();
  params.signal = ac.signal;
  process.on('SIGINT', () => { console.log('\n[retake] SIGINT — aborting...'); ac.abort(); });
  process.on('SIGTERM', () => { console.log('\n[retake] SIGTERM — aborting...'); ac.abort(); });
  params.onProgress = (done, total) => console.log(`[retake] ${done}/${total} take(s)`);

  const t0 = Date.now();
  const result = await bridge.generateCandidates(params);
  if (!result.success) throw new Error(`generate candidates failed: ${result.error}`);
  for (const c of result.candidates) {
    console.log(`[retake] sentence ${c.index}${c.failed ? ' FAILED' : ''}`);
    console.log(`  original: ${c.originalPath}`);
    c.takePaths.forEach((p, i) => console.log(`  take ${i + 1}:   ${p}`));
  }
  console.log(`[retake] done in ${((Date.now() - t0) / 1000).toFixed(0)}s — approve one with `
    + `--commit --index <n> --take <path>`);
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[retake] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
