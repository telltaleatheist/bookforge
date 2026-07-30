/**
 * Exercise electron/rubric-run.ts without a model.
 *
 *   npm run build:electron   (or: npx tsc -p tsconfig.electron.json)
 *   node tools/test-rubric-run.js
 *
 * rubric-bridge is stubbed, so "classifying" is deterministic and instant and
 * no GPU or 5 GB model is involved. What is checked is the machinery a real run
 * depends on and that a live run cannot easily prove: resume from `done` rather
 * than re-asking, the fingerprint that stops answers being grafted onto pages
 * they were not about, cancel, join-don't-restart, and the live/not-live
 * distinction that decides whether opening a book may load a model.
 *
 * Every assertion here is about a page NOT being re-asked or NOT being
 * mislabelled — the two ways this component can waste GPU-hours or corrupt a
 * prediction set, neither of which is visible by watching it work.
 */
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DIST = path.join(__dirname, '..', 'dist', 'electron');
const BRIDGE = path.join(DIST, 'rubric-bridge.js');
const RUN = path.join(DIST, 'rubric-run.js');

// Every page the stub was asked about, so "did it re-ask?" is checkable.
let asked = [];
let failFrom = null;   // page index at which the stub starts erroring

const stub = {
  rubricClassify: async (req) => {
    for (const p of req.pages) asked.push(p.raw);
    if (failFrom !== null && asked.length > failFrom) {
      return { success: false, error: 'stub failure' };
    }
    // Small delay so cancel can land mid-run.
    await new Promise(r => setTimeout(r, 5));
    return { success: true, answers: req.pages.map(p => `ANSWER(${p.raw})`) };
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => {
    try { return Module._resolveFilename(request, parent, isMain); } catch { return null; }
  })();
  if (resolved === BRIDGE) return stub;
  return origLoad.apply(this, arguments);
};

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubric-run-test-'));

function freshManager() {
  // Drop the module from cache so each "app start" gets empty in-memory runs —
  // only the state directory carries over, which is exactly the restart case.
  delete require.cache[RUN];
  const m = require(RUN);
  m.rubricRunInit({ stateDir, emit: () => {} });
  return m;
}

const pages = (n, salt = '') => Array.from({ length: n }, (_, i) => ({
  page: i, system: 'sys', user: `u${i}`, raw: `prompt-${i}${salt}`,
}));

