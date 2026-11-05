#!/usr/bin/env node
/**
 * A TAG WRITE NEVER RISKS THE BOOK (Owen, 2026-11-05).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-m4b-tags.js
 *
 * A crash at any point must leave the old book or the new one, whole and playable. So a
 * child process is really killed at each named point in both paths, on each layout the
 * library holds, and the audio, chapters and tags are read back through ffmpeg. Every file
 * here is built in a temp folder. Mutagen's parity was measured on real books separately;
 * this pins the behaviour once the Python is gone.
 */
'use strict';
const assert = require('assert');
const { spawnSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');
const DOOR = path.join(REPO, 'dist', 'electron', 'narrator', 'assemble', 'm4b-tags.js');
if (!fs.existsSync(DOOR)) {
  console.log(skipLine('dist/electron/narrator/assemble/m4b-tags.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}
const FFMPEG = process.env.BF_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.BF_FFPROBE || 'ffprobe';
if (spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.log(skipLine('ffmpeg is not on PATH, and these books are built and read with it'));
  process.exit(0);
}
const tags = require(DOOR);
const probe = tags.ffmpegM4bProbe(FFMPEG, FFPROBE);
const CHILD = path.join(__dirname, 'm4b-kill-child.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-m4b-tags-'));
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
const ff = (...args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });

// ── books, one per layout the library holds ───────────────────────────────────
const at = (name) => path.join(root, name);
fs.writeFileSync(at('meta.txt'), ';FFMETADATA1\ntitle=Old Title\nartist=An Author\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=One\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=4000\ntitle=Two\n');
fs.writeFileSync(at('s.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello there.\n');
ff('-f', 'lavfi', '-i', 'anoisesrc=d=4:c=pink:r=44100:a=0.2', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', at('a.m4a'));
const base = ['-i', at('a.m4a'), '-i', at('meta.txt'), '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy'];
const LAYOUTS = {
  'moov first, no keys': (out) => ff(...base, '-f', 'ipod', '-movflags', '+faststart', out),
  'moov first, keys atom': (out) => ff(...base, '-f', 'mp4', '-movflags', '+faststart+use_metadata_tags', out),
  'mdat first': (out) => ff(...base, '-f', 'ipod', out),
  'mdat first, keys atom': (out) => ff(...base, '-f', 'mp4', '-movflags', '+use_metadata_tags', out),
};
const books = {};
let n = 0;
for (const [name, build] of Object.entries(LAYOUTS)) {
  n += 1;
  books[name] = at(`book${n}.m4b`);
  build(books[name]);
}
// A real cover's worth of bytes: far more than any padding a muxer leaves.
const coverPath = at('cover.jpg');
fs.writeFileSync(coverPath, crypto.createHash('sha256').update('cover').digest().toString('hex').repeat(2000));

// ── reading a book back, independently of the writer ──────────────────────────
function atoms(buffer, from, to) {
  const out = [];
  let p = from;
  while (p + 8 <= to) {
    let length = buffer.readUInt32BE(p);
    let header = 8;
    if (length === 1) { length = Number(buffer.readBigUInt64BE(p + 8)); header = 16; } else if (length === 0) length = to - p;
    if (length < 8) throw new Error(`bad atom at ${p}`);
    out.push({ name: buffer.toString('latin1', p + 4, p + 8), start: p, end: p + length, body: p + header });
    p += length;
  }
  return out;
}
function metaOf(file) {
  const buffer = fs.readFileSync(file);
  const top = atoms(buffer, 0, buffer.length);
  const moov = top.find((a) => a.name === 'moov');
  const udta = atoms(buffer, moov.body, moov.end).find((a) => a.name === 'udta');
  const meta = atoms(buffer, udta.body, udta.end).find((a) => a.name === 'meta');
  return { buffer, kids: atoms(buffer, meta.body + 4, meta.end) };
}
function titlesIn(file) {
  const { buffer, kids } = metaOf(file);
  return kids.filter((a) => a.name === 'ilst').map((ilst) => {
    const item = atoms(buffer, ilst.body, ilst.end).find((a) => a.name === '\xa9nam');
    if (!item) return null;
    const data = atoms(buffer, item.body, item.end).find((a) => a.name === 'data');
    return buffer.toString('utf8', data.body + 8, data.end);
  });
}
const partialsIn = (dir) => fs.readdirSync(dir).filter(tags.isM4bTagPartial);

/** The whole book, as anything that plays it would read it. */
async function assertWhole(file, want, allowedTitles) {
  assert.strictEqual(await probe.audioPackets(file), want.audio, 'the audio packets changed');
  assert.strictEqual(await probe.chapters(file), want.chapters, 'the chapters changed');
  const titles = titlesIn(file);
  assert.ok(titles.length >= 1, 'no ilst left');
  for (const title of titles) assert.ok(allowedTitles.includes(title), `a torn tag: ${JSON.stringify(title)}`);
}

function kill(file, point, title, cover) {
  return spawnSync(process.execPath, [CHILD, file, point, title, ...(cover ? [cover] : [])], {
    encoding: 'utf8', env: { ...process.env, BF_M4B_REPO: REPO, BF_FFMPEG: FFMPEG, BF_FFPROBE: FFPROBE },
  });
}
// Windows reports a self-kill as exit 1. The child's own failures exit 3, success 0.
const killedByPoint = (result) => result.signal === 'SIGKILL' || result.status === 1;

const COPY_POINTS = ['copy:mid', 'copy:written', 'copy:verified', 'copy:swapped'];
const INPLACE_POINTS = ['inplace:written', 'inplace:both', 'inplace:flipped'];

async function main() {
  for (const [layout, book] of Object.entries(books)) {
    const dir = path.join(root, `run-${path.basename(book)}`);
    fs.mkdirSync(dir);
    const want = { audio: await probe.audioPackets(book), chapters: await probe.chapters(book) };

    for (const point of COPY_POINTS) {
      await check(`${layout}: killed at ${point}, the book is whole`, async () => {
        const copy = path.join(dir, `${point.replace(':', '-')}.m4b`);
        fs.copyFileSync(book, copy);
        const result = kill(copy, point, 'New Title', coverPath);
        assert.ok(killedByPoint(result), `it was not killed: status ${result.status} ${result.stderr}`);
        // A keys book holds its title in numbered items, so it has no ©nam until a write.
        const allowed = point === 'copy:swapped' ? ['New Title'] : titlesIn(book);
        await assertWhole(copy, want, allowed);
      });
    }
    await check(`${layout}: what a kill left is recognised, and only a stale one is removed`, async () => {
      const left = partialsIn(dir);
      assert.ok(left.length >= 1, 'a kill mid-copy should leave a partial');
      assert.deepStrictEqual(await tags.removeM4bTagLeftovers(dir), [], 'a young partial may be another machine\'s');
      const removed = await tags.removeM4bTagLeftovers(dir, Date.now() + 2 * 60 * 60 * 1000);
      assert.strictEqual(removed.length, left.length);
      assert.deepStrictEqual(partialsIn(dir), []);
    });

    // A padded book: the copy path leaves room, so what follows is the in-place path.
    const padded = path.join(dir, 'padded.m4b');
    fs.copyFileSync(book, padded);
    await check(`${layout}: a new file keeps the audio and chapters, and leaves no partial`, async () => {
      await tags.setM4bItems(padded, tags.audiobookItems({ title: 'Padded' }, { data: fs.readFileSync(coverPath), path: coverPath }), { probe });
      await assertWhole(padded, want, ['Padded']);
      assert.deepStrictEqual(partialsIn(dir), []);
    });
    await check(`${layout}: the next edit fits the padding, so no audio moves, repeatedly`, async () => {
      const size = fs.statSync(padded).size;
      const before = fs.readFileSync(padded);
      const mdat = atoms(before, 0, before.length).filter((a) => a.name === 'mdat').map((a) => [a.start, a.end]);
      const copying = [];
      for (let i = 0; i < 6; i += 1) {
        await tags.setM4bItems(padded, tags.audiobookItems({ title: `Edit ${i}` }, null), {
          probe, onProgress: (p) => copying.push(p),
        });
        assert.deepStrictEqual(titlesIn(padded), [`Edit ${i}`]);
      }
      assert.deepStrictEqual(copying, [], 'it fell back to a whole-file copy');
      assert.strictEqual(fs.statSync(padded).size, size);
      const after = fs.readFileSync(padded);
      for (const [start, end] of mdat) assert.ok(before.subarray(start, end).equals(after.subarray(start, end)));
      await assertWhole(padded, want, ['Edit 5']);
    });
    for (const point of INPLACE_POINTS) {
      await check(`${layout}: killed in place at ${point}, the book is whole, and the next write heals it`, async () => {
        const copy = path.join(dir, `in-${point.replace(':', '-')}.m4b`);
        fs.copyFileSync(padded, copy);
        const result = kill(copy, point, 'Killed Edit');
        assert.ok(killedByPoint(result), `it was not killed: status ${result.status} ${result.stderr}`);
        await assertWhole(copy, want, ['Edit 5', 'Killed Edit']);
        await tags.setM4bItems(copy, tags.audiobookItems({ title: 'Healed' }, null), { probe });
        assert.deepStrictEqual(titlesIn(copy), ['Healed']);
        await assertWhole(copy, want, ['Healed']);
      });
    }
  }

  // ── refusals: the book is untouched, by name ────────────────────────────────
  const book = books['moov first, no keys'];
  const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const items = tags.audiobookItems({ title: 'Refused' }, { data: fs.readFileSync(coverPath), path: coverPath });
  const refused = fs.mkdtempSync(path.join(root, 'refused-'));
  const inRefused = (name) => { const f = path.join(refused, name); fs.copyFileSync(book, f); return f; };

  await check('no room is refused by name, before anything is written', async () => {
    const f = inRefused('room.m4b');
    const was = hash(f);
    await assert.rejects(tags.setM4bItems(f, items, { probe, freeBytes: async () => 1000 }), (e) => e.code === 'm4b_no_room' && /not touched/.test(e.message));
    assert.strictEqual(hash(f), was);
    assert.deepStrictEqual(partialsIn(refused), []);
  });
  await check('a new copy whose audio differs is discarded, and the book kept', async () => {
    const f = inRefused('audio.m4b');
    const was = hash(f);
    const lying = { ...probe, audioPackets: async (file) => (file === f ? 'old' : 'new') };
    await assert.rejects(tags.setM4bItems(f, items, { probe: lying }), (e) => e.code === 'm4b_write_unverified' && /audio/.test(e.message));
    assert.strictEqual(hash(f), was);
    assert.deepStrictEqual(partialsIn(refused), []);
  });
  await check('chapters that differ are discarded too', async () => {
    const f = inRefused('chapters.m4b');
    const was = hash(f);
    const lying = { ...probe, chapters: async (file) => (file === f ? 'old' : 'new') };
    await assert.rejects(tags.setM4bItems(f, items, { probe: lying }), (e) => e.code === 'm4b_write_unverified' && /chapters/.test(e.message));
    assert.strictEqual(hash(f), was);
  });
  await check('a book changed during the copy is not overwritten', async () => {
    const f = inRefused('changed.m4b');
    const touching = {
      ...probe,
      chapters: async (file) => { fs.utimesSync(f, new Date(), new Date(Date.now() + 5000)); return probe.chapters(file); },
    };
    await assert.rejects(tags.setM4bItems(f, items, { probe: touching }), (e) => e.code === 'm4b_changed_underneath');
    assert.deepStrictEqual(partialsIn(refused), []);
  });
  await check('stopping a copy removes the partial and keeps the book', async () => {
    const f = inRefused('stop.m4b');
    const was = hash(f);
    const stop = new AbortController();
    await tags.setM4bItems(f, items, { probe, signal: stop.signal, onProgress: () => stop.abort() });
    assert.strictEqual(hash(f), was);
    assert.deepStrictEqual(partialsIn(refused), []);
  });
  await check('progress is reported through the copy and the verify', async () => {
    const f = inRefused('progress.m4b');
    const seen = [];
    await tags.setM4bItems(f, items, { probe, onProgress: (p) => seen.push(p) });
    assert.ok(seen.some((p) => p.phase === 'copying' && p.bytesDone === p.bytesTotal));
    assert.ok(seen.some((p) => p.phase === 'verifying'));
  });
  await check('something that is not an mp4 is refused by name', async () => {
    const f = at('not.m4b');
    fs.writeFileSync(f, Buffer.alloc(4096, 0x41));
    await assert.rejects(tags.setM4bItems(f, items, { probe }), (e) => e instanceof tags.M4bTagError);
  });

  // Z: refuses about 6 % of renames with EPERM (40 real writes there on 2026-11-05 happened
  // to meet none), so the refusal is forced here rather than waited for.
  const withRefusals = async (times, fn) => {
    const real = fs.renameSync;
    let left = times;
    let asked = 0;
    fs.renameSync = (a, b) => {
      asked += 1;
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      return real(a, b);
    };
    try { await fn(); } finally { fs.renameSync = real; }
    return asked;
  };
  await check('a rename the share refuses is waited out, and the book lands', async () => {
    const f = inRefused('eperm.m4b');
    const want = await probe.audioPackets(f);
    const asked = await withRefusals(2, () => tags.setM4bItems(f, items, { probe }));
    assert.strictEqual(asked, 3);
    assert.deepStrictEqual(titlesIn(f), ['Refused']);
    assert.strictEqual(await probe.audioPackets(f), want);
    assert.deepStrictEqual(partialsIn(refused), []);
  });

  await check('through applyMetadata, the door every caller uses', async () => {
    const { installElectronStub } = require('./fake-crucible');
    installElectronStub('bf-m4b-apply-');
    const { applyMetadata } = require(path.join(REPO, 'dist', 'electron', 'metadata-tools.js'));
    const f = inRefused('apply.m4b');
    const want = await probe.audioPackets(f);
    const seen = [];
    await applyMetadata(f, { title: 'Applied', author: 'An Author', narrator: 'A Narrator', series: 'A Series' }, { onProgress: (p) => seen.push(p.phase) });
    assert.deepStrictEqual(titlesIn(f), ['Applied']);
    assert.strictEqual(await probe.audioPackets(f), want);
    assert.ok(typeof seen.length === 'number');
    assert.ok(!fs.existsSync(path.join(REPO, 'electron', 'scripts', 'write_m4b_tags.py')), 'the Python writer is gone');
  });

  await check('the sweep finds a stale partial in the folders books live in, not a book', async () => {
    const projects = path.join(root, 'projects');
    const out = path.join(projects, 'p1', 'archive');
    fs.mkdirSync(out, { recursive: true });
    const stale = path.join(out, '.bf-retag-host-1-2.partial');
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(path.join(out, 'book.m4b'), 'x');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    assert.deepStrictEqual(await tags.sweepM4bTagLeftovers(projects), [stale]);
    assert.ok(fs.existsSync(path.join(out, 'book.m4b')));
  });
  await check('the fields map to the atoms the Python writer used, and an empty one is skipped', () => {
    const got = tags.audiobookItems({ title: 'T', artist: 'A', composer: 'N', grouping: 'S', genre: 'G', date: 'D', description: 'X', other: 'no' }, null);
    assert.deepStrictEqual(got.map((i) => i.name), ['\xa9nam', '\xa9ART', '\xa9wrt', '\xa9grp', '\xa9gen', '\xa9day', 'desc', 'stik']);
    assert.strictEqual(tags.audiobookItems({ title: '' }, null).length, 1);
    assert.strictEqual(tags.coverItem(Buffer.alloc(1), 'a.PNG').dataType, 14);
    assert.strictEqual(tags.coverItem(Buffer.alloc(1), 'a.jpg').dataType, 13);
  });
  await check('nothing renames a book but through the retrying door', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron/narrator/assemble/m4b-tags.ts'), 'utf8');
    assert.ok(/renameWithRetry\(partial, file, LARGE_FILE_RETRY_DELAYS_MS\)/.test(src));
    assert.ok(!/\.rename(Sync)?\(/.test(src));
  });

  console.log(`\ntest-m4b-tags: ${passed} passed, ${failed.length} failed`);
  if (failed.length > 0) console.log(`  failed: ${failed.join(', ')}`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => { fs.rmSync(root, { recursive: true, force: true }); });
