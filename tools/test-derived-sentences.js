/**
 * Tests for WHEN A DERIVED SENTENCE SET MAY BE REUSED (electron/derived-sentences.ts).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-derived-sentences.js
 *
 * The denoised and voice-converted sets became durable on 2026-08-29 — they live
 * inside the session and survive the assembly that reads them, because with the
 * current models each pass costs about as much GPU wall-clock as the narration
 * itself and re-assembly is routine.
 *
 * WHICH MAKES THIS THE DANGEROUS FILE. A set that is wrongly re-derived costs an
 * hour; a set that is wrongly REUSED is an audiobook assembled from the wrong
 * audio, with nothing about the file to say so. So every reason a set can go
 * stale is written down here as its own case, and every one of them must answer
 * "no" — the gap knob changing, a sentence re-rendered, a sentence added, the
 * pass in front of it re-derived with different settings, a half-written set.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'electron', 'derived-sentences.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const {
  beginDerivedSentences,
  checkDerivedSentences,
  commitDerivedSentences,
  abandonDerivedSentences,
  derivedChainDir,
  derivedChainOf,
  derivedPartialDir,
  derivedPassOf,
  derivedSentencesDir,
  rawSentencesDir,
  readDerivedManifest,
  DERIVED_MANIFEST_NAME,
  MAX_DERIVED_CHAIN,
} = require(MODULE);

const tests = [];
let passed = 0, failed = 0;
const test = (name, fn) => tests.push({ name, fn });

/** A session on disk with `count` raw sentences. Returns its processDir. */
function makeSession(count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-derived-'));
  const raw = rawSentencesDir(root);
  fs.mkdirSync(raw, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(raw, `${i}.flac`), `raw-${i}`);
  }
  return root;
}

/** Derive a set of the same size as its source, and publish it. */
function derive(processDir, req) {
  const partial = beginDerivedSentences(req.dir);
  for (const name of fs.readdirSync(req.sourceDir).filter((n) => n.endsWith('.flac'))) {
    fs.writeFileSync(path.join(partial, name), `derived-${name}`);
  }
  return commitDerivedSentences(req.dir, req);
}

const denoiseReq = (processDir, params) => ({
  dir: derivedSentencesDir(processDir, 'denoise'),
  kind: 'denoise',
  params: Object.assign({ gapSeconds: 0.5, minGapSeconds: 0, voice: 'deathstalker' }, params),
  sourceDir: rawSentencesDir(processDir),
});

// ── the happy answer ────────────────────────────────────────────────────────

test('a freshly derived set is reusable', () => {
  const p = makeSession(4);
  const req = denoiseReq(p);
  derive(p, req);
  const verdict = checkDerivedSentences(req);
  assert.strictEqual(verdict.reusable, true, verdict.reason);
  assert.strictEqual(verdict.manifest.outputCount, 4);
  assert.strictEqual(verdict.manifest.kind, 'denoise');
});

test('the manifest rides INSIDE the set and is not counted as a sentence', () => {
  const p = makeSession(3);
  const req = denoiseReq(p);
  const manifest = derive(p, req);
  assert.ok(fs.existsSync(path.join(req.dir, DERIVED_MANIFEST_NAME)));
  // Four files on disk, three sentences declared: the JSON must not inflate the count.
  assert.strictEqual(fs.readdirSync(req.dir).length, 4);
  assert.strictEqual(manifest.outputCount, 3);
});

// ── every way it goes stale ─────────────────────────────────────────────────

test('nothing derived yet is not reusable', () => {
  const p = makeSession(2);
  const verdict = checkDerivedSentences(denoiseReq(p));
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /yet/);
});

test('a set with no manifest is not reusable — a directory alone proves nothing', () => {
  const p = makeSession(2);
  const req = denoiseReq(p);
  derive(p, req);
  fs.rmSync(path.join(req.dir, DERIVED_MANIFEST_NAME));
  assert.strictEqual(checkDerivedSentences(req).reusable, false);
});

test('CHANGING THE GAP re-derives — the gap is baked in before the roformer sees the audio', () => {
  const p = makeSession(3);
  derive(p, denoiseReq(p, { gapSeconds: 0.5 }));
  const verdict = checkDerivedSentences(denoiseReq(p, { gapSeconds: 0.2 }));
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /settings changed/);
});

