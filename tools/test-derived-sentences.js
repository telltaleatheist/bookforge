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
  assertStagingSpace,
  beginDerivedSentences,
  checkDerivedSentences,
  commitDerivedSentences,
  copySentenceSetInto,
  abandonDerivedSentences,
  derivedChainDir,
  derivedChainOf,
  derivedPartialDir,
  derivedPassOf,
  derivedSentencesDir,
  fingerprintSentences,
  listSentenceFiles,
  rawSentencesDir,
  readDerivedManifest,
  sentenceSetBytes,
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

/**
 * Derive a set of the same size as its source, and publish it — through the SAME
 * three moves the real passes make since the library volume became a network
 * share: write the outputs to LOCAL staging, bulk-copy them into the `.partial`,
 * commit. Every reuse case below therefore exercises the staged path.
 */
async function derive(processDir, req) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-stage-'));
  try {
    for (const name of fs.readdirSync(req.sourceDir).filter((n) => n.endsWith('.flac'))) {
      fs.writeFileSync(path.join(stage, name), `derived-${name}`);
    }
    const partial = beginDerivedSentences(req.dir);
    await copySentenceSetInto(stage, partial);
    return await commitDerivedSentences(req.dir, req);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

const denoiseReq = (processDir, params) => ({
  dir: derivedSentencesDir(processDir, 'denoise'),
  kind: 'denoise',
  params: Object.assign({ gapSeconds: 0.5, minGapSeconds: 0, voice: 'deathstalker' }, params),
  sourceDir: rawSentencesDir(processDir),
});

// ── the happy answer ────────────────────────────────────────────────────────

test('a freshly derived set is reusable', async () => {
  const p = makeSession(4);
  const req = denoiseReq(p);
  await derive(p, req);
  const verdict = await checkDerivedSentences(req);
  assert.strictEqual(verdict.reusable, true, verdict.reason);
  assert.strictEqual(verdict.manifest.outputCount, 4);
  assert.strictEqual(verdict.manifest.kind, 'denoise');
});

test('the manifest rides INSIDE the set and is not counted as a sentence', async () => {
  const p = makeSession(3);
  const req = denoiseReq(p);
  const manifest = await derive(p, req);
  assert.ok(fs.existsSync(path.join(req.dir, DERIVED_MANIFEST_NAME)));
  // Four files on disk, three sentences declared: the JSON must not inflate the count.
  assert.strictEqual(fs.readdirSync(req.dir).length, 4);
  assert.strictEqual(manifest.outputCount, 3);
});

// ── every way it goes stale ─────────────────────────────────────────────────

test('nothing derived yet is not reusable', async () => {
  const p = makeSession(2);
  const verdict = await checkDerivedSentences(denoiseReq(p));
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /yet/);
});

test('a set with no manifest is not reusable — a directory alone proves nothing', async () => {
  const p = makeSession(2);
  const req = denoiseReq(p);
  await derive(p, req);
  fs.rmSync(path.join(req.dir, DERIVED_MANIFEST_NAME));
  assert.strictEqual((await checkDerivedSentences(req)).reusable, false);
});

test('CHANGING THE GAP re-derives — the gap is baked in before the roformer sees the audio', async () => {
  const p = makeSession(3);
  await derive(p, denoiseReq(p, { gapSeconds: 0.5 }));
  const verdict = await checkDerivedSentences(denoiseReq(p, { gapSeconds: 0.2 }));
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /settings changed/);
});

test('changing the min-gap floor re-derives too', async () => {
  const p = makeSession(3);
  await derive(p, denoiseReq(p, { minGapSeconds: 0 }));
  assert.strictEqual((await checkDerivedSentences(denoiseReq(p, { minGapSeconds: 0.15 }))).reusable, false);
});

test('a re-rendered sentence re-derives the whole set', async () => {
  const p = makeSession(3);
  const req = denoiseReq(p);
  await derive(p, req);
  // Same name, different bytes and a later mtime — a TTS resume filling a gap.
  const one = path.join(rawSentencesDir(p), '1.flac');
  fs.writeFileSync(one, 'raw-1-re-rendered-longer');
  fs.utimesSync(one, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  const verdict = await checkDerivedSentences(req);
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /1\.flac/);
});

