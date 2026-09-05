#!/usr/bin/env node
/**
 * THE RETAKE DOOR, on a real session, through the bridge's own function.
 *
 *   node --require ./cli/electron-stub.js tools/smoke-narrator-retake.js \
 *        --session-dir <ebook-uuid dir> --indices 3,4,5
 *
 * NOT a keeper: it loads a model and needs the GPU. `tools/test-narrator-argv-snapshot.js`
 * pins the retake door's ARGV; this runs it.
 *
 * ── Why the retake door needs its own proof ─────────────────────────────────
 *
 * It is the one render door with no headless CLI entry — `bookforge-tts` covers
 * prep, worker and assembly, and Correct Sentences is a UI feature — so it is also
 * the door most likely to be proven "by reading the snapshot". It moved this phase
 * like every other: `<py> <e2a>/worker.py --sentence_indices` became
 * `<py> -u -m narrator.compat.worker --sentence_indices`, and on Windows it stages
 * session state into the guest first (`stageSessionStateForWsl`), a step the render
 * door does not take.
 *
 * This calls `regenerateSentenceIndices` — the app's own function, the one
 * `correct-sentences-bridge.ts` calls — rather than building a python command line.
 *
 * ── What it asserts, and the one that is easy to get backwards ──────────────
 *
 * 1. The requested indices come back as FLACs in the SCRATCH dir, and each one
 *    DIFFERS from the corresponding file in the live cache. Sampling is unseeded
 *    here on purpose (a different take of the same sentence is the whole feature),
 *    so a byte-identical file means the door re-copied rather than re-rendered.
 * 2. **The live cache is untouched** — every FLAC in the session's own
 *    `chapters/sentences` has the same sha256 after the run as before, including
 *    the ones that were retaken. The retake writes candidates; a human approves
 *    them later. A door that wrote into the live cache would silently overwrite a
 *    book's audio with an unreviewed take, and the failure would only be audible.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const sessionDir = arg('session-dir');
const indices = String(arg('indices', '3,4,5')).split(',').map((s) => Number(s.trim()));
if (!sessionDir || !fs.existsSync(sessionDir)) {
  console.error('usage: node --require ./cli/electron-stub.js tools/smoke-narrator-retake.js --session-dir <dir> [--indices 3,4,5]');
  process.exitCode = 2;
  return;
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const hashDir = (dir) => {
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile() && f.endsWith('.flac')) out[f] = sha(p);
  }
  return out;
};

// The process dir is the `<hash>` subdir holding session-state.json — the same
// resolution `load_session_state` does in the guest.
const procName = fs.readdirSync(sessionDir).find((n) => {
  const p = path.join(sessionDir, n);
  return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'session-state.json'));
});
if (!procName) { console.error(`no <hash>/session-state.json under ${sessionDir}`); process.exitCode = 2; return; }
const procDir = path.join(sessionDir, procName);
const liveSentences = path.join(procDir, 'chapters', 'sentences');
const sessionId = path.basename(sessionDir).replace(/^ebook-/, '');

// The render settings, from BookForge's own sidecar when it exists and rebuilt from
// narrator's `session-state.json` otherwise (`renderRangeHeadless` writes no sidecar
// — the Mac proof found the same thing about the assembly door's engine check).
//
// THE FIELD NAMES ARE `ParallelTtsSettings`'S, NOT NARRATOR'S, and getting that
// wrong is silent. `pushVoiceArgs` reads `settings.orpheusModelDir` and
// `settings.fineTuned`; hand it `{voice, customModelDir}` and every branch falls
// through — including the "not installed" refusal, which is guarded on
// `if (requested && ...)` and so does not fire for an ABSENT voice. The spawn then
// carries no `--fine_tuned` at all and narrator renders in its own default speaker.
// This tool hit exactly that on its first run. So: map explicitly, and refuse a
// session that does not name a voice rather than rendering in whatever answers.
let settings = null;
const sidecar = path.join(procDir, 'session_state.json');
if (fs.existsSync(sidecar)) settings = JSON.parse(fs.readFileSync(sidecar, 'utf-8')).settings ?? null;
if (!settings) {
  const st = JSON.parse(fs.readFileSync(path.join(procDir, 'session-state.json'), 'utf-8'));
  if (!st.fine_tuned) {
    console.error(`${procDir}/session-state.json names no fine_tuned voice — refusing to `
      + 'retake in whatever the engine defaults to. A take rendered by a different '
      + 'speaker than the book is worse than no take.');
    process.exitCode = 2;
    return;
  }
  if (!st.language_iso1) {
    console.error(`${procDir}/session-state.json names no language_iso1. It used to fall `
      + "back to 'en', which is a retake rendered in a language the book may not be in — "
      + 'a take that succeeds and is wrong.');
    process.exitCode = 2;
    return;
  }
  settings = {
    ttsEngine: st.tts_engine,
    fineTuned: st.fine_tuned,
    orpheusModelDir: st.orpheus_model_dir || undefined,
    // NOT `|| 'en'`. This file's own header argues that a silent fallback is the
    // failure it exists to prevent, and a retake rendered in the wrong language is
    // precisely that: it succeeds, and the audio is wrong.
    language: st.language_iso1,
    device: 'CUDA',
  };
  console.log('[retake] settings rebuilt from narrator session-state.json (no BookForge sidecar)');
}
if (!settings.fineTuned) {
  console.error('the resolved settings name no `fineTuned` voice — see the note above.');
  process.exitCode = 2;
  return;
}
console.log('[retake] settings:', JSON.stringify(settings));

const bridge = require(path.join(DIST, 'parallel-tts-bridge.js'));

(async () => {
  const before = hashDir(liveSentences);
  console.log(`[retake] live cache: ${Object.keys(before).length} FLACs`);

  const scratch = path.join(procDir, 'chapters', 'retake-smoke');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });

  const t0 = Date.now();
  const r = await bridge.regenerateSentenceIndices({
    sessionId, sessionDir, settings, indices, targetSentencesDir: scratch,
    onProgress: (d, t) => console.log(`[retake] ${d}/${t}`),
  });
  const secs = (Date.now() - t0) / 1000;
  console.log(`[retake] result ${JSON.stringify(r)} in ${secs.toFixed(1)} s`);

  let bad = 0;
  const ok = (name, cond, detail) => {
    console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
    if (!cond) bad++;
  };

  ok('the door reported success', r.success, r.error);

  for (const i of indices) {
    const produced = path.join(scratch, `${i}.flac`);
    const live = path.join(liveSentences, `${i}.flac`);
    if (!fs.existsSync(produced)) { ok(`sentence ${i} was re-rendered`, false, `${produced} missing`); continue; }
    const sz = fs.statSync(produced).size;
    ok(`sentence ${i} was re-rendered (${sz} bytes)`, sz > 0, 'empty file');
    if (fs.existsSync(live)) {
      ok(`sentence ${i}'s take DIFFERS from the live cache`, sha(produced) !== before[`${i}.flac`],
        'byte-identical — the door copied instead of rendering');
    }
  }

  const after = hashDir(liveSentences);
  const changed = Object.keys(after).filter((f) => before[f] !== after[f]);
  const removed = Object.keys(before).filter((f) => !(f in after));
  const added = Object.keys(after).filter((f) => !(f in before));
  ok(`the live cache is untouched (${Object.keys(after).length} FLACs)`,
    changed.length === 0 && removed.length === 0 && added.length === 0,
    `changed=${JSON.stringify(changed)} removed=${JSON.stringify(removed)} added=${JSON.stringify(added)}`);

  console.log(bad ? `\n${bad} check(s) FAILED.` : '\nRetake door: all checks passed.');
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
