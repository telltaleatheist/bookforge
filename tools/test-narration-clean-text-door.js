#!/usr/bin/env node
/**
 * test-narration-clean-text-door — the FAILSAFE door onto `foundry clean-text`.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narration-clean-text-door.js
 *
 * ── What this holds ─────────────────────────────────────────────────────────
 *
 * Owen ruled on 2026-09-05 that the narration text cleanup lives in the Foundry
 * engine and that BookForge's own "Clean text" action is a FAILSAFE that cleans
 * a finished EPUB and replaces it. `electron/narration-clean-text.ts` is the
 * whole of BookForge's side of that: resolve the binary, refuse one that is too
 * old, spawn `clean-text --epub … --out …`, parse its counter, read back its
 * receipt and its stamp.
 *
 * That is a WIRE between two repositories that do not compile against each
 * other, so most of what is below drives the REAL binary rather than a mock:
 *
 *  1. the pure parts — the progress pattern, the sidecar names, the settings the
 *     hosted Clean text press uses, the self-overwrite refusal, the version
 *     floor and the one notice both offer surfaces show;
 *  2. THE REAL ENGINE, NO MODEL — `foundry epub-stamp` makes a stamped fixture,
 *     and an UNSTAMPED book is refused by the engine before a model is opened.
 *     That exercises the entire spawn path (the floor, the argv, a nonzero exit,
 *     the engine's own sentence carried out to the user) for free;
 *  3. THE REAL ENGINE, WITH A MODEL — when ollama is up and holds one, a real
 *     cleanup runs over a one-block fixture and the result is read back with
 *     BookForge's own stamp parser and file gate. Skipped BY NAME when ollama is
 *     not answering, which is the honest answer on a machine that cannot run it.
 *
 * ── When there is no foundry ────────────────────────────────────────────────
 *
 * SKIPS BY NAME and exits 0, on `test-foundry-narration-stamp`'s rule: a machine
 * with no engine cannot answer the question, and a keeper that failed there
 * would be red everywhere but on the machines that build foundry.
 */
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'narration-clean-text.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

/** The foundry release the `--epub` failsafe door arrived in. */
const FAILSAFE_RELEASE = '1.2.0';

