#!/usr/bin/env node
/**
 * A PUBLISH IS A MERGE, AND IT IS NEVER SUCCESSFUL OVER A HOLE.
 *
 *   npx tsc -p tsconfig.electron.json && /bin/cp -R electron/prompts electron/data dist/electron/
 *   node tools/test-session-cache-merge.js
 *
 * The finding (bug hunt 2026-09-20, S11 — *Hitler's People*, HIGH, data loss):
 * `cacheSessionToProject` opened with an idempotency shortcut — *"if the
 * destination already has a valid cached session, return early … skipping
 * re-copy"* — whose whole test was `findCachedSessionLayout(destDir)`, i.e.
 * "there is a `chapters/sentences` under this directory". It compared nothing.
 *
 *   02:39  the app quit mid-render; the interrupt path published 5 chunks
 *   13:06  the render resumed and wrote all 2267 chunks to scratch
 *   13:39  the completion path called the publish, hit the shortcut, returned
 *          `success: true`, and logged "Session cached to project on completion"
 *
 * 2262 chunks never left scratch. The alignment and the assembly read the
 * five-chunk cache and failed on "chapter 1 is missing chunk audio …/1.flac".
 * Nothing was lost on disk and nothing anywhere said why.
 *
 * The two sibling comparisons — the interrupt-cache's *"cache already at least
 * as complete"* and the startup rescue's *"project cache is already at least as
 * complete"* — did compare, but they compared COUNTS, and a count cannot tell
 * 5 chunks from a DIFFERENT 5 chunks.
 *
 * So the rule under test: **the durable cache is the UNION of everything ever
 * rendered for that session, and a publish never returns success while the
 * source holds a chunk the cache lacks.** One module owns it
 * (`electron/session-cache-merge.ts`) and all three sites ask it.
 *
 * Real filesystem, temp dirs only, no network, no GPU, no library: every case
 * below builds an e2a-shaped session (`ebook-<uuid>/<hash>/chapters/sentences/`)
 * and drives the real bridge over it.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

if (!fs.existsSync(path.join(DIST, 'parallel-tts-bridge.js'))
  || !fs.existsSync(path.join(DIST, 'session-cache-merge.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}
if (!fs.existsSync(path.join(DIST, 'data', 'rvc-voice-assets.json'))) {
  console.error(
    'dist/electron/data/rvc-voice-assets.json is missing — this suite loads the whole bridge, '
    + 'which reads it at import.\n'
    + '  npx tsc -p tsconfig.electron.json && /bin/cp -R electron/prompts electron/data dist/electron/');
  process.exitCode = 1;
  return;
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-session-cache-merge-'));
const USER_DATA = path.join(WORK, 'userData');
fs.mkdirSync(USER_DATA, { recursive: true });
process.env.BOOKFORGE_USER_DATA = USER_DATA;
process.env.BOOKFORGE_USERDATA_DIR = USER_DATA;
require(path.join(REPO, 'cli', 'electron-stub.js'));

const cacheMerge = require(path.join(DIST, 'session-cache-merge.js'));
const bridge = require(path.join(DIST, 'parallel-tts-bridge.js'));

const merge = require(path.join(DIST, 'session-cache-merge.js'));
const BRIDGE_TS = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
const TTS_STEP_TS = fs.readFileSync(
  path.join(REPO, 'electron', 'queue-steps', 'tts-conversion.ts'), 'utf8');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(err && err.message).split('\n').join('\n        ')}`);
    process.exitCode = 1;
  }
}

// ── session fixtures ────────────────────────────────────────────────────────
const HASH = 'a1b2c3d4e5f6';
const pad = (i) => String(i).padStart(4, '0');

/**
 * An e2a-shaped session. `chunks` is the set of indices rendered; `ageSeconds`
 * backdates every file, so "the source is newer" is a stated fact rather than a
 * race with the clock (`NEWER_BY_MS` is 1 s).
 */
