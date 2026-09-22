#!/usr/bin/env node
/**
 * WORK IN PROGRESS IS LOCAL; THE SHARE RECEIVES FINISHED THINGS, ONCE.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-bounded-copy.js
 *
 * The finding (2026-09-21, measured on the live library): the library is ONE
 * shared tree on a NAS, reached over SMB by both machines, and the narrator
 * scratch root defaulted to `<library>/tmp` — INSIDE it — so that a publish
 * could be a same-volume rename. Over SMB that trade is backwards. A render
 * wrote every downloaded chunk (`<index>.flac` + `<index>.flac.provenance.json`,
 * ~3,400 files for a 1,700-chunk book), every `session-state.json` rewrite and
 * the whole prepare row onto the share AS IT WORKED, and then the publish copied
 * them all again into `.tmp-ebook-…` before the one rename. A burst of ~2,700
 * metadata operations wedged the Mac's SMB client and with it the whole machine,
 * twice in two days.
 *
 * So the scratch is machine-local now (`defaultNarratorScratchRoot`), every
 * publish crosses a volume, and two modules carry what that costs:
 *
 *   electron/bounded-copy.ts        four files in flight, each retried through a
 *                                   stated weather budget (2/5/10 s)
 *   electron/resume-materialize.ts  a resume brings the cached session DOWN —
 *                                   the pack and the skip set, not the whole
 *                                   tree — and renders on this machine
 *
 * Real filesystem, temp dirs only. No network, no library, no GPU.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

/*
 * `narrator-paths` statically requires `electron` and reaches the component
 * manager at import. The CLI's shim is the one answer to that — the same one a
 * headless render uses — and `BOOKFORGE_USER_DATA` keeps this suite off Owen's
 * own records. Neither is written to here; the module is only asked to state a
 * path.
 */
process.env.BOOKFORGE_USER_DATA = process.env.BOOKFORGE_USER_DATA
  || fs.mkdtempSync(path.join(os.tmpdir(), 'bf-bounded-ud-'));
require(path.join(REPO, 'cli', 'electron-stub.js'));

for (const mod of ['bounded-copy.js', 'resume-materialize.js', 'narrator-paths.js']) {
  if (!fs.existsSync(path.join(DIST, mod))) {
    console.error(`dist/electron/${mod} is missing — compile first: npx tsc -p tsconfig.electron.json`);
    process.exitCode = 1;
    return;
  }
}