test('a source that gained a sentence re-derives', async () => {
  const p = makeSession(3);
  const req = denoiseReq(p);
  await derive(p, req);
  fs.writeFileSync(path.join(rawSentencesDir(p), '3.flac'), 'raw-3');
  const verdict = await checkDerivedSentences(req);
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /holds 4 sentences now/);
});

test('a set missing files it declared re-derives — a half-set must never assemble', async () => {
  const p = makeSession(4);
  const req = denoiseReq(p);
  await derive(p, req);
  fs.rmSync(path.join(req.dir, '2.flac'));
  const verdict = await checkDerivedSentences(req);
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /manifest declares/);
});

test('a set derived by another pass is not this pass\'s set', async () => {
  const p = makeSession(2);
  const req = denoiseReq(p);
  await derive(p, req);
  const asRvc = Object.assign({}, req, { kind: 'rvc' });
  assert.strictEqual((await checkDerivedSentences(asRvc)).reusable, false);
});

// ── chained derivation: RVC over the denoised set ───────────────────────────

async function rvcOverDenoise(processDir, denoiseParams) {
  const dn = denoiseReq(processDir, denoiseParams);
  await derive(processDir, dn);
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

test('a conversion over the denoised set is reusable while both are unchanged', async () => {
  const p = makeSession(3);
  const req = await rvcOverDenoise(p);
  await derive(p, req);
  assert.strictEqual((await checkDerivedSentences(req)).reusable, true);
});

test('RE-DENOISING WITH A DIFFERENT GAP invalidates the conversion built on it', async () => {
  const p = makeSession(3);
  const req = await rvcOverDenoise(p, { gapSeconds: 0.5 });
  await derive(p, req);
  // The same conversion, asked for over a denoise with a different gap.
  const asked = Object.assign({}, req, {
    upstream: { kind: 'denoise', params: Object.assign({}, req.upstream.params, { gapSeconds: 0.2 }) },
  });
  const verdict = await checkDerivedSentences(asked);
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /re-derived with different settings/);
});

