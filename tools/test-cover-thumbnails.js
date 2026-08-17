#!/usr/bin/env node
/**
 * The cover-thumbnail keeper: the identity, the ETag, and the cache.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-cover-thumbnails.js
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * Two things make a shelf load fast, and both of them are one string:
 *
 *   IDENTITY  (path, size, mtime) for a cover that is a file. It versions the
 *             ETag AND names the cache file, which is what removes the
 *             invalidation step — a re-saved cover lands on a different name
 *             rather than having to be noticed and evicted. If identity ever
 *             stops changing with the bytes, every phone on the network keeps
 *             showing the old art and nothing in the app says why.
 *
 *   ETAG      derived from that identity, so a 304 costs one stat(). If the
 *             comparison ever stops matching what we emit, every cover is
 *             re-downloaded on every shelf load and the only symptom is that
 *             it feels slow — the exact bug this change was made to fix, back
 *             again and invisible.
 *
 * So this checks the contract, not the plumbing: same file → same tag; changed
 * bytes → different tag; different width → different tag; a browser's real
 * `If-None-Match` shapes (list, `W/`, `*`) all compare correctly; and a
 * generated thumbnail is smaller than its source, is cached, and is re-read
 * rather than regenerated.
 *
 * No sockets. The module is filesystem-only on purpose so this can be a plain
 * node script — see electron/cover-thumbnails.ts.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MOD = path.join(REPO, 'dist', 'electron', 'cover-thumbnails.js');
if (!fs.existsSync(MOD)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const {
  ALLOWED_THUMBNAIL_WIDTHS, SHELF_THUMBNAIL_WIDTH,
  bytesCoverIdentity, coverBytes, coverEtag, etagMatches,
  fileCoverIdentity, parseThumbnailWidth, sweepThumbnailCache, thumbnailCachePath,
} = require(MOD);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(() => { passed++; }, (e) => { failed++; report(name, e); });
    passed++;
  } catch (e) {
    failed++;
    report(name, e);
  }
  return Promise.resolve();
}
function report(name, e) {
  console.log(`FAIL  ${name}`);
  console.log(`      ${e && e.message ? e.message : e}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cover-thumbs-'));

/** A real, decodable JPEG at `size`×`size` so sharp has something to resize. */
async function makeJpeg(file, size, tint) {
  const sharp = require(path.join(REPO, 'node_modules', 'sharp'));
  const buf = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: tint, g: 40, b: 200 } },
  }).jpeg({ quality: 92 }).toBuffer();
  fs.writeFileSync(file, buf);
  return buf;
}