function makeSession(sessionDir, { chunks, body = 'AUDIO', ageSeconds = 0, sidecars = true }) {
  const processDir = path.join(sessionDir, HASH);
  const sentences = path.join(processDir, 'chapters', 'sentences');
  fs.mkdirSync(sentences, { recursive: true });
  fs.writeFileSync(path.join(processDir, 'session-state.json'), JSON.stringify({
    chapter_sentences: [['one sentence', 'another']],
    chapters_dir: path.join(processDir, 'chapters'),
    chapters_dir_sentences: sentences,
  }, null, 2));
  fs.writeFileSync(path.join(sentences, 'gaps.json'), JSON.stringify({ '0': 0.6 }));
  for (const i of chunks) {
    fs.writeFileSync(path.join(sentences, `${pad(i)}.flac`), `${body}-${i}`);
    if (sidecars) {
      fs.writeFileSync(
        path.join(sentences, `${pad(i)}.flac.provenance.json`),
        JSON.stringify({ index: i, body }));
    }
  }
  if (ageSeconds) backdate(sessionDir, ageSeconds);
  return { sessionDir, processDir, sentences };
}

/** Backdate every file under `dir` by `seconds`, so mtime comparisons are exact. */
function backdate(dir, seconds) {
  const when = new Date(Date.now() - seconds * 1000);
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else fs.utimesSync(p, when, when);
    }
  };
  walk(dir);
}

const cacheDirFor = (projectDir, language, sessionName) =>
  path.join(projectDir, 'stages', '03-tts', 'sessions', language, sessionName);

/** Chunk indices in a published cache, read back off disk. */
async function cachedIndices(projectDir, language, sessionName) {
  return merge.renderedChunkSet(
    path.join(cacheDirFor(projectDir, language, sessionName), HASH, 'chapters', 'sentences'));
}

/** Run `fn` with console.log/error captured, and hand back the lines. */
async function withCapturedLog(fn) {
  const lines = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
}