const base = {
  bookKey: 'hashABC', endpoint: 'http://x', backend: 'ollama',
  model: 'rubric-v3-4b', adapter: 'rubric-v3-4b', chunk: 4,
};

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok    ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const settle = async (m, key) => {
  for (let i = 0; i < 400; i++) {
    const s = m.rubricRunAttach(key);
    if (s && s.status !== 'running') return s;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('run never settled');
};

async function main() {
  console.log('\n1. a clean run answers every page exactly once');
  {
    asked = []; failFrom = null;
    const m = freshManager();
    m.rubricRunStart({ ...base, pages: pages(10) });
    const s = await settle(m, base.bookKey);
    check('status done', s.status === 'done', s.status);
    check('10 of 10', s.done === 10 && s.total === 10, `${s.done}/${s.total}`);
    check('no page asked twice', new Set(asked).size === 10 && asked.length === 10,
      `${asked.length} asks`);
    check('answers are in page order',
      s.answers.every((a, i) => a === `ANSWER(prompt-${i})`));
  }

  console.log('\n2. a failure keeps the pages already answered');
  {
    asked = []; failFrom = 4;   // first chunk of 4 lands, the second errors
    fs.rmSync(stateDir, { recursive: true, force: true });
    const m = freshManager();
    m.rubricRunStart({ ...base, pages: pages(12) });
    const s = await settle(m, base.bookKey);
    check('status error', s.status === 'error', s.status);
    check('kept the first chunk', s.done === 4, `done=${s.done}`);
    check('first 4 answers present',
      s.answers.slice(0, 4).every(a => typeof a === 'string'));
    check('rest still null', s.answers.slice(4).every(a => a === null));
  }

  console.log('\n3. restarting the SAME question resumes instead of re-asking');
  {
    // Continues from the state left by test 2: done=4 of 12, persisted.
    asked = []; failFrom = null;
    const m = freshManager();           // fresh module = the app restarted
    const attached = m.rubricRunAttach(base.bookKey);
    check('attach finds the interrupted run after a restart',
      !!attached && attached.done === 4 && attached.total === 12,
      attached ? `${attached.done}/${attached.total}` : 'null');
    // The crux: a disk-recovered run must NOT look live, or the renderer would
    // auto-resume it and load the model just because a book was opened.
    check('a disk-recovered run is not live', attached.live === false,
      `live=${attached.live}`);
    check('...but still reports running so it is resumable',
      attached.status === 'running', attached.status);
    m.rubricRunStart({ ...base, pages: pages(12) });
    const s = await settle(m, base.bookKey);
    check('finished', s.status === 'done' && s.done === 12, `${s.status} ${s.done}`);
    check('asked only the remaining 8', asked.length === 8, `${asked.length} asks`);
    check('did not re-ask page 0', !asked.includes('prompt-0'));
    check('answers 0-3 survived from before',
      s.answers[0] === 'ANSWER(prompt-0)' && s.answers[3] === 'ANSWER(prompt-3)');
  }

  console.log('\n4. a DIFFERENT question discards the old answers');
  {
    asked = []; failFrom = 4;
    fs.rmSync(stateDir, { recursive: true, force: true });
    let m = freshManager();
    m.rubricRunStart({ ...base, pages: pages(12) });
    await settle(m, base.bookKey);      // error at done=4, persisted

    asked = []; failFrom = null;
    m = freshManager();
    // Same book key, same page count, different prompts — a re-OCR, an edited
    // block, a different encoder version.
    m.rubricRunStart({ ...base, pages: pages(12, '-v2') });
    const s = await settle(m, base.bookKey);
    check('started over', asked.length === 12, `${asked.length} asks`);
    check('no answer from the old question survived',
      s.answers.every((a, i) => a === `ANSWER(prompt-${i}-v2)`));
  }

  console.log('\n5. cancel stops the run and keeps what landed');
  {
    asked = []; failFrom = null;
    fs.rmSync(stateDir, { recursive: true, force: true });
    const m = freshManager();
    m.rubricRunStart({ ...base, pages: pages(200) });
    await new Promise(r => setTimeout(r, 20));
    const res = m.rubricRunCancel(base.bookKey);
    check('cancel reported', res.cancelled === true);
    const s = await settle(m, base.bookKey);
    check('status cancelled', s.status === 'cancelled', s.status);
    check('stopped early', s.done > 0 && s.done < 200, `done=${s.done}`);
    check('done matches the answers recorded',
      s.answers.filter(a => a !== null).length === s.done);
    check('runActive is false afterwards', m.rubricRunActive() === false);

    // And a resume picks up from the cancel point.
    const stoppedAt = s.done;
    asked = [];
    m.rubricRunStart({ ...base, pages: pages(200) });
    const s2 = await settle(m, base.bookKey);
    check('resumed after cancel', s2.done === 200 && s2.status === 'done');
    check('re-asked only what was left', asked.length === 200 - stoppedAt,
      `${asked.length} vs ${200 - stoppedAt}`);
  }

  console.log('\n6. joining a live run does not restart it');
  {
    asked = []; failFrom = null;
    fs.rmSync(stateDir, { recursive: true, force: true });
    const m = freshManager();
    m.rubricRunStart({ ...base, pages: pages(100) });
    await new Promise(r => setTimeout(r, 20));
    const joined = m.rubricRunStart({ ...base, pages: pages(100) });
    check('join returned the live state',
      joined.status === 'running' && joined.live === true);
    // The reload case: a fresh renderer attaching mid-run sees live, so it
    // watches instead of starting anything.
    const watched = m.rubricRunAttach(base.bookKey);
    check('attaching to a working run reports live', watched.live === true);
    const s = await settle(m, base.bookKey);
    check('each page asked once despite two starts',
      asked.length === 100 && new Set(asked).size === 100, `${asked.length} asks`);
    check('finished once', s.done === 100 && s.status === 'done');
  }

  console.log('\n7. a run with no pages is rejected, not silently empty');
  {
    const m = freshManager();
    let threw = false;
    try { m.rubricRunStart({ ...base, bookKey: 'empty', pages: [] }); }
    catch { threw = true; }
    check('threw', threw);
    let threwRaw = false;
    try {
      m.rubricRunStart({ ...base, bookKey: 'noraw',
        pages: [{ page: 0, system: 's', user: 'u', raw: '' }] });
    } catch { threwRaw = true; }
    check('a page without a templated prompt is rejected', threwRaw);
  }

  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILURES\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