/** A real foundry binary on this machine, or null. `test-foundry-host-queue`'s rule. */
function realFoundry() {
  const name = process.platform === 'win32'
    ? `foundry-windows-${process.arch}.exe`
    : `foundry-${process.platform}-${process.arch}`;
  const candidates = [
    process.env.FOUNDRY_CLI_PATH,
    path.join('/Volumes/Callisto/Projects/foundry', 'dist', name),
    path.join(os.homedir(), 'Projects', 'foundry', 'dist', name),
    path.join('C:', 'Users', 'tellt', 'Projects', 'foundry', 'dist', name),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const BINARY = realFoundry();
if (BINARY === null) {
  console.log(
    'SKIP test-narration-clean-text-door — no foundry engine on this machine. Set '
    + 'FOUNDRY_CLI_PATH, or build one with tools/release-build.sh host in the foundry checkout.');
  process.exit(0);
}

// EVERY root this keeper writes to is under one temp dir, set BEFORE the stub is
// loaded: `app.getPath('userData')` is derived from APPDATA/XDG_CONFIG_HOME
// there, and the settings this door reads live under it. Pointing it here is
// what keeps the keeper off the machine's real BookForge settings — and what
// makes the settings assertions about THIS run's file.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-clean-door-'));
const FAKE_APPDATA = path.join(ROOT, 'appdata');
fs.mkdirSync(path.join(FAKE_APPDATA, 'BookForge'), { recursive: true });
if (process.platform === 'win32') process.env.APPDATA = FAKE_APPDATA;
else if (process.platform === 'darwin') process.env.HOME = FAKE_APPDATA;
else process.env.XDG_CONFIG_HOME = FAKE_APPDATA;
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');
// The binary this run uses, stated: `ensureFoundryPath` returns it without
// touching the component registry, which is not mounted here.
process.env.FOUNDRY_CLI_PATH = BINARY;

require(path.join(REPO, 'cli', 'electron-stub.js'));

const door = require(path.join(DIST, 'narration-clean-text.js'));
const epub = require(path.join(DIST, 'epub-processor.js'));
const hostQueue = require(path.join(DIST, 'foundry-host-queue.js'));
const { foundryVersionAtLeast } = require(path.join(REPO, 'dist', 'shared', 'vlm', 'readings-bank.js'));
const { NARRATION_TEXT_FAILSAFE_NOTICE } =
  require(path.join(REPO, 'dist', 'shared', 'processing', 'narration-text-notice.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ─────────────────────────────────────────────────────────────────────────────
// A tiny EPUB, written by hand
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A minimal STORED (uncompressed) zip — `test-foundry-narration-stamp`'s writer,
 * for its reason: this keeper must not depend on a zip tool being on the
 * machine, and `mimetype` must be first and stored or every reader downstream
 * refuses the file.
 */
function writeZip(outPath, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(entry.data) : crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  fs.writeFileSync(outPath, Buffer.concat([...locals, centralBytes, end]));
}

/** CRC-32, for the node builds whose zlib has none. */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

/** A one-chapter publisher's EPUB. Carries NO `data-bf-*` stamps of its own. */
function writeFixtureEpub(outPath, sentence) {
  const opf = Buffer.from(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n'
    + '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
    + '    <dc:identifier id="bookid">urn:uuid:bf-clean-door-fixture</dc:identifier>\n'
    + '    <dc:title>A Failsafe Fixture</dc:title>\n'
    + '    <dc:language>en</dc:language>\n'
    + '  </metadata>\n'
    + '  <manifest>\n'
    + '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'
    + '    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>\n'
    + '  </manifest>\n'
    + '  <spine><itemref idref="c1"/></spine>\n'
    + '</package>\n', 'utf8');
  const nav = Buffer.from(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">\n'
    + '<head><title>Contents</title></head><body><nav epub:type="toc"><ol>\n'
    + '<li><a href="chapter1.xhtml">Chapter One</a></li>\n'
    + '</ol></nav></body></html>\n', 'utf8');
  const chapter = Buffer.from(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">\n'
    + '<head><title>Chapter One</title></head>\n<body>\n'
    + '<section id="chapter1"><h1 id="ch1-title">Chapter One</h1>\n'
    + `<p id="ch1-p1">${sentence}</p>\n</section>\n</body></html>\n`, 'utf8');
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
    { name: 'OEBPS/chapter1.xhtml', data: chapter },
  ]);
}

/** The smallest model ollama is holding at `endpoint`, or null when it is not up. */
function ollamaSmallestModel(endpoint) {
  return new Promise((resolve) => {
    const url = new URL('/api/tags', endpoint);
    const request = http.get(url, { timeout: 2000 }, (response) => {
      if (response.statusCode !== 200) { response.resume(); resolve(null); return; }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const models = JSON.parse(body).models;
          if (!Array.isArray(models) || models.length === 0) { resolve(null); return; }
          const smallest = models.slice().sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0];
          resolve(typeof smallest.name === 'string' ? smallest.name : null);
        } catch { resolve(null); }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
  });
}

function writeAppSettings(settings) {
  const userData = process.platform === 'darwin'
    ? path.join(FAKE_APPDATA, 'Library', 'Application Support', 'BookForge')
    : path.join(FAKE_APPDATA, 'BookForge');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'app-settings.json'), JSON.stringify(settings, null, 2), 'utf8');
  return userData;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The pure parts
// ─────────────────────────────────────────────────────────────────────────────

test('the progress pattern reads the engine\'s counter and NOTHING else on that prefix', () => {
  assert.deepStrictEqual(door.parseCleanTextProgress('clean-text: 412/2081'),
    { done: 412, total: 2081 });
  assert.deepStrictEqual(door.parseCleanTextProgress('  clean-text: 1/1  '), { done: 1, total: 1 });
  // The engine writes many other lines on this prefix. Matching a count out of
  // one of them would draw a progress bar off a sentence.
  for (const line of [
    'clean-text: 456 blocks, 87 changed, 3 edits refused in 91s',
    'clean-text: 12 answer(s) are banked in C:\\x\\out.epub.clean-bank.jsonl; 3 of 4 block(s)',
    'clean-text: REFUSED a punctuation span in OEBPS/c1.xhtml#2 — "  " would have become " "',
    'clean-text: LEFT AS PRINTED — OEBPS/c1.xhtml#7: it holds an entity this program does not decode',
    'clean-text: punctuation (s1) rewrote 4 span(s) across 2 block(s); 0 refused.',
  ]) {
    assert.strictEqual(door.parseCleanTextProgress(line), null, line);
  }
});

test('the sidecars are named where the engine writes them', () => {
  const out = path.join(ROOT, 'names', 'book.epub');
  assert.strictEqual(door.cleanTextStampSidecar(out), `${path.resolve(out)}.stamp.json`);
  assert.strictEqual(door.cleanTextReceiptPath(out), `${path.resolve(out)}.receipt.json`);
  assert.strictEqual(door.cleanTextBankPath(out), `${path.resolve(out)}.clean-bank.jsonl`);
});

test('the model and the endpoint are the ones the HOSTED Clean text press uses', async () => {
  const dir = path.join(ROOT, 'settings');
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    defaultLlmModel: 'qwen3.8:14b', ollamaUrl: 'http://titan:11434/',
  }), 'utf8');
  const read = await door.cleanTextEngineSettingsIn(dir);
  assert.strictEqual(read.model, 'qwen3.8:14b', 'foundry\'s own defaultLlmModel');
  // The trailing slash goes, exactly as `clampOllamaUrl` drops it there, so the
  // two doors send byte-identical `--endpoint` values.
  assert.strictEqual(read.endpoint, 'http://titan:11434');

  // A file that is not there, and one that is not JSON, are what Foundry itself
  // reads as its own defaults — so this answers with what the hosted press would
  // actually run rather than with a refusal about a file the user never made.
  const empty = await door.cleanTextEngineSettingsIn(path.join(ROOT, 'settings-none'));
  assert.strictEqual(empty.model, 'qwen3.8:27b');
  assert.strictEqual(empty.endpoint, 'http://localhost:11434');
  assert.ok(/could not be read/.test(empty.source), empty.source);

  // A tag with whitespace in it is not a tag, and a non-http URL is not an
  // endpoint. Both are the clamps' own answers, mirrored.
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    defaultLlmModel: 'two words', ollamaUrl: 'file:///etc/passwd',
  }), 'utf8');
  const clamped = await door.cleanTextEngineSettingsIn(dir);
  assert.strictEqual(clamped.model, 'qwen3.8:27b');
  assert.strictEqual(clamped.endpoint, 'http://localhost:11434');
});

