#!/usr/bin/env node
/**
 * The sidecar delivery tier: WHEN the anti-spillover proof is paid, and when it
 * is not owed at all.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-sidecar-delivery.js
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *
 * `resolveSidecars` serves a cover or transcript only after proving the m4b
 * beside it hashes to the digest its binding recorded. That proof is the whole
 * protocol (electron/sidecar-binding.ts) and nothing here relaxes it: every case
 * below that COULD end in a served file still reads every byte of the audiobook.
 *
 * What changed on 2026-09-19 is the order the questions are asked in. The proof
 * is about a PAIRING, so it is owed only when there is something to pair, and
 * the old order read the whole audiobook first and looked for the sidecar after.
 * Over the library's SMB mount that is ~6 s of reading per book, on `/api/vtt`,
 * which gates playback — and 91 of 210 audiobooks measured had no bound
 * transcript for it to find.
 *
 * So the checks come in two halves, and the second is the reason for the first:
 *
 *  1. The guarantee, unchanged: a wrong hash serves NOTHING, a right hash serves
 *     the file, and a caller can tell the two apart from `m4b`.
 *  2. The skips, proved by BYTES NEVER READ rather than by timing. Each of those
 *     checks replaces `fs.createReadStream` with a function that throws, so a
 *     call that would hash anything cannot return at all. A test that watched a
 *     clock would pass on a fast disk and say nothing about the decision.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIST = path.resolve(__dirname, '..', 'dist', 'electron');
const {
  resolveSidecars,
  m4bIdentity,
  SIDECAR_BINDING_VERSION,
} = require(path.join(DIST, 'sidecar-binding.js'));

let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.then(
      () => console.log(`ok   ${name}`),
      (err) => { console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err}`); process.exitCode = 1; },
    );
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err}`);
    process.exitCode = 1;
  }
  return Promise.resolve();
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A book on disk: an "m4b", a VTT and a cover beside it, and a binding over all three. */
function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-sidecar-delivery-'));
  const m4bPath = path.join(dir, 'Book.m4b');
  const audio = Buffer.from(opts.audio ?? 'PRETEND THIS IS AN AUDIOBOOK');
  fs.writeFileSync(m4bPath, audio);

  const assets = {};
  if (opts.vtt !== false) {
    const body = Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n');
    fs.writeFileSync(path.join(dir, 'Book.m4b.vtt'), body);
    assets.vtt = { path: 'output/Book.m4b.vtt', sha256: sha(body), bytes: body.length, source: 'embedded' };
  }
  if (opts.cover !== false) {
    const body = Buffer.from('\x89PNG-ish');
    fs.writeFileSync(path.join(dir, 'Book.m4b.cover.png'), body);
    assets.cover = { path: 'output/Book.m4b.cover.png', sha256: sha(body), bytes: body.length, source: 'metadata' };
  }
  // The binding is written to describe the audio that is there, unless a check
  // is deliberately describing different audio.
  const binding = {
    protocol: SIDECAR_BINDING_VERSION,
    projectId: 'A_Book_-_Someone_(2026)',
    variantId: 'audiobook',
    m4b: {
      path: 'output/Book.m4b',
      sha256: opts.bindingSha ?? sha(audio),
      bytes: opts.bindingBytes ?? audio.length,
    },
    assets,
    createdAt: new Date().toISOString(),
    generator: 'test-sidecar-delivery',
  };
  return { dir, m4bPath, binding };
}

/**
 * Run `fn` and COUNT the whole-file reads it caused.
 *
 * Counted, not forbidden. The first draft of this helper made `createReadStream`
 * throw — and every check still passed with the skip removed, because
 * `resolveSidecars` catches an unreadable audiobook and returns the same empty
 * answer it returns when there was nothing to read. A stub that throws proves
 * only that the caller has a catch. A tally cannot be swallowed.
 */
async function countingReads(fn) {
  const realCreate = fs.createReadStream;
  let reads = 0;
  fs.createReadStream = (...args) => { reads += 1; return realCreate.apply(fs, args); };
  try { return { value: await fn(), reads }; } finally { fs.createReadStream = realCreate; }
}

