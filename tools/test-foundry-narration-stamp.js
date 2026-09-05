#!/usr/bin/env node
/**
 * test-foundry-narration-stamp — the stamp Foundry WRITES, read by the reader
 * BookForge KEPT.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-narration-stamp.js
 *
 * ── What moved, and what this holds ─────────────────────────────────────────
 *
 * Owen ruled on 2026-09-05 that the narration text cleanup moves into the
 * Foundry engine as "Clean text". What moved is the PASS — the rules, the
 * prompts, the validators, `NORMALIZER_VERSION` and `PUNCTUATION_SPEC_VERSION`.
 * What stayed is everything that READS the result: the stamp parser
 * (`readNarrationTextStamp`, electron/epub-processor.ts), the file gate
 * (`narrationTextGate`, electron/narration-clean-text.ts) and the project gate
 * (`narrationTextReadiness`, electron/narration-text-readiness.ts) — the engine
 * has no applied-passes model, so the ledger side could not have gone with it.
 *
 * That split puts a WRITER and a READER of one JSON object in two repositories,
 * and nothing on either side compiles against the other. A field renamed there
 * is a book that reads **stale** here, forever, silently — the reader downgrades
 * a stamp it cannot understand rather than throwing, which is right at a render
 * door and is exactly what would hide this.
 *
 * So this drives the REAL engine binary end to end and reads what it wrote:
 *
 *   foundry vlm-book    --epub <fixture.epub> --out <book.jsonl>
 *   foundry vlm-compile --book <book.jsonl> --out <out.epub>
 *                       --narration-stamp <stamp.json>
 *
 * and then asks BookForge's own reader about `out.epub`.
 *
 * ── NO MODEL AND NO GPU ─────────────────────────────────────────────────────
 *
 * `clean-text` itself is deliberately NOT run. It asks a local model about every
 * block of the book — minutes of GPU on a real book, tens of seconds on a
 * fixture — and it is not what this keeper is about: the stamp is composed by
 * `narrationTextStamp` from the modules that define the versions and is written
 * by `--narration-stamp` on the COMPILE, which is arithmetic. Both stages here
 * are CPU and finish in under a second.
 *
 * What that costs is stated: this proves the WIRE (the JSON shape, the OPF meta,
 * the round trip), not that a cleanup produces those values. The values are held
 * by `test-foundry-clean-text-vendor`, which pins n6/s1 on both sides.
 *
 * ── The second stamp is the engine's own bytes ──────────────────────────────
 *
 * A stamp this repository composed and read back proves the round trip and could
 * still agree with itself about a field the engine never writes. So the second
 * case uses the exact JSON a real `foundry clean-text` run emitted (measured
 * 2026-09-05, foundry 1.1.0, on a three-chapter fixture) — a fixture in the
 * literal sense: bytes from the other side of the seam.
 *
 * ── When there is no foundry ────────────────────────────────────────────────
 *
 * SKIPS BY NAME and exits 0, on `test-foundry-clean-text-vendor`'s rule: a
 * machine with no engine cannot answer the question, and a keeper that failed
 * there would be red everywhere but on the machines that build foundry.
 */
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'epub-processor.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

/**
 * The exact stamp a real `foundry clean-text` run wrote, measured 2026-09-05
 * against foundry 1.1.0. Its `at` is that run's; every other field is a claim
 * about the rules, and every one of them is a field this reader requires.
 */
const ENGINE_WROTE = {
  stampVersion: 2,
  normalizerVersion: 'n6',
  punctuationSpec: 's1',
  model: 'qwen3.8:27b',
  at: '2026-09-05T19:14:50.539Z',
  punctuationRefused: 0,
};

