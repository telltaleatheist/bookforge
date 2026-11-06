#!/usr/bin/env node
/**
 * THE MANIFEST AND THE SESSION READERS, HELD TO THE PYTHON'S OWN ANSWERS.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narrator-session.js
 *
 * `tools/fixtures/narrator-session-cases.json` was captured from the Python narrator before
 * it left the repo: every scenario its tests name, with the session tree it ran on, and the
 * exact bytes or refusal it answered with. The FLACs are their real headers, padded back to
 * their real size, because a header is all these readers read.
 * `tools/fixtures/narrator-py-compat.json` does the same for py-compat.ts.
 *
 * The first porting of this was also measured on every session on the library (72 sessions,
 * 156 variants); this pins that result once the Python is gone.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');
const NARRATOR = path.join(REPO, 'dist', 'electron', 'narrator');
if (!fs.existsSync(path.join(NARRATOR, 'session', 'session-v1.js'))) {
  console.log(skipLine('dist/electron/narrator/session/session-v1.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}
const py = require(path.join(NARRATOR, 'py-compat.js'));
const M = require(path.join(NARRATOR, 'session', 'manifest.js'));
const S = require(path.join(NARRATOR, 'session', 'session-v1.js'));
const ST = require(path.join(NARRATOR, 'session', 'session-store.js'));
const FH = require(path.join(NARRATOR, 'session', 'flac-header.js'));
const { ENGINE_PROFILES, profileFor } = require(path.join(NARRATOR, 'assemble', 'engine-profiles.js'));

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'narrator-session-cases.json'), 'utf8'));
const compat = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'narrator-py-compat.json'), 'utf8'));

let passed = 0;
const failed = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failed.push(name);
    console.log(`  FAIL  ${name}\n        ${String(err.message || err).slice(0, 900)}`);
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-narrator-session-'));
let caseNumber = 0;

function plantTree(tree) {
  const root = path.join(scratch, String(caseNumber++));
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, entry] of Object.entries(tree)) {
    if (entry === null) {
      fs.mkdirSync(path.join(root, rel), { recursive: true });
      continue;
    }
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof entry === 'string') {
      fs.writeFileSync(file, entry);
    } else if (typeof entry.text === 'number') {
      fs.writeFileSync(file, fixture.texts[entry.text]);
    } else {
      const blob = entry.flac === undefined ? { head: entry.bytes, size: entry.size } : fixture.blobs[entry.flac];
      const bytes = Buffer.alloc(blob.size);
      Buffer.from(blob.head, 'base64').copy(bytes);
      fs.writeFileSync(file, bytes);
    }
  }
  return root;
}

/** The temp folder and the separator are the only things allowed to differ. */
function clean(text, root) {
  let out = text;
  for (const spelling of [root, root.replace(/\\/g, '\\\\'), root.replace(/\\/g, '/')]) out = out.split(spelling).join('<ROOT>');
  return out.replace(/\\\\/g, '/').replace(/\\/g, '/');
}

/**
 * Two spellings are allowed to differ and nothing else: a JSON parser's own account of where
 * it gave up, and how a refusal prints four bad bytes (Python's b'not ' is a Python-ism).
 */
function refusalWords(text) {
  return text
    .replace(/(is not valid JSON): .*$/s, '$1')
    .replace(/(could not be read\/parsed) \(.*?\)\. Refusing/s, '$1. Refusing')
    .replace(/\(magic is .*?, expected .*?\)/, '(magic)');
}

