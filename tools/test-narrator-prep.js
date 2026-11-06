#!/usr/bin/env node
/**
 * PREP, HELD TO THE PYTHON'S OWN ANSWERS.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narrator-prep.js
 *
 * `tools/fixtures/narrator-prep-cases.json` was captured from the Python narrator before it left the repo:
 * the small rules as vectors, and small invented books run through its real prep, with the three files it wrote
 * or how it refused. Those books carry what lxml gave the Python for each document, because the libxml2
 * binary does not exist yet; that seam is the one thing this keeper does not exercise. Real books
 * are compared whole by the corpus run; this pins that result.
 */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');
const TEXT = path.join(REPO, 'dist', 'electron', 'narrator', 'text');
if (!fs.existsSync(path.join(TEXT, 'prep.js'))) {
  console.log(skipLine('dist/electron/narrator/text/prep.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

const compat = require(path.join(REPO, 'dist', 'electron', 'narrator', 'py-compat.js'));
const { normalizeText, unidecode } = require(path.join(TEXT, 'normalize.js'));
const { normalizeDocKey, readEpub } = require(path.join(TEXT, 'epub.js'));
const { BadZipFile, ZipFile } = require(path.join(TEXT, 'html', 'zipfile.js'));
const { linkParents } = require(path.join(TEXT, 'html', 'lxml.js'));
const { writeCover } = require(path.join(TEXT, 'cover.js'));
const { countRealSentences, normalizeDevice, prepSession, resolveLanguage } = require(path.join(TEXT, 'prep.js'));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'narrator-prep-cases.json'), 'utf8'));

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const adopt = (node) => {
  const copy = { ...node, parent: null, children: node.children.map(adopt) };
  return copy;
};

class FromLxml {
  constructor(fx) { this.fx = fx; }
  parseXml(content) {
    const node = this.fx.xml[md5(content)];
    if (!node) throw new Error(`no captured XML for ${content.toString('utf8').slice(0, 60)}`);
    return linkParents(adopt(node));
  }
  parseHtml(content) {
    const node = this.fx.html[md5(content)];
    if (!node) throw new Error(`no captured HTML for ${content.toString('utf8').slice(0, 60)}`);
    return linkParents(adopt(node));
  }
  serializeBody(content) {
    const body = this.fx.body[md5(content)];
    if (body === undefined) throw new Error(`no captured body for ${content.toString('utf8').slice(0, 60)}`);
    if (body === null) return null;
    if (body.error !== undefined) throw new Error(body.error);
    return { tostring: Buffer.from(body.tostring, 'base64'), length: body.length };
  }
}

/** The books were captured in another folder: its name, and the hashes of its paths, are all that may differ. */
const comparable = (text, root) => {
  const json = JSON.stringify(root).slice(1, -1);
  return text.split(json).join('<ROOT>').split(root).join('<ROOT>')
    .replace(/\\\\/g, '/').replace(/[0-9a-f]{32}/g, '<HASH>')
    .replace(/"(created_at|updated_at)": "[^"]*"/g, '"$1": "<TIME>"');
};

const REFUSAL_MESSAGE = (message) => comparable(message, '<ROOT>');
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([name, null]);
  } catch (err) {
    results.push([name, err]);
  }
}

