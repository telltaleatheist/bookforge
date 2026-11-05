#!/usr/bin/env node
/**
 * TYPESCRIPT ASSEMBLY, HELD TO THE PYTHON'S OWN ANSWERS AND BUILT FOR REAL.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narrator-assemble.js
 *
 * `tools/fixtures/narrator-assemble-cases.json` was captured from the Python narrator before it
 * left the repo: fades sample by sample at both depths, transcripts, the metadata document, the
 * audit. Real books were compared whole, audio packets included; this pins that result. The second
 * half builds small books through the worker door with a real ffmpeg, in a temp folder.
 */
'use strict';
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');
const NARRATOR = path.join(REPO, 'dist', 'electron', 'narrator');
if (!fs.existsSync(path.join(NARRATOR, 'assemble', 'assemble-door.js'))) {
  console.log(skipLine('dist/electron/narrator/assemble/assemble-door.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}
const FFMPEG = process.env.BF_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.BF_FFPROBE || 'ffprobe';
if (spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.log(skipLine('ffmpeg is not on PATH, and these books are built and read with it'));
  process.exit(0);
}
const py = require(path.join(NARRATOR, 'py-compat.js'));
const M = require(path.join(NARRATOR, 'session', 'manifest.js'));
const E = require(path.join(NARRATOR, 'assemble', 'edges.js'));
const V = require(path.join(NARRATOR, 'assemble', 'vtt.js'));
const SV = require(path.join(NARRATOR, 'assemble', 'sentence-vtt.js'));
const ENC = require(path.join(NARRATOR, 'assemble', 'encode.js'));
const RUN = require(path.join(NARRATOR, 'assemble', 'run.js'));
const COV = require(path.join(NARRATOR, 'assemble', 'coverage-gate.js'));
const DOOR = require(path.join(NARRATOR, 'assemble', 'assemble-door.js'));
const { splitSentences } = require(path.join(NARRATOR, 'text', 'sentences.js'));
const FH = require(path.join(NARRATOR, 'session', 'flac-header.js'));
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'narrator-assemble-cases.json'), 'utf8'));

let passed = 0;
const failed = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed.push(name);
    console.log(`  FAIL  ${name}\n        ${String(err.stack || err).slice(0, 900)}`);
  }
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-narrator-assemble-'));

const pcmOf = (file) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
  assert.strictEqual(r.status, 0, String(r.stderr));
  return [...new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 1)];
};
const probe = (file) => JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout);

