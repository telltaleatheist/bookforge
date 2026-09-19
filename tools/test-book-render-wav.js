#!/usr/bin/env node
/**
 * THE WHOLE-BOOK RENDER'S `.wav` FILES ARE ACTUALLY WAVs.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-book-render-wav.js
 *
 * ── The defect this exists for ──────────────────────────────────────────────
 *
 * Until 2026-09-18 `render/sentences/<i>.wav` got the engine's raw Int16
 * samples and nothing else: the streaming engine returns base64 PCM16
 * (`electron/crucible/stream.ts`, which hands the ENCODING to whoever is
 * listening), and the render service wrote those bytes straight to a file whose
 * extension was the only thing claiming they were a WAV. A header is what says
 * how many channels there are, how wide a sample is and HOW FAST TO PLAY THEM,
 * so without one the reader's per-sentence route served bytes no decoder could
 * read and ffmpeg's concat demuxer had no container to probe. Nothing threw —
 * the file was written, the coverage bit was set, and the book was "rendered".
 *
 * The neighbouring `silentWav` pad WAS a real 44-byte RIFF, which is why the
 * set looked plausible; and `wavSeconds` subtracted a 44-byte header the real
 * files did not carry and divided by a hardcoded 24 kHz the engine never
 * reported.
 *
 * So three claims are pinned here, and each of them was false:
 *
 *   §1  The header builder is ONE function, it states the rate it was GIVEN,
 *       and it refuses a missing one by name — a wrong rate is audible as pitch
 *       and errors nowhere, so there is no default to fall back to.
 *   §2  The file the render service actually writes begins with RIFF/WAVE,
 *       states the rate the ENGINE reported, and carries the samples verbatim.
 *   §3  Nobody builds a second header. The reader's HTTP route had the correct
 *       builder next door the whole time; a copy is how the two drift.
 */
'use strict';
const assert = require('assert');
const { skipLine } = require('./keeper-skip.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'book-render-service.js'))) {
  console.log(skipLine('dist/electron is not built — run `npx tsc -p tsconfig.electron.json`'));
  return;
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-render-wav-'));
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');
// The render service reaches the engine registry, which statically requires
// 'electron'; the CLI's own shim answers it, so the module loads as it does
// headless. Nothing here starts an engine — only the write path is exercised.
require('../cli/electron-stub.js');

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (err) { failures++; console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`); }
}

const WAV = path.join(DIST, 'pcm16-wav.js');
if (!fs.existsSync(WAV)) {
  console.log('  FAIL  the RIFF header has one owner\n'
    + `        ${path.relative(REPO, WAV)} does not exist: the render service and the reader's\n`
    + '        audio store each build their own header — and one of them builds none at all,\n'
    + '        which is why every rendered sentence is headerless PCM in a file named .wav.');
  console.log('\n1 check(s) FAILED.');
  process.exitCode = 1;
  fs.rmSync(ROOT, { recursive: true, force: true });
  return;
}
const { pcm16Wav, pcm16WavHeader, pcm16WavSeconds, WAV_HEADER_BYTES } = require(WAV);
const { writeSentenceWav } = require(path.join(DIST, 'book-render-service.js'));

/** One sentence's worth of engine output: 1200 samples at a NON-default rate. */
const PCM = Buffer.alloc(2400);
for (let i = 0; i < 1200; i++) PCM.writeInt16LE(((i * 37) % 2000) - 1000, i * 2);
const AUDIO = { data: PCM.toString('base64'), duration: 0, sampleRate: 22050 };

