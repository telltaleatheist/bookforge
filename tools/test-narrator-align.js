#!/usr/bin/env node
/**
 * THE ALIGNMENT MEASUREMENT, HELD TO THE PYTHON'S OWN ANSWERS.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narrator-align.js
 *
 * `tools/fixtures/narrator-align-cases.json` was captured from the Python narrator before it left the
 * repo: the report, the sentence VTT and the log of one small session whose every chunk is a different
 * case, the refusals of bad documents, the silence map and the character folds. Real books were
 * compared whole, byte for byte; this pins that result. The session is built here from a formula and
 * goes through the worker door with a real ffmpeg, in a temp folder.
 *
 * `--build-session <dir>` only writes the session and its documents, which is how the capture started.
 */
'use strict';
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');
const NARRATOR = path.join(REPO, 'dist', 'electron', 'narrator');
if (!fs.existsSync(path.join(NARRATOR, 'align', 'align-door.js'))) {
  console.log(skipLine('dist/electron/narrator/align/align-door.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}
const FFMPEG = process.env.BF_FFMPEG || 'ffmpeg';
if (spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.log(skipLine('ffmpeg is not on PATH, and the measurement decodes every chunk with it'));
  process.exit(0);
}

const E = require(path.join(NARRATOR, 'assemble', 'edges.js'));
const RATE = 24000;

/** Speech is noise from a fixed generator, and quiet is zero, so both sides read the same samples. */
function samplesOf(segments) {
  const total = segments.reduce((sum, [, seconds]) => sum + Math.round(seconds * RATE), 0);
  const out = new Int16Array(total);
  let at = 0;
  let state = 12345;
  for (const [kind, seconds] of segments) {
    const n = Math.round(seconds * RATE);
    for (let i = 0; i < n; i += 1) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      out[at] = kind === 'speech' ? ((state >>> 16) % 16000) - 8000 : 0;
      at += 1;
    }
  }
  return out;
}

const wordsOf = (text) => text.replace(/\[heading\]/, '').split(' ').filter(Boolean);
/** One item per word, evenly over `[from, to]`. */
function even(text, from, to) {
  const words = wordsOf(text);
  const step = (to - from) / words.length;
  return words.map((word, i) => ({ text: word, start: from + i * step, end: from + (i + 1) * step }));
}

const FIVE = 'One two three four five.';
const TWELVE = 'One two three four five six seven eight nine ten eleven twelve.';
/** Each row: the text, the audio, and what the document says about it. `null` items leaves the chunk out. */
const CHUNKS = [
  { why: 'a heading', kind: 'heading', text: '[heading]Chapter One.', audio: [['speech', 1]], items: (t) => even(t, 0, 1) },
  {
    why: 'two sentences with a pause to snap to',
    text: 'The first sentence is here. The second one follows it.',
    audio: [['speech', 1.2], ['quiet', 0.4], ['speech', 1.2]],
    items: () => [...even('The first sentence is here.', 0, 1.15), ...even('The second one follows it.', 1.6, 2.8)],
  },
  {
    why: 'the model splits a word and merges two, in letters a fold changes',
    text: 'Straße ΣΊΣΥΦΟΣ ends—well, here. Café déjà vu.',
    audio: [['speech', 3]],
    items: () => [
      { text: 'STRASSE', start: 0, end: 0.4 }, { text: 'σίσυφος', start: 0.4, end: 0.9 }, { text: 'ends', start: 0.9, end: 1.1 },
      { text: 'well', start: 1.1, end: 1.4 }, { text: 'here', start: 1.4, end: 1.7 }, { text: 'CAFÉ', start: 1.8, end: 2.1 }, { text: 'déjà vu', start: 2.1, end: 2.9 },
    ],
  },
  { why: 'a word with no letters', text: 'A dash — stands alone here.', audio: [['speech', 2]], items: () => [
    { text: 'A', start: 0, end: 0.2 }, { text: 'dash', start: 0.2, end: 0.6 }, { text: 'stands', start: 0.7, end: 1.1 }, { text: 'alone', start: 1.1, end: 1.5 }, { text: 'here', start: 1.5, end: 1.9 },
  ] },
  { why: 'marker-only', text: '[break]', audio: [['quiet', 0.5]], items: () => [] },
  { why: 'not in the document', text: FIVE, audio: [['speech', 1.5]], items: null },
  { why: 'the model rewrote the text', text: FIVE, audio: [['speech', 1.5]], items: () => even('One two three four six.', 0, 1.5) },
  { why: 'no items list', text: FIVE, audio: [['speech', 1.5]], items: () => 'nothing' },
  { why: 'no items at all', text: FIVE, audio: [['speech', 1.5]], items: () => [] },
  { why: 'an item missing a time', text: FIVE, audio: [['speech', 1.5]], items: (t) => even(t, 0, 1.5).map((r, i) => (i === 2 ? { text: r.text, start: r.start } : r)) },
  { why: 'a time that is not a number', text: FIVE, audio: [['speech', 1.5]], items: (t) => even(t, 0, 1.5).map((r, i) => (i === 1 ? { ...r, end: 'soon' } : r)) },
  { why: 'a null time', text: FIVE, audio: [['speech', 1.5]], items: (t) => even(t, 0, 1.5).map((r, i) => (i === 1 ? { ...r, start: null } : r)) },
  { why: 'an item that is not an object', text: FIVE, audio: [['speech', 1.5]], items: () => [5] },
  { why: 'times spelled as strings', text: FIVE, audio: [['speech', 1.5]], items: (t) => even(t, 0, 1.5).map((r) => ({ ...r, start: String(r.start), end: String(r.end) })) },
  { why: 'a word ending before it starts', text: FIVE, audio: [['speech', 1.5]], items: (t) => even(t, 0, 1.5).map((r, i) => (i === 1 ? { ...r, end: 0 } : r)) },
  { why: 'an untimed word, spelled nan', text: FIVE, audio: [['speech', 1.5]], items: (t) => even(t, 0, 1.5).map((r, i) => (i === 3 ? { ...r, start: 'nan' } : r)) },
  { why: 'an infinite time', text: FIVE, audio: [['speech', 1.5]], items: (t) => even(t, 0, 1.5).map((r, i) => (i === 3 ? { ...r, end: 'inf' } : r)) },
  {
    why: 'words placed backwards inside a sentence',
    text: 'Forward words go here. Then these backward words.',
    audio: [['speech', 3]],
    items: () => [
      ...even('Forward words go here.', 0, 1.2),
      { text: 'Then', start: 2.4, end: 2.5 }, { text: 'these', start: 1.3, end: 1.5 }, { text: 'backward', start: 1.5, end: 1.8 }, { text: 'words', start: 1.8, end: 2 },
    ],
  },
  {
    why: 'a sentence with no placed word',
    text: 'This one is placed. Nothing here is.',
    audio: [['speech', 2]],
    items: () => [...even('This one is placed.', 0, 1), ...even('Nothing here is.', 1, 2).map((r) => ({ ...r, start: 'nan' }))],
  },
  {
    why: 'a run of words placed inside a pause: dropped text',
    text: TWELVE,
    audio: [['speech', 1], ['quiet', 2], ['speech', 0.5]],
    items: (t) => [...even(t, 0, 0.5).slice(0, 0), ...even('One two three.', 0, 0.9), ...even('four five six seven eight nine ten.', 1.1, 2.9), ...even('eleven twelve.', 3, 3.4)],
  },
  {
    why: 'speech at the head, inside and at the tail that no word covers: inserted audio',
    text: 'Only these few words are said here.',
    audio: [['speech', 8]],
    items: () => [...even('Only these few', 1.5, 2.5), ...even('words are said here.', 4.5, 5.5)],
  },
  { why: 'words too fast to be placements', text: TWELVE, audio: [['speech', 6]], items: (t) => even(t, 3, 3.06) },
  {
    why: 'a word the model split, opening a sentence: the seam reads the first piece',
    text: 'Well said. Bookkeeper went home.',
    audio: [['speech', 3]],
    items: () => [{ text: 'Well', start: 0, end: 0.3 }, { text: 'said', start: 0.3, end: 0.7 }, { text: 'Book', start: 1.3, end: 1.6 }, { text: 'keeper', start: 1.9, end: 2.2 }, { text: 'went', start: 2.2, end: 2.5 }, { text: 'home', start: 2.5, end: 2.9 }],
  },
  { why: 'a heading of two sentences: only the first is the heading', text: '[heading]Chapter Two. A subtitle here.', audio: [['speech', 2]], items: () => [...even('Chapter Two.', 0, 0.9), ...even('A subtitle here.', 1, 2)] },
  { why: 'an accent the model decomposed: a different letter sequence', text: 'Café is open.', audio: [['speech', 1.5]], items: () => [{ text: 'Café', start: 0, end: 0.5 }, { text: 'is', start: 0.5, end: 0.8 }, { text: 'open', start: 0.8, end: 1.4 }] },
  { why: 'a chunk the document places well, last', text: FIVE, audio: [['speech', 1.5]], items: (t) => even(t, 0, 1.5) },
];
const CHAPTERS = [[0, 5], [5, 15], [15, CHUNKS.length]];

/** The session and the good document, in `dir`. `rows` can be longer, for a run long enough to cancel. */
async function buildSession(dir, rows = CHUNKS, ranges = CHAPTERS) {
  const sentences = path.join(dir, 'chapters', 'sentences');
  fs.mkdirSync(sentences, { recursive: true });
  const gaps = {};
  const documentChunks = [];
  for (const [index, row] of rows.entries()) {
    const samples = samplesOf(row.audio);
    await E.writeFlac(path.join(sentences, `${index}.flac`), RATE, samples.length, samples);
    gaps[String(index)] = { before: 0, after: 0.2 };
    if (row.items !== null) {
      const items = row.items(row.text);
      documentChunks.push(items === 'nothing' ? { index } : { index, items });
    }
  }
  fs.writeFileSync(path.join(sentences, 'gaps.json'), JSON.stringify({ version: 1, engine: 'higgs-v3', gaps }));
  fs.writeFileSync(path.join(dir, 'session-state.json'), JSON.stringify({
    version: 2, session_id: 'align-keeper', epub_content_hash: 'h', total_sentences: rows.length, total_chapters: ranges.length,
    chapters: ranges.map(([from, to], c) => ({ chapter_num: c + 1, sentence_count: to - from, raw_sentence_count: to - from, sentence_start: from, sentence_end: to - 1 })),
    chapter_sentences: ranges.map(([from, to]) => rows.slice(from, to).map((r) => r.text)),
    language: 'eng', language_iso1: 'en', fine_tuned: 'v', tts_engine: 'higgs-v3', output_format: 'm4b',
    metadata: { title: 'Align', creator: 'Author', language: 'en' }, bookforge_metadata: { title: 'Align', author: 'Author', year: '1999' },
    cover: null, chapter_titles: ranges.map((_, c) => `Title ${c + 1}`), chapter_docs: ranges.map((_, c) => `d${c}.xhtml`),
    chapter_titles_by_doc: Object.fromEntries(ranges.map((_, c) => [`d${c}.xhtml`, `Title ${c + 1}`])),
  }));
  const good = { engine: 'qwen3-forced-aligner', device: 'cuda', chunks: documentChunks };
  fs.writeFileSync(path.join(dir, 'alignment.json'), JSON.stringify(good));
  return good;
}

/** Documents refused whole. Written where the session is, so a refusal quoting the path can be compared. */
const REFUSED_DOCUMENTS = {
  'no engine': '{"chunks": []}',
  'an unknown engine': '{"engine": "whisperx-2", "chunks": []}',
  'no chunks list': '{"engine": "qwen3-forced-aligner"}',
  'a chunk with no index': '{"engine": "qwen3-forced-aligner", "chunks": [{"items": []}]}',
  'an index that is not a number': '{"engine": "qwen3-forced-aligner", "chunks": [{"index": "first", "items": []}]}',
  'the same chunk twice': '{"engine": "qwen3-forced-aligner", "chunks": [{"index": 0, "items": []}, {"index": 0, "items": []}]}',
  'about another session': '{"engine": "qwen3-forced-aligner", "chunks": [{"index": 900, "items": []}]}',
  'an array': '[1, 2]',
};

if (process.argv[2] === '--build-session') {
  const dir = process.argv[3];
  (async () => {
    await buildSession(dir);
    for (const [name, text] of Object.entries(REFUSED_DOCUMENTS)) fs.writeFileSync(path.join(dir, `refused-${name.replace(/ /g, '-')}.json`), text);
    console.log(JSON.stringify(Object.keys(REFUSED_DOCUMENTS)));
  })();
  return;
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: { app: { getPath: () => os.tmpdir(), getAppPath: () => REPO, isPackaged: false }, BrowserWindow: class {} } };

const py = require(path.join(NARRATOR, 'py-compat.js'));
const A = require(path.join(NARRATOR, 'align', 'aligner.js'));
const { startAlignment } = require(path.join(NARRATOR, 'align', 'align-door.js'));
const { pyCasefold } = require(path.join(NARRATOR, 'text', 'casefold.js'));
const job = require(path.join(REPO, 'dist', 'electron', 'coverage-align-job.js'));
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'narrator-align-cases.json'), 'utf8'));