let caseNo = 0;
const caseDir = (tag) => {
  const dir = path.join(WORK, `case-${++caseNo}-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  console.log('1. OWEN\'S CASE — a five-chunk cache and a 2267-chunk render');
  // ───────────────────────────────────────────────────────────────────────────

  await check('cache {0,4,8,11,15} + source 0..2266 → the cache ends with all 2267, success', async () => {
    const root = caseDir('owen');
    const project = path.join(root, 'project');
    const scratch = path.join(root, 'scratch');
    const NAME = 'ebook-3f7c1a20';
    const ALL = Array.from({ length: 2267 }, (_, i) => i);

    // 02:39 — the interrupt path published five chunks and no more.
    makeSession(cacheDirFor(project, 'en', NAME), {
      chunks: [0, 4, 8, 11, 15], body: 'INTERRUPT', ageSeconds: 40000,
    });
    // 13:06–13:39 — the resumed render wrote every chunk to scratch.
    const source = makeSession(path.join(scratch, NAME), { chunks: ALL, body: 'FULL' });

    const { value: result, lines } = await withCapturedLog(
      () => bridge.cacheSessionToProject(source.sessionDir, project, 'en'));

    assert.strictEqual(result.success, true, `the publish must succeed: ${result.error}`);
    const cached = await cachedIndices(project, 'en', NAME);
    assert.strictEqual(cached.size, 2267,
      `the cache must hold every rendered chunk; it holds ${cached.size}`);
    for (const i of [0, 1, 2266]) {
      assert.ok(cached.has(i), `chunk ${i} never reached the cache`);
    }
    // The five the interrupt wrote are the OLDER render of those indices; the
    // newer one supersedes them (`newerInSource`), or a correction pass could
    // never reach the cache either.
    const chunk4 = fs.readFileSync(path.join(
      cacheDirFor(project, 'en', NAME), HASH, 'chapters', 'sentences', '0004.flac'), 'utf8');
    assert.strictEqual(chunk4, 'FULL-4',
      'a chunk the source rendered again, newer, must replace the interrupted one');
    // And the answer names the sentences dir the chunks actually went into.
    assert.strictEqual(
      path.resolve(result.cachedSentencesDir),
      path.resolve(cacheDirFor(project, 'en', NAME), HASH, 'chapters', 'sentences'),
      'the publish must answer with the sentences dir it merged into');

    const byNumbers = lines.find(l => /cache had 5, source had 2267/.test(l));
    assert.ok(byNumbers, `the log must say what it did by number; got:\n${lines.join('\n')}`);
    assert.ok(/cache now has 2267/.test(byNumbers), `and what the cache holds now: ${byNumbers}`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('2. THE CACHE IS ALREADY AHEAD — nothing is copied, and it says so');
  // ───────────────────────────────────────────────────────────────────────────

  await check('cache ⊇ source → success, no chunk overwritten, both counts in the log', async () => {
    const root = caseDir('ahead');
    const project = path.join(root, 'project');
    const scratch = path.join(root, 'scratch');
    const NAME = 'ebook-aa11bb22';

    const source = makeSession(path.join(scratch, NAME), {
      chunks: [0, 1, 2, 3, 4], body: 'OLD', ageSeconds: 600,
    });
    makeSession(cacheDirFor(project, 'en', NAME), {
      chunks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], body: 'CACHE',
    });

    const { value: result, lines } = await withCapturedLog(
      () => bridge.cacheSessionToProject(source.sessionDir, project, 'en'));

    assert.strictEqual(result.success, true, `nothing owed is a success: ${result.error}`);
    const cached = await cachedIndices(project, 'en', NAME);
    assert.strictEqual(cached.size, 10, 'the cache must keep every chunk it had');
    const chunk2 = fs.readFileSync(path.join(
      cacheDirFor(project, 'en', NAME), HASH, 'chapters', 'sentences', '0002.flac'), 'utf8');
    assert.strictEqual(chunk2, 'CACHE-2',
      'an OLDER source render must not overwrite the cache — the union keeps the newer one');

    const byNumbers = lines.find(l => /cache had 10, source had 5/.test(l));
    assert.ok(byNumbers,
      `"skipping re-copy" must never appear without the numbers that justify it; got:\n${lines.join('\n')}`);
    assert.ok(/copied 0 file\(s\)/.test(byNumbers), `and it copied nothing: ${byNumbers}`);
    assert.ok(!lines.some(l => /skipping re-copy/.test(l)),
      'the bare shortcut line is gone');
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('3. A COPY THAT FAILS — success: false, named, and nothing deleted');
  // ───────────────────────────────────────────────────────────────────────────

  await check('one chunk that cannot be written → success: false naming the count and the index', async () => {
    const root = caseDir('failed-copy');
    const project = path.join(root, 'project');
    const scratch = path.join(root, 'scratch');
    const NAME = 'ebook-cc33dd44';

    // The cache's two chunks are the NEWER render of those indices, so the union
    // keeps them; 2 and 3 are only in the source and must be published.
    const source = makeSession(path.join(scratch, NAME), {
      chunks: [0, 1, 2, 3], body: 'SRC', ageSeconds: 600,
    });
    const cache = makeSession(cacheDirFor(project, 'en', NAME), { chunks: [0, 1], body: 'CACHE' });
    // A DIRECTORY where a chunk belongs: what a half-finished copy over SMB
    // leaves behind, and a rename onto it fails (EISDIR) the way a full volume
    // or a permission would.
    fs.mkdirSync(path.join(cache.sentences, '0003.flac'));

    const result = await bridge.cacheSessionToProject(source.sessionDir, project, 'en');

    assert.strictEqual(result.success, false, 'a publish over a hole is not a success');
    assert.ok(/missing 1 of the 4 rendered chunk/.test(result.error),
      `the error must count what is missing; got: ${result.error}`);
    assert.ok(/Missing: 3\b/.test(result.error),
      `and name the index; got: ${result.error}`);
    assert.ok(result.error.includes(source.sentences),
      `and say where the audio still is; got: ${result.error}`);

    // NOTHING DELETED — the cache keeps what it had, and gains what it could.
    assert.strictEqual(fs.readFileSync(path.join(cache.sentences, '0000.flac'), 'utf8'), 'CACHE-0');
    assert.strictEqual(fs.readFileSync(path.join(cache.sentences, '0001.flac'), 'utf8'), 'CACHE-1');
    assert.strictEqual(fs.readFileSync(path.join(cache.sentences, '0002.flac'), 'utf8'), 'SRC-2',
      'the chunks that COULD be published still were');
    assert.ok(fs.existsSync(path.join(cache.sentences, '0003.flac')),
      'the obstruction is left exactly as found — this function never deletes in the cache');
    assert.ok(!fs.existsSync(path.join(cache.sentences, '.tmp-0003.flac')),
      'and the half-written temp name is cleaned up, not left for the next publish to inherit');
  });

  await check('mergeSessionTree reports every failure, not the first', async () => {
    const root = caseDir('inject');
    const source = makeSession(path.join(root, 'ebook-x'), { chunks: [0, 1, 2], body: 'SRC' });
    const dest = path.join(root, 'cache', 'ebook-x');
    const report = await merge.mergeSessionTree(source.sessionDir, dest, {
      copyFile: async (from, to) => {
        if (/000[12]\.flac$/.test(to)) throw new Error('EROFS: read-only file system');
        await merge.copyFileAtomic(from, to);
      },
    });
    assert.strictEqual(report.failures.length, 2,
      `both refusals must be reported; got ${JSON.stringify(report.failures)}`);
    assert.ok(report.copied.some(r => r.endsWith('0000.flac')),
      'and the files that could be copied were');
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('4. "AT LEAST AS COMPLETE" IS A SUPERSET, NOT A COUNT');
  // ───────────────────────────────────────────────────────────────────────────

  await check('a BIGGER cache missing one chunk the source has is NOT at least as complete', () => {
    const cache = new Set([0, 1, 2, 3, 4, 5]);
    const source = new Set([0, 1, 2, 9]);
    assert.strictEqual(cache.size > source.size, true, 'the count says the cache is ahead');
    assert.strictEqual(merge.cacheIsAtLeastAsComplete(cache, source), false,
      'and the count is wrong: chunk 9 is only in the source');
    assert.deepStrictEqual(merge.missingFrom(cache, source), [9]);
    assert.strictEqual(merge.cacheIsAtLeastAsComplete(new Set([0, 1, 2, 9, 11]), source), true);
  });

  await check('both guards ask that one function — no `>=` comparison survives', () => {
    for (const marker of [
      'Interrupt-cache skipped — cache already holds every chunk this session has',
      'Scratch rescue skipped — project cache already holds every chunk this session has',
    ]) {
      assert.ok(BRIDGE_TS.includes(marker), `the guard must say what it compared: ${marker}`);
    }
    assert.strictEqual(
      (BRIDGE_TS.match(/cacheIsAtLeastAsComplete\(/g) || []).length, 2,
      'the interrupt-cache and the rescue both call it, and nothing else re-derives it');
    assert.ok(!/existing >= ours/.test(BRIDGE_TS), 'the count comparison is gone from the flush');
    assert.ok(!/cached\.find\(s => s\.language === language\)\?\.sentenceCount/.test(BRIDGE_TS),
      'and from the rescue');
  });

  await check('the startup rescue MERGES a scratch session into a cache that is merely bigger', async () => {
    const root = caseDir('rescue');
    const project = path.join(root, 'project');
    const scratch = path.join(root, 'scratch');
    const NAME = 'ebook-ee55ff66';

    // The cache holds five chunks; the orphaned scratch session holds two, one
    // of which (9) the cache has never seen. The old `cached >= ours` skipped
    // this and the sweep behind it deleted chunk 9.
    makeSession(cacheDirFor(project, 'en', NAME), {
      chunks: [0, 1, 2, 3, 4], body: 'CACHE', ageSeconds: 600,
    });
    const source = makeSession(path.join(scratch, NAME), { chunks: [0, 9], body: 'SCRATCH' });
    fs.writeFileSync(path.join(source.sessionDir, 'bookforge-session.json'), JSON.stringify({
      jobId: 'step_rescue', bfpPath: project, language: 'en',
      epubPath: path.join(root, 'book.epub'), createdAt: new Date().toISOString(),
      host: os.hostname(), pid: process.pid,
    }, null, 2));

    const outcome = await bridge.rescueOrphanedScratchSessions(scratch);
    assert.strictEqual(outcome.rescued, 1,
      `the session must be rescued, not skipped: ${JSON.stringify(outcome)}`);
    const cached = await cachedIndices(project, 'en', NAME);
    assert.deepStrictEqual([...cached].sort((a, b) => a - b), [0, 1, 2, 3, 4, 9],
      'the cache is the UNION: it keeps its five and gains the one only scratch had');
    assert.strictEqual(
      fs.readFileSync(path.join(cacheDirFor(project, 'en', NAME), HASH,
        'chapters', 'sentences', '0009.flac'), 'utf8'),
      'SCRATCH-9');
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('5. SIDECARS TRAVEL WITH THEIR CHUNK');
  // ───────────────────────────────────────────────────────────────────────────

  await check('a merged chunk brings its .provenance.json, and gaps.json comes too', async () => {
    const root = caseDir('sidecars');
    const project = path.join(root, 'project');
    const scratch = path.join(root, 'scratch');
    const NAME = 'ebook-1122aabb';

    makeSession(cacheDirFor(project, 'en', NAME), { chunks: [0], body: 'CACHE', ageSeconds: 600 });
    const source = makeSession(path.join(scratch, NAME), { chunks: [0, 1, 2], body: 'SRC' });

    const result = await bridge.cacheSessionToProject(source.sessionDir, project, 'en');
    assert.strictEqual(result.success, true, result.error);

    const sentences = path.join(cacheDirFor(project, 'en', NAME), HASH, 'chapters', 'sentences');
    for (const i of [1, 2]) {
      assert.ok(fs.existsSync(path.join(sentences, `${pad(i)}.flac`)), `chunk ${i} is in the cache`);
      assert.ok(fs.existsSync(path.join(sentences, `${pad(i)}.flac.provenance.json`)),
        `chunk ${i}'s provenance sidecar travelled with it — a chunk with no provenance `
        + 'cannot be re-rendered or explained');
    }
    assert.ok(fs.existsSync(path.join(sentences, 'gaps.json')),
      'gaps.json is what the assembler realizes as silence; it is part of the session');
    const state = JSON.parse(fs.readFileSync(path.join(
      cacheDirFor(project, 'en', NAME), HASH, 'session-state.json'), 'utf8'));
    assert.strictEqual(path.resolve(state.chapters_dir_sentences), path.resolve(sentences),
      'and session-state.json was re-pointed at the cache, not left naming scratch');
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('6. THE FRESH PUBLISH IS CHECKED THE SAME WAY');
  // ───────────────────────────────────────────────────────────────────────────

  await check('a first publish lands every chunk and verifies the set before saying so', async () => {
    const root = caseDir('fresh');
    const project = path.join(root, 'project');
    const scratch = path.join(root, 'scratch');
    const NAME = 'ebook-99887766';
    const source = makeSession(path.join(scratch, NAME), {
      chunks: [0, 1, 2, 3, 4, 5, 6, 7], body: 'SRC',
    });

    const result = await bridge.cacheSessionToProject(source.sessionDir, project, 'en');
    assert.strictEqual(result.success, true, result.error);
    const cached = await cachedIndices(project, 'en', NAME);
    assert.strictEqual(cached.size, 8);
    const plan = await merge.publishPlan(source.sentences,
      path.join(cacheDirFor(project, 'en', NAME), HASH, 'chapters', 'sentences'));
    assert.deepStrictEqual(plan.missing, [], 'nothing is owed after a fresh publish');

    // The branch is short and its verification cannot be reached from outside,
    // so the shape is asserted: the fresh arm runs the same plan and can return
    // the same refusal.
    // Anchored on a line that exists ONCE: "// Rename temp dir to final name"
    // also opens `cacheSessionToBfp`, and slicing from the wrong function is how
    // a shape check passes over code it never read.
    const freshArm = BRIDGE_TS.slice(BRIDGE_TS.indexOf('// THE SET IS CHECKED ON THIS BRANCH TOO'));
    assert.ok(freshArm.length > 200, 'the fresh arm must be found before it is read');
    assert.ok(/const cacheNow = await renderedChunkSet\(destSentencesDir\)/.test(freshArm)
      && /missingFrom\(cacheNow, renderedSet\)/.test(freshArm),
      'the fresh publish must verify the cache against the set the render MADE — captured '
      + 'before anything moved, because a hand-over empties the source and a comparison '
      + 'against an empty source passes over every hole');
    assert.ok(freshArm.indexOf('missingChunksSentence(fresh.missing')
      < freshArm.indexOf('success: true'),
      'and it must be able to refuse BEFORE it reports success');
  });

  await check('a resume whose source IS the cache is a no-op success, never a self-copy', async () => {
    const root = caseDir('same-path');
    const project = path.join(root, 'project');
    const NAME = 'ebook-5a5a5a5a';
    const inCache = makeSession(cacheDirFor(project, 'en', NAME), { chunks: [0, 1, 2], body: 'CACHE' });

    const result = await bridge.cacheSessionToProject(inCache.sessionDir, project, 'en');
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(fs.readFileSync(path.join(inCache.sentences, '0001.flac'), 'utf8'), 'CACHE-1',
      'copying a file onto itself truncates it — the same-path case must not copy at all');
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('7. THE CALLER FAILS THE STEP');
  // ───────────────────────────────────────────────────────────────────────────

  // ── 8. A PUBLISH THAT TAKES MINUTES SAYS SO ────────────────────────────────
  //
  // Owen, 2026-09-20, on a *Shift* whose render had just finished: *"it moved to
  // CPU and just sat there for like 10 minutes. im getting no indication of
  // whats happening, and i have no idea if its locked up or what."* It was
  // copying 1,637 chunks — 2.5 GB — into the library at ~200 files a minute,
  // with every bar on the row reading done.
  //
  // So the publish reports, on both branches, and the two reports that matter
  // are the FIRST (before a byte moves, so a slow copy is never silent) and the
  // LAST (after the set comparison, so a full bar means the cache holds every
  // chunk the render made — never "the copy loop ran out of files").

  await check('a fresh publish announces itself and reports a verified full bar', async () => {
    const root = caseDir('reports-fresh');
    const project = path.join(root, 'project');
    const scratch = path.join(root, 'scratch');
    const source = makeSession(path.join(scratch, 'ebook-77aa77aa'), { chunks: [0, 1, 2, 3] });

    const seen = [];
    const result = await bridge.cacheSessionToProject(source.sessionDir, project, 'en', {
      onProgress: (p) => seen.push(p),
    });
    assert.strictEqual(result.success, true, result.error);
    assert.ok(seen.length >= 2, `the publish reported ${seen.length} time(s); expected a first and a last`);
    assert.deepStrictEqual(seen[0], { copied: 0, total: 4 },
      'the first report goes out before the copy starts, naming what it owes');
    assert.deepStrictEqual(seen[seen.length - 1], { copied: 4, total: 4 },
      'and the last says every chunk landed');
  });

  await check('a merge publish reports too, over the cache it is merging into', async () => {
    const root = caseDir('reports-merge');
    const project = path.join(root, 'project');
    const scratch = path.join(root, 'scratch');
    const NAME = 'ebook-88bb88bb';
    makeSession(cacheDirFor(project, 'en', NAME), { chunks: [0], body: 'CACHE', ageSeconds: 600 });
    const source = makeSession(path.join(scratch, NAME), { chunks: [0, 1, 2], body: 'SRC' });

    const seen = [];
    const result = await bridge.cacheSessionToProject(source.sessionDir, project, 'en', {
      onProgress: (p) => seen.push(p),
    });
    assert.strictEqual(result.success, true, result.error);
    assert.deepStrictEqual(seen[0], { copied: 0, total: 3 });
    assert.deepStrictEqual(seen[seen.length - 1], { copied: 3, total: 3 });
  });

  await check('a publish that drops a chunk never reports a full bar', async () => {
    const root = caseDir('reports-hole');
    const project = path.join(root, 'project');
    const scratch = path.join(root, 'scratch');
    const source = makeSession(path.join(scratch, 'ebook-99cc99cc'), { chunks: [0, 1, 2] });
    // The destination is a FILE where the session must go, so the copy fails.
    const langDir = path.join(project, 'stages', '03-tts', 'sessions', 'en');
    fs.mkdirSync(langDir, { recursive: true });
    fs.writeFileSync(path.join(langDir, 'ebook-99cc99cc'), 'not a directory');

    const seen = [];
    const result = await bridge.cacheSessionToProject(source.sessionDir, project, 'en', {
      onProgress: (p) => seen.push(p),
    });
    assert.strictEqual(result.success, false, 'the publish could not land the session');
    assert.ok(!seen.some((p) => p.copied === p.total && p.total > 0),
      'and it never showed a full bar for a cache that does not hold the render');
  });

  // ── 9. HANDING THE SESSION OVER MOVES IT ───────────────────────────────────
  //
  // Measured on the live library share, 2026-09-20: chunk-sized files copy at
  // 4.7 files/s (0.21 s of round trip each), while renaming a directory of 100
  // takes 0.05 s. The scratch session and the project cache are the same
  // filesystem on every ordinary install — the scratch root is derived from the
  // library root, whichever machine rendered the book — so publishing *Shift*
  // spent six minutes dragging 2.5 GB across SMB to land it a few directories
  // away.
  //
  // So a caller that has finished with the session says so, and the publish
  // MOVES it. What must stay true either way: the cache is the union, the
  // success is a set comparison, and a chunk that cannot be placed is still
  // wherever it was.

  await check('a hand-over moves the session — the cache holds it, scratch is gone', async () => {
    const root = caseDir('handover-fresh');
    const project = path.join(root, 'project');
    const scratch = path.join(root, 'scratch');
    const source = makeSession(path.join(scratch, 'ebook-aa11bb22'), { chunks: [0, 1, 2] });

    const result = await bridge.cacheSessionToProject(source.sessionDir, project, 'en', {
      consumeSource: true,
    });
    assert.strictEqual(result.success, true, result.error);

    const sentences = path.join(
      cacheDirFor(project, 'en', 'ebook-aa11bb22'), HASH, 'chapters', 'sentences');
    for (const i of [0, 1, 2]) {
      assert.ok(fs.existsSync(path.join(sentences, `${pad(i)}.flac`)), `chunk ${i} is in the cache`);
    }
    assert.ok(!fs.existsSync(source.sessionDir),
      'the scratch session was handed over, not copied — nothing is left behind to sweep');
  });

  await check('a hand-over merge still keeps the cache’s newer render of a chunk', async () => {
    const root = caseDir('handover-merge');
    const project = path.join(root, 'project');
    const scratch = path.join(root, 'scratch');
    const NAME = 'ebook-bb22cc33';
    // The cache's chunk 0 is the NEWER render; the source's 1 and 2 are new.
    const source = makeSession(path.join(scratch, NAME), {
      chunks: [0, 1, 2], body: 'SRC', ageSeconds: 600,
    });
    const cache = makeSession(cacheDirFor(project, 'en', NAME), { chunks: [0], body: 'CACHE' });

    const result = await bridge.cacheSessionToProject(source.sessionDir, project, 'en', {
      consumeSource: true,
    });
    assert.strictEqual(result.success, true, result.error);

    assert.strictEqual(fs.readFileSync(path.join(cache.sentences, '0000.flac'), 'utf8'), 'CACHE-0',
      'ADD, NEVER REMOVE survives the move: the newer cached render is untouched');
    assert.strictEqual(fs.readFileSync(path.join(cache.sentences, '0001.flac'), 'utf8'), 'SRC-1');
    assert.strictEqual(fs.readFileSync(path.join(cache.sentences, '0002.flac'), 'utf8'), 'SRC-2');
    assert.ok(!fs.existsSync(path.join(source.sentences, '0001.flac')),
      'and the chunks that moved are no longer in scratch');
  });

  await check('a hand-over that cannot place a chunk fails, and that chunk is still in scratch', async () => {
    const root = caseDir('handover-hole');
    const project = path.join(root, 'project');
    const scratch = path.join(root, 'scratch');
    const NAME = 'ebook-cc33ee44';
    const source = makeSession(path.join(scratch, NAME), {
      chunks: [0, 1, 2, 3], body: 'SRC', ageSeconds: 600,
    });
    const cache = makeSession(cacheDirFor(project, 'en', NAME), { chunks: [0], body: 'CACHE' });
    // A DIRECTORY where chunk 3 belongs: a rename onto it fails exactly as a
    // copy onto it does.
    fs.mkdirSync(path.join(cache.sentences, '0003.flac'));

    const result = await bridge.cacheSessionToProject(source.sessionDir, project, 'en', {
      consumeSource: true,
    });
    assert.strictEqual(result.success, false, 'a publish over a hole is never a success');
    assert.ok(/missing 1 of the 4 rendered chunk/.test(result.error),
      `the count is measured against what the render MADE, not against a source the move `
      + `emptied; got: ${result.error}`);
    assert.ok(fs.existsSync(path.join(source.sentences, '0003.flac')),
      'and the chunk that could not be placed is still in scratch — a failed move loses nothing');
  });

  await check('without a hand-over the source is left exactly where it is', async () => {
    const root = caseDir('no-handover');
    const project = path.join(root, 'project');
    const scratch = path.join(root, 'scratch');
    const source = makeSession(path.join(scratch, 'ebook-dd44ff55'), { chunks: [0, 1] });

    const result = await bridge.cacheSessionToProject(source.sessionDir, project, 'en');
    assert.strictEqual(result.success, true, result.error);
    for (const i of [0, 1]) {
      assert.ok(fs.existsSync(path.join(source.sentences, `${pad(i)}.flac`)),
        `chunk ${i} is still in scratch — the interrupt flush and the startup rescue both `
        + 'publish a session other things still read');
    }
  });

  await check('moveFileAtomic moves a file, making the directory it lands in', async () => {
    const root = caseDir('move-primitive');
    const from = path.join(root, 'from', 'x.flac');
    const to = path.join(root, 'to', 'deeper', 'x.flac');
    fs.mkdirSync(path.dirname(from), { recursive: true });
    fs.writeFileSync(from, 'AUDIO');
    await cacheMerge.moveFileAtomic(from, to);
    assert.strictEqual(fs.readFileSync(to, 'utf8'), 'AUDIO');
    assert.ok(!fs.existsSync(from), 'a move does not leave the source behind');
    assert.ok(!fs.existsSync(path.join(path.dirname(to), '.tmp-x.flac')),
      'and it needs no .tmp- sibling: rename is atomic by itself');
  });

  await check('the render hands its session over; the flush and the rescue do not', () => {
    const completion = BRIDGE_TS.slice(
      BRIDGE_TS.indexOf('// Cache TTS session to project BEFORE assembly'));
    assert.ok(/consumeSource: true/.test(completion.slice(0, 3000)),
      "the render's own publish hands the session over");
    assert.ok(/repointSessionAtCache\(session, cacheResult\)/.test(completion.slice(0, 4000)),
      'and re-points the session at the cache, because the scratch paths are gone');
    // The other three callers publish a session something else still reads: the
    // interrupt flush (the resume reads it back), the startup rescue, and the
    // IPC door. Each is asserted on its own call, not on a slice of the file —
    // `consumeSource` is declared in this module and appears above them all.
    for (const call of [
      /cacheSessionToProject\(sessionDir, owner\.bfpPath, language\)/,
      /const r = await cacheSessionToProject\(sessionDir, bfpPath, language\)/,
    ]) {
      assert.ok(call.test(BRIDGE_TS),
        `this caller must still publish by COPY, leaving the source: ${call}`);
    }
  });

  await check('the chapter closer finishes BEFORE the session is published', () => {
    const closer = BRIDGE_TS.indexOf('const closerManifest = await stopChapterCloser');
    const publish = BRIDGE_TS.indexOf('// Cache TTS session to project BEFORE assembly');
    assert.ok(closer > 0 && publish > 0, 'both landmarks are present');
    assert.ok(closer < publish,
      'a chapter closed after the publish never reaches the cache the assembly reads — '
      + 'and with the publish MOVING the session, it would be closing into a directory that had gone');
  });

  await check('tts-conversion throws on a publish that did not succeed', () => {
    const arm = TTS_STEP_TS.slice(TTS_STEP_TS.indexOf('const cached = await cacheSessionToProject('));
    assert.ok(/if \(!cached\.success\) \{\s*\n\s*throw new Error\(/.test(arm),
      'a `success: false` publish must fail the step, not fall through the `if`');
    assert.ok(/the alignment and the assembly read the project cache/.test(arm),
      'and the sentence must say why a finished render is being failed');
    assert.ok(!/console\.error\('\[QUEUE-STEP tts\] could not cache the session to the project/.test(arm),
      'the swallowing catch is gone');
  });

  // ───────────────────────────────────────────────────────────────────────────
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (failures.length) console.log(`failed: ${failures.join(', ')}`);
  fs.rmSync(WORK, { recursive: true, force: true });
})();