async function main() {
  // ═════════════════════════════════════════════════════════════════════════
  // 1. The header states the rate it was given, and refuses a missing one
  // ═════════════════════════════════════════════════════════════════════════
  console.log('the RIFF header, built once');

  await check('a header is 44 canonical bytes that state the rate, mono, 16-bit', () => {
    // 22050 deliberately: the rate the old code assumed was 24000, so a header
    // that says 24000 here is the assumption, not the engine's answer.
    const header = pcm16WavHeader(4, 22050);
    assert.strictEqual(header.length, 44);
    assert.strictEqual(WAV_HEADER_BYTES, 44);
    assert.strictEqual(header.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(header.toString('ascii', 8, 12), 'WAVE');
    assert.strictEqual(header.toString('ascii', 36, 40), 'data');
    assert.strictEqual(header.readUInt32LE(4), 40, 'RIFF size is 36 + data bytes');
    assert.strictEqual(header.readUInt16LE(20), 1, 'PCM');
    assert.strictEqual(header.readUInt16LE(22), 1, 'mono');
    assert.strictEqual(header.readUInt32LE(24), 22050, 'the sample rate it was given');
    assert.strictEqual(header.readUInt32LE(28), 44100, 'byte rate = rate * 2 for mono 16-bit');
    assert.strictEqual(header.readUInt16LE(32), 2, 'block align');
    assert.strictEqual(header.readUInt16LE(34), 16, 'bits per sample');
    assert.strictEqual(header.readUInt32LE(40), 4, 'data bytes');
  });

  await check('a missing or nonsense sample rate is refused BY NAME, never defaulted', () => {
    for (const rate of [undefined, null, 0, -1, NaN, 24000.5]) {
      assert.throws(() => pcm16Wav(Buffer.alloc(2), rate), /sample rate/i,
        `pcm16Wav accepted ${String(rate)} as a sample rate`);
    }
  });

  await check('pcm16WavSeconds reads the header it was handed, and is exact', () => {
    // One second at 22050 Hz is 44100 bytes, and a third of a second is 14700.
    assert.strictEqual(pcm16WavSeconds(pcm16Wav(Buffer.alloc(44100), 22050)), 1);
    assert.strictEqual(pcm16WavSeconds(pcm16Wav(Buffer.alloc(14700), 22050)), 1 / 3);
    // The SAME payload at a different rate is a different length — which is the
    // whole reason the rate may not be assumed.
    assert.strictEqual(pcm16WavSeconds(pcm16Wav(Buffer.alloc(44100), 44100)), 0.5);
  });

  await check('headerless PCM is refused rather than measured as if it had a header', () => {
    assert.throws(() => pcm16WavSeconds(Buffer.alloc(48000)), /RIFF/,
      'raw samples were accepted as a WAV — the old files would still measure');
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 2. The file the render service writes
  // ═════════════════════════════════════════════════════════════════════════
  console.log('the sentence file on disk');

  await check('the written file begins RIFF/WAVE and carries the samples verbatim', async () => {
    const file = path.join(ROOT, '0.wav');
    await writeSentenceWav(file, AUDIO);
    const onDisk = fs.readFileSync(file);
    assert.strictEqual(onDisk.toString('ascii', 0, 4), 'RIFF',
      'the sentence file is still raw PCM in a file named .wav');
    assert.strictEqual(onDisk.toString('ascii', 8, 12), 'WAVE');
    assert.strictEqual(onDisk.readUInt32LE(24), 22050,
      'the header states a rate the engine did not report');
    assert.strictEqual(onDisk.length, WAV_HEADER_BYTES + PCM.length);
    assert.ok(onDisk.subarray(WAV_HEADER_BYTES).equals(PCM), 'the samples were altered');
    assert.strictEqual(pcm16WavSeconds(onDisk), 1200 / 22050);
  });

  await check('a result with no sample rate stops the write by name', async () => {
    await assert.rejects(
      () => writeSentenceWav(path.join(ROOT, 'norate.wav'), { data: PCM.toString('base64'), duration: 0 }),
      /sample rate/i,
      'a rateless result was written at some assumed rate');
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 3. One owner
  // ═════════════════════════════════════════════════════════════════════════
  console.log('one owner for the header');

  await check('neither writer builds a RIFF header of its own', () => {
    for (const rel of ['electron/book-render-service.ts', 'electron/reader-audio-store.ts']) {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf-8');
      assert.ok(/from '\.\/pcm16-wav'/.test(src), `${rel} does not build its WAVs through pcm16-wav.ts`);
      assert.ok(!/'RIFF'|"RIFF"/.test(src),
        `${rel} writes its own RIFF header; there is one builder and this is a copy of it`);
    }
  });

  await check('the render service assumes no sample rate anywhere', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'book-render-service.ts'), 'utf-8');
    // 24000 was the assumed rate and 48000 its byte rate; both were written into
    // the duration maths and the silence pad, and neither was ever the engine's.
    const assumed = src.match(/\b(24000|48000)\b/g);
    assert.strictEqual(assumed, null,
      `the engine's rate is still assumed: ${assumed && assumed.join(', ')}`);
  });

  fs.rmSync(ROOT, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exitCode = 1; }
  else console.log('\nEvery rendered sentence is a real WAV at the engine\'s own rate.');
}

void main();