test('changing the min-gap floor re-derives too', () => {
  const p = makeSession(3);
  derive(p, denoiseReq(p, { minGapSeconds: 0 }));
  assert.strictEqual(checkDerivedSentences(denoiseReq(p, { minGapSeconds: 0.15 })).reusable, false);
});

test('a re-rendered sentence re-derives the whole set', () => {
  const p = makeSession(3);
  const req = denoiseReq(p);
  derive(p, req);
  // Same name, different bytes and a later mtime — a TTS resume filling a gap.
  const one = path.join(rawSentencesDir(p), '1.flac');
  fs.writeFileSync(one, 'raw-1-re-rendered-longer');
  fs.utimesSync(one, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  const verdict = checkDerivedSentences(req);
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /1\.flac/);
});

test('a source that gained a sentence re-derives', () => {
  const p = makeSession(3);
  const req = denoiseReq(p);
  derive(p, req);
  fs.writeFileSync(path.join(rawSentencesDir(p), '3.flac'), 'raw-3');
  const verdict = checkDerivedSentences(req);
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /holds 4 sentences now/);
});

test('a set missing files it declared re-derives — a half-set must never assemble', () => {
  const p = makeSession(4);
  const req = denoiseReq(p);
  derive(p, req);
  fs.rmSync(path.join(req.dir, '2.flac'));
  const verdict = checkDerivedSentences(req);
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /manifest declares/);
});

test('a set derived by another pass is not this pass\'s set', () => {
  const p = makeSession(2);
  const req = denoiseReq(p);
  derive(p, req);
  const asRvc = Object.assign({}, req, { kind: 'rvc' });
  assert.strictEqual(checkDerivedSentences(asRvc).reusable, false);
});

// ── chained derivation: RVC over the denoised set ───────────────────────────

function rvcOverDenoise(processDir, denoiseParams) {
  const dn = denoiseReq(processDir, denoiseParams);
  derive(processDir, dn);
  return {
    // Named after the WHOLE chain: this is not the same set as a conversion of
    // the raw sentences, and the two must not share a directory.
    dir: derivedChainDir(processDir, [{ kind: 'denoise' }, { kind: 'rvc', key: 'deathstalker-sigma' }]),
    kind: 'rvc',
    params: { voiceId: 'deathstalker-sigma', indexRate: 0.3, protectRate: 0.1 },
    sourceDir: dn.dir,
    upstream: { kind: 'denoise', params: dn.params },
  };
}

test('a conversion over the denoised set is reusable while both are unchanged', () => {
  const p = makeSession(3);
  const req = rvcOverDenoise(p);
  derive(p, req);
  assert.strictEqual(checkDerivedSentences(req).reusable, true);
});

test('RE-DENOISING WITH A DIFFERENT GAP invalidates the conversion built on it', () => {
  const p = makeSession(3);
  const req = rvcOverDenoise(p, { gapSeconds: 0.5 });
  derive(p, req);
  // The same conversion, asked for over a denoise with a different gap.
  const asked = Object.assign({}, req, {
    upstream: { kind: 'denoise', params: Object.assign({}, req.upstream.params, { gapSeconds: 0.2 }) },
  });
  const verdict = checkDerivedSentences(asked);
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /re-derived with different settings/);
});

test('a conversion of the RAW sentences is not a conversion of the denoised ones', () => {
  const p = makeSession(3);
  const req = rvcOverDenoise(p);
  derive(p, req);
  const rawSourced = Object.assign({}, req, { sourceDir: rawSentencesDir(p), upstream: null });
  const verdict = checkDerivedSentences(rawSourced);
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /enhanced source/);
});

// ── the chain is the NAME, and the name is the identity ─────────────────────
//
// Since the user picks which enhancement pass goes first (Owen, 2026-08-29), a
// set can be the product of two passes and the two orders are DIFFERENT AUDIO.
// If both orders wrote to one directory the staleness check would do its job —
// and re-derive an hour of GPU every time somebody flipped the radio button,
// which is the exact thrash the durable sets exist to end.