let passed = 0;
const failed = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed.push(name);
    console.log(`  FAIL  ${name}\n        ${String(err.stack || err).slice(0, 1200)}`);
  }
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-narrator-align-'));
const noTiming = (text) => text.replace(/"elapsedSeconds": [0-9.e-]+/g, '"elapsedSeconds": 0').replace(/"secondsPerChunk(Median|Max)": [0-9.e-]+/g, '"secondsPerChunk$1": 0');
const collect = (child) => new Promise((resolve) => {
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.on('close', (code) => resolve({ code, stdout }));
});
const here = (text, dir) => text.split(JSON.stringify(dir).slice(1, -1)).join('<S>').split(dir).join('<S>').split(JSON.stringify(path.sep).slice(1, -1)).join('/').split(path.sep).join('/');

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return `at ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 80), i + 200))} vs ${JSON.stringify(b.slice(Math.max(0, i - 80), i + 200))}`;
}

// The job narrates into the console, and a keeper's output is its checks.
const say = console.log;
const inJob = (fn) => async () => {
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.log = say;
  }
};

(async () => {
  console.log('the Python\'s answers');
  await check('the silence map, frame for frame', () => {
    for (const c of fx.silences) {
      const audio = new Float32Array(c.size);
      for (const [from, to, value] of c.runs) audio.fill(value, from, to);
      assert.deepStrictEqual(A.detectSilences(audio).map((s) => [...s]), c.want, c.name);
    }
  });
  await check('the report escapes as json.dumps does, DEL and astral included', () => {
    for (const [text, want] of fx.ascii) assert.strictEqual(py.pyJsonDumpsAscii({ a: text, b: py.pyFloat(1), c: [] }), want);
  });
  await check('casefold and letters: the words a derived score counts', () => {
    for (const [text, fold, norm] of fx.folds) {
      assert.strictEqual(pyCasefold(text), fold, `fold of ${text}`);
      assert.strictEqual(A.normalized(text), norm, `normalized ${text}`);
    }
  });

  const dir = path.join(root, 'session');
  fs.mkdirSync(dir);
  await buildSession(dir);
  const out = path.join(root, 'out');
  fs.mkdirSync(out);
  const report = path.join(out, 'report.json');
  const vtt = path.join(out, 'out.vtt');
  const request = (extra) => ({ processDir: dir, alignmentPath: path.join(dir, 'alignment.json'), reportPath: report, vttPath: vtt, language: 'en', chapterGap: 3, ffmpeg: FFMPEG, ...extra });
  const { code, stdout } = await collect(startAlignment(request()));

  await check('it exits 0 with every kind of chunk in it: the exit code says the run happened', () => {
    assert.strictEqual(code, 0, stdout.slice(-800));
  });
  await check('the report is the Python\'s byte for byte, every failure by the same words', () => {
    const got = noTiming(here(fs.readFileSync(report, 'utf8'), dir));
    if (got !== fx.report) assert.fail(firstDifference(fx.report, got));
  });
  await check('the sentence VTT is the Python\'s byte for byte, estimates and quality notes in place', () => {
    const got = fs.readFileSync(vtt, 'utf8');
    if (got !== fx.vtt) assert.fail(firstDifference(fx.vtt, got));
  });
  await check('the log is the Python\'s, including the two lines the row\'s bar reads', () => {
    const lines = here(stdout, dir).split(/\r?\n/).filter(Boolean).map((l) => l.replace(/median [0-9.e-]+s\/chunk/, 'median Xs/chunk').split(out.split(path.sep).join('/')).join('<O>'));
    assert.deepStrictEqual(lines, fx.log);
    assert.ok(lines.some((l) => /^\[align\] \d+ chunk\(s\) to align/.test(l)));
    assert.ok(lines.some((l) => /^\[align\] aligned \d+\/\d+ chunk\(s\)$/.test(l)));
  });
  for (const [name, text] of Object.entries(REFUSED_DOCUMENTS)) {
    await check(`refused: ${name}`, async () => {
      const file = path.join(dir, `refused-${name.replace(/ /g, '-')}.json`);
      fs.writeFileSync(file, text);
      const r = await collect(startAlignment(request({ alignmentPath: file, reportPath: path.join(out, 'none.json'), vttPath: path.join(out, 'none.vtt') })));
      assert.strictEqual(r.code, 1);
      const last = here(r.stdout, dir).trim().split(/\r?\n/).pop();
      assert.strictEqual(last, fx.refused[name]);
      assert.ok(!fs.existsSync(path.join(out, 'none.json')), 'a refused document writes no report');
    });
  }
  await check('a document that is not JSON is refused by name', async () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{"engine":');
    const r = await collect(startAlignment(request({ alignmentPath: file })));
    assert.strictEqual(r.code, 1);
    assert.ok(/^Error: --alignment .* is not JSON \(.*\)\. It is the artifact a Crucible `align` job lands\.$/m.test(r.stdout), r.stdout.slice(-400));
  });

  console.log('the job the queue runs');
  await check('the request carries the assembly\'s chapter gap and the session\'s report', () => {
    const made = job.coverageAlignRequest({ processDir: dir, language: 'en', chapterGap: 4.5 }, { reportPath: report, alignmentPath: 'a.json', ffmpeg: FFMPEG });
    assert.strictEqual(made.chapterGap, 4.5);
    assert.strictEqual(made.reportPath, report);
    assert.strictEqual(made.vttPath, undefined, 'the transcript lands beside the session, named for the book');
  });
  await check('the job measures a book: report and transcript beside the session, counts on the result', inJob(async () => {
    const session = path.join(root, 'job');
    fs.mkdirSync(session);
    await buildSession(session);
    const result = await job.runCoverageAlignLocally('step-1', { processDir: session, language: 'en', chapterGap: 3 }, null, { alignmentPath: path.join(session, 'alignment.json') });
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.reportPath, job.coverageReportPath(session));
    assert.ok(fs.existsSync(path.join(session, 'Align._Author.__1999_.sentences.vtt')), fs.readdirSync(session).join());
    assert.strictEqual(fs.readFileSync(path.join(session, 'Align._Author.__1999_.sentences.vtt'), 'utf8'), fx.vtt);
    assert.strictEqual(result.chunksFailed, JSON.parse(fx.report).summary.chunksFailed);
    assert.deepStrictEqual(result.retakeIndices, [...new Set([...JSON.parse(fx.report).summary.failedIndices, ...JSON.parse(fx.report).summary.errorIndices])].sort((a, b) => a - b));
  }));
  await check('stopping the job ends it as a cancel, writes no report and leaves no decoder', inJob(async () => {
    const session = path.join(root, 'stop');
    fs.mkdirSync(session);
    const rows = Array.from({ length: 200 }, () => ({ text: FIVE, audio: [['speech', 1.5]], items: (t) => even(t, 0, 1.5) }));
    await buildSession(session, rows, [[0, 200]]);
    const pending = job.runCoverageAlignLocally('step-2', { processDir: session, language: 'en', chapterGap: 3 }, null, { alignmentPath: path.join(session, 'alignment.json') });
    await new Promise((r) => setTimeout(r, 1500));
    job.stopCoverageAlign('step-2');
    const result = await pending;
    assert.strictEqual(result.wasStopped, true, JSON.stringify(result).slice(0, 300));
    assert.ok(!fs.existsSync(job.coverageReportPath(session)), 'a cancelled pass writes no report');
  }));

  fs.rmSync(root, { recursive: true, force: true });
  const total = passed + failed.length;
  console.log(`\ntest-narrator-align: ${passed}/${total} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