(async () => {
  // ── The Python's float, int and repr ──────────────────────────────────────────────
  for (const [text, value] of Object.entries(compat.floats)) {
    await check(`float ${text}`, () => assert.strictEqual(py.pyFloatRepr(value), text));
  }
  for (const [text, [value, rounded]] of Object.entries(compat.rounds)) {
    await check(`round ${text}`, () => assert.strictEqual(py.pyRound1(value), rounded));
  }
  for (const [text, value] of Object.entries(compat.ints)) {
    await check(`int ${JSON.stringify(text)}`, () => assert.strictEqual(py.pyInt(text), value));
  }
  // A float that is whole arrives here as a JSON number, and only PyFloat keeps it a float.
  const floatsInReprs = new Set(['0.0']);
  for (const [jsonText, text] of Object.entries(compat.reprs)) {
    const value = JSON.parse(jsonText);
    const held = floatsInReprs.has(jsonText) ? py.pyFloat(value) : value;
    await check(`repr ${jsonText}`, () => assert.strictEqual(py.pyRepr(held), text));
  }
  await check('repr escapes what Python calls non-printable, in Python\'s own forms', () => {
    // Captured from CPython 3.11's repr(). Prep's log and refusals quote book text through this.
    const vectors = [["a­b", "'a\\xadb'"], ["x y", "'x\\xa0y'"], ["z​w", "'z\\u200bw'"], ["󠀁t", "'\\U000e0001t'"], ["é😀", "'é😀'"], ["\u0000\u007f\u0085", "'\\x00\\x7f\\x85'"], ["  ", "'\\u2028\\u2029'"], ["　 ", "'\\u3000 '"], ["퟿", "'\\ud7ff'"], ["", "'\\ue000'"], ["􏿿", "'\\U0010ffff'"], ["it's", "\"it's\""], ["say \"hi\"", "'say \"hi\"'"], ["both ' \"", "'both \\' \"'"], ["tab\t\n\r\\", "'tab\\t\\n\\r\\\\'"], ["͸", "'\\u0378'"], ["﻿", "'\\ufeff'"]];
    for (const [value, want] of vectors) assert.strictEqual(py.pyRepr(value), want);
  });
  await check('json.dumps', () => {
    const f = py.pyFloat;
    assert.strictEqual(
      py.pyJsonDumps({ a: f(0), b: [1, 2.5, 'xé \n"\\'], c: {}, d: [], e: null, f: true, g: f(1e-5), h: f(1e16), i: f(1.5e300), j: f(0.1 + 0.2) }),
      compat.dumps,
    );
  });

  // ── The assembler's table: a wrong row is a book that clicks at every join ────────
  await check('the engine table equals engine_profiles.py', () => {
    assert.deepStrictEqual(Object.keys(ENGINE_PROFILES).sort(), Object.keys(fixture.profiles).sort());
    for (const [id, row] of Object.entries(fixture.profiles)) {
      const ours = profileFor(id);
      assert.strictEqual(ours.pads, row.pads, id);
      assert.strictEqual(ours.fadeInMs, row.fade_in_ms, id);
      assert.strictEqual(ours.fadeOutMs, row.fade_out_ms, id);
    }
  });

  // ── Every scenario the Python's tests name ────────────────────────────────────────
  for (const c of fixture.cases) {
    await check(`manifest: ${c.name}`, async () => {
      const root = plantTree(c.tree);
      const processDir = path.join(root, c.process);
      const sentencesDir = c.sentences ? path.join(processDir, ...c.sentences.split('/')) : null;
      const log = [];
      let text;
      let refused;
      try {
        const manifest = await S.buildManifest(processDir, { sentencesDir, chapters: c.chapters, log: (l) => log.push(l) });
        text = M.renderManifest(manifest);
        // what was built must also survive its own validator and its own round trip
        M.validate(manifest);
        assert.strictEqual(M.renderManifest(M.fromDict(JSON.parse(text))), text, 'round trip');
        text = clean(text, root);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        refused = clean(err.message, root);
      }
      if (c.refused !== undefined) {
        assert.strictEqual(text, undefined, 'the Python refused and this built');
        assert.strictEqual(refusalWords(refused), refusalWords(c.refused));
      } else {
        assert.strictEqual(refused, undefined, `the Python built and this refused: ${refused}`);
        assert.strictEqual(text, c.text);
      }
      assert.deepStrictEqual(log.map((l) => clean(l, root)), c.log);
    });
  }

  // ── The store's readers ───────────────────────────────────────────────────────────
  for (const c of fixture.store) {
    await check(`store: ${c.name}`, async () => {
      const root = plantTree(c.tree);
      const named = c.args.session === undefined ? 'ebook-ccd14111' : c.args.session;
      const arg = named.startsWith('bare:') ? named.slice(5) : path.join(root, named);
      const processDir = path.join(root, 'ebook-ccd14111', '645fe7068635f759cbda0b8a6d3a348d');
      let got;
      let refused;
      const realLog = console.log;
      console.log = () => {}; // resume's warnings go to stdout, as the Python's do
      try {
        if (c.op === 'list') got = await ST.listResumableSessions(root);
        else if (c.op === 'resume') got = await ST.resumeSession(arg, root, c.kw && c.kw.voice, c.kw && c.kw.tts_engine);
        else if (c.op === 'scan') got = await ST.scanCompletedSentences(path.join(processDir, 'chapters', 'sentences'), c.args.total);
        else if (c.op === 'resolve') got = { process: await ST.resolveProcessDir(arg), found: await ST.findProcessDir(arg) };
        else if (c.op === 'load') got = await ST.loadSessionStateFrom(arg);
      } catch (err) {
        refused = clean(err.message, root);
      } finally {
        console.log = realLog;
      }
      if (c.refused !== undefined) {
        assert.strictEqual(refusalWords(refused || ''), refusalWords(c.refused));
      } else {
        assert.strictEqual(refused, undefined, `the Python answered and this refused: ${refused}`);
        assert.deepStrictEqual(JSON.parse(clean(JSON.stringify(got), root)), c.want);
      }
    });
  }

  for (const [missing, ranges] of Object.entries(fixture.ranges)) {
    await check(`missing ranges ${missing}`, () => assert.deepStrictEqual(ST.calculateMissingRanges(JSON.parse(missing)), ranges));
  }

  await check('a saved state is the Python\'s bytes, keys in its order, and no temp file stays', async () => {
    const dir = path.join(scratch, 'save');
    fs.mkdirSync(dir, { recursive: true });
    const input = JSON.parse(JSON.stringify(fixture.save.input).split('<ROOT>').join(dir.replace(/\\/g, '/')));
    await ST.saveSessionState(dir, input);
    assert.deepStrictEqual(fs.readdirSync(dir), ['session-state.json']);
    assert.strictEqual(clean(fs.readFileSync(path.join(dir, 'session-state.json'), 'utf8'), dir), fixture.save.bytes);
  });

  // ── FLAC headers: what no fixture can say ─────────────────────────────────────────
  await check('the sample count survives past 32 bits', async () => {
    // STREAMINFO's total is 36 bits. A 32-bit shift would wrap a very long chunk to a short one.
    const samples = 2 ** 33 + 5;
    const head = Buffer.alloc(42);
    head.write('fLaC', 0, 'latin1');
    head[7] = 34;
    const rate = 24000;
    const packed = (BigInt(rate) << 44n) | (0n << 41n) | (15n << 36n) | BigInt(samples);
    head.writeBigUInt64BE(packed, 8 + 10);
    const file = path.join(scratch, 'long.flac');
    fs.writeFileSync(file, head);
    const info = await FH.readStreaminfo(file);
    assert.strictEqual(info.samples, samples);
    assert.strictEqual(info.sampleRate, rate);
  });

  fs.rmSync(scratch, { recursive: true, force: true });
  const total = passed + failed.length;
  console.log(`\ntest-narrator-session: ${passed}/${total} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
