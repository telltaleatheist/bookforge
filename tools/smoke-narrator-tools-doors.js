#!/usr/bin/env node
/**
 * Do the TOOLS doors the bridge builds actually run on this machine?
 *
 *   npx tsc -p tsconfig.electron.json && node tools/smoke-narrator-tools-doors.js
 *
 * NOT a keeper: it needs a real python environment with narrator importable,
 * which a CI checkout does not have. It is the hand-run proof for the two Phase 3
 * doors that need no GPU and no model — `--list_sessions` and `--resume_session`
 * — driven through the SAME `buildNarratorSpawn` the app uses, with the same
 * environment and the same cwd. The render doors are GPU-bound and are proved
 * separately.
 *
 * It also drives the two output readers, because both were broken in the same way
 * before Phase 3: narrator prints `json.dumps(result, indent=2)` and the bridge
 * scanned stdout line by line, so no line was ever valid JSON on its own.
 * `lastJsonValue` is exercised here against the REAL bytes rather than a fixture.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron') return 'estub';
  return orig.call(this, r, ...a);
};
require.cache['estub'] = {
  id: 'estub', filename: 'estub', loaded: true,
  exports: {
    app: { getAppPath: () => REPO, getPath: () => os.tmpdir(), isPackaged: false },
    BrowserWindow: class {},
  },
};

const spawnMod = require(path.join(DIST, 'narrator-spawn.js'));

// A sessions root with ONE session in it, so `--list_sessions` has something to
// find and `--resume_session` has something to read. Built here rather than
// pointed at a real library: this smoke is about the DOOR, and a real session
// would make the result depend on whatever happens to be cached.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-tools-doors-'));
const SESSION_ID = '0f0a68d5-1111-2222-3333-444455556666';
const SESSION_DIR = path.join(ROOT, `ebook-${SESSION_ID}`);
const PROCESS_DIR = path.join(SESSION_DIR, 'abcdef0123');
const SENTENCES = path.join(PROCESS_DIR, 'chapters', 'sentences');
fs.mkdirSync(SENTENCES, { recursive: true });
// At least MIN_RENDERED_FILE_BYTES each: the size rule is what makes a
// half-written file re-render instead of being kept, and it is also why a 0.1 s
// digital-silence FLAC (~100 bytes) never counts. A 9-byte fixture counts as
// missing, which is the correct answer to the wrong question.
for (const i of [0, 1, 2]) fs.writeFileSync(path.join(SENTENCES, `${i}.flac`), Buffer.alloc(64 * 1024, 7));
// The state file lives in the PROCESS dir, not the session dir: load_session_state
// walks the session dir's subdirectories for it and OVERWRITES process_dir and
// session_dir with the directories it actually walked, so the paths written here
// are never trusted (a session may have been written on another machine).
fs.writeFileSync(path.join(PROCESS_DIR, 'session-state.json'), JSON.stringify({
  session_id: SESSION_ID,
  session_dir: SESSION_DIR,
  process_dir: PROCESS_DIR,
  total_sentences: 5,
  total_chapters: 1,
  title: 'A } braced { title',
  language: 'eng',
  tts_engine: 'orpheus',
  fine_tuned: 'deathstalker',
  metadata: { title: 'A } braced { title' },
}, null, 2));

function run(phase, args) {
  const plan = spawnMod.buildNarratorSpawn({
    phase,
    args,
    // NARRATOR_SESSIONS_ROOT is what `session_store.sessions_root()` reads. The app sets it
    // through buildToolsSpawnEnv from the configured scratch; here it is pointed
    // at the fixture so the door has a root that is not the developer's library.
    envExtras: { NARRATOR_SESSIONS_ROOT: ROOT },
    cwdHint: REPO,
  });
  console.log(`\n=== ${phase} ===`);
  console.log('COMMAND : ' + plan.command);
  console.log('ARGV    : ' + JSON.stringify(plan.args));
  console.log('CWD     : ' + plan.cwd);
  console.log('viaWsl  : ' + plan.viaWsl);
  const r = spawnSync(plan.command, plan.args, {
    cwd: plan.cwd, env: plan.env, encoding: 'utf-8', timeout: 180000,
  });
  console.log('EXIT    : ' + r.status);
  if (r.stderr && r.stderr.trim()) console.log('STDERR  : ' + r.stderr.trim().split('\n').slice(-4).join('\n          '));
  console.log('STDOUT  :\n' + (r.stdout || '').trim().split('\n').map((l) => '  ' + l).join('\n'));
  return r;
}

// The bridge's own reader, compiled — not a copy of it.
const bridgeJs = fs.readFileSync(path.join(DIST, 'parallel-tts-bridge.js'), 'utf-8');
const readerSrc = bridgeJs.match(/function lastJsonValue[\s\S]*?\n}\n/);
if (!readerSrc) throw new Error('lastJsonValue is not in the compiled bridge');
// eslint-disable-next-line no-eval
// Returned out of the eval rather than left to leak into this scope: this file is
// strict, and in strict mode an eval gets its own scope.
const lastJsonValue = eval(`${readerSrc[0]}; lastJsonValue`);

let bad = 0;
function expect(what, cond, detail) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}${cond ? '' : ' — ' + detail}`);
  if (!cond) bad++;
}

const list = run('list', ['--headless', '--list_sessions']);
expect('list_sessions exits 0', list.status === 0, `exit ${list.status}`);
const rows = lastJsonValue(list.stdout || '', '[');
expect('the bridge reader parses its output', Array.isArray(rows), 'not an array');
expect('it found the fixture session',
  Array.isArray(rows) && rows.some((r) => r.session_id === SESSION_ID),
  JSON.stringify(rows).slice(0, 200));

const resume = run('resume', ['--headless', '--resume_session', SESSION_DIR]);
expect('resume_session exits 0', resume.status === 0, `exit ${resume.status}`);
const parsed = lastJsonValue(resume.stdout || '', '{');
expect('the bridge reader parses its PRETTY-PRINTED output', !!parsed && parsed.success !== undefined,
  'this is the exact shape that used to fall through to "Failed to parse resume check output"');
if (parsed) {
  expect('it counted the three rendered sentences', parsed.completed_sentences === 3,
    `completed_sentences=${parsed.completed_sentences}`);
  expect('it reports the session as incomplete (3 of 5)', parsed.complete === false,
    `complete=${parsed.complete}`);
  expect('a braced title did not break the scan', parsed.session_id === SESSION_ID,
    `session_id=${parsed.session_id}`);
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(bad === 0 ? '\nTOOLS DOORS OK' : `\n${bad} check(s) FAILED`);
process.exitCode = bad === 0 ? 0 : 1;