test('a conversion of the RAW sentences is not a conversion of the denoised ones', async () => {
  const p = makeSession(3);
  const req = await rvcOverDenoise(p);
  await derive(p, req);
  const rawSourced = Object.assign({}, req, { sourceDir: rawSentencesDir(p), upstream: null });
  const verdict = await checkDerivedSentences(rawSourced);
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

test('a one-pass chain is the plain name — the old names did not move', async () => {
  const p = makeSession(1);
  assert.strictEqual(
    derivedChainDir(p, [{ kind: 'denoise' }]), derivedSentencesDir(p, 'denoise'));
  assert.strictEqual(
    derivedChainDir(p, [{ kind: 'rvc', key: 'leah' }]), derivedSentencesDir(p, 'rvc', 'leah'));
  assert.strictEqual(path.basename(derivedSentencesDir(p, 'denoise')), 'sentences-denoised');
  assert.strictEqual(path.basename(derivedSentencesDir(p, 'rvc', 'leah')), 'sentences-rvc-leah');
});

test('THE TWO ORDERS ARE TWO DIRECTORIES, spelled in the order they ran', async () => {
  const p = makeSession(1);
  const denoiseFirst = derivedChainDir(p, [{ kind: 'denoise' }, { kind: 'rvc', key: 'leah' }]);
  const rvcFirst = derivedChainDir(p, [{ kind: 'rvc', key: 'leah' }, { kind: 'denoise' }]);
  assert.strictEqual(path.basename(denoiseFirst), 'sentences-denoised-rvc-leah');
  assert.strictEqual(path.basename(rvcFirst), 'sentences-rvc-leah-denoised');
  assert.notStrictEqual(denoiseFirst, rvcFirst);
});

test('a conversion of the RAW sentences does not share a directory with one of the denoised', async () => {
  const p = makeSession(1);
  assert.notStrictEqual(
    derivedChainDir(p, [{ kind: 'rvc', key: 'leah' }]),
    derivedChainDir(p, [{ kind: 'denoise' }, { kind: 'rvc', key: 'leah' }]));
});

test('two voices are two chains', async () => {
  const p = makeSession(1);
  assert.notStrictEqual(
    derivedChainDir(p, [{ kind: 'denoise' }, { kind: 'rvc', key: 'leah' }]),
    derivedChainDir(p, [{ kind: 'denoise' }, { kind: 'rvc', key: 'sigma' }]));
});

test('a chain longer than the manifest can vouch for is REFUSED, not written', async () => {
  const p = makeSession(1);
  const tooLong = [
    { kind: 'denoise' }, { kind: 'rvc', key: 'leah' }, { kind: 'denoise' },
  ];
  assert.strictEqual(tooLong.length > MAX_DERIVED_CHAIN, true);
  assert.throws(() => derivedChainDir(p, tooLong), /provenance could not be checked/);
  assert.throws(() => derivedChainDir(p, []), /nothing to name it after/);
});

// ── provenance is READ OFF THE SET, never carried beside it ─────────────────

test('a set says which chain it belongs to, so the pass on top of it can extend it', async () => {
  const p = makeSession(3);
  const dn = denoiseReq(p);
  await derive(p, dn);
  assert.deepStrictEqual(derivedChainOf(readDerivedManifest(dn.dir)), [{ kind: 'denoise' }]);

  // And a two-pass set names both of them, in order — which is what makes the
  // chain reconstructible from the set alone, with nothing threaded through a
  // config to go stale.
  const q = makeSession(3);
  const req = await rvcOverDenoise(q);
  await derive(q, req);
  assert.deepStrictEqual(
    derivedChainOf(readDerivedManifest(req.dir)),
    [{ kind: 'denoise' }, { kind: 'rvc', key: 'deathstalker-sigma' }]);
});

test('a conversion set with no voice in its params cannot be named — refused', async () => {
  assert.throws(() => derivedPassOf('rvc', { indexRate: 0.3 }), /records no voice/);
  // A denoise has no variant to name, so an empty params object is fine.
  assert.deepStrictEqual(derivedPassOf('denoise', {}), { kind: 'denoise' });
});

test('a DENOISE OVER A CONVERSION records the conversion as its upstream', async () => {
  const p = makeSession(3);
  const rvc = {
    dir: derivedChainDir(p, [{ kind: 'rvc', key: 'leah' }]),
    kind: 'rvc',
    params: { voiceId: 'leah', indexRate: 0.3, gapSeconds: 0.5, minGapSeconds: 0 },
    sourceDir: rawSentencesDir(p),
  };
  await derive(p, rvc);
  const dn = {
    dir: derivedChainDir(p, [{ kind: 'rvc', key: 'leah' }, { kind: 'denoise' }]),
    kind: 'denoise',
    // Second in the chain, so it ran no gap pass: null is the ANSWER.
    params: { gapSeconds: null, minGapSeconds: 0, voice: null },
    sourceDir: rvc.dir,
    upstream: { kind: 'rvc', params: rvc.params },
  };
  const manifest = await derive(p, dn);
  assert.strictEqual(manifest.upstream.kind, 'rvc');
  assert.strictEqual((await checkDerivedSentences(dn)).reusable, true);

  // RE-CONVERTING AT A DIFFERENT INDEX RATE invalidates the denoise on top of it.
  const asked = Object.assign({}, dn, {
    upstream: { kind: 'rvc', params: Object.assign({}, rvc.params, { indexRate: 0.9 }) },
  });
  const verdict = await checkDerivedSentences(asked);
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /re-derived with different settings/);
});

test('a re-rendered sentence invalidates the SECOND pass of a chain too', async () => {
  const p = makeSession(3);
  const req = await rvcOverDenoise(p);
  await derive(p, req);
  // The denoised set is this conversion's source; touching it is what a
  // re-derivation of the denoise looks like from up here.
  const one = path.join(req.sourceDir, '1.flac');
  fs.writeFileSync(one, 'denoised-1-again');
  fs.utimesSync(one, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  const verdict = await checkDerivedSentences(req);
  assert.strictEqual(verdict.reusable, false);
  assert.match(verdict.reason, /1\.flac/);
});

test('BOTH ORDERS CAN SIT IN ONE SESSION without either replacing the other', async () => {
  const p = makeSession(2);
  // denoise → convert
  const a = await rvcOverDenoise(p);
  await derive(p, a);
  // convert → denoise, from the raw sentences
  const rvcRaw = {
    dir: derivedChainDir(p, [{ kind: 'rvc', key: 'deathstalker-sigma' }]),
    kind: 'rvc',
    params: { voiceId: 'deathstalker-sigma', indexRate: 0.3, protectRate: 0.1 },
    sourceDir: rawSentencesDir(p),
  };
  await derive(p, rvcRaw);
  const b = {
    dir: derivedChainDir(p, [{ kind: 'rvc', key: 'deathstalker-sigma' }, { kind: 'denoise' }]),
    kind: 'denoise',
    params: { gapSeconds: null, minGapSeconds: 0, voice: null },
    sourceDir: rvcRaw.dir,
    upstream: { kind: 'rvc', params: rvcRaw.params },
  };
  await derive(p, b);

  assert.deepStrictEqual(fs.readdirSync(path.join(p, 'chapters')).sort(), [
    'sentences',
    'sentences-denoised',
    'sentences-denoised-rvc-deathstalker-sigma',
    'sentences-rvc-deathstalker-sigma',
    'sentences-rvc-deathstalker-sigma-denoised',
  ]);
  assert.strictEqual((await checkDerivedSentences(a)).reusable, true, 'denoise-first survived');
  assert.strictEqual((await checkDerivedSentences(b)).reusable, true, 'rvc-first survived');
});

// ── atomicity ───────────────────────────────────────────────────────────────

test('a crash mid-derive leaves a .partial, never a set that looks complete', async () => {
  const p = makeSession(4);
  const req = denoiseReq(p);
  const partial = beginDerivedSentences(req.dir);
  fs.writeFileSync(path.join(partial, '0.flac'), 'half');
  // Nothing was committed, so nothing is visible under the real name.
  assert.strictEqual(fs.existsSync(req.dir), false);
  assert.strictEqual((await checkDerivedSentences(req)).reusable, false);
  abandonDerivedSentences(req.dir);
  assert.strictEqual(fs.existsSync(derivedPartialDir(req.dir)), false);
});

test('publishing an incomplete set is REFUSED rather than committed', async () => {
  const p = makeSession(4);
  const req = denoiseReq(p);
  const partial = beginDerivedSentences(req.dir);
  fs.writeFileSync(path.join(partial, '0.flac'), 'only one of four');
  await assert.rejects(() => commitDerivedSentences(req.dir, req), /incomplete/i);
  assert.strictEqual(fs.existsSync(req.dir), false);
});

// ── atomicity ACROSS THE LOCAL-STAGING HOP ──────────────────────────────────
//
// The passes stage their output on local disk and copy the finished set onto the
// library share in one bulk pass, so the window in which the `.partial` is
// half-populated is now a COPY rather than an hour of GPU. It is the same window,
// and it must still be unreadable: manifest last, rename last.

test('A CRASH MID-COPY leaves no readable set — neither the old one nor a half-copied one', async () => {
  const p = makeSession(4);
  const req = denoiseReq(p);
  // A good set is already published; the re-derivation must not damage it.
  await derive(p, req);
  const published = fs.readFileSync(path.join(req.dir, '3.flac'), 'utf-8');

  const second = denoiseReq(p, { gapSeconds: 0.2 });
  second.dir = req.dir;                       // same chain, so the same directory
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-stage-'));
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(stage, `${i}.flac`), `second-${i}`);
  const partial = beginDerivedSentences(second.dir);
  // The copy dies after two of four files — a pulled cable, a full disk, a stop.
  const abort = new AbortController();
  fs.copyFileSync(path.join(stage, '0.flac'), path.join(partial, '0.flac'));
  fs.copyFileSync(path.join(stage, '1.flac'), path.join(partial, '1.flac'));
  abort.abort();
  await assert.rejects(
    () => copySentenceSetInto(stage, partial, { signal: abort.signal }),
    /cancel/i,
  );

  // The OLD set is still whole and still reusable — the rename never happened.
  assert.strictEqual(fs.readFileSync(path.join(req.dir, '3.flac'), 'utf-8'), published);
  assert.strictEqual((await checkDerivedSentences(req)).reusable, true);
  // And the half-copy carries no manifest, so nothing would read it as a set.
  assert.strictEqual(readDerivedManifest(partial), null);
  // Committing it is refused by count, not published and hoped for.
  await assert.rejects(() => commitDerivedSentences(second.dir, second), /incomplete/i);

  abandonDerivedSentences(second.dir);
  fs.rmSync(stage, { recursive: true, force: true });
  assert.strictEqual((await checkDerivedSentences(req)).reusable, true, 'the old set survived the failed re-derivation');
});

test('the bulk copy carries SENTENCES ONLY — no staged file can pre-empt the manifest', async () => {
  const p = makeSession(3);
  const req = denoiseReq(p);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-stage-'));
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(stage, `${i}.flac`), `dn-${i}`);
  // Debris a pass might leave in its staging dir, including a manifest that would
  // make the `.partial` look committed if it were copied.
  fs.writeFileSync(path.join(stage, DERIVED_MANIFEST_NAME), '{"version":1,"kind":"denoise"}');
  fs.writeFileSync(path.join(stage, 'blocks.json'), '{}');

  const partial = beginDerivedSentences(req.dir);
  const copied = await copySentenceSetInto(stage, partial);
  assert.strictEqual(copied, 3);
  assert.deepStrictEqual(fs.readdirSync(partial).sort(), ['0.flac', '1.flac', '2.flac']);
  assert.strictEqual(readDerivedManifest(partial), null, 'the manifest arrives at commit, never before');

  const manifest = await commitDerivedSentences(req.dir, req);
  assert.strictEqual(manifest.outputCount, 3);
  assert.strictEqual((await checkDerivedSentences(req)).reusable, true);
  fs.rmSync(stage, { recursive: true, force: true });
});

