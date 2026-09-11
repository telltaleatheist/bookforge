#!/usr/bin/env node
/**
 * THE LISTEN PACKER'S RAMP — the shape of every Higgs Listen row.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-listen-chunks.js
 *
 * ── Why this is a keeper ────────────────────────────────────────────────────
 *
 * `packListenChunks` decides how many sentences ride in one Higgs inference, and
 * both of its jobs fail silently and in opposite directions:
 *
 *  - PACK TOO LITTLE and you get what Owen heard on 2026-09-11 — a hard seam
 *    with a render's worth of latency at every sentence boundary, and prosody
 *    the model never got to choose.
 *  - PACK TOO MUCH TOO EARLY and playback stalls. Higgs renders one row at a
 *    time at 2.0x realtime, so row k must be no longer than the audio already
 *    delivered before it: len(k) <= len(c0) + Σ_{i<k} len(c_i). Break the ramp
 *    and nothing errors — the listener just hears a gap, in the middle of a
 *    paragraph, on a machine that is working perfectly.
 *
 * Neither is visible from a unit of BookForge that renders audio, and neither
 * would be caught by a type. So the ramp inequality itself is asserted here,
 * over every chunk of every fixture.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'electron', 'listen-chunks.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const {
  packListenChunks,
  listenBandFromCaps,
  describeListenChunks,
  LISTEN_OPENER_CHARS,
  LISTEN_MIN_CHUNK_CHARS,
} = require(MODULE);

let failures = 0;
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── fixtures ────────────────────────────────────────────────────────────────

const BAND = { openerChars: LISTEN_OPENER_CHARS, minChars: 300, maxChars: 800 };

/** A sentence of exactly `n` chars, ending in a period. */
function sentence(n, word = 'word') {
  assert.ok(n >= 6, 'fixture sentences are at least six chars');
  let s = '';
  while (s.length < n - 1) s += (s ? ' ' : '') + word;
  return `${s.slice(0, n - 1).trim().padEnd(n - 1, 'x')}.`;
}

/** The ramp cap that applied to chunk `k`, given the chunks before it. */
function rampCap(chunks, k, band) {
  const opener = Math.min(band.openerChars, band.maxChars);
  if (k === 0) return opener;
  let delivered = 0;
  for (let i = 0; i < k; i++) delivered += chunks[i].length;
  return Math.min(band.maxChars, chunks[0].length + delivered);
}

/**
 * How many whole sentences each chunk is made of — and proof that it IS made of
 * whole sentences, in order, single-spaced.
 */
function unitRuns(units, chunks) {
  assert.strictEqual(chunks.join(' '), units.filter((u) => u.trim()).join(' '),
    'chunks are not the input sentences in order');
  const runs = [];
  let seen = 0;
  for (const chunk of chunks) {
    let taken = '';
    let n = 0;
    while (taken !== chunk) {
      assert.ok(seen < units.length, 'a chunk boundary fell inside a sentence');
      taken = taken ? `${taken} ${units[seen]}` : units[seen];
      seen++; n++;
      assert.ok(taken.length <= chunk.length, 'a chunk boundary fell inside a sentence');
    }
    runs.push(n);
  }
  assert.strictEqual(seen, units.length, 'a sentence was dropped');
  return runs;
}

/**
 * THE INEQUALITY, over a whole result. Two exemptions, both deliberate:
 *
 *  - A ONE-SENTENCE CHUNK cannot be made shorter (the packer never splits a
 *    sentence), so a sentence longer than everything played before it overruns
 *    the ramp by construction. That is the one hole left, and it is the
 *    extension's projection gate that reasons about it.
 *  - THE LAST CHUNK gets LISTEN_MIN_CHUNK_CHARS of slack: a tail scrap is
 *    absorbed past the cap on purpose, and nothing plays after it to stall.
 */
function assertRamp(units, chunks, band, why) {
  const runs = unitRuns(units, chunks);
  for (let k = 0; k < chunks.length; k++) {
    if (runs[k] === 1) continue;
    const cap = rampCap(chunks, k, band);
    const slack = k === chunks.length - 1 && k > 0 ? LISTEN_MIN_CHUNK_CHARS : 0;
    assert.ok(
      chunks[k].length <= cap + slack,
      `${why}: chunk ${k} is ${chunks[k].length} chars against a ramp cap of ${cap} — `
      + 'playback stalls here',
    );
  }
}

// ── the opener ──────────────────────────────────────────────────────────────

test('the default opener is 300 chars — ~9 s to first word at 2.0x', () => {
  assert.strictEqual(LISTEN_OPENER_CHARS, 300);
});

test('chunk 0 is capped at openerChars, not at the band', () => {
  const units = [];
  for (let i = 0; i < 12; i++) units.push(sentence(120));
  const chunks = packListenChunks(units, BAND);
  assert.ok(chunks[0].length <= BAND.openerChars,
    `opener is ${chunks[0].length} chars, above the ${BAND.openerChars} cap — `
    + 'the listener waits that much longer for the first word');
  assert.ok(chunks[0].length > BAND.openerChars - 130,
    'the opener must still be filled greedily, not left at one sentence');
});