function buildZip(entries) {
  const crcOf = (bytes) => {
    let c = -1;
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (~c) >>> 0;
  };
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data);
    const crc = e.crc === undefined ? crcOf(data) : e.crc;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(e.flags || 0, 6); local.writeUInt16LE(e.method || 0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(e.flags || 0, 8); dir.writeUInt16LE(e.method || 0, 10);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(dir, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-prep-'));
  try {
    await check('TOC titles normalize as they did', () => {
      for (const [input, want] of cases.normalize) assert.strictEqual(normalizeText(input, 'eng'), want, JSON.stringify(input));
    });
    await check('a language without a table refuses by name', () => {
      assert.throws(() => normalizeText('x', 'fra'), /carries language tables for \['eng'\] only, not 'fra'/);
    });
    await check('Unidecode table', () => {
      for (const [input, want] of cases.unidecode) assert.strictEqual(unidecode(input), want, JSON.stringify(input));
    });
    await check('posix path rules', () => {
      for (const [p, want] of cases.normpath) assert.strictEqual(compat.pyPosixNormpath(p), want, `normpath ${p}`);
      for (const [p, want] of cases.dirname) assert.strictEqual(compat.pyPosixDirname(p), want, `dirname ${p}`);
      for (const [a, b, want] of cases.join) assert.strictEqual(compat.pyPosixJoin(a, b), want, `join ${a} ${b}`);
      for (const [p, want] of cases.extension) assert.strictEqual(compat.pyExtension(p), want, `ext ${p}`);
      for (const [h, want] of cases.unquote) assert.strictEqual(compat.pyUnquote(h), want, `unquote ${h}`);
    });
    await check('TOC href and document name keys', () => {
      for (const [h, want] of cases.docKey) assert.strictEqual(normalizeDocKey(h), want, String(h));
    });
    await check('real sentence count', () => {
      for (const [s, want] of cases.sentences) assert.strictEqual(countRealSentences(s), want, JSON.stringify(s));
    });
    await check('device names', () => {
      for (const [d, want] of cases.device) assert.strictEqual(normalizeDevice(d), want, String(d));
    });
    await check('language codes', () => {
      for (const [code, want, message] of cases.language) {
        if (want) assert.deepStrictEqual(resolveLanguage(code), want, code);
        else assert.throws(() => resolveLanguage(code), (err) => err.message === message, code);
      }
    });

    await check('a ZIP reads as zipfile reads it', async () => {
      const file = path.join(scratch, 'z.zip');
      fs.writeFileSync(file, buildZip([
        { name: 'first.txt', data: 'old' },
        { name: 'first.txt', data: 'new' },
        { name: Buffer.from([0x63, 0x61, 0x66, 0x82]), data: 'cp437' },
        { name: 'caf\u00e9-utf8', flags: 0x800, data: 'utf8' },
        { name: 'dir\\file', data: 'folded' },
        { name: 'bad-crc', data: 'x', crc: 1 },
        { name: 'encrypted', data: 'x', flags: 1 },
        { name: 'lzma', data: 'x', method: 14 },
      ]));
      const zip = await ZipFile.open(file);
      assert.strictEqual((await zip.read('first.txt')).toString(), 'new');
      assert.strictEqual((await zip.read('caf\u00e9')).toString(), 'cp437');
      assert.strictEqual((await zip.read('caf\u00e9-utf8')).toString(), 'utf8');
      assert.strictEqual((await zip.read('dir/file')).toString(), 'folded');
      await assert.rejects(zip.read('missing'), /There is no item named 'missing' in the archive/);
      await assert.rejects(zip.read('bad-crc'), BadZipFile);
      await assert.rejects(zip.verify('bad-crc'), BadZipFile);
      await assert.rejects(zip.read('encrypted'), /is encrypted, password required/);
      await assert.rejects(zip.read('lzma'), /compression type 14/);
      await zip.close();
      const notZip = path.join(scratch, 'n.epub');
      fs.writeFileSync(notZip, 'not a zip');
      await assert.rejects(readEpub(notZip, new FromLxml({})), /Bad Zip file/);
    });

    for (const fx of cases.books) {
      await check(`book: ${fx.name}`, async () => {
        const root = path.join(scratch, fx.name);
        fs.mkdirSync(root, { recursive: true });
        const epub = path.join(root, `${fx.name}.epub`);
        fs.writeFileSync(epub, Buffer.from(fx.epub, 'base64'));
        const lines = [];
        let outcome = null;
        let refused = null;
        try {
          outcome = await prepSession(epub, path.join(root, 'session'), {
            session: 'fixed-session', ttsEngine: 'higgs-v3', higgsVoice: 'voice-x', language: 'eng',
            maxChars: fx.cap, floorChars: fx.floor, sentencePerParagraph: fx.rows, skipHeadings: fx.skip,
          }, new FromLxml(fx), writeCover, (line) => lines.push(line));
        } catch (err) {
          refused = err;
        }
        if (fx.expect.refused) {
          assert.ok(refused, `the Python refused with ${fx.expect.refused}: ${fx.expect.message}`);
          assert.strictEqual(REFUSAL_MESSAGE(refused.message.split(root).join('<ROOT>')), REFUSAL_MESSAGE(fx.expect.message));
          return;
        }
        if (refused) throw refused;
        for (const [rel, want] of Object.entries(fx.expect.files)) {
          const got = fs.readFileSync(path.join(outcome.processDir, rel), 'utf8');
          assert.strictEqual(comparable(got, root), comparable(want, fx.expect.root), rel);
        }
        const printed = lines.map((line) => `${line}\n`).join('');
        assert.strictEqual(comparable(printed, root), comparable(fx.stdout, '<ROOT>'), 'printed log');
        if (typeof fx.expect.cover === 'string') assert.ok(fs.statSync(outcome.state.cover).size > 0, 'cover written');
      });
    }

    await check('the door: startPrep, through the committed binary, writes what the Python wrote', async () => {
      const { startPrep } = require(path.join(TEXT, 'prep-door.js'));
      const fx = cases.books.find((b) => !b.expect.refused && b.rows !== true && b.skip !== true && !/malformed|broken|bad/.test(b.name));
      const root = path.join(scratch, 'door');
      fs.mkdirSync(root, { recursive: true });
      const epub = path.join(root, `${fx.name}.epub`);
      fs.writeFileSync(epub, Buffer.from(fx.epub, 'base64'));
      const run = (dir, extra) => new Promise((resolve) => {
        const child = startPrep({ ebook: epub, sessionDir: dir, options: { session: 'fixed-session', ttsEngine: 'higgs-v3', higgsVoice: 'voice-x', language: 'eng', maxChars: fx.cap, floorChars: fx.floor, ...extra } });
        let said = '';
        child.stdout.on('data', (d) => { said += d; });
        child.stderr.on('data', (d) => { said += d; });
        child.on('close', (code) => resolve({ code, said }));
      });
      const gapsOf = (dir) => {
        const pd = path.join(dir, fs.readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory()).name);
        return JSON.parse(fs.readFileSync(path.join(pd, 'chapters', 'sentences', 'gaps.json'), 'utf8')).gaps;
      };
      const plain = path.join(root, 'session');
      const first = await run(plain, {});
      assert.strictEqual(first.code, 0, first.said.slice(-400));
      const pd = path.join(plain, fs.readdirSync(plain, { withFileTypes: true }).find((e) => e.isDirectory()).name);
      assert.strictEqual(comparable(fs.readFileSync(path.join(pd, 'session-state.json'), 'utf8'), root),
        comparable(fx.expect.files['session-state.json'], fx.expect.root).split('<ROOT>/' + fx.name + '/').join('<ROOT>/'), 'session-state');
      // THE VOICE'S JOIN GAP. The Python read it from NARRATOR_SENTENCE_GAP on its own spawn; a worker has none.
      const voiced = path.join(root, 'voiced');
      assert.strictEqual((await run(voiced, { sentenceGap: 0.27 })).code, 0);
      const after = Object.values(gapsOf(voiced)).map((g) => g.after);
      assert.ok(after.length > 0 && after.every((g) => g === 0.27), `gaps.json did not take the stated gap: ${after.slice(0, 5)}`);
      assert.ok(Object.values(gapsOf(plain)).every((g) => g.after === 0.6), 'absent, it is the default');
    });

    await check('the committed binary is the one its README names, and it ships', () => {
      const binary = fs.readFileSync(path.join(REPO, 'vendor', 'libxml2-wasm', 'libxml2.wasm'));
      const sha = require('crypto').createHash('sha256').update(binary).digest('hex');
      assert.ok(fs.readFileSync(path.join(REPO, 'vendor', 'libxml2-wasm', 'README.md'), 'utf8').includes(sha), `the README does not name ${sha}`);
      const files = require(path.join(REPO, 'package.json')).build.files;
      assert.ok(files.includes('vendor/libxml2-wasm/libxml2.wasm') && files.includes('vendor/libxml2-wasm/LICENSE.libxml2'), 'the packaging list leaves out the binary or its licence');
    });

    await check('a cover is written past MAX_PATH, as Pillow wrote it', async () => {
      // A long title under a deep session dir passes 260 characters; libvips alone cannot open that for writing.
      const dir = path.join(scratch, 'd'.repeat(120), 'e'.repeat(120));
      fs.mkdirSync(dir, { recursive: true });
      const png = await require('sharp')({ create: { width: 4, height: 4, channels: 3, background: '#808080' } }).png().toBuffer();
      const book = { itemsOfType: (type) => (type === 'cover' ? [{ content: async () => png }] : []) };
      const lines = [];
      const written = await writeCover(book, dir, 'f'.repeat(40), (line) => lines.push(line));
      assert.deepStrictEqual(lines, []);
      assert.ok(typeof written === 'string' && written.length > 260, `a path past MAX_PATH, not ${written}`);
      assert.ok(fs.statSync(written).size > 0, 'cover written');
    });

    await check('an Orpheus prep refuses by name', async () => {
      await assert.rejects(prepSession('x.epub', 'y', { ttsEngine: 'orpheus', maxChars: 1, floorChars: 1 }, new FromLxml({}), writeCover, () => {}),
        /narrator preps for \['higgs-v3'\], not 'orpheus'/);
    });
    await check('a path that is no EPUB refuses by name', async () => {
      const txt = path.join(scratch, 'a.txt');
      fs.writeFileSync(txt, 'x');
      await assert.rejects(prepSession(txt, 'y', { ttsEngine: 'higgs-v3', maxChars: 1, floorChars: 1 }, new FromLxml({}), writeCover, () => {}), /reads EPUB only, not '\.txt'/);
      await assert.rejects(prepSession(path.join(scratch, 'none.epub'), 'y', { ttsEngine: 'higgs-v3', maxChars: 1, floorChars: 1 }, new FromLxml({}), writeCover, () => {}), /--ebook does not exist/);
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  let failed = 0;
  for (const [name, err] of results) {
    if (err) {
      failed += 1;
      console.log(`  FAIL  ${name}\n        ${String(err.message).slice(0, 900)}`);
    } else {
      console.log(`  ok    ${name}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
