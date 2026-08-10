#!/usr/bin/env node
/**
 * Tests for `planVlmConversion` (electron/vlm-convert.ts) — everything a
 * conversion decides BEFORE it spawns anything.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-vlm-convert-plan.js
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *
 * The plan was split out of `runVlmConversion` so the headless CLI
 * (`bookforge-tts --generate-epub --dry-run`, cli/generate-epub.js) can say what
 * a conversion WOULD do without a GPU. That is only worth anything if the plan is
 * the run's own — so what these tests hold in place is that the refusals a person
 * meets before a page is read are the DOCUMENT PIPELINE'S refusals, arriving in
 * the order the run makes them, whichever surface asked.
 *
 * ORDER is a property, not an accident. The endpoint setting is resolved FIRST,
 * before a project is even looked at, because a half-configured server is the
 * user's settings being wrong and is cheapest to say immediately. A test that
 * only checked "it throws" would pass while the run spent a minute resolving a
 * project it was never going to convert.
 *
 * Everything here stops before `ensureFoundryPath`, deliberately: a test suite
 * must not download a 38 MB binary, and these are exactly the refusals that
 * happen before it would.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'vlm-convert.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

// vlm-convert reaches for `app.getPath('userData')`. The CLI's own shim answers
// that, and using it here means the module under test loads exactly as it does
// for `--generate-epub`.
require('../cli/electron-stub.js');
const { planVlmConversion } = require(path.join(DIST, 'vlm-convert.js'));
const manifestService = require(path.join(DIST, 'manifest-service.js'));

/**
 * A configured endpoint on every request below.
 *
 * Not decoration: with none, `resolveVlmRoute` answers with whatever THIS machine
 * can do — MLX on an Apple Silicon Mac, the WSL reader on a Windows box that has
 * one configured, a refusal anywhere else — and the suite would assert different
 * things on different machines. A URL makes the route the same everywhere, which
 * is the only way the refusals underneath it can be the thing under test.
 */
const ENDPOINT = { url: 'http://127.0.0.1:8000/v1', model: '', concurrency: 0 };

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-vlm-plan-'));
manifestService.setLibraryBasePath(ROOT);

/** A project laid out the way the library lays one out. */
function makeProject(projectId, manifest, files) {
  const dir = path.join(ROOT, 'projects', projectId);
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
  for (const [rel, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), bytes);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'),
    JSON.stringify({ version: 1, projectId, projectType: 'book', ...manifest }, null, 2));
  return dir;
}

const archiveEntry = (rel, format) => ({
  path: rel, role: 'original', format, label: `Original ${format.toUpperCase()}`,
  archivedAt: '2026-08-10T00:00:00.000Z', size: 3,
});
const variantEntry = (rel, format, descriptor) => ({
  id: `arch:${rel}`, kind: 'ebook', format, path: rel, descriptor,
  addedAt: '2026-08-10T00:00:00.000Z',
});

// ── the endpoint setting is resolved before anything else ───────────────────

test('a model name with no endpoint URL is refused before the project is even read', async () => {
  await assert.rejects(
    () => planVlmConversion({
      // Deliberately not a project. Reaching a project error from here would mean
      // the endpoint check had moved after the resolve, and a user with a typo in
      // Settings would be told about their book instead of their setting.
      projectDir: path.join(ROOT, 'no-such-project'),
      endpoint: { url: '', model: 'rednote-hilab/dots.ocr', concurrency: 0 },
    }),
    (err) => /model name .* is set with no endpoint URL/.test(err.message)
      && /Settings → AI → Reading pages/.test(err.message),
  );
});

test('a URL that is not one is refused by name, not repaired', async () => {
  await assert.rejects(
    () => planVlmConversion({
      projectDir: path.join(ROOT, 'no-such-project'),
      endpoint: { url: '192.168.1.4:8000', model: '', concurrency: 0 },
    }),
    (err) => /is not a URL a VLM endpoint can be reached at/.test(err.message),
  );
});

// ── which document ──────────────────────────────────────────────────────────