test('--out equal to --epub is refused HERE, before any spawn', async () => {
  const book = path.join(ROOT, 'same.epub');
  writeFixtureEpub(book, 'Nothing happens.');
  await assert.rejects(
    () => door.cleanTextEpub({ epubPath: book, outPath: book }),
    (err) => /write its result over the book it is reading/.test(err.message));
});

test('the version floor names the release the failsafe door arrived in', () => {
  assert.strictEqual(hostQueue.FOUNDRY_VERSION_FOR_CLEAN_TEXT_EPUB, FAILSAFE_RELEASE);
  // ONE comparator, the app's own — not a second copy beside the first floor.
  assert.strictEqual(foundryVersionAtLeast('1.1.0', FAILSAFE_RELEASE), false);
  assert.strictEqual(foundryVersionAtLeast('1.2.0', FAILSAFE_RELEASE), true);
  assert.strictEqual(foundryVersionAtLeast('1.3.1', FAILSAFE_RELEASE), true);
  const refusal = hostQueue.foundryTooOldForCleanTextEpub('1.1.0');
  assert.ok(refusal.includes('1.1.0'), 'names what is installed');
  assert.ok(refusal.includes(FAILSAFE_RELEASE), 'and the release the door arrived in');
  assert.ok(/Nothing was cleaned/.test(refusal), 'and says nothing ran');
  // The two floors are different facts and must not collapse into one.
  assert.strictEqual(hostQueue.FOUNDRY_VERSION_FOR_CLEAN_TEXT, '1.1.0');
});