/** A real foundry binary on this machine, or null. `test-foundry-host-queue`'s rule. */
function realFoundry() {
  const name = process.platform === 'win32'
    ? `foundry-windows-${process.arch}.exe`
    : `foundry-${process.platform}-${process.arch}`;
  const candidates = [
    process.env.FOUNDRY_CLI_PATH,
    path.join('/Volumes/Callisto/Projects/foundry', 'dist', name),
    path.join(os.homedir(), 'Projects', 'foundry', 'dist', name),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// A three-chapter EPUB, written by hand
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A minimal STORED (uncompressed) zip. Written here rather than shelled out to,
 * because this keeper must not depend on a zip tool being on the machine, and
 * the fixture is four small files.
 *
 * `mimetype` MUST be first and stored, which is the one rule of the container
 * format that a hand-written writer can get wrong — and every reader downstream
 * would then refuse a file this keeper called a fixture.
 */
function writeZip(outPath, entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);        // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0, 14);
    dir.writeUInt32LE(crc >>> 0, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(outPath, Buffer.concat([...locals, centralBuf, end]));
}

/** CRC-32, for the Node builds whose zlib does not export one. */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c;
}

const CHAPTER = (n, title, body) => Buffer.from(
  '<?xml version="1.0" encoding="utf-8"?>\n'
  + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">\n'
  + `<head><title>${title}</title></head>\n<body>\n`
  + `<section id="chapter${n}"><h1 id="ch${n}-title">${title}</h1>\n`
  + `<p id="ch${n}-p1">${body}</p>\n</section>\n</body></html>\n`, 'utf8');

function writeFixtureEpub(outPath) {
  const opf = Buffer.from(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n'
    + '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
    + '    <dc:identifier id="bookid">urn:uuid:bf-stamp-fixture</dc:identifier>\n'
    + '    <dc:title>A Stamp Fixture</dc:title>\n'
    + '    <dc:language>en</dc:language>\n'
    + '  </metadata>\n'
    + '  <manifest>\n'
    + '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'
    + '    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>\n'
    + '    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>\n'
    + '    <item id="c3" href="chapter3.xhtml" media-type="application/xhtml+xml"/>\n'
    + '  </manifest>\n'
    + '  <spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine>\n'
    + '</package>\n', 'utf8');
  const nav = Buffer.from(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">\n'
    + '<head><title>Contents</title></head><body><nav epub:type="toc"><ol>\n'
    + '<li><a href="chapter1.xhtml">Chapter One</a></li>\n'
    + '<li><a href="chapter2.xhtml">Chapter Two</a></li>\n'
    + '<li><a href="chapter3.xhtml">Chapter Three</a></li>\n'
    + '</ol></nav></body></html>\n', 'utf8');
  writeZip(outPath, [
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8') },
    {
      name: 'META-INF/container.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        + '<rootfiles><rootfile full-path="OEBPS/content.opf" '
        + 'media-type="application/oebps-package+xml"/></rootfiles></container>\n', 'utf8'),
    },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: CHAPTER(1, 'Chapter One',
        'In 1933, on 23/3/1933, the committee approved $5,000 and sent 12 men.'),
    },
    { name: 'OEBPS/chapter2.xhtml', data: CHAPTER(2, 'Chapter Two', 'Dr. Smith read (1 Pet. 3:7) aloud at 2:00 p.m.') },
    { name: 'OEBPS/chapter3.xhtml', data: CHAPTER(3, 'Chapter Three', 'The FBI said nothing, and the meeting ended.') },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

/**
 * One assertion, named. Synchronous on purpose: everything awaited in this file
 * is awaited BEFORE its check, so a rejected promise is a failure of the run
 * rather than a case that quietly passed.
 */
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) {
    failures.push(name);
    console.error(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}

async function main() {
  const binary = realFoundry();
  if (binary === null) {
    console.log(
      'SKIP test-foundry-narration-stamp — no foundry engine on this machine. Set FOUNDRY_CLI_PATH, '
      + 'or build one with tools/release-build.sh host in the foundry checkout.');
    return;
  }

  const epub = require(path.join(DIST, 'epub-processor.js'));
  const pass = require(path.join(DIST, 'narration-clean-text.js'));
  const normalizer = require(path.join(DIST, 'tts-number-normalizer.js'));
  const punctuation = require(path.join(DIST, 'tts-punctuation.js'));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-stamp-'));
  const run = (args) => execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    const fixture = path.join(scratch, 'fixture.epub');
    writeFixtureEpub(fixture);

    const book = path.join(scratch, 'book.jsonl');
    run(['vlm-book', '--epub', fixture, '--out', book]);
    assert.ok(fs.existsSync(book), 'vlm-book wrote no book file');

    /*
     * ROUND ONE — a stamp this build composed, written by the engine, read back
     * here. Every field comes from the module that owns it, so a rename on
     * either side of the seam breaks this rather than reading `stale` forever.
     */
    const ours = {
      stampVersion: epub.NARRATION_TEXT_STAMP_VERSION,
      normalizerVersion: normalizer.NORMALIZER_VERSION,
      punctuationSpec: punctuation.PUNCTUATION_SPEC_VERSION,
      model: 'fake:1b',
      at: new Date().toISOString(),
      punctuationRefused: 7,
    };
    const oursPath = path.join(scratch, 'ours.stamp.json');
    fs.writeFileSync(oursPath, JSON.stringify(ours));
    const oursEpub = path.join(scratch, 'ours.epub');
    run(['vlm-compile', '--book', book, '--out', oursEpub, '--narration-stamp', oursPath]);

    const readBack = await epub.readNarrationTextStamp(oursEpub);
    check('the engine writes the stamp into the OPF, and this reader gets every field back', () => {
      assert.notStrictEqual(readBack, null, 'no bookforge:narration-text meta in the compiled OPF');
      assert.deepStrictEqual(
        readBack, ours,
        'a field renamed on either side of the seam makes every cleaned book read STALE, silently, '
        + 'because the reader downgrades what it cannot understand rather than throwing',
      );
    });

    const gate = await pass.narrationTextGate(oursEpub);
    check('the FILE gate accepts what the engine wrote, at this build\'s own versions', () => {
      assert.strictEqual(gate.ok, true, gate.ok ? '' : `${gate.state}: ${gate.reason}`);
      assert.strictEqual(gate.stamp.normalizerVersion, normalizer.NORMALIZER_VERSION);
      assert.strictEqual(gate.stamp.punctuationSpec, punctuation.PUNCTUATION_SPEC_VERSION);
      assert.strictEqual(gate.stamp.model, 'fake:1b');
      assert.strictEqual(
        gate.stamp.punctuationRefused, 7,
        'the refusal count is what stops a book with three hundred unreachable spans being '
        + 'byte-indistinguishable from a clean one',
      );
    });

    /*
     * ROUND TWO — the engine's OWN bytes. Round one could agree with itself
     * about a field a real cleanup never writes; this is a stamp measured off a
     * real `foundry clean-text` run.
     */
    const theirsPath = path.join(scratch, 'theirs.stamp.json');
    fs.writeFileSync(theirsPath, JSON.stringify(ENGINE_WROTE));
    const theirsEpub = path.join(scratch, 'theirs.epub');
    run(['vlm-compile', '--book', book, '--out', theirsEpub, '--narration-stamp', theirsPath]);
    const theirs = await epub.readNarrationTextStamp(theirsEpub);
    check('a stamp a REAL clean-text run wrote is read field for field', () => {
      assert.deepStrictEqual(theirs, ENGINE_WROTE);
    });

    check('this build agrees with the engine about the rule versions', () => {
      // Not a coincidence to leave unasserted: the whole point of the move is
      // that ONE definition serves the renders and the corpora. If these ever
      // differ, a book the engine stamped reads stale here BY RULE — correctly —
      // and the fix is a re-vendor, not a looser gate.
      assert.strictEqual(normalizer.NORMALIZER_VERSION, ENGINE_WROTE.normalizerVersion);
      assert.strictEqual(punctuation.PUNCTUATION_SPEC_VERSION, ENGINE_WROTE.punctuationSpec);
      assert.strictEqual(epub.NARRATION_TEXT_STAMP_VERSION, ENGINE_WROTE.stampVersion);
    });

    /*
     * AND THE ONE THING THE COMPILE DOES NOT DO, asserted so nobody has to
     * rediscover it. `vlm-compile` takes `--book` and `--narration-stamp` and
     * has NO `--records` flag: it writes the stamp and compiles the book file it
     * was handed, cleaned or not. So a caller that ran `clean-text` and then
     * compiled the PARENT book file would produce a file claiming a cleanup over
     * text nobody cleaned. Foundry's app materialises the cleaned book file
     * first (`translated()`, app/shared/materialize.ts); a host doing this by
     * hand must too.
     */
    check('vlm-compile stamps the book it is HANDED — the records are not applied by it', () => {
      const help = execFileSync(binary, ['vlm-compile', '--help'], { encoding: 'utf8' });
      assert.ok(/--narration-stamp/.test(help), 'the stamp flag is gone from vlm-compile');
      assert.ok(
        !/--records/.test(help),
        'vlm-compile grew a --records flag. It can now apply a cleanup itself, which changes the '
        + 'division of labour docs/NARRATION_TEXT_PASS.md describes — read it and update both.',
      );
    });

    /*
     * THE FAILSAFE DOOR EXISTS ON THIS ENGINE — the flag pair BookForge's own
     * "Clean text" action spawns (electron/narration-clean-text.ts). Asserted
     * here because this is the keeper that already holds the engine's surface,
     * and because the gap it closed is written down in
     * docs/NARRATION_TEXT_PASS.md: until foundry 1.2.0 nothing on the CLI could
     * clean an arbitrary EPUB in place, which is why this app carried its own
     * copy of the pass at all.
     *
     * What the DOOR does with it — the version floor, the argv, the receipt, the
     * stamp read back through this app's parser after a real cleanup — is
     * `tools/test-narration-clean-text-door.js`, which drives the same binary.
     */
    check('clean-text carries the --epub failsafe door the app\'s Clean text action spawns', () => {
      const help = execFileSync(binary, ['clean-text', '--help'], { encoding: 'utf8' });
      assert.ok(/--epub/.test(help),
        'the --epub failsafe is gone from clean-text. BookForge\'s Clean text action spawns it; '
        + 'without it there is no way to clean a finished EPUB and the ruling of 2026-09-05 has '
        + 'no implementation.');
      assert.ok(/--out/.test(help), 'and --out, which is where the cleaned book is written');
      assert.ok(/--book/.test(help) && /--records/.test(help),
        'the BOOK route is still there — it is the standard method, and the failsafe is not it');
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`\nfoundry narration stamp: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