test('an empty staging dir is REFUSED — never published as a set of nothing', async () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-stage-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-dest-'));
  await assert.rejects(() => copySentenceSetInto(stage, dest), /no sentence files/i);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
});

// ── the staging guard ───────────────────────────────────────────────────────

test('the staging guard NAMES THE NUMBER and never falls back to the share', async () => {
  const p = makeSession(3);
  const files = await fingerprintSentences(rawSentencesDir(p));
  assert.strictEqual(files.length, 3);
  assert.strictEqual(sentenceSetBytes(files), files.reduce((n, f) => n + f.size, 0));

  // Room for three tiny files exists; room for a petabyte does not.
  await assertStagingSpace(os.tmpdir(), sentenceSetBytes(files) * 2, 'The final denoise');
  await assert.rejects(
    () => assertStagingSpace(os.tmpdir(), 2 ** 50, 'The final denoise'),
    (err) => {
      assert.match(err.message, /final denoise/i);
      assert.match(err.message, /1048576\.00 GB/);       // the number it needs, spelled out
      assert.match(err.message, /will not fall back/i);  // and the refusal to route around it
      return true;
    },
  );
});

test('the sentence listing is the same rule everywhere — audio only, sorted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-list-'));
  for (const n of ['10.flac', '2.flac', '1.wav', 'blocks.json', DERIVED_MANIFEST_NAME]) {
    fs.writeFileSync(path.join(dir, n), 'x');
  }
  assert.deepStrictEqual(await listSentenceFiles(dir), ['1.wav', '10.flac', '2.flac']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a re-derivation REPLACES the old set rather than accumulating beside it', async () => {
  const p = makeSession(3);
  await derive(p, denoiseReq(p, { gapSeconds: 0.5 }));
  const second = denoiseReq(p, { gapSeconds: 0.2 });
  await derive(p, second);
  const siblings = fs.readdirSync(path.join(p, 'chapters')).sort();
  assert.deepStrictEqual(siblings, ['sentences', 'sentences-denoised']);
  assert.strictEqual((await checkDerivedSentences(second)).reusable, true);
});

// ── run ─────────────────────────────────────────────────────────────────────

(async () => {
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}
console.log(`derived-sentences: ${passed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
})();
