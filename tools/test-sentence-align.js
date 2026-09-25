#!/usr/bin/env node
/**
 * GENERATE SENTENCES, EXACT — the pure logic (shared/sentence-align).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-sentence-align.js
 *
 * Pins, on a synthetic book and "heard" transcript:
 *  1. A misheard proper noun (Ellen for Elend) is a near-miss: the sentence is
 *     PLACED with the EPUB's text and the heard word's times.
 *  2. A sentence the reader skipped is UNSPOKEN, never placed.
 *  3. A number read out ("1024" heard as "ten twenty four") leaves its sentence
 *     DISPUTED, and it becomes one aligner window bounded by placed neighbours.
 *  4. Heard words the book does not contain (an ad) are listed as extra audio.
 *  5. placeWindow maps window-relative aligner items back onto EPUB words.
 *  6. Cue edges land at the centre of the pause beside each word, two sentences
 *     sharing a pause meet in it, and an edge with no pause is flagged.
 */
'use strict';
const assert = require('assert');
const D = require('../dist/shared/sentence-align/book-diff.js');
const E = require('../dist/shared/sentence-align/cue-edges.js');

let passed = 0; const failed = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const sentences = [
  { text: 'Elend Venture stood on the wall.' },
  { text: 'The mists were thick tonight, thicker than Vin had ever seen.' },
  { text: 'This sentence was never read aloud by the narrator at all.' },
  { text: 'He counted 1024 koloss below.' },
  { text: 'Sazed nodded slowly.' },
];
// heard: 0.5 s per word, 0.6 s pause between sentences; an ad between sentence 2 and 4
let t = 1.0; const heard = [];
const say = (text) => { for (const w of text.split(' ')) { heard.push({ word: w, start: t, end: t + 0.4 }); t += 0.5; } t += 0.6; };
say('Ellen Venture stood on the wall.');
say('The mists were thick tonight, thicker than Vin had ever seen.');
say('Buy the new audiobook today from our partner store now.');
say('He counted ten twenty four koloss below.');
say('Sazed nodded slowly.');

const diff = D.diffBookAgainstHeard(sentences, heard);
const S = diff.sentences;

check('a misheard proper noun is placed, with the EPUB text and the heard times', () => {
  assert.strictEqual(S[0].status, 'placed');
  assert.strictEqual(S[0].words[0].norm, 'elend');
  assert.strictEqual(S[0].words[0].match, 'fuzzy');
  assert.strictEqual(S[0].start, 1.0);
});
check('an ordinary sentence is placed exactly', () => {
  assert.strictEqual(S[1].status, 'placed');
  assert.ok(S[1].coverage === 1);
});
check('a skipped sentence is unspoken, never placed', () => {
  assert.strictEqual(S[2].status, 'unspoken');
  assert.strictEqual(S[2].start, null);
});
check('a number read out leaves its sentence disputed', () => {
  assert.strictEqual(S[3].status, 'disputed', `got ${S[3].status} (${S[3].reason})`);
});
check('the last sentence is placed', () => assert.strictEqual(S[4].status, 'placed'));
check('the ad is listed as extra audio', () => {
  assert.ok(diff.extraAudio.some((x) => /audiobook/.test(x.text)), JSON.stringify(diff.extraAudio));
});

const { windows, tooLong } = D.planAlignWindows(diff, sentences, t + 5);
check('one window, hugging the sentence\'s own heard words, NOT the ad before it, carrying the EPUB text', () => {
  assert.strictEqual(tooLong.length, 0);
  const w = windows.find((x) => x.sentences.includes(3));
  assert.ok(w, JSON.stringify(windows));
  const he = heard.find((h) => h.word === 'He'); const below = heard.find((h) => h.word === 'below.');
  const adStart = heard.find((h) => h.word === 'Buy').start;
  assert.ok(w.start <= he.start && w.end >= below.end, JSON.stringify(w));
  const adEnd = heard.find((h) => h.word === 'now.').end;
  assert.ok(w.start >= adEnd && adStart < adEnd, `window starts at ${w.start}, inside the ad (${adStart}-${adEnd})`);
  assert.ok(w.start >= S[1].end - 1e-9 && w.end <= S[4].start + 1e-9);
  assert.ok(w.text.includes('1024'));
});

check('aligner items map back onto the window\'s EPUB words', () => {
  const w = windows.find((x) => x.sentences.includes(3));
  const s3 = sentences[3].text.split(' ');
  const items = s3.map((word, i) => ({ text: word, start: 1 + i * 0.5, end: 1.4 + i * 0.5 }));
  const [p] = D.placeWindow({ ...w, sentences: [3], text: sentences[3].text }, sentences, items);
  assert.strictEqual(p.status, 'placed');
  assert.ok(Math.abs(p.start - (w.start + 1)) < 1e-9);
});

// Envelope: speech at -20 dB over each heard word, room tone -80 elsewhere, and one
// run-on (no pause) between two words at 50.0-50.4 / 50.4-50.8.
const N = Math.ceil(60 / E.FRAME_S); const db = new Float32Array(N).fill(-80);
const loud = (a, b) => { for (let k = Math.floor(a / E.FRAME_S); k < Math.ceil(b / E.FRAME_S); k++) db[k] = -20; };
loud(10.0, 12.0); loud(13.0, 15.0); loud(50.0, 50.8);
const env = { db };
check('an end edge lands at the centre of the pause after the word', () => {
  const e = E.endEdge(env, 12.0, 13.0);
  assert.ok(e.inSilence && Math.abs(e.t - 12.5) <= 0.03, JSON.stringify(e));
});
check('the next start lands in the same pause: the cues meet there', () => {
  const s = E.startEdge(env, 13.0, 12.0);
  assert.ok(s.inSilence && Math.abs(s.t - 12.5) <= 0.03, JSON.stringify(s));
});
check('a long silence is not handed to the cue: the edge stays within reach of the word', () => {
  const e = E.endEdge(env, 15.0, null);
  assert.ok(e.inSilence && e.t - 15.0 <= E.MAX_REACH_S + 1e-9, JSON.stringify(e));
});
check('a run-on edge is flagged, never passed off as a pause', () => {
  const e = E.endEdge(env, 50.4, 50.4);
  assert.strictEqual(e.inSilence, false);
});

console.log(`\nsentence-align: ${passed} passed, ${failed.length} failed${failed.length ? ': ' + failed.join('; ') : ''}`);
process.exit(failed.length ? 1 : 0);