test('a voice whose whole band is under the opener clamps the opener to the band', () => {
  const narrow = { openerChars: 300, minChars: null, maxChars: 250 };
  const units = [sentence(120), sentence(120), sentence(120), sentence(120)];
  const chunks = packListenChunks(units, narrow);
  for (const c of chunks) {
    assert.ok(c.length <= narrow.maxChars,
      `a ${c.length}-char chunk against a 250 cap is a truncation waiting to happen`);
  }
  assertRamp(units, chunks, narrow, 'narrow band');
});

// ── the ramp ────────────────────────────────────────────────────────────────

test('chunk 1 is no longer than twice the opener', () => {
  const units = [];
  for (let i = 0; i < 20; i++) units.push(sentence(100));
  const chunks = packListenChunks(units, BAND);
  assert.ok(chunks.length >= 3, 'fixture must produce at least three chunks');
  assert.ok(chunks[1].length <= 2 * chunks[0].length,
    `chunk 1 is ${chunks[1].length} against an opener of ${chunks[0].length}`);
});

test('chunk 2 is no longer than opener + c0 + c1, capped at the band', () => {
  const units = [];
  for (let i = 0; i < 30; i++) units.push(sentence(100));
  const chunks = packListenChunks(units, BAND);
  const cap = Math.min(BAND.maxChars, chunks[0].length * 2 + chunks[1].length);
  assert.ok(chunks[2].length <= cap, `chunk 2 is ${chunks[2].length} against a cap of ${cap}`);
});

test('a 2,000-char paragraph ramps 300 -> 600 -> 800, and ends in no scrap', () => {
  // Sixty-six 30-char sentences ~ 2,000 chars. Short sentences so each chunk can
  // fill close to its cap: with paragraph-length ones the ramp is the same but the
  // granularity hides it.
  const units = [];
  for (let i = 0; i < 66; i++) units.push(sentence(30, `s${i}`));
  const chunks = packListenChunks(units, BAND);
  assertRamp(units, chunks, BAND, '2,000-char paragraph');
  assert.ok(chunks.length >= 4, `expected several chunks, got ${chunks.length}`);
  // Each chunk fills most of the cap that applied to it — a packer that closed
  // early would obey the ramp and still leave the seams Owen heard.
  for (let k = 0; k < chunks.length - 1; k++) {
    const cap = rampCap(chunks, k, BAND);
    assert.ok(chunks[k].length > cap - 40,
      `chunk ${k} is ${chunks[k].length} against a cap of ${cap} — closed early`);
  }
  // The headline: 300 -> ~2x -> the band's own ceiling by the third.
  assert.ok(chunks[0].length <= 300 && chunks[0].length > 260, `opener ${chunks[0].length}`);
  assert.ok(chunks[1].length <= 2 * chunks[0].length && chunks[1].length > 480,
    `chunk 1 ${chunks[1].length} should be about twice the opener`);
  assert.strictEqual(rampCap(chunks, 2, BAND), BAND.maxChars,
    'by the third chunk the ramp must have reached the band itself');
  assert.ok(chunks[2].length > 700, `chunk 2 ${chunks[2].length} should reach for 800`);
  assert.ok(chunks[chunks.length - 1].length >= LISTEN_MIN_CHUNK_CHARS,
    'the block must not end in a fragment spoken alone');
});

test('every chunk of every fixture obeys the ramp', () => {
  const sizes = [40, 60, 90, 140, 210, 260, 330, 480, 790];
  for (const size of sizes) {
    for (const count of [1, 2, 3, 5, 9, 17]) {
      const units = [];
      for (let i = 0; i < count; i++) units.push(sentence(size));
      assertRamp(units, packListenChunks(units, BAND), BAND, `${count} x ${size} chars`);
    }
  }
});

// ── what a chunk is ─────────────────────────────────────────────────────────

test('a 250-char paragraph of three sentences is ONE chunk', () => {
  const units = [sentence(90), sentence(80), sentence(78)];
  const chunks = packListenChunks(units, BAND);
  assert.strictEqual(chunks.length, 1,
    'the median paragraph must reach the model whole — that is the prosody half of the ask');
  assert.strictEqual(chunks[0], units.join(' '));
});

test('sentences are never split, and none is lost or reordered', () => {
  const units = [];
  for (let i = 0; i < 25; i++) units.push(sentence(60 + i * 7, `w${i}`));
  const chunks = packListenChunks(units, BAND);
  const runs = unitRuns(units, chunks); // asserts the joins and the ordering
  assert.ok(runs.some((n) => n > 1), 'nothing was packed at all — this is the whole feature');
});

test('a single over-cap sentence is NOT split here — splitForTts already capped it', () => {
  // What actually reaches the packer: splitForTts(text, 'en', band.maxChars).
  const capped = [sentence(800)];
  const chunks = packListenChunks(capped, BAND);
  assert.deepStrictEqual(chunks, capped);
  // And an uncapped one passes straight through rather than being cut mid-word.
  const oversized = [sentence(1500)];
  assert.deepStrictEqual(packListenChunks(oversized, BAND), oversized,
    'the packer must not invent a split point — capping is splitForTts\'s job');
});

