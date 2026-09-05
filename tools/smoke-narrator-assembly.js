#!/usr/bin/env node
/**
 * ASSEMBLE THE KERSHAW GOLDEN SESSION THROUGH THE BRIDGE'S REAL PLAN, and compare
 * the result with the committed reference.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/smoke-narrator-assembly.js
 *
 * NOT a keeper: it needs the golden session (C:\tmp\narrator-golden\kershaw, ~60
 * MB of rendered FLACs), ffmpeg/ffprobe on PATH and a python env with narrator
 * importable. It is the hand-run proof for Phase 3's assembly door, which is the
 * ONE render-pipeline door that can be proved without a GPU: assembly loads no
 * model. The prep and worker doors are GPU-bound and are proved separately.
 *
 * ── What it actually proves ─────────────────────────────────────────────────
 *
 * Not "narrator can assemble" — narrator's own suite covers that. It proves that
 * the argv, the environment, the conda env and the cwd that
 * `parallel-tts-bridge.ts` now builds for the assembly door produce the SAME
 * audiobook the shipped pipeline produced: 133 cues, 2615.400 s, from 133
 * sentence FLACs. Every part of that chain changed this phase — the door moved
 * from `app.py` in one of three routes to `-m narrator.compat.app` in the tools
 * env on every platform — and none of it is visible in a snapshot.
 *
 * ── The source is READ-ONLY ─────────────────────────────────────────────────
 *
 * `C:\tmp\narrator-golden\kershaw` is the reference and is never written to: the
 * session is copied to a scratch directory first. An assembly writes into its
 * session dir (concat lists, the chapter FLAC), so running in place would mutate
 * the thing being compared against.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
const GOLDEN = process.env.NARRATOR_GOLDEN || 'C:\\tmp\\narrator-golden\\kershaw';

const EXPECT_CUES = 133;
const EXPECT_SECONDS = 2615.400;
const SECONDS_TOLERANCE = 0.25;

if (!fs.existsSync(GOLDEN)) {
  console.error(`No golden session at ${GOLDEN}. Set NARRATOR_GOLDEN to point at it.`);
  process.exit(2);
}

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

let bad = 0;
function expect(what, cond, detail) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}${cond ? '' : ' — ' + detail}`);
  if (!cond) bad++;
}

// ── copy the session out of the read-only golden tree ────────────────────────
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-asm-'));
const sessionName = fs.readdirSync(GOLDEN).find((n) => n.startsWith('ebook-'));
if (!sessionName) { console.error('no ebook-* session under ' + GOLDEN); process.exit(2); }
const SESSION_DIR = path.join(SCRATCH, sessionName);
const OUT_DIR = path.join(SCRATCH, 'out');
fs.cpSync(path.join(GOLDEN, sessionName), SESSION_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const sessionId = sessionName.replace(/^ebook-/, '');
const processDir = fs.readdirSync(SESSION_DIR)
  .map((n) => path.join(SESSION_DIR, n))
  .find((p) => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'chapters')));
const sentencesDir = path.join(processDir, 'chapters', 'sentences');
const sentenceCount = fs.readdirSync(sentencesDir).filter((n) => /^\d+\.(flac|wav|mp3)$/.test(n)).length;
console.log(`session   : ${sessionName}`);
console.log(`sentences : ${sentenceCount}`);

// ── the argv the bridge builds for this door ─────────────────────────────────
//
// Kept in step with runAssembly / assembleSession by hand, and asserted against
// the argv snapshot by tools/test-narrator-argv-snapshot.js — this file proves the
// door RUNS, the snapshot proves the door's flags have not moved.
const args = [
  '--headless',
  '--output_dir', OUT_DIR,
  '--session', sessionId,
  // THE PROCESS DIR. narrator's assembly opens `<dir>/session-state.json`
  // directly; the render routes walk a session dir's subdirectories for it.
  '--session_dir', processDir,
  '--device', 'CPU',
  '--language', 'eng',
  '--tts_engine', 'orpheus',
  '--assemble_only',
  '--no_split',
];

const plan = spawnMod.buildNarratorSpawn({
  phase: 'assembly',
  args,
  envExtras: { VLLM_USE_V1: '0' },
  cwdHint: REPO,
});

console.log('\nCOMMAND : ' + plan.command);
console.log('ARGV    : ' + JSON.stringify(plan.args));
console.log('CWD     : ' + plan.cwd);
console.log('viaWsl  : ' + plan.viaWsl);
expect('the assembly door is NATIVE (never WSL)', plan.viaWsl === false, 'it routed through WSL');
expect('it names no engine environment', !('NARRATOR_ENGINE' in plan.env),
  'NARRATOR_ENGINE=' + plan.env.NARRATOR_ENGINE);

const started = Date.now();
const r = spawnSync(plan.command, plan.args, {
  cwd: plan.cwd, env: plan.env, encoding: 'utf-8', timeout: 30 * 60 * 1000,
});
console.log(`\nEXIT ${r.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (r.stdout) console.log('STDOUT tail:\n' + r.stdout.trim().split('\n').slice(-8).map((l) => '  ' + l).join('\n'));
if (r.stderr && r.stderr.trim()) console.log('STDERR tail:\n' + r.stderr.trim().split('\n').slice(-8).map((l) => '  ' + l).join('\n'));
expect('assembly exits 0', r.status === 0, `exit ${r.status}`);

// ── compare with the reference ───────────────────────────────────────────────
const produced = fs.readdirSync(OUT_DIR).filter((n) => n.toLowerCase().endsWith('.m4b'));
expect('exactly one m4b was written', produced.length === 1, JSON.stringify(fs.readdirSync(OUT_DIR)));

if (produced.length === 1) {
  const m4b = path.join(OUT_DIR, produced[0]);
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', m4b,
  ], { encoding: 'utf-8' });
  const seconds = parseFloat((probe.stdout || '').trim());
  console.log(`\nm4b       : ${produced[0]}`);
  console.log(`duration  : ${seconds}s  (reference ${EXPECT_SECONDS}s)`);
  expect(`duration is ${EXPECT_SECONDS}s ±${SECONDS_TOLERANCE}`,
    Number.isFinite(seconds) && Math.abs(seconds - EXPECT_SECONDS) <= SECONDS_TOLERANCE,
    `got ${seconds}`);

  const vtt = [path.join(OUT_DIR, produced[0] + '.vtt'), m4b.replace(/\.m4b$/i, '.vtt')]
    .find((p) => fs.existsSync(p));
  expect('a VTT sidecar was written', !!vtt, JSON.stringify(fs.readdirSync(OUT_DIR)));
  if (vtt) {
    const cues = (fs.readFileSync(vtt, 'utf-8').match(/^\d\d:\d\d:\d\d\.\d\d\d --> /gm) || []).length;
    const refCues = (fs.readFileSync(path.join(GOLDEN, 'reference.vtt'), 'utf-8')
      .match(/^\d\d:\d\d:\d\d\.\d\d\d --> /gm) || []).length;
    console.log(`cues      : ${cues}  (reference ${refCues})`);
    expect(`the VTT has ${EXPECT_CUES} cues`, cues === EXPECT_CUES, `got ${cues}`);
    expect('the reference itself still has that many', refCues === EXPECT_CUES, `got ${refCues}`);
    expect('one cue per sentence FLAC', cues === sentenceCount, `${cues} cues vs ${sentenceCount} sentences`);
  }
}

console.log(`\nscratch kept for inspection: ${SCRATCH}`);
console.log(bad === 0 ? '\nASSEMBLY DOOR OK' : `\n${bad} check(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);
