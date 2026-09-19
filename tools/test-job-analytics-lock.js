#!/usr/bin/env node
/**
 * Keeper: `job-analytics.json` is a LOCKED read-modify-write.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-job-analytics-lock.js
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *
 * The library lives on the NAS and both machines' BookForge instances write it
 * (ruling 2026-08-17). `{projectDir}/job-analytics.json` was read, modified and
 * written back with no lock at all: an atomic write prevents a TORN file, not a
 * LOST UPDATE. Two machines finishing a job on the same book inside the same
 * read-modify-write window leave one of the two runs gone — the same shape as
 * the manifest bug `library-lock` was written for, in the file beside it.
 *
 * The claims:
 *
 *  1. An append that begins while another writer holds the project's lock does
 *     not read stale contents and does not clobber: BOTH runs are in the file
 *     afterwards. Driven with a real second PROCESS, because an in-process
 *     promise chain would mask a lock that did nothing.
 *  2. The lock is the project's OWN `.manifest.lock` — one lock per project
 *     directory, not a second lock file with its own staleness rules — and it
 *     is released afterwards.
 *  3. The existing behaviour is intact: same `jobId` replaces rather than
 *     duplicates, and only the last ten runs of a type are kept.
 *  4. main.ts's IPC handler no longer does the read-modify-write itself, so
 *     there is one door onto this file.
 */
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'electron', 'job-analytics.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'estub';
  return origResolve.call(this, request, ...rest);
};
require.cache['estub'] = {
  id: 'estub', filename: 'estub', loaded: true,
  exports: {
    app: { getPath: () => REPO, getAppPath: () => REPO, on() {}, isPackaged: false },
    ipcMain: { handle() {}, on() {} },
    BrowserWindow: class {},
    shell: {},
  },
};
const { appendJobAnalytics, MAX_ANALYTICS_HISTORY } = require(MODULE);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-analytics-lock-'));
const LOCK_NAME = '.manifest.lock';
let caseNumber = 0;
function freshProject() {
  const dir = path.join(ROOT, `project-${++caseNumber}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  return dir;
}

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

/**
 * ANOTHER MACHINE, as a real process, doing the same read-modify-write.
 *
 * It takes the project's lock with exclusive create, READS the file straight
 * away — that read is its snapshot, taken before the test body starts — and
 * writes the modified copy back `writeAfterMs` later, holding the lock until
 * `holdMs`. That is what a lost update looks like on two machines: two reads
 * of one state, two writes, one survivor. Resolves once the child HAS the
 * lock, so the test body genuinely races a held lock.
 */
function foreignWriter(dir, writeAfterMs, holdMs, entry) {
  const code = `
    const fs = require('fs'); const path = require('path');
    const dir = ${JSON.stringify(dir)};
    const lock = path.join(dir, ${JSON.stringify(LOCK_NAME)});
    const file = path.join(dir, 'job-analytics.json');
    fs.writeFileSync(lock, JSON.stringify({ host: 'other-machine', pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
    let data = { ttsJobs: [], reassemblyJobs: [], videoAssemblyJobs: [], rvcJobs: [], translationJobs: [] };
    try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
    process.stdout.write('LOCKED\\n');
    setTimeout(() => {
      data.ttsJobs = [...(data.ttsJobs || []), ${JSON.stringify(entry)}];
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    }, ${writeAfterMs});
    // Release and LEAVE: a pending write timer must not keep this process
    // alive past the lock it was holding.
    setTimeout(() => { fs.unlinkSync(lock); process.exit(0); }, ${holdMs});
  `;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  const done = new Promise((resolve) => child.on('exit', resolve));
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (b) => {
      out += b.toString();
      if (out.includes('LOCKED')) resolve({ done });
    });
    child.on('exit', (code) => { if (!out.includes('LOCKED')) reject(new Error(`foreign writer exited ${code} without taking the lock`)); });
  });
}

(async () => {
  console.log('two machines appending to one book');

  await check('an append that starts under a held lock does not lose the other machine\'s run', async () => {
    const dir = freshProject();
    const foreign = await foreignWriter(dir, 300, 900, { jobId: 'other-machine-job', durationMs: 42 });

    await appendJobAnalytics(dir, 'tts-conversion', { jobId: 'our-job', durationMs: 7 });
    await foreign.done;

    const data = JSON.parse(fs.readFileSync(path.join(dir, 'job-analytics.json'), 'utf-8'));
    const ids = (data.ttsJobs || []).map((j) => j.jobId).sort();
    assert.deepStrictEqual(ids, ['other-machine-job', 'our-job'],
      `one of the two runs was lost — the file holds ${JSON.stringify(ids)}`);
  });

  await check('the lock it takes is the project\'s own .manifest.lock, and it is released', async () => {
    const dir = freshProject();
    await appendJobAnalytics(dir, 'reassembly', { jobId: 'a' });
    assert.ok(!fs.existsSync(path.join(dir, LOCK_NAME)), 'the lock was left behind');
    assert.deepStrictEqual(
      fs.readdirSync(dir).filter((f) => f.endsWith('.lock')), [],
      'a second lock file was minted beside the manifest lock');

    // A lock held by somebody else genuinely blocks: prove it by holding one
    // and watching the append wait rather than sail past.
    const foreign = await foreignWriter(dir, 100_000, 500, { jobId: 'never' });
    const startedAt = Date.now();
    await appendJobAnalytics(dir, 'reassembly', { jobId: 'b' });
    const waited = Date.now() - startedAt;
    await foreign.done;
    assert.ok(waited >= 300, `the append did not wait for the lock (returned after ${waited}ms)`);
  });

  console.log('\nwhat the file already promised');

  await check('the same jobId replaces its earlier entry', async () => {
    const dir = freshProject();
    await appendJobAnalytics(dir, 'rvc', { jobId: 'x', pass: 1 });
    await appendJobAnalytics(dir, 'rvc', { jobId: 'x', pass: 2 });
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'job-analytics.json'), 'utf-8'));
    assert.strictEqual(data.rvcJobs.length, 1);
    assert.strictEqual(data.rvcJobs[0].pass, 2);
  });

  await check(`only the last ${MAX_ANALYTICS_HISTORY} runs of a type are kept`, async () => {
    const dir = freshProject();
    for (let i = 0; i < MAX_ANALYTICS_HISTORY + 4; i++) {
      await appendJobAnalytics(dir, 'translation', { jobId: `j${i}` });
    }
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'job-analytics.json'), 'utf-8'));
    assert.strictEqual(data.translationJobs.length, MAX_ANALYTICS_HISTORY);
    assert.strictEqual(data.translationJobs[0].jobId, 'j4');
  });

  await check('main.ts holds the IPC door only — the read-modify-write is not there', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'main.ts'), 'utf-8');
    const at = src.indexOf("ipcMain.handle('audiobook:append-analytics'");
    assert.ok(at > 0, 'the append-analytics handler is gone');
    const body = src.slice(at, at + 1800);
    assert.match(body, /appendJobAnalytics\(/, 'the handler does not call the one door');
    assert.ok(!/atomicWriteFile\(analyticsPath/.test(body),
      'main.ts still writes job-analytics.json itself, outside the lock');
  });

  try { fs.rmSync(ROOT, { recursive: true, force: true }); }
  catch { /* a temp dir that will not go is not a test failure */ }

  if (failed) { console.log(`\n${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\nAll job-analytics-lock checks passed.');
})().catch((err) => {
  console.error('job-analytics-lock: the suite itself failed:', err);
  process.exit(1);
});