async function main() {
  // ── 1. The guarantee ──────────────────────────────────────────────────────

  await check('the bytes match: both sidecars are served, and `m4b` says it was PROVED', async () => {
    const { dir, m4bPath, binding } = fixture();
    const r = await resolveSidecars(binding, m4bPath, dir);
    assert.strictEqual(r.m4b, 'proved');
    assert.strictEqual(path.basename(r.vtt), 'Book.m4b.vtt');
    assert.strictEqual(path.basename(r.cover), 'Book.m4b.cover.png');
  });

  await check('a WRONG hash at the right length serves nothing, and says `disproved` — the anti-spillover guarantee', async () => {
    const { dir, m4bPath, binding } = fixture({ bindingSha: 'f'.repeat(64) });
    const r = await resolveSidecars(binding, m4bPath, dir);
    assert.strictEqual(r.m4b, 'disproved');
    assert.strictEqual(r.vtt, null);
    assert.strictEqual(r.cover, null);
  });

  await check('an audiobook that is not there serves nothing and claims nothing about its bytes', async () => {
    const { dir, m4bPath, binding } = fixture();
    fs.unlinkSync(m4bPath);
    const r = await resolveSidecars(binding, m4bPath, dir);
    assert.strictEqual(r.m4b, 'not-asked');
    assert.strictEqual(r.vtt, null);
  });

  await check('verifyAssetBytes still catches an EDITED sidecar, even though the audiobook proved', async () => {
    const { dir, m4bPath, binding } = fixture();
    fs.writeFileSync(path.join(dir, 'Book.m4b.vtt'), 'WEBVTT\n\nsomebody else wrote this\n');
    const r = await resolveSidecars(binding, m4bPath, dir, { verifyAssetBytes: true });
    assert.strictEqual(r.m4b, 'proved', 'the audiobook is still the right audiobook');
    assert.strictEqual(r.vtt, null, 'but that transcript is not the one it was bound to');
    assert.ok(r.cover, 'and the cover, which was not edited, is unaffected');
  });

  // ── 2. The skips, proved by bytes never read ──────────────────────────────

  await check('NO TRANSCRIPT IN THE BINDING: asking for one reads not a byte of the audiobook', async () => {
    const { dir, m4bPath, binding } = fixture({ vtt: false });
    const { value: r, reads } = await countingReads(() => resolveSidecars(binding, m4bPath, dir, { kinds: ['vtt'] }));
    assert.strictEqual(reads, 0, `the audiobook was streamed ${reads} time(s) to answer a question about a transcript that is not bound`);
    assert.strictEqual(r.vtt, null);
    // NOT `disproved`: nothing about this audiobook was in question. This is the
    // whole reason the field has three values — see SidecarResolution.
    assert.strictEqual(r.m4b, 'not-asked');
  });

  await check('a bound transcript whose FILE IS GONE is the same answer at the same price', async () => {
    const { dir, m4bPath, binding } = fixture();
    fs.unlinkSync(path.join(dir, 'Book.m4b.vtt'));
    const { value: r, reads } = await countingReads(() => resolveSidecars(binding, m4bPath, dir, { kinds: ['vtt'] }));
    assert.strictEqual(reads, 0, `the audiobook was streamed ${reads} time(s) for a transcript file that is gone`);
    assert.strictEqual(r.vtt, null);
    assert.strictEqual(r.m4b, 'not-asked');
  });

  await check('a DIFFERENT LENGTH disproves the binding for the cost of a stat', async () => {
    const { dir, m4bPath, binding } = fixture({ bindingBytes: 999_999 });
    const { value: r, reads } = await countingReads(() => resolveSidecars(binding, m4bPath, dir));
    assert.strictEqual(reads, 0, `the audiobook was streamed ${reads} time(s) to disprove what one stat disproves`);
    assert.strictEqual(r.m4b, 'disproved', 'bytes of another length cannot hash to that digest');
    assert.strictEqual(r.vtt, null);
    assert.strictEqual(r.cover, null);
  });

  await check('asking only for a COVER does not pay for a transcript that is sitting right there', async () => {
    // Both assets are bound and present, so the whole-file hash IS owed — the
    // point of this check is that `kinds` narrows the question rather than
    // filtering the answer, which is what makes the skips above reachable.
    const { dir, m4bPath, binding } = fixture();
    const r = await resolveSidecars(binding, m4bPath, dir, { kinds: ['cover'] });
    assert.strictEqual(r.m4b, 'proved');
    assert.ok(r.cover);
    assert.strictEqual(r.vtt, null, 'a transcript nobody asked about is not resolved');
  });

  await check('a binding with a cover and no transcript still serves the cover', async () => {
    const { dir, m4bPath, binding } = fixture({ vtt: false });
    const r = await resolveSidecars(binding, m4bPath, dir, { kinds: ['cover'] });
    assert.strictEqual(r.m4b, 'proved');
    assert.ok(r.cover);
  });

  // ── 3. One hash for two askers ────────────────────────────────────────────

  await check('two overlapping requests for one audiobook read it ONCE', async () => {
    const { m4bPath } = fixture();
    let reads = 0;
    const realCreate = fs.createReadStream;
    fs.createReadStream = (...args) => { reads += 1; return realCreate.apply(fs, args); };
    try {
      const [a, b] = await Promise.all([m4bIdentity(m4bPath), m4bIdentity(m4bPath)]);
      assert.strictEqual(a.sha256, b.sha256);
      assert.strictEqual(reads, 1, `the file was streamed ${reads} time(s) for two concurrent callers`);
    } finally { fs.createReadStream = realCreate; }
  });

  await check('a `strict` caller never joins a delivery flight — it exists to read the real bytes now', async () => {
    const { m4bPath } = fixture();
    let reads = 0;
    const realCreate = fs.createReadStream;
    fs.createReadStream = (...args) => { reads += 1; return realCreate.apply(fs, args); };
    try {
      await Promise.all([m4bIdentity(m4bPath), m4bIdentity(m4bPath, { strict: true })]);
      assert.strictEqual(reads, 2, 'strict must do its own read');
    } finally { fs.createReadStream = realCreate; }
  });

  await check('a second look at an UNCHANGED file is served from the delivery cache', async () => {
    const { m4bPath } = fixture();
    await m4bIdentity(m4bPath);
    const { value: again, reads } = await countingReads(() => m4bIdentity(m4bPath));
    assert.strictEqual(reads, 0, 'an unchanged file is not re-read');
    assert.ok(/^[a-f0-9]{64}$/.test(again.sha256));
  });

  console.log(`\n${ran} checks, ${process.exitCode ? 'FAILING' : 'all passing'}`);
}

void main();