test('a book that arrived as an EPUB is refused with the document pipeline’s own sentence', async () => {
  const dir = makeProject('An_Epub_Only_Book', {
    source: { type: 'epub', originalFilename: 'An Epub Only Book.epub' },
    metadata: { title: 'An Epub Only Book', language: 'en' },
    archive: [archiveEntry('archive/An Epub Only Book.epub', 'epub')],
    variants: [variantEntry('archive/An Epub Only Book.epub', 'epub', 'Original EPUB')],
    primaryVariantId: 'arch:archive/An Epub Only Book.epub',
    families: [],
  }, { 'archive/An Epub Only Book.epub': 'PK' });

  await assert.rejects(
    () => planVlmConversion({ projectDir: dir, endpoint: ENDPOINT }),
    (err) => /This project has no PDF/.test(err.message)
      && /it was imported as a book/.test(err.message),
  );
});

test('two PDFs and no choice is a question, and it names both', async () => {
  const dir = makeProject('Two_Editions', {
    source: { type: 'pdf', originalFilename: 'First Edition.pdf' },
    metadata: { title: 'Two Editions', language: 'en' },
    archive: [archiveEntry('archive/First Edition.pdf', 'pdf')],
    variants: [
      variantEntry('archive/First Edition.pdf', 'pdf', 'First edition'),
      variantEntry('archive/Second Edition.pdf', 'pdf', 'Second edition'),
    ],
    primaryVariantId: 'arch:archive/First Edition.pdf',
    families: [],
  }, {
    'archive/First Edition.pdf': '%PDF-1.4',
    'archive/Second Edition.pdf': '%PDF-1.4',
  });

  await assert.rejects(
    () => planVlmConversion({ projectDir: dir, endpoint: ENDPOINT }),
    (err) => /holds 2 PDFs and nothing said which one to read/.test(err.message)
      && /First edition/.test(err.message) && /Second edition/.test(err.message),
  );
});

test('a variantId that names the EPUB version is refused, not read as a PDF', async () => {
  const dir = makeProject('Both_Formats', {
    source: { type: 'pdf', originalFilename: 'Both Formats.pdf' },
    metadata: { title: 'Both Formats', language: 'en' },
    archive: [archiveEntry('archive/Both Formats.pdf', 'pdf')],
    variants: [
      variantEntry('archive/Both Formats.pdf', 'pdf', 'Original PDF'),
      variantEntry('archive/Both Formats.epub', 'epub', 'Publisher EPUB'),
    ],
    primaryVariantId: 'arch:archive/Both Formats.pdf',
    families: [],
  }, {
    'archive/Both Formats.pdf': '%PDF-1.4',
    'archive/Both Formats.epub': 'PK',
  });

  await assert.rejects(
    () => planVlmConversion({
      projectDir: dir,
      variantId: 'arch:archive/Both Formats.epub',
      endpoint: ENDPOINT,
    }),
    (err) => /is a epub, and \s*the document pipeline reads a PDF/.test(err.message.replace(/\n/g, ' ')),
  );
});

test('a project directory with no manifest is not a project, and says so', async () => {
  const dir = path.join(ROOT, 'projects', 'Not_A_Project');
  fs.mkdirSync(dir, { recursive: true });
  await assert.rejects(
    () => planVlmConversion({ projectDir: dir, endpoint: ENDPOINT }),
    (err) => /is not a BookForge project/.test(err.message),
  );
});

// ── where the book would land ───────────────────────────────────────────────

test('the cast is named after the archive file, in source/, by manifest-service alone', async () => {
  const dir = makeProject('A_Test_Book', {
    source: { type: 'pdf', originalFilename: 'A Test Book.pdf' },
    metadata: { title: 'A Test Book', language: 'en' },
    archive: [archiveEntry('archive/A Test Book.pdf', 'pdf')],
    variants: [variantEntry('archive/A Test Book.pdf', 'pdf', 'Original PDF')],
    primaryVariantId: 'arch:archive/A Test Book.pdf',
    families: [],
  }, { 'archive/A Test Book.pdf': '%PDF-1.4' });

  const target = await manifestService.generatedEpubTarget(dir);
  assert.strictEqual(target.relPath, 'source/A Test Book.generated.epub');
  assert.strictEqual(target.absPath, path.join(dir, 'source', 'A Test Book.generated.epub'));
  // Nothing is created by asking where a book would go.
  assert.ok(!fs.existsSync(path.join(dir, 'source')));
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failures.push({ name, err });
    }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const f of failures) {
    console.log(`FAIL  ${f.name}`);
    console.log(`      ${f.err && f.err.message ? f.err.message : f.err}`);
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