function collect(child) {
  return new Promise((resolve) => {
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

/**
 * A Higgs session of real FLACs at `rate`, `chapterSeconds` per chapter, one chunk per chapter plus a short second chunk.
 * `signal` is what the chunks hold: noise spends the bitrate an encoder was given, and silence makes a two-hour book cheap.
 */
const SIGNALS = {
  tone: (rate, length, index) => `sine=frequency=${220 + 20 * index}:sample_rate=${rate}:duration=${length}`,
  noise: (rate, length, index) => `anoisesrc=color=white:amplitude=0.5:sample_rate=${rate}:duration=${length}:seed=${index + 1}`,
  silence: (rate, length) => `anullsrc=r=${rate}:cl=mono:d=${length}`,
};
function buildSession(name, rate, chapterSeconds, { engine = 'higgs-v3', cover = true, signal = 'tone' } = {}) {
  const dir = path.join(root, name);
  const sentences = path.join(dir, 'chapters', 'sentences');
  fs.mkdirSync(sentences, { recursive: true });
  const chapterSentences = [];
  const ranges = [];
  let index = 0;
  const gaps = {};
  chapterSeconds.forEach((seconds, c) => {
    const rows = [`[heading]Chapter ${c + 1}.`, `The body of chapter ${c + 1}. It says two things.`];
    chapterSentences.push(rows);
    ranges.push({ chapter_num: c + 1, sentence_count: 2, raw_sentence_count: 2, sentence_start: index, sentence_end: index + 1 });
    for (const length of [0.5, seconds]) {
      const out = path.join(sentences, `${index}.flac`);
      const made = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', SIGNALS[signal](rate, length, index), '-c:a', 'flac', '-sample_fmt', 's16', '-y', out]);
      assert.strictEqual(made.status, 0, String(made.stderr));
      gaps[String(index)] = { before: 0.0, after: 0.6 };
      index += 1;
    }
  });
  const state = {
    version: 2, session_id: `s-${name}`, epub_content_hash: 'h', total_sentences: index, total_chapters: chapterSeconds.length,
    chapters: ranges, chapter_sentences: chapterSentences, language: 'eng', language_iso1: 'en', fine_tuned: 'v', tts_engine: engine,
    output_format: 'm4b', metadata: { title: `Book ${name}`, creator: 'Author', language: 'en', publisher: 'Pub' }, bookforge_metadata: { title: `Book ${name}`, author: 'Author', year: '1999' },
    cover: cover ? true : null, chapter_titles: chapterSeconds.map((_, c) => `Title ${c + 1}`), chapter_docs: chapterSeconds.map((_, c) => `d${c}.xhtml`),
    chapter_titles_by_doc: Object.fromEntries(chapterSeconds.map((_, c) => [`d${c}.xhtml`, `Title ${c + 1}`])),
  };
  fs.writeFileSync(path.join(dir, 'session-state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(sentences, 'gaps.json'), JSON.stringify({ version: 1, engine, gaps }));
  if (cover) {
    const made = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=64x64', '-frames:v', '1', '-y', path.join(dir, 'cover.jpg')]);
    assert.strictEqual(made.status, 0, String(made.stderr));
  }
  return dir;
}

const request = (processDir, outputDir, extra = {}) => ({ processDir, outputDir, chapterGap: 3, finalDenoise: false, ffmpeg: FFMPEG, ffprobe: FFPROBE, ...extra });
const topLevelAtoms = (file) => {
  const data = fs.readFileSync(file);
  const names = [];
  for (let at = 0; at + 8 <= data.length;) {
    const size = data.readUInt32BE(at);
    names.push(data.toString('latin1', at + 4, at + 8));
    assert.ok(size >= 8, `atom ${names[names.length - 1]} at ${at} has size ${size}`);
    at += size;
  }
  return names;
};
const workDirs = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('narrator-asm-')));

(async () => {
  console.log('the Python\'s answers');
  await check('faded samples, both depths, every clamp path', () => {
    for (const c of fx.fades) {
      const source = Int32Array.from(c.source);
      assert.deepStrictEqual([...E.fadePcm(source, c.bits, c.fadeIn, c.fadeOut)], c.want, `${c.bits}-bit ${c.source.length} samples, ${c.fadeIn}/${c.fadeOut}`);
    }
  });
  await check('fade windows and gap lengths round as the Python does', () => {
    for (const [ms, rate, want] of fx.fadeSamples) assert.strictEqual(E.fadeSamples(ms, rate), want, `${ms} ms at ${rate}`);
    for (const [s, rate, want] of fx.gapFrames) assert.strictEqual(E.gapFrames(s, rate), want, `${s} s at ${rate}`);
  });
  await check('timestamps, including every tie a sample count can make', () => {
    for (const [s, want] of Object.entries(fx.ts)) assert.strictEqual(V.formatTimestamp(Number(s)), want, s);
  });
  await check('fixed-point formatting rounds the exact binary value', () => {
    for (const [k, want] of Object.entries(fx.fixed)) {
      const [x, d] = k.split('|');
      assert.strictEqual(py.pyFixed(Number(x), Number(d)), want, k);
    }
  });
  await check('file names and chapter titles', () => {
    for (const [t, want] of Object.entries(fx.names)) assert.strictEqual(RUN.getSanitized(t), want, t);
    for (const [k, want] of Object.entries(fx.titles)) {
      const i = k.lastIndexOf('|');
      assert.strictEqual(ENC.sanitizeMetaChapterTitle(k.slice(0, i), Number(k.slice(i + 1))), want, k);
    }
  });
  await check('sentences split where the Python splits them', () => {
    for (const [t, want] of Object.entries(fx.sentences)) assert.deepStrictEqual(splitSentences(t), want, JSON.stringify(t));
  });
  const manifest = M.fromDict(fx.manifest);
  await check('both transcripts are the Python\'s bytes, with and without a chapter gap', () => {
    for (const [gap, want] of Object.entries(fx.transcripts)) {
      assert.strictEqual(V.buildVtt(manifest, Number(gap)), want.vtt);
      assert.strictEqual(SV.buildSentenceVtt(SV.estimatedCuesForManifest(manifest, 'assemble', Number(gap))), want.sentences);
      assert.strictEqual(V.vttDuration(manifest, Number(gap)), want.duration);
    }
  });
  await check('the metadata document and the file name are the Python\'s', async () => {
    const file = path.join(root, 'metadata.txt');
    await ENC.generateFfmpegMetadata(manifest, [4000, 60000, 3603], file);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), fx.metadata);
    assert.strictEqual(RUN.finalName(manifest), fx.finalName);
  });
  for (const [name, c] of Object.entries(fx.audits)) {
    await check(`audit: ${name}`, async () => {
      const dir = path.join(root, `audit-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      const report = path.join(dir, 'coverage.json');
      if (c.report !== null) fs.writeFileSync(report, typeof c.report === 'string' ? c.report : JSON.stringify(c.report));
      const m = M.fromDict({ ...fx.manifest, source: { ...fx.manifest.source, processDir: dir } });
      const lines = [];
      let refused;
      let returned;
      try {
        returned = (await COV.checkCoverage(m, c.named ? report : null, (l) => lines.push(l))) !== null;
      } catch (err) {
        if (!(err instanceof COV.CoverageRefusal)) throw err;
        refused = err.message;
      }
      const clean = (l) => l.split(dir).join('<S>').replace(/\\/g, '/');
      // A JSON parser's own account of where it gave up is the one spelling allowed to differ.
      const words = (l) => l.replace(/(is unreadable): .*$/s, '$1').replace(/(is not valid JSON): .*$/s, '$1').replace(/(ignored: .* is unreadable).*$/s, '$1');
      assert.deepStrictEqual(lines.map(clean).map(words), c.log.map(words));
      if (c.refused !== undefined) assert.strictEqual(words(clean(refused || '')), words(c.refused));
      else assert.strictEqual(returned, c.returned);
    });
  }

  console.log('the FLACs this writes');
  await check('a verbatim FLAC decodes to exactly its samples, across a block edge', async () => {
    const file = path.join(root, 'verbatim.flac');
    const samples = Int16Array.from({ length: E.FLAC_BLOCKSIZE * 2 + 17 }, (_, i) => ((i * 37) % 65536) - 32768);
    await E.writeFlac(file, 48000, samples.length, samples);
    assert.deepStrictEqual(pcmOf(file), [...samples]);
    const info = await FH.readStreaminfo(file);
    assert.deepStrictEqual([info.samples, info.sampleRate, info.channels, info.bitsPerSample, info.maxBlocksize], [samples.length, 48000, 1, 16, E.FLAC_BLOCKSIZE]);
  });
  await check('silence is exact, and past 65,536 frames the frame numbers still decode', async () => {
    const file = path.join(root, 'silence.flac');
    await E.writeSilence(file, 14400, 24000);
    assert.deepStrictEqual(pcmOf(file), new Array(14400).fill(0));
    const long = path.join(root, 'long-silence.flac');
    const frames = E.FLAC_BLOCKSIZE * 66000;
    await E.writeSilence(long, frames, 24000);
    assert.strictEqual((await FH.readStreaminfo(long)).samples, frames);
    const out = spawnSync(FFMPEG, ['-v', 'error', '-i', long, '-f', 'null', '-'], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0);
    assert.strictEqual(out.stderr, '', 'ffmpeg reported something wrong with the frames');
  });
  await check('the concat demuxer drops nothing across silences and chunks', async () => {
    const dir = path.join(root, 'concat');
    fs.mkdirSync(dir);
    const a = path.join(dir, 'a.flac');
    const b = path.join(dir, 'b.flac');
    const s = path.join(dir, 's.flac');
    await E.writeFlac(a, 24000, 5000, Int16Array.from({ length: 5000 }, () => 1000));
    await E.writeFlac(b, 24000, 100, Int16Array.from({ length: 100 }, () => -1000));
    await E.writeSilence(s, 300, 24000);
    const list = path.join(dir, 'l.txt');
    fs.writeFileSync(list, [a, s, b, s, a].map((f) => `file '${f.replace(/\\/g, '/')}'\n`).join(''));
    const r = spawnSync(FFMPEG, ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.length / 2, 5000 + 300 + 100 + 300 + 5000);
  });

  console.log('whole books, through the worker door');
  await check('an Orpheus session routes to the Python, and everything else to this', async () => {
    const dir = path.join(root, 'route');
    fs.mkdirSync(dir);
    const state = path.join(dir, 'session-state.json');
    assert.strictEqual(await DOOR.assemblyRoute(dir), 'typescript', 'no state: the reader refuses it by name');
    for (const [engine, want] of [['orpheus', 'python'], ['higgs-v3', 'typescript'], ['xtts', 'typescript']]) {
      fs.writeFileSync(state, JSON.stringify({ tts_engine: engine }));
      assert.strictEqual(await DOOR.assemblyRoute(dir), want, engine);
    }
  });
  await check('a short book: serial, cover, chapters, gaps, both transcripts, no work dir left', async () => {
    const before = workDirs();
    const dir = buildSession('short', 24000, [1.5, 1, 2], { signal: 'noise' });
    const out = path.join(root, 'short-out');
    const { code, stdout } = await collect(DOOR.startAssembly(request(dir, out)));
    assert.strictEqual(code, 0, stdout.slice(-800));
    assert.ok(stdout.includes('[assembly] Serial encode:'), 'the short path');
    assert.ok(/"success": true/.test(stdout), 'the result document');
    const files = fs.readdirSync(out).sort();
    assert.deepStrictEqual(files, ['Book_short._Author.__1999_.m4b', 'Book_short._Author.__1999_.vtt'], 'only the book and its VTT land in the output');
    const doc = probe(path.join(out, files[0]));
    assert.strictEqual(doc.chapters.length, 3);
    assert.deepStrictEqual(doc.chapters.map((c) => c.tags.title), ['Title 1', 'Title 2', 'Title 3']);
    assert.strictEqual(doc.format.tags.artist, 'Author');
    assert.ok(doc.streams.some((s) => s.disposition && s.disposition.attached_pic === 1), 'the cover went in');
    assert.strictEqual(doc.format.tags.publisher, 'Pub', 'a tag MP4 has no atom of its own for survives: +use_metadata_tags');
    const audio = doc.streams.find((s) => s.codec_type === 'audio');
    assert.deepStrictEqual([audio.codec_name, audio.sample_rate, audio.channels], ['aac', '44100', 1]);
    // 6 s of noise in a 14.6 s book that is otherwise silent gaps: 192k comes out near 96k, and 128k near 64k.
    assert.ok(Number(audio.bit_rate) > 85000 && Number(audio.bit_rate) < 110000, `noise spends the 192k it was given, got ${audio.bit_rate}`);
    const atoms = topLevelAtoms(path.join(out, files[0]));
    assert.ok(atoms.indexOf('moov') < atoms.indexOf('mdat'), `+faststart: the index comes before the audio, got ${atoms}`);
    // 3 x (0.5 + 0.6) + (1.5 + 1 + 2) + 3 x 0.6 of tails counted once each + 2 chapter gaps of 3
    const expected = 3 * 0.5 + 1.5 + 1 + 2 + 6 * 0.6 + 2 * 3;
    assert.ok(Math.abs(Number(doc.format.duration) - expected) < 0.1, `${doc.format.duration} vs ${expected}`);
    assert.ok(fs.readFileSync(path.join(out, files[1]), 'utf8').startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:00.500\n<b>Chapter 1.</b>\n'));
    assert.ok(fs.existsSync(path.join(dir, 'Book_short._Author.__1999_.sentences.vtt')), 'the estimate lands beside the session');
    assert.deepStrictEqual([...workDirs()].filter((n) => !before.has(n)), [], 'the work dir is removed on success');
  });
  await check('a 48 kHz set assembles at its own rate and the same length', async () => {
    const dir = buildSession('rate48', 48000, [1, 1], { cover: false });
    const out = path.join(root, 'rate48-out');
    const { code, stdout } = await collect(DOOR.startAssembly(request(dir, out)));
    assert.strictEqual(code, 0, stdout.slice(-800));
    const doc = probe(path.join(out, fs.readdirSync(out).find((f) => f.endsWith('.m4b'))));
    assert.ok(Math.abs(Number(doc.format.duration) - (2 * 0.5 + 2 + 4 * 0.6 + 3)) < 0.1, doc.format.duration);
  });
  await check('a book over two hours takes the parallel path, and its chapters tile with the gap', async () => {
    const dir = buildSession('long', 24000, [3700, 3650], { cover: false, signal: 'silence' });
    const out = path.join(root, 'long-out');
    const { code, stdout } = await collect(DOOR.startAssembly(request(dir, out)));
    assert.strictEqual(code, 0, stdout.slice(-800));
    assert.ok(stdout.includes('[assembly] Parallel encode: 2 chapters'), 'the long path');
    assert.ok(stdout.includes('1 chapter gap(s) of 3.000s'), 'the gap is listed between chapters');
    const doc = probe(path.join(out, fs.readdirSync(out).find((f) => f.endsWith('.m4b'))));
    assert.strictEqual(doc.chapters.length, 2);
    assert.strictEqual(doc.chapters[0].end, doc.chapters[1].start);
    assert.ok(Math.abs(Number(doc.chapters[0].end_time) - (0.5 + 3700 + 1.2 + 3)) < 0.01, doc.chapters[0].end_time);
  });
  await check('a failure is a result the bridge can read, and the work dir stays as evidence', async () => {
    const before = workDirs();
    const dir = buildSession('broken', 24000, [1, 1], { cover: false });
    fs.writeFileSync(path.join(dir, 'chapters', 'sentences', '3.flac'), Buffer.alloc(2048));
    const { code, stdout } = await collect(DOOR.startAssembly(request(dir, path.join(root, 'broken-out'))));
    assert.strictEqual(code, 1);
    assert.ok(stdout.includes('assemble_audiobook() Exception: '), 'the line the bridges read');
    assert.ok(stdout.includes('"success": false'), 'the result document');
    const left = [...workDirs()].filter((n) => !before.has(n));
    for (const n of left) fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true });
  });
  await check('an Orpheus session handed to this anyway refuses by name', async () => {
    const before = workDirs();
    const dir = buildSession('padded', 24000, [1], { engine: 'orpheus', cover: false });
    fs.rmSync(path.join(dir, 'chapters', 'sentences', 'gaps.json'));
    const { code, stdout } = await collect(DOOR.startAssembly(request(dir, path.join(root, 'padded-out'))));
    assert.strictEqual(code, 1);
    assert.ok(/Orpheus is retired/.test(stdout), stdout.slice(-400));
    assert.ok(/finished audiobook is untouched/.test(stdout));
    for (const n of [...workDirs()].filter((d) => !before.has(d))) fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true });
  });
  await check('cancelling mid-encode kills its ffmpegs, exits, and leaves no work dir', async () => {
    const before = workDirs();
    const dir = path.join(root, 'long');
    const child = DOOR.startAssembly(request(dir, path.join(root, 'cancel-out')));
    const done = collect(child);
    let sent = false;
    child.stdout.on('data', (d) => {
      if (!sent && d.toString().startsWith('Export - ')) {
        sent = true;
        child.kill();
      }
    });
    const { code, stdout } = await done;
    assert.ok(sent, 'it never reached the encode');
    assert.strictEqual(code, 1);
    const ffmpegs = spawnSync('powershell.exe', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | Where-Object { $_.CommandLine -match 'bf-narrator-assemble|narrator-asm-' } | Measure-Object).Count"], { encoding: 'utf8' });
    if (process.platform === 'win32') assert.strictEqual(ffmpegs.stdout.trim(), '0', 'an encoder outlived the cancel');
    assert.deepStrictEqual([...workDirs()].filter((n) => !before.has(n)), [], `a cancelled assembly cleans up after itself: ${stdout.slice(-500)}`);
  });

  fs.rmSync(root, { recursive: true, force: true });
  const total = passed + failed.length;
  console.log(`\ntest-narrator-assemble: ${passed}/${total} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