test('a one-pass chain is the plain name — the old names did not move', () => {
  const p = makeSession(1);
  assert.strictEqual(
    derivedChainDir(p, [{ kind: 'denoise' }]), derivedSentencesDir(p, 'denoise'));
  assert.strictEqual(
    derivedChainDir(p, [{ kind: 'rvc', key: 'leah' }]), derivedSentencesDir(p, 'rvc', 'leah'));
  assert.strictEqual(path.basename(derivedSentencesDir(p, 'denoise')), 'sentences-denoised');
  assert.strictEqual(path.basename(derivedSentencesDir(p, 'rvc', 'leah')), 'sentences-rvc-leah');
});

test('THE TWO ORDERS ARE TWO DIRECTORIES, spelled in the order they ran', () => {
  const p = makeSession(1);
  const denoiseFirst = derivedChainDir(p, [{ kind: 'denoise' }, { kind: 'rvc', key: 'leah' }]);
  const rvcFirst = derivedChainDir(p, [{ kind: 'rvc', key: 'leah' }, { kind: 'denoise' }]);
  assert.strictEqual(path.basename(denoiseFirst), 'sentences-denoised-rvc-leah');
  assert.strictEqual(path.basename(rvcFirst), 'sentences-rvc-leah-denoised');
  assert.notStrictEqual(denoiseFirst, rvcFirst);
});

test('a conversion of the RAW sentences does not share a directory with one of the denoised', () => {
  const p = makeSession(1);
  assert.notStrictEqual(
    derivedChainDir(p, [{ kind: 'rvc', key: 'leah' }]),
    derivedChainDir(p, [{ kind: 'denoise' }, { kind: 'rvc', key: 'leah' }]));
});

test('two voices are two chains', () => {
  const p = makeSession(1);
  assert.notStrictEqual(
    derivedChainDir(p, [{ kind: 'denoise' }, { kind: 'rvc', key: 'leah' }]),
    derivedChainDir(p, [{ kind: 'denoise' }, { kind: 'rvc', key: 'sigma' }]));
});

test('a chain longer than the manifest can vouch for is REFUSED, not written', () => {
  const p = makeSession(1);
  const tooLong = [
    { kind: 'denoise' }, { kind: 'rvc', key: 'leah' }, { kind: 'denoise' },
  ];
  assert.strictEqual(tooLong.length > MAX_DERIVED_CHAIN, true);
  assert.throws(() => derivedChainDir(p, tooLong), /provenance could not be checked/);
  assert.throws(() => derivedChainDir(p, []), /nothing to name it after/);
});

// ── provenance is READ OFF THE SET, never carried beside it ─────────────────

test('a set says which chain it belongs to, so the pass on top of it can extend it', () => {
  const p = makeSession(3);
  const dn = denoiseReq(p);
  derive(p, dn);
  assert.deepStrictEqual(derivedChainOf(readDerivedManifest(dn.dir)), [{ kind: 'denoise' }]);

  // And a two-pass set names both of them, in order — which is what makes the
  // chain reconstructible from the set alone, with nothing threaded through a
  // config to go stale.
  const q = makeSession(3);
  const req = rvcOverDenoise(q);
  derive(q, req);
  assert.deepStrictEqual(
    derivedChainOf(readDerivedManifest(req.dir)),
    [{ kind: 'denoise' }, { kind: 'rvc', key: 'deathstalker-sigma' }]);
});

test('a conversion set with no voice in its params cannot be named — refused', () => {
  assert.throws(() => derivedPassOf('rvc', { indexRate: 0.3 }), /records no voice/);
  // A denoise has no variant to name, so an empty params object is fine.
  assert.deepStrictEqual(derivedPassOf('denoise', {}), { kind: 'denoise' });
});

test('a DENOISE OVER A CONVERSION records the conversion as its upstream', () => {
  const p = makeSession(3);
  const rvc = {
    dir: derivedChainDir(p, [{ kind: 'rvc', key: 'leah' }]),
    kind: 'rvc',
    params: { voiceId: 'leah', indexRate: 0.3, gapSeconds: 0.5, minGapSeconds: 0 },
    sourceDir: rawSentencesDir(p),
  };
  derive(p, rvc);
  const dn = {
    dir: derivedChainDir(p, [{ kind: 'rvc', key: 'leah' }, { kind: 'denoise' }]),
    kind: 'denoise',
    // Second in the chain, so it ran no gap pass: null is the ANSWER.
    params: { gapSeconds: null, minGapSeconds: 0, voice: null },
    sourceDir: rvc.dir,
    upstream: { kind: 'rvc', params: rvc.params },
  };
  const manifest = derive(p, dn);
  assert.strictEqual(manifest.upstream.kind, 'rvc');
  assert.strictEqual(checkDerivedSentences(dn).reusable, true);

  // RE-CONVERTING AT A DIFFERENT INDEX RATE invalidates the denoise on top of it.
  const asked = Object.assign({}, dn, {
    upstream: { kind: 'rvc', params: Object.assign({}, rvc.params, { indexRate: 0.9 }) },
  });
  const verdict = checkDerivedSentences(asked);
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /re-derived with different settings/);
});