(async () => {
  const big = path.join(TMP, 'cover.jpg');
  await makeJpeg(big, 1400, 220);

  // ── Identity ───────────────────────────────────────────────────────────────

  await check('identity is stable for an unchanged file', () => {
    const a = fileCoverIdentity(big, fs.statSync(big));
    const b = fileCoverIdentity(big, fs.statSync(big));
    assert.strictEqual(a, b);
  });

  await check('identity changes when the file does', async () => {
    const before = fileCoverIdentity(big, fs.statSync(big));
    await makeJpeg(big, 1200, 90);         // different size AND different bytes
    fs.utimesSync(big, new Date(), new Date(Date.now() + 5000));
    const after = fileCoverIdentity(big, fs.statSync(big));
    assert.notStrictEqual(before, after, 'a re-saved cover must not keep its identity');
  });

  await check('in-memory covers are identified by their bytes', () => {
    const a = bytesCoverIdentity(Buffer.from('one'));
    const b = bytesCoverIdentity(Buffer.from('one'));
    const c = bytesCoverIdentity(Buffer.from('two'));
    assert.strictEqual(a, b);
    assert.notStrictEqual(a, c);
  });

  // ── ETag ───────────────────────────────────────────────────────────────────

  const id = fileCoverIdentity(big, fs.statSync(big));

  await check('the etag is a strong quoted tag', () => {
    assert.match(coverEtag(id, 480), /^"[0-9a-f]{40}"$/);
  });

  await check('each width gets its own etag, and full-size its own again', () => {
    const tags = new Set([...ALLOWED_THUMBNAIL_WIDTHS, null].map((w) => coverEtag(id, w)));
    assert.strictEqual(tags.size, ALLOWED_THUMBNAIL_WIDTHS.length + 1,
      'two representations sharing a tag would serve one at the other\'s URL');
  });

  await check('a changed cover changes the etag at every width', () => {
    const other = bytesCoverIdentity(Buffer.from('different art'));
    for (const w of [null, ...ALLOWED_THUMBNAIL_WIDTHS]) {
      assert.notStrictEqual(coverEtag(id, w), coverEtag(other, w));
    }
  });

  // ── If-None-Match, in the shapes browsers actually send ────────────────────

  const tag = coverEtag(id, SHELF_THUMBNAIL_WIDTH);

  await check('a matching tag is a 304', () => {
    assert.strictEqual(etagMatches(tag, tag), true);
  });
  await check('no header, or a different tag, is not', () => {
    assert.strictEqual(etagMatches(undefined, tag), false);
    assert.strictEqual(etagMatches('', tag), false);
    assert.strictEqual(etagMatches(coverEtag(id, 960), tag), false);
  });
  await check('a comma list matches on any member', () => {
    assert.strictEqual(etagMatches(`${coverEtag(id, 240)}, ${tag}`, tag), true);
    assert.strictEqual(etagMatches(`"aaa", "bbb"`, tag), false);
  });
  await check('a weak validator matches (RFC 9110 uses weak comparison here)', () => {
    assert.strictEqual(etagMatches(`W/${tag}`, tag), true);
  });
  await check('* matches anything', () => {
    assert.strictEqual(etagMatches('*', tag), true);
  });

  // ── ?w= parsing ────────────────────────────────────────────────────────────

  await check('an absent width means full size, not a default thumbnail', () => {
    assert.strictEqual(parseThumbnailWidth(undefined), null);
    assert.strictEqual(parseThumbnailWidth(''), null);
  });
  await check('an allowed width parses; anything else is a refusal, not a substitution', () => {
    assert.strictEqual(parseThumbnailWidth('480'), 480);
    assert.strictEqual(parseThumbnailWidth(240), 240);
    assert.strictEqual(parseThumbnailWidth('481'), undefined);
    assert.strictEqual(parseThumbnailWidth('abc'), undefined);
    assert.strictEqual(parseThumbnailWidth('-480'), undefined);
  });

  // ── The bytes ──────────────────────────────────────────────────────────────

  const cacheDir = path.join(TMP, 'cache');
  const cover = { identity: id, contentType: 'image/jpeg', filePath: big };

  await check('full size returns the original file untouched', async () => {
    const { buffer } = await coverBytes(cacheDir, cover, null);
    assert.deepStrictEqual(buffer, fs.readFileSync(big));
  });

  let thumbBytes = 0;
  await check('a thumbnail is generated, cached, and much smaller', async () => {
    const { buffer, contentType } = await coverBytes(cacheDir, cover, 480);
    thumbBytes = buffer.length;
    assert.strictEqual(contentType, 'image/jpeg');
    const original = fs.statSync(big).size;
    assert.ok(buffer.length < original / 2,
      `thumbnail ${buffer.length}B is not meaningfully smaller than the ${original}B original`);
    assert.ok(fs.existsSync(thumbnailCachePath(cacheDir, id, 480)), 'nothing was cached');
  });

  await check('the second request reads the cache, byte for byte', async () => {
    // Prove it is the CACHE and not a re-render: rewrite the cached file and
    // watch that content come back.
    const marker = Buffer.from('not really a jpeg, but it is what is cached');
    fs.writeFileSync(thumbnailCachePath(cacheDir, id, 480), marker);
    const { buffer } = await coverBytes(cacheDir, cover, 480);
    assert.deepStrictEqual(buffer, marker);
  });

  await check('a null cache dir still serves bytes (it just keeps none)', async () => {
    const { buffer } = await coverBytes(null, cover, 240);
    assert.ok(buffer.length > 0);
    assert.ok(buffer.length < thumbBytes, '240px should be smaller than 480px');
  });

  await check('a cover with neither a path nor bytes is an error, not an empty image', async () => {
    await assert.rejects(() => coverBytes(cacheDir, { identity: 'x', contentType: 'image/jpeg' }, null));
  });

  // ── The sweep ──────────────────────────────────────────────────────────────

  await check('the sweep trims oldest-first and leaves a small cache alone', () => {
    const dir = path.join(TMP, 'sweep');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      const f = path.join(dir, `f${i}-480.jpg`);
      fs.writeFileSync(f, 'x');
      const t = new Date(Date.now() - (10 - i) * 60000);
      fs.utimesSync(f, t, t);
    }
    sweepThumbnailCache(dir, 20);
    assert.strictEqual(fs.readdirSync(dir).length, 10, 'an under-cap cache must not be touched');
    sweepThumbnailCache(dir, 4);
    const left = fs.readdirSync(dir).sort();
    assert.strictEqual(left.length, 4);
    assert.deepStrictEqual(left, ['f6-480.jpg', 'f7-480.jpg', 'f8-480.jpg', 'f9-480.jpg'],
      'the sweep kept the wrong four — it must drop the oldest');
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`${failed === 0 ? 'ok' : 'FAILED'}  cover thumbnails: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