test('a trailing scrap is absorbed into its neighbour, not spoken alone', () => {
  const units = [];
  for (let i = 0; i < 8; i++) units.push(sentence(100));
  units.push('Yes.');
  const chunks = packListenChunks(units, BAND);
  assert.ok(chunks[chunks.length - 1].length >= LISTEN_MIN_CHUNK_CHARS);
  assert.ok(chunks[chunks.length - 1].endsWith('Yes.'), 'the scrap must still be spoken');
});

test('a short opener absorbs forward instead of pinning the ramp at 3 chars', () => {
  // "Hi." closed as its own chunk would set chunk 1's cap to 6 chars, which no
  // following sentence could fit — the ramp would be dead for the whole block.
  const chunks = packListenChunks(['Hi.', sentence(299), sentence(100)], BAND);
  assert.ok(chunks[0].length >= LISTEN_MIN_CHUNK_CHARS,
    `opener of ${chunks[0].length} chars starves the ramp`);
  assert.ok(chunks[0].startsWith('Hi. '));
});

test('one sentence, one chunk; nothing in, nothing out', () => {
  assert.deepStrictEqual(packListenChunks(['Just this.'], BAND), ['Just this.']);
  assert.deepStrictEqual(packListenChunks([], BAND), []);
  assert.deepStrictEqual(packListenChunks(['', '   '], BAND), []);
});

test('deterministic: the same text and band pack the same way every time', () => {
  const units = [];
  for (let i = 0; i < 40; i++) units.push(sentence(55 + (i % 9) * 31, `t${i}`));
  const first = packListenChunks(units, BAND);
  for (let i = 0; i < 5; i++) {
    assert.deepStrictEqual(packListenChunks(units, BAND), first,
      'a resumed block indexes into this list — a drifting split splices the wrong audio');
  }
});

test('minChars is ADVISORY — it never splits, pads or drops a chunk', () => {
  const floored = { openerChars: 300, minChars: 700, maxChars: 800 };
  const chunks = packListenChunks([sentence(120), sentence(90)], floored);
  assert.strictEqual(chunks.length, 1);
  assert.ok(chunks[0].length < floored.minChars,
    'the packer must not pad a short block up to the safe floor');
});

// ── the band, from the catalog ──────────────────────────────────────────────

test('safeMaxChars is the ceiling when the catalog states one', () => {
  const band = listenBandFromCaps('sigma', { maxChars: 800, safeMaxChars: 640, safeMinChars: 210 });
  assert.strictEqual(band.maxChars, 640);
  assert.strictEqual(band.minChars, 210);
  assert.strictEqual(band.openerChars, LISTEN_OPENER_CHARS);
});

test('maxChars stands in when the voice has no measured band', () => {
  const band = listenBandFromCaps('sigma', { maxChars: 800 });
  assert.strictEqual(band.maxChars, 800);
  assert.strictEqual(band.minChars, null);
});

test('a voice with NO cap is refused by name — never the Orpheus number', () => {
  assert.throws(() => listenBandFromCaps('deathstalker', {}), (err) => {
    assert.ok(/deathstalker/.test(err.message), 'the refusal must name the voice');
    assert.ok(/safeMaxChars|maxChars/.test(err.message), 'it must name what is missing');
    assert.ok(/wrong engine|Orpheus/i.test(err.message),
      'both catalogs ship a deathstalker — the refusal exists to say so');
    return true;
  });
  assert.throws(() => listenBandFromCaps('sigma', { maxChars: 0 }), /declares no chunk length/);
});

// ── the floor's source of truth ─────────────────────────────────────────────

test('LISTEN_MIN_CHUNK_CHARS still matches text-ai.ts MIN_SEGMENT_CHARS', () => {
  const src = fs.readFileSync(path.join(REPO, 'electron', 'text-ai.ts'), 'utf-8');
  const m = src.match(/const MIN_SEGMENT_CHARS\s*=\s*(\d+)/);
  assert.ok(m, 'MIN_SEGMENT_CHARS has moved or been renamed in electron/text-ai.ts');
  assert.strictEqual(LISTEN_MIN_CHUNK_CHARS, Number(m[1]),
    'the packer mirrors that constant by hand (text-ai.ts cannot be imported outside '
    + 'Electron) — they have drifted');
});

// ── the log line ────────────────────────────────────────────────────────────

test('the log names the sentence count, the chunk count and every length', () => {
  const line = describeListenChunks(7, ['a'.repeat(280), 'b'.repeat(540)], BAND);
  assert.ok(/7 sentences/.test(line), line);
  assert.ok(/2 chunks/.test(line), line);
  assert.ok(/280, 540/.test(line), 'a stall is read against the chunk lengths');
  assert.ok(/800/.test(line), 'the band has to be in the line to read the lengths against');
});

// ── run ─────────────────────────────────────────────────────────────────────

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}
console.log(`listen-chunks: ${passed}/${tests.length} passed`);
process.exit(failures === 0 ? 0 : 1);