test('the failsafe notice is ONE constant, and it says the three things it must', () => {
  const notice = NARRATION_TEXT_FAILSAFE_NOTICE;
  assert.ok(/in place/.test(notice), 'that it cleans the exported EPUB in place');
  assert.ok(/re-export/.test(notice), 'that a re-export loses it');
  assert.ok(/Foundry/.test(notice), 'and that the hosted step is the standard method');
  // Both offer surfaces use the constant rather than a paraphrase of it.
  for (const file of [
    path.join(REPO, 'src', 'app', 'features', 'studio', 'components', 'narration-modal',
      'narration-modal.component.ts'),
    path.join(REPO, 'src', 'app', 'features', 'studio', 'components', 'studio-versions',
      'studio-versions.component.ts'),
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes('NARRATION_TEXT_FAILSAFE_NOTICE'),
      `${path.basename(file)} shows the shared notice`);
    assert.ok(source.includes("from '@shared/processing/narration-text-notice'"),
      `${path.basename(file)} imports it rather than writing its own`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The real engine, no model
// ─────────────────────────────────────────────────────────────────────────────

test('the engine REFUSES a book with none of its stamps, and the door says so verbatim', async () => {
  const book = path.join(ROOT, 'unstamped.epub');
  writeFixtureEpub(book, 'On 23/3/1933 the committee approved $5,000.');
  await assert.rejects(
    () => door.cleanTextEpub({ epubPath: book, outPath: path.join(ROOT, 'unstamped.out.epub') }),
    (err) => {
      // The whole spawn path ran: the floor passed, the argv was accepted, the
      // engine read the file and refused it, and its own sentence — which names
      // the remedy — reached the caller instead of a paraphrase.
      assert.ok(/foundry clean-text exited/.test(err.message), err.message);
      assert.ok(/epub-stamp/.test(err.message),
        `the engine's remedy must survive to the user: ${err.message}`);
      return true;
    });
});

test('`foundry epub-stamp` makes a book this door can clean', () => {
  const printed = path.join(ROOT, 'printed.epub');
  writeFixtureEpub(printed, 'On 23/3/1933 the committee approved $5,000.');
  const stamped = path.join(ROOT, 'stamped.epub');
  execFileSync(BINARY, ['epub-stamp', '--epub', printed, '--out', stamped],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(fs.existsSync(stamped), 'epub-stamp wrote nothing');
  const bytes = fs.readFileSync(stamped).toString('binary');
  assert.ok(bytes.includes('data-bf-cat'),
    'the stamped book carries the categories clean-text admits a book by');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The real engine, with a model
// ─────────────────────────────────────────────────────────────────────────────

test('a REAL cleanup stamps the book, and this app\'s own gate reads it', async () => {
  const endpoint = 'http://localhost:11434';
  const model = await ollamaSmallestModel(endpoint);
  if (model === null) {
    // BY NAME, and not silently: a machine with no ollama cannot answer this,
    // and pretending it passed would be worse than saying it was not asked.
    console.log(
      '      SKIPPED — ollama is not answering at http://localhost:11434, or holds no model. '
      + 'Start it (and pull one) to run the live leg of this keeper.');
    return;
  }
  writeAppSettings({ defaultLlmModel: model, ollamaUrl: endpoint });

  const printed = path.join(ROOT, 'live.epub');
  writeFixtureEpub(printed, 'On 23/3/1933 the committee approved $5,000.');
  const stamped = path.join(ROOT, 'live.stamped.epub');
  execFileSync(BINARY, ['epub-stamp', '--epub', printed, '--out', stamped],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const cleaned = path.join(ROOT, 'live.cleaned.epub');
  const seen = [];
  // A ceiling, so a wedged model is a named failure rather than a keeper that
  // never returns. Two blocks of one short sentence each.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 420_000);
  let outcome;
  try {
    outcome = await door.cleanTextEpub({
      epubPath: stamped,
      outPath: cleaned,
      signal: stop.signal,
      onProgress: (done, total) => seen.push(`${done}/${total}`),
    });
  } finally {
    clearTimeout(timer);
  }

  assert.ok(seen.length > 0, 'the door saw no `clean-text: N/M` line to draw a bar from');
  assert.strictEqual(outcome.settings.model, model, 'it ran the model the settings named');
  assert.strictEqual(outcome.settings.endpoint, endpoint);

  // The receipt: the shape the ledger row is written from.
  assert.strictEqual(outcome.receipt.punctuationSpec, outcome.stamp.punctuationSpec);
  assert.strictEqual(outcome.receipt.normalizerVersion, outcome.stamp.normalizerVersion);
  assert.ok(Array.isArray(outcome.receipt.units) && outcome.receipt.units.length > 0,
    'the receipt names the blocks it cleaned');
  assert.ok(fs.existsSync(door.cleanTextStampSidecar(cleaned)), 'the stamp sidecar is beside --out');

  // THE STAMP, THROUGH BOOKFORGE'S OWN PARSER — the wire this keeper exists for.
  const stamp = await epub.readNarrationTextStamp(cleaned);
  assert.notStrictEqual(stamp, null, 'no bookforge:narration-text meta in the cleaned OPF');
  assert.strictEqual(stamp.stampVersion, epub.NARRATION_TEXT_STAMP_VERSION);
  assert.strictEqual(stamp.model, model);
  assert.strictEqual(typeof stamp.punctuationRefused, 'number');

  // AND THE FILE GATE, which is what the render door asks.
  const gate = await door.narrationTextGate(cleaned);
  assert.strictEqual(gate.ok, true, gate.ok ? '' : `${gate.state}: ${gate.reason}`);
  // The book it READ is untouched: the engine writes a new one, always.
  const before = await door.narrationTextGate(stamped);
  assert.strictEqual(before.ok, false, 'the input must not have been stamped in place');
  assert.strictEqual(before.state, 'missing');
});

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failures.push(t.name);
      console.error(`  FAIL  ${t.name}\n        ${err && err.message}`);
    }
  }
  console.log(`\nclean-text door: ${passed}/${tests.length} passed`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failures.length === 0 ? 0 : 1);
})();