test('a re-rendered sentence invalidates the SECOND pass of a chain too', () => {
  const p = makeSession(3);
  const req = rvcOverDenoise(p);
  derive(p, req);
  // The denoised set is this conversion's source; touching it is what a
  // re-derivation of the denoise looks like from up here.
  const one = path.join(req.sourceDir, '1.flac');
  fs.writeFileSync(one, 'denoised-1-again');
  fs.utimesSync(one, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  const verdict = checkDerivedSentences(req);
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /1\.flac/);
});

test('BOTH ORDERS CAN SIT IN ONE SESSION without either replacing the other', () => {
  const p = makeSession(2);
  // denoise → convert
  const a = rvcOverDenoise(p);
  derive(p, a);
  // convert → denoise, from the raw sentences
  const rvcRaw = {
    dir: derivedChainDir(p, [{ kind: 'rvc', key: 'deathstalker-sigma' }]),
    kind: 'rvc',
    params: { voiceId: 'deathstalker-sigma', indexRate: 0.3, protectRate: 0.1 },
    sourceDir: rawSentencesDir(p),
  };
  derive(p, rvcRaw);
  const b = {
    dir: derivedChainDir(p, [{ kind: 'rvc', key: 'deathstalker-sigma' }, { kind: 'denoise' }]),
    kind: 'denoise',
    params: { gapSeconds: null, minGapSeconds: 0, voice: null },
    sourceDir: rvcRaw.dir,
    upstream: { kind: 'rvc', params: rvcRaw.params },
  };
  derive(p, b);

  assert.deepStrictEqual(fs.readdirSync(path.join(p, 'chapters')).sort(), [
    'sentences',
    'sentences-denoised',
    'sentences-denoised-rvc-deathstalker-sigma',
    'sentences-rvc-deathstalker-sigma',
    'sentences-rvc-deathstalker-sigma-denoised',
  ]);
  assert.strictEqual(checkDerivedSentences(a).reusable, true, 'denoise-first survived');
  assert.strictEqual(checkDerivedSentences(b).reusable, true, 'rvc-first survived');
});

// ── atomicity ───────────────────────────────────────────────────────────────

test('a crash mid-derive leaves a .partial, never a set that looks complete', () => {
  const p = makeSession(4);
  const req = denoiseReq(p);
  const partial = beginDerivedSentences(req.dir);
  fs.writeFileSync(path.join(partial, '0.flac'), 'half');
  // Nothing was committed, so nothing is visible under the real name.
  assert.strictEqual(fs.existsSync(req.dir), false);
  assert.strictEqual(checkDerivedSentences(req).reusable, false);
  abandonDerivedSentences(req.dir);
  assert.strictEqual(fs.existsSync(derivedPartialDir(req.dir)), false);
});

test('publishing an incomplete set is REFUSED rather than committed', () => {
  const p = makeSession(4);
  const req = denoiseReq(p);
  const partial = beginDerivedSentences(req.dir);
  fs.writeFileSync(path.join(partial, '0.flac'), 'only one of four');
  assert.throws(() => commitDerivedSentences(req.dir, req), /incomplete/i);
  assert.strictEqual(fs.existsSync(req.dir), false);
});

test('a re-derivation REPLACES the old set rather than accumulating beside it', () => {
  const p = makeSession(3);
  derive(p, denoiseReq(p, { gapSeconds: 0.5 }));
  const second = denoiseReq(p, { gapSeconds: 0.2 });
  derive(p, second);
  const siblings = fs.readdirSync(path.join(p, 'chapters')).sort();
  assert.deepStrictEqual(siblings, ['sentences', 'sentences-denoised']);
  assert.strictEqual(checkDerivedSentences(second).reusable, true);
});

// ── run ─────────────────────────────────────────────────────────────────────

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}
console.log(`derived-sentences: ${passed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