const bounded = require(path.join(DIST, 'bounded-copy.js'));
const materialize = require(path.join(DIST, 'resume-materialize.js'));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-bounded-'));
let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err && err.message}`);
  }
}

const caseDir = (name) => {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** An `ebook-<uuid>/<hash>/` session with `chunks` rendered into it. */
function makeSession(sessionDir, { chunks, sidecars = true, chapters = [] }) {
  const processDir = path.join(sessionDir, 'abc123hash');
  const sentences = path.join(processDir, 'chapters', 'sentences');
  fs.mkdirSync(sentences, { recursive: true });
  fs.writeFileSync(path.join(processDir, 'session-state.json'), JSON.stringify({
    total_sentences: 8,
    chapter_sentences: [['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']],
    chapters: [{ chapter_num: 1, sentence_start: 0, sentence_end: 7, sentence_count: 8 }],
    total_chapters: 1,
    chapters_dir: path.join(processDir, 'chapters'),
    chapters_dir_sentences: sentences,
  }, null, 2));
  fs.writeFileSync(path.join(processDir, 'book.epub'), 'EPUB');
  for (const i of chunks) {
    const name = String(i).padStart(4, '0');
    fs.writeFileSync(path.join(sentences, `${name}.flac`), 'A'.repeat(4096));
    if (sidecars) {
      fs.writeFileSync(path.join(sentences, `${name}.flac.provenance.json`), '{"server":"x"}');
    }
  }
  for (const n of chapters) {
    fs.writeFileSync(path.join(processDir, 'chapters', `${n}.flac`), 'B'.repeat(65536));
  }
  return { sessionDir, processDir, sentences };
}

const errno = (code) => Object.assign(new Error(`${code}: injected`), { code });

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  console.log('1. THE CEILING IS REAL AND THE REPORT IS IN PLAN ORDER');
  // ───────────────────────────────────────────────────────────────────────────

  await check('runBounded never exceeds its limit, and answers in index order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await bounded.runBounded([...Array(25).keys()], 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n % 3));
      inFlight--;
      return n * 2;
    });
    assert.strictEqual(peak, 4, `at most four in flight; saw ${peak}`);
    assert.deepStrictEqual(out, [...Array(25).keys()].map((n) => n * 2),
      'results land at their own index — a shuffled report cannot be compared run to run');
  });

  await check('COPY_CONCURRENCY is the one stated number', () => {
    assert.strictEqual(bounded.COPY_CONCURRENCY, 4,
      'four: enough to hide the SMB round trip, few enough not to be the metadata burst');
    assert.deepStrictEqual([...bounded.WEATHER_BACKOFF_MS], [2000, 5000, 10000],
      'the retry budget is the contract — three retries, 17 s, per file');
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('2. WEATHER IS WAITED OUT; AN ANSWER IS NOT');
  // ───────────────────────────────────────────────────────────────────────────

  await check('EIO is weather, ENOENT is an answer', () => {
    assert.ok(bounded.isWeather(errno('EIO')), 'a soft mount answers EIO when it times out');
    assert.ok(bounded.isWeather(errno('ETIMEDOUT')));
    assert.ok(bounded.isWeather(errno('EHOSTDOWN')));
    assert.ok(!bounded.isWeather(errno('ENOENT')), 'a missing file will still be missing');
    assert.ok(!bounded.isWeather(errno('ENOSPC')));
    assert.ok(!bounded.isWeather(new Error('EROFS: read-only file system')),
      'an error with no code is not weather — retrying it spends the budget for nothing');
  });

  await check('retryWeather retries EIO within the budget and then gives up with the real error',
    async () => {
      let tries = 0;
      const got = await bounded.retryWeather(async () => {
        tries++;
        if (tries < 3) throw errno('EIO');
        return 'landed';
      }, { backoffMs: [1, 1, 1] });
      assert.strictEqual(got, 'landed');
      assert.strictEqual(tries, 3);

      let attempts = 0;
      await assert.rejects(
        () => bounded.retryWeather(async () => { attempts++; throw errno('EIO'); },
          { backoffMs: [1, 1, 1] }),
        /EIO/, 'the LAST error is thrown, so the caller can name what went wrong');
      assert.strictEqual(attempts, 4, 'one attempt plus three retries, and no more');
    });

  await check('a non-weather failure is not retried at all', async () => {
    let attempts = 0;
    await assert.rejects(
      () => bounded.retryWeather(async () => { attempts++; throw errno('ENOENT'); },
        { backoffMs: [1, 1, 1] }),
      /ENOENT/);
    assert.strictEqual(attempts, 1, 'ENOENT is an answer; asking again just delays it');
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('3. A TREE COPY REPORTS EVERY HOLE, NOT THE FIRST');
  // ───────────────────────────────────────────────────────────────────────────

  await check('copyTreeBounded copies the whole tree, dot files excepted', async () => {
    const root = caseDir('tree');
    const src = makeSession(path.join(root, 'ebook-a'), { chunks: [0, 1, 2] });
    fs.writeFileSync(path.join(src.sentences, '.tmp-0003.flac'), 'half');
    const dest = path.join(root, 'dest');

    const report = await bounded.copyTreeBounded(src.sessionDir, dest);
    assert.strictEqual(report.failures.length, 0, JSON.stringify(report.failures));
    for (const rel of ['abc123hash/session-state.json', 'abc123hash/book.epub',
      'abc123hash/chapters/sentences/0000.flac',
      'abc123hash/chapters/sentences/0002.flac.provenance.json']) {
      assert.ok(fs.existsSync(path.join(dest, rel)), `${rel} arrived`);
    }
    assert.ok(!fs.existsSync(path.join(dest, 'abc123hash/chapters/sentences/.tmp-0003.flac')),
      "another publish's half-written file is never carried over");
  });

  await check('one file giving up does not stop the rest, and is named', async () => {
    const root = caseDir('tree-fail');
    const src = makeSession(path.join(root, 'ebook-b'), { chunks: [0, 1, 2], sidecars: false });
    const dest = path.join(root, 'dest');
    const report = await bounded.copyTreeBounded(src.sessionDir, dest, {
      copyFile: async (from, to) => {
        if (/0001\.flac$/.test(to)) throw errno('ENOSPC');
        await fs.promises.copyFile(from, to);
      },
    });
    assert.strictEqual(report.failures.length, 1, JSON.stringify(report.failures));
    assert.ok(report.failures[0].rel.endsWith('0001.flac'), 'the failure names the file');
    assert.ok(fs.existsSync(path.join(dest, 'abc123hash/chapters/sentences/0002.flac')),
      'and everything else still travelled');
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('4. A RESUME BRINGS THE SKIP SET DOWN, NOT THE WHOLE BOOK TWICE');
  // ───────────────────────────────────────────────────────────────────────────

  await check('materializeSessionLocally copies the pack and the chunk audio', async () => {
    const root = caseDir('resume');
    const cache = makeSession(path.join(root, 'cache', 'ebook-c'), {
      chunks: [0, 1, 2], chapters: [1],
    });
    const scratch = path.join(root, 'scratch');
    fs.mkdirSync(scratch, { recursive: true });

    const report = await materialize.materializeSessionLocally(
      cache.sessionDir, cache.processDir, scratch);

    assert.strictEqual(report.failures.length, 0, JSON.stringify(report.failures));
    assert.strictEqual(path.basename(report.sessionDir), 'ebook-c',
      'the local session keeps the name, so ids and the publish destination do not move');
    assert.ok(fs.existsSync(path.join(report.processDir, 'session-state.json')),
      'the pack comes down — it is what the resume is judged against');
    for (const i of [0, 1, 2]) {
      assert.ok(fs.existsSync(path.join(report.sentencesDir, `000${i}.flac`)),
        `chunk ${i} is in the local skip set`);
    }
  });

  await check('it leaves behind what the render does not read', async () => {
    const root = caseDir('resume-lean');
    const cache = makeSession(path.join(root, 'cache', 'ebook-d'), {
      chunks: [0, 1], chapters: [1, 2],
    });
    const scratch = path.join(root, 'scratch');
    const report = await materialize.materializeSessionLocally(
      cache.sessionDir, cache.processDir, scratch);

    assert.ok(!fs.existsSync(path.join(report.sentencesDir, '0000.flac.provenance.json')),
      'the sidecar of an already-published chunk stays in the cache — half the files, for '
      + 'nothing the render reads, and the merge back never removes it');
    assert.ok(!fs.existsSync(path.join(report.processDir, 'chapters', '1.flac')),
      "the chapter closer's pre-encoded chapters are a second copy of the same audio");
  });

  await check('a truncated chunk is not carried into the skip set', async () => {
    const root = caseDir('resume-truncated');
    const cache = makeSession(path.join(root, 'cache', 'ebook-e'), { chunks: [0, 1] });
    fs.writeFileSync(path.join(cache.sentences, '0001.flac'), 'tiny');   // < RESUME_MIN_BYTES
    const scratch = path.join(root, 'scratch');
    const report = await materialize.materializeSessionLocally(
      cache.sessionDir, cache.processDir, scratch);

    assert.ok(fs.existsSync(path.join(report.sentencesDir, '0000.flac')));
    assert.ok(!fs.existsSync(path.join(report.sentencesDir, '0001.flac')),
      'a truncated write is one narrator re-renders anyway — copying it would put a file in '
      + 'the skip set that is not a rendered chunk');
  });

  await check('a second resume brings down only what the cache has gained', async () => {
    const root = caseDir('resume-twice');
    const cache = makeSession(path.join(root, 'cache', 'ebook-f'), { chunks: [0, 1] });
    const scratch = path.join(root, 'scratch');
    const first = await materialize.materializeSessionLocally(
      cache.sessionDir, cache.processDir, scratch);
    assert.ok(first.copied.length > 0);

    fs.writeFileSync(path.join(cache.sentences, '0002.flac'), 'A'.repeat(4096));
    const second = await materialize.materializeSessionLocally(
      cache.sessionDir, cache.processDir, scratch);
    assert.ok(second.copied.some((rel) => rel.endsWith('0002.flac')),
      'the new chunk arrives');
    assert.ok(!second.copied.some((rel) => rel.endsWith('0000.flac')),
      'and the ones already local are kept, not fetched again');
    assert.ok(second.kept > 0, 'which is what "kept" counts');
  });

  await check('the local work never touches the cache', async () => {
    const root = caseDir('resume-readonly');
    const cache = makeSession(path.join(root, 'cache', 'ebook-g'), { chunks: [0, 1] });
    const before = fs.readdirSync(cache.sentences).sort();
    const scratch = path.join(root, 'scratch');
    const report = await materialize.materializeSessionLocally(
      cache.sessionDir, cache.processDir, scratch);
    fs.writeFileSync(path.join(report.sentencesDir, '0002.flac'), 'A'.repeat(4096));
    assert.deepStrictEqual(fs.readdirSync(cache.sentences).sort(), before,
      'a render on this machine adds nothing to the share until the publish says so');
  });

  await check('handed the same directory twice, it copies nothing (copyFile would truncate)',
    async () => {
      const root = caseDir('resume-same');
      const scratch = path.join(root, 'scratch');
      fs.mkdirSync(scratch, { recursive: true });
      const session = makeSession(path.join(scratch, 'ebook-i'), { chunks: [0, 1] });
      const before = fs.statSync(path.join(session.sentences, '0000.flac')).size;

      // The same session, reached through a second spelling of its own root.
      const report = await materialize.materializeSessionLocally(
        session.sessionDir, session.processDir, scratch);
      assert.deepStrictEqual([...report.copied], [],
        'nothing is copied when the source IS the destination');
      assert.strictEqual(fs.statSync(path.join(session.sentences, '0000.flac')).size, before,
        'and the skip set is intact — copyFile(x, x) truncates, which would destroy the '
        + 'very thing this act exists to preserve');
    });

  await check('a failure to read the cache is reported, never swallowed', async () => {
    const root = caseDir('resume-fail');
    const cache = makeSession(path.join(root, 'cache', 'ebook-h'), { chunks: [0, 1] });
    const scratch = path.join(root, 'scratch');
    const report = await materialize.materializeSessionLocally(
      cache.sessionDir, cache.processDir, scratch, {
        copyFile: async (from, to) => {
          if (/0001\.flac$/.test(to)) throw errno('EACCES');
          await fs.promises.copyFile(from, to);
        },
      });
    assert.strictEqual(report.failures.length, 1, JSON.stringify(report.failures));
    assert.ok(report.failures[0].rel.endsWith('0001.flac'));
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('5. THE DEFAULT SCRATCH ROOT IS MACHINE-LOCAL, IN BOTH DOORS');
  // ───────────────────────────────────────────────────────────────────────────

  await check('defaultNarratorScratchRoot is ~/Documents/BookForge/scratch', () => {
    const narratorPaths = require(path.join(DIST, 'narrator-paths.js'));
    assert.strictEqual(
      narratorPaths.defaultNarratorScratchRoot(),
      path.join(os.homedir(), 'Documents', 'BookForge', 'scratch'),
      'beside the render cache and the foundry run dirs, NOT inside the shared library');
  });

  await check('the CLI resolves the app\'s own default, not a second spelling', () => {
    const src = fs.readFileSync(path.join(REPO, 'cli', 'narrator-sessions-root.js'), 'utf8');
    assert.ok(/narratorPaths\.defaultNarratorScratchRoot\(\)/.test(src),
      'a CLI that spelled the default itself would name a session directory the app never '
      + 'looks in (measured 2026-09-02, the duplicate narration-cuts pass)');
    assert.ok(!/path\.join\(libraryRoot, 'tmp'\)/.test(src),
      'and the library no longer decides it');
  });

  await check('main.ts states the same default and says nothing else about <library>/tmp', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'main.ts'), 'utf8');
    assert.ok(/setNarratorScratchRoot\(defaultNarratorScratchRoot\(\)\)/.test(src),
      'the app states the shared default');
    assert.ok(/noteLegacyLibraryScratch/.test(src),
      'and an old <library>/tmp with sessions in it gets ONE line naming it — never a '
      + 'migration, never a delete');
  });

  // ───────────────────────────────────────────────────────────────────────────
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (failures.length) {
    console.log(`failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
  fs.rmSync(WORK, { recursive: true, force: true });
})();
