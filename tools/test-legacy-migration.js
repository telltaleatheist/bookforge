#!/usr/bin/env node
/**
 * Tests for the legacy-variant migration — `electron/legacy-variant-migration.ts`,
 * the sweep behind `tools/migrate-legacy-variants.js`. Against REAL project
 * directories on disk, in a temp library, one per generation of project the old
 * library holds.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-legacy-migration.js
 *
 * The migration exists because the new versions page draws the variants registry
 * and only 66 of 378 readable old manifests carry variants, so ~312 books would
 * show an empty page over a full archive folder. What these tests pin:
 *
 *  - EACH GENERATION REGISTERS WHAT IT REALLY HAS. Generation 1 is `archive/`
 *    alone; generation 2 adds a working chain in `source/` and a finished m4b in
 *    `output/`; generation 3 has NO `archive/` at all and its
 *    `source/exported.epub` is the only copy of the book. All three must come
 *    out with the same kind of rows the app would have minted.
 *  - A WORKING-CHAIN FILE IS NOT A VERSION. `<stem>.working.epub`,
 *    `<stem>.tts.epub` and the unpacked `<stem>.working/` folder are the chain's
 *    own state. Registering them would put three rows on the page for one book
 *    and offer the user a "version" that is really an internal artifact.
 *  - A SIDECAR TRAVELS WITH ITS M4B AND IS NEVER ITS OWN ROW. The players find
 *    `<m4b>.vtt` and `<m4b>.sidecars.json` by DERIVATION, so nothing has to be
 *    recorded — and a `.vtt` row on the versions page would be a version the
 *    user could try to narrate.
 *  - A DRY RUN WRITES NOTHING. Asserted on the bytes, not on the absence of a
 *    reported change: the whole review depends on it.
 *  - A SECOND APPLY CHANGES NOTHING. Asserted on the bytes too, which is
 *    stricter than "no new rows" — `modifyManifest` stamps `modifiedAt` on every
 *    write, so a no-op that still wrote would churn 385 books' timestamps.
 *  - AN UNREADABLE MANIFEST IS NAMED AND STEPPED OVER, never replaced. Eight of
 *    the old library's manifests do not parse.
 *  - THE ABSOLUTE-PATH SCAN REPORTS EVERYTHING AND REWRITES ALMOST NOTHING: only
 *    a path under the old root, in a field whose base is known, whose file is
 *    provably at the equivalent place here.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MIGRATION = path.join(REPO, 'dist', 'electron', 'legacy-variant-migration.js');
const MANIFEST = path.join(REPO, 'dist', 'electron', 'manifest-service.js');
if (!fs.existsSync(MIGRATION) || !fs.existsSync(MANIFEST)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
// The migration reaches library-actions for `sha256File`, and library-actions
// reaches the component catalog, which `require('electron')` at load time. Same
// arrangement as tools/test-foundry-landing.js, loaded FIRST.
if (!process.env.BOOKFORGE_USERDATA_DIR) {
  process.env.BOOKFORGE_USERDATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-legacy-ud-'));
}
require(path.join(REPO, 'cli', 'electron-stub.js'));
const migration = require(MIGRATION);
const manifestService = require(MANIFEST);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const OLD_ROOT = 'E:\\Shared\\BookForge';

/**
 * A temp library with whatever projects a test needs.
 *
 * `files` is a flat map of project-relative path -> contents, which is how a
 * generation is described here: the SHAPE of the folders is the whole subject,
 * so writing it out literally per test is the point rather than a chore.
 */
function makeLibrary() {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-legacy-mig-'));
  fs.mkdirSync(path.join(library, 'projects'), { recursive: true });
  manifestService.setLibraryBasePath(library);

  const api = {
    library,
    dir: (projectId) => path.join(library, 'projects', projectId),
    /** Write a project: its manifest, and the files its folders hold. */
    project: (projectId, manifest, files = {}) => {
      const dir = path.join(library, 'projects', projectId);
      fs.mkdirSync(dir, { recursive: true });
      for (const [rel, body] of Object.entries(files)) {
        const abs = path.join(dir, ...rel.split('/'));
        if (rel.endsWith('/')) { fs.mkdirSync(abs, { recursive: true }); continue; }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
      }
      // A raw string manifest is written verbatim — that is how the unreadable
      // fixture gets to be genuinely unparseable rather than merely odd.
      fs.writeFileSync(
        path.join(dir, 'manifest.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
      return dir;
    },
    /** A library-level cover file, for the coverPath rebase test. */
    media: (name, body) => {
      fs.mkdirSync(path.join(library, 'media'), { recursive: true });
      fs.writeFileSync(path.join(library, 'media', name), body);
    },
    read: (projectId) => JSON.parse(
      fs.readFileSync(path.join(library, 'projects', projectId, 'manifest.json'), 'utf-8')),
    bytes: (projectId) => fs.readFileSync(
      path.join(library, 'projects', projectId, 'manifest.json')),
    variants: (projectId) => manifestService.getVariants(api.read(projectId)).variants,
    sweep: (apply = false) => migration.sweepLegacyVariants(library, {
      apply, oldLibraryRoot: OLD_ROOT,
    }),
    one: (projectId, apply = false) => migration.migrateProjectVariants(
      path.join(library, 'projects', projectId),
      { apply, libraryRoot: library, oldLibraryRoot: OLD_ROOT }),
    cleanup: () => fs.rmSync(library, { recursive: true, force: true }),
  };
  return api;
}

const run = (fn) => async () => {
  const lib = makeLibrary();
  try { await fn(lib); } finally { lib.cleanup(); }
};

/** The manifest an old project carries: metadata and nothing else — no variants,
 *  no archive[] list, no outputs. That absence is the whole problem. */
function bareManifest(projectId, over = {}) {
  return {
    version: 2,
    projectId,
    projectType: 'book',
    createdAt: '2024-01-01T00:00:00.000Z',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    source: { type: 'epub', originalFilename: 'book.epub' },
    metadata: { title: 'A Book', author: 'An Author', year: '2020', language: 'en' },
    chapters: [],
    pipeline: {},
    outputs: {},
    ...over,
  };
}

const rel = (r) => r.minted.map((m) => m.relPath).sort();
const skippedFor = (r, p) => r.skipped.find((s) => s.relPath === p);

// ── Generation 1: archive/ holds everything ────────────────────────────────

const GEN1 = 'Gen1_Recent';
const GEN1_FILES = {
  'archive/A Book. An Author. (2020).epub': 'EPUB BYTES',
  'archive/A Book. An Author. (2020).pdf': 'PDF BYTES',
  'archive/A Book. An Author. (2020).m4b': 'M4B BYTES',
  'archive/A Book. An Author. (2020).m4b.vtt': 'WEBVTT',
  'archive/A Book. An Author. (2020).m4b.sidecars.json': '{}',
  'archive/A Book. An Author. (2020).m4b.cover.jpg': 'JPEG',
  'archive/A Book. An Author. (2020).m4b.prebak': 'OLD M4B',
};

test('generation 1 — archive/ epub, pdf and m4b all become versions', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1), GEN1_FILES);
  const r = await lib.one(GEN1, true);
  assert.strictEqual(r.outcome, 'migrated');
  assert.deepStrictEqual(rel(r), [
    'archive/A Book. An Author. (2020).epub',
    'archive/A Book. An Author. (2020).m4b',
    'archive/A Book. An Author. (2020).pdf',
  ]);
  const kinds = Object.fromEntries(r.minted.map((m) => [m.format, m.kind]));
  assert.deepStrictEqual(kinds, { epub: 'ebook', pdf: 'ebook', m4b: 'audiobook' });
}));

test('the m4b\'s sidecars are never versions — they travel with it', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1), GEN1_FILES);
  const r = await lib.one(GEN1, true);
  for (const s of ['.vtt', '.sidecars.json', '.cover.jpg']) {
    const p = `archive/A Book. An Author. (2020).m4b${s}`;
    assert.ok(!rel(r).includes(p), `${s} must not be a version of its own`);
    assert.strictEqual(skippedFor(r, p).reason, 'sidecar');
  }
  const m4b = r.minted.find((m) => m.kind === 'audiobook');
  assert.strictEqual(m4b.sidecars.length, 3, 'the report says which travelled with it');
  assert.strictEqual(m4b.variant.vttPath, undefined,
    'nothing records a sidecar path: the players derive it, and registerAudiobookOutput clears it');
}));

test('a .prebak copy is clutter, not a version', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1), GEN1_FILES);
  const r = await lib.one(GEN1, true);
  const p = 'archive/A Book. An Author. (2020).m4b.prebak';
  assert.ok(!rel(r).includes(p));
  assert.strictEqual(skippedFor(r, p).reason, 'backup');
  assert.ok(r.clutter.includes(p), 'and it is listed so Owen can clear it');
}));

test('a migrated row is shaped like one addVariant minted', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1), GEN1_FILES);
  await lib.one(GEN1, true);
  const v = lib.variants(GEN1).find((x) => x.path.endsWith('.epub'));
  assert.match(v.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'a uuid, as crypto.randomUUID makes');
  assert.strictEqual(v.kind, 'ebook');
  assert.strictEqual(v.format, 'epub');
  assert.ok(!v.path.includes('\\'), 'project-relative, forward slashes');
  assert.strictEqual(v.metadata.title, 'A Book', 'the project\'s own metadata names it');
  assert.strictEqual(v.metadata.author, 'An Author');
  assert.strictEqual(v.metadata.year, '2020');
  assert.strictEqual(v.sourceFileHash.length, 64, 'the same sha256 the duplicate guard reads');
  assert.ok(Date.parse(v.addedAt) > 0);
  assert.strictEqual(v.descriptor, undefined,
    'an archive file is already named after the book — addVariant gives it no descriptor either');
}));

test('addedAt is the FILE\'s mtime, not the morning of the sweep', run(async (lib) => {
  const dir = lib.project(GEN1, bareManifest(GEN1), GEN1_FILES);
  const when = new Date('2021-06-05T09:30:00.000Z');
  const file = path.join(dir, 'archive', 'A Book. An Author. (2020).epub');
  fs.utimesSync(file, when, when);
  const r = await lib.one(GEN1, true);
  const v = r.minted.find((m) => m.relPath.endsWith('.epub')).variant;
  assert.strictEqual(v.addedAt, when.toISOString(),
    'addedAt orders the versions page; a now() would re-date the whole library');
}));

test('a TTS render is not filed as professionally read', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1), GEN1_FILES);
  const r = await lib.one(GEN1, true);
  const m4b = r.minted.find((m) => m.kind === 'audiobook').variant;
  assert.strictEqual(m4b.professionallyRead, false,
    'source.type is epub, so this m4b is a render — the flag must be written, not left to '
    + 'getVariants\' `?? true`, which is the branch for a human upload');
}));

test('an imported audiobook project keeps its narration professional', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1, {
    source: { type: 'audiobook', originalFilename: 'read.m4b' },
  }), GEN1_FILES);
  const r = await lib.one(GEN1, true);
  const m4b = r.minted.find((m) => m.kind === 'audiobook').variant;
  assert.strictEqual(m4b.professionallyRead, true, 'the same test getVariants applies');
}));

// ── Generation 2: archive/ + a working chain + output/ ─────────────────────

const GEN2 = 'Gen2_Chain';
const GEN2_FILES = {
  'archive/A Book. An Author. (2020).epub': 'ARCHIVE EPUB',
  'source/A Book. An Author. (2020).working.epub': 'WORKING COPY',
  'source/A Book. An Author. (2020).tts.epub': 'NARRATION CUT',
  'source/cover.png': 'PNG',
  'output/A Book. An Author. (2020).m4b': 'FINISHED M4B',
  'output/A Book. An Author. (2020).m4b.vtt': 'WEBVTT',
  'output/cleaned.epub': 'CLEANED EPUB',
};

test('generation 2 — the archive book, the finished m4b and the cleaned epub register',
  run(async (lib) => {
    lib.project(GEN2, bareManifest(GEN2), GEN2_FILES);
    const r = await lib.one(GEN2, true);
    assert.deepStrictEqual(rel(r), [
      'archive/A Book. An Author. (2020).epub',
      'output/A Book. An Author. (2020).m4b',
      'output/cleaned.epub',
    ]);
  }));

test('the working chain\'s own files never become versions', run(async (lib) => {
  lib.project(GEN2, bareManifest(GEN2), GEN2_FILES);
  const r = await lib.one(GEN2, true);
  for (const p of [
    'source/A Book. An Author. (2020).working.epub',
    'source/A Book. An Author. (2020).tts.epub',
  ]) {
    assert.ok(!rel(r).includes(p), `${p} is chain state, not an edition`);
    assert.strictEqual(skippedFor(r, p).reason, 'chain-artifact');
  }
}));

test('an unpacked working copy — a FOLDER — is recognized as chain state too',
  run(async (lib) => {
    lib.project(GEN2, bareManifest(GEN2), {
      ...GEN2_FILES,
      'source/A Book. An Author. (2020).working/': '',
      'source/A Book. An Author. (2020).working/content.opf': 'OPF',
    });
    const r = await lib.one(GEN2, true);
    const s = skippedFor(r, 'source/A Book. An Author. (2020).working');
    assert.strictEqual(s.reason, 'chain-artifact');
    assert.strictEqual(s.detail, 'unpacked working copy');
    assert.ok(!r.minted.some((m) => m.relPath.includes('.working/')),
      'and nothing inside it is reached — the folders are read top level only');
  }));

test('a file outside archive/ carries its own name as the descriptor', run(async (lib) => {
  lib.project(GEN2, bareManifest(GEN2), GEN2_FILES);
  const r = await lib.one(GEN2, true);
  const cleaned = r.minted.find((m) => m.relPath === 'output/cleaned.epub').variant;
  assert.strictEqual(cleaned.descriptor, 'cleaned.epub',
    'three rows all called "A Book" would be unreadable — the same reason a Foundry export '
    + 'keeps its tray name');
  const archived = r.minted.find((m) => m.relPath.startsWith('archive/')).variant;
  assert.strictEqual(archived.descriptor, undefined);
}));

test('source/cover.png is reported, never guessed at', run(async (lib) => {
  lib.project(GEN2, bareManifest(GEN2), GEN2_FILES);
  const r = await lib.one(GEN2, true);
  assert.strictEqual(skippedFor(r, 'source/cover.png').reason, 'not-a-book');
}));

test('a project with audiobooks and no outputs.audiobook says so and sets nothing',
  run(async (lib) => {
    lib.project(GEN2, bareManifest(GEN2), GEN2_FILES);
    const r = await lib.one(GEN2, true);
    assert.ok(r.notes.some((n) => n.includes('outputs.audiobook')));
    assert.strictEqual(lib.read(GEN2).outputs.audiobook, undefined,
      'which narration IS the book\'s is not on disk to read, so the shelf pointer stays unset');
  }));

// ── Generation 3: no archive/ at all ───────────────────────────────────────

const GEN3 = 'Gen3_Ancient';
const GEN3_FILES = {
  'source/exported.epub': 'THE ONLY COPY OF THE BOOK',
  'source/cover.png': 'PNG',
  'output/A Book. An Author. (2020).m4b': 'M4B',
  'output/A Book. An Author. (2020).m4b.cover.png': 'PNG',
  'output/A Book. An Author. (2020).m4b.sidecars.json': '{}',
  'output/cleaned.epub': 'CLEANED',
};

test('generation 3 — source/exported.epub IS the book and registers', run(async (lib) => {
  lib.project(GEN3, bareManifest(GEN3), GEN3_FILES);
  const r = await lib.one(GEN3, true);
  assert.deepStrictEqual(rel(r), [
    'output/A Book. An Author. (2020).m4b',
    'output/cleaned.epub',
    'source/exported.epub',
  ]);
  const book = r.minted.find((m) => m.relPath === 'source/exported.epub').variant;
  assert.strictEqual(book.kind, 'ebook');
  assert.strictEqual(book.descriptor, 'exported.epub');
}));

test('a project with no archive/ folder is not a failure to read one', run(async (lib) => {
  lib.project(GEN3, bareManifest(GEN3), GEN3_FILES);
  const r = await lib.one(GEN3, true);
  assert.deepStrictEqual(r.notes.filter((n) => n.includes('could not be listed')), []);
}));

test('primaryVariantId is seeded when absent, preferring the book over the narration',
  run(async (lib) => {
    lib.project(GEN3, bareManifest(GEN3), GEN3_FILES);
    const r = await lib.one(GEN3, true);
    const mf = lib.read(GEN3);
    assert.ok(mf.primaryVariantId, 'a project with none gets one');
    assert.strictEqual(r.primarySeeded, mf.primaryVariantId);
    const primary = mf.variants.find((v) => v.id === mf.primaryVariantId);
    assert.strictEqual(primary.kind, 'ebook',
      'getVariants\' own precedence: the first ebook, never whichever row was minted first');
  }));

test('an existing primaryVariantId is never touched', run(async (lib) => {
  lib.project(GEN3, bareManifest(GEN3, {
    variants: [{
      id: 'kept', kind: 'ebook', format: 'epub', path: 'source/exported.epub',
      metadata: { title: 'A Book' }, addedAt: '2024-01-01T00:00:00.000Z',
    }],
    primaryVariantId: 'kept',
  }), GEN3_FILES);
  const r = await lib.one(GEN3, true);
  assert.strictEqual(r.primarySeeded, null);
  assert.strictEqual(lib.read(GEN3).primaryVariantId, 'kept');
}));

// ── A project that is already correct ──────────────────────────────────────

test('a project whose files are all already versions is left untouched', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1, {
    variants: [
      {
        id: 'v-epub', kind: 'ebook', format: 'epub',
        path: 'archive/A Book. An Author. (2020).epub',
        metadata: { title: 'A Book' }, addedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'v-pdf', kind: 'ebook', format: 'pdf',
        path: 'archive/A Book. An Author. (2020).pdf',
        metadata: { title: 'A Book' }, addedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'v-m4b', kind: 'audiobook', format: 'm4b',
        path: 'archive/A Book. An Author. (2020).m4b',
        metadata: { title: 'A Book' }, addedAt: '2024-01-01T00:00:00.000Z',
        professionallyRead: true,
      },
    ],
    primaryVariantId: 'v-epub',
  }), GEN1_FILES);
  const before = lib.bytes(GEN1);
  const r = await lib.one(GEN1, true);
  assert.strictEqual(r.minted.length, 0);
  assert.notStrictEqual(r.outcome, 'migrated');
  assert.deepStrictEqual(lib.bytes(GEN1), before,
    'not one byte — a project that is already correct must not even churn modifiedAt');
}));

test('a file already covered by a SYNTHESIZED archive[] row is not registered twice',
  run(async (lib) => {
    // getVariants derives `arch:` ebook rows from archive[] for a project with no
    // real variants. Those rows ARE on the versions page, so the file is not
    // missing and must not gain a second row.
    lib.project(GEN1, bareManifest(GEN1, {
      archive: [{
        path: 'archive/A Book. An Author. (2020).epub', role: 'original',
        format: 'epub', archivedAt: '2024-01-01T00:00:00.000Z',
      }],
    }), GEN1_FILES);
    const r = await lib.one(GEN1, true);
    assert.ok(!rel(r).includes('archive/A Book. An Author. (2020).epub'));
    assert.strictEqual(
      skippedFor(r, 'archive/A Book. An Author. (2020).epub').reason, 'already-a-version');
  }));

test('a file whose bytes are already a version is refused the way addVariant refuses it',
  run(async (lib) => {
    lib.project(GEN2, bareManifest(GEN2, {
      variants: [{
        id: 'v-archive', kind: 'ebook', format: 'epub',
        path: 'archive/A Book. An Author. (2020).epub',
        metadata: { title: 'A Book' }, addedAt: '2024-01-01T00:00:00.000Z',
        // The sha256 of 'ARCHIVE EPUB', which output/copy.epub below also holds.
        sourceFileHash: require('crypto').createHash('sha256').update('ARCHIVE EPUB').digest('hex'),
      }],
    }), { ...GEN2_FILES, 'output/copy.epub': 'ARCHIVE EPUB' });
    const r = await lib.one(GEN2, true);
    assert.ok(!rel(r).includes('output/copy.epub'));
    const s = skippedFor(r, 'output/copy.epub');
    assert.strictEqual(s.reason, 'same-bytes');
    assert.strictEqual(s.detail, 'archive/A Book. An Author. (2020).epub');
  }));

// ── The dry run, and running twice ─────────────────────────────────────────

test('a dry run writes NOTHING — asserted on the bytes', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1), GEN1_FILES);
  lib.project(GEN2, bareManifest(GEN2), GEN2_FILES);
  lib.project(GEN3, bareManifest(GEN3), GEN3_FILES);
  const before = [GEN1, GEN2, GEN3].map((p) => lib.bytes(p));
  const { totals } = await lib.sweep(false);
  assert.strictEqual(totals.migrated, 3, 'it says it would migrate all three');
  assert.ok(totals.variants > 0);
  [GEN1, GEN2, GEN3].forEach((p, i) => {
    assert.deepStrictEqual(lib.bytes(p), before[i], `${p} was written to during a dry run`);
  });
}));

test('the dry run reports the very records the apply writes', run(async (lib) => {
  lib.project(GEN2, bareManifest(GEN2), GEN2_FILES);
  const dry = await lib.one(GEN2, false);
  assert.strictEqual(dry.written, false);
  const wet = await lib.one(GEN2, true);
  assert.strictEqual(wet.written, true);
  // The uuid differs between two runs by construction; everything a person
  // reviews — which files, of what kind, at what path, with which metadata — is
  // the same, because the dry run does the identical work minus the write.
  assert.deepStrictEqual(rel(dry), rel(wet));
  assert.deepStrictEqual(
    dry.minted.map((m) => [m.kind, m.format, m.variant.sourceFileHash, m.variant.addedAt]),
    wet.minted.map((m) => [m.kind, m.format, m.variant.sourceFileHash, m.variant.addedAt]));
}));

test('a second apply changes nothing — idempotent to the byte', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1), GEN1_FILES);
  lib.project(GEN2, bareManifest(GEN2), GEN2_FILES);
  lib.project(GEN3, bareManifest(GEN3), GEN3_FILES);
  await lib.sweep(true);
  const after = [GEN1, GEN2, GEN3].map((p) => lib.bytes(p));
  const { totals } = await lib.sweep(true);
  assert.strictEqual(totals.migrated, 0, 'nothing left to register');
  [GEN1, GEN2, GEN3].forEach((p, i) => {
    assert.deepStrictEqual(lib.bytes(p), after[i], `${p} was rewritten by a second apply`);
  });
}));

test('applying persists the rows getVariants was only deriving', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1, {
    archive: [{
      path: 'archive/A Book. An Author. (2020).pdf', role: 'original',
      format: 'pdf', archivedAt: '2024-01-01T00:00:00.000Z',
    }],
  }), GEN1_FILES);
  await lib.one(GEN1, true);
  const stored = lib.read(GEN1).variants;
  assert.ok(stored.some((v) => v.id === 'archive:pdf' || v.id.startsWith('arch:')),
    'the derived archive row is now a real one — the same `mf.variants = cur.variants` every '
    + 'library-actions mutation opens with');
  assert.strictEqual(stored.length, 3, 'the derived row plus the two files it did not cover');
}));

// ── An unreadable manifest ─────────────────────────────────────────────────

test('a manifest that will not parse is named and stepped over', run(async (lib) => {
  lib.project('Broken', '{ "projectId": "Broken", "metadata": ', GEN1_FILES);
  const before = lib.bytes('Broken');
  const r = await lib.one('Broken', true);
  assert.strictEqual(r.outcome, 'unreadable');
  assert.ok(r.refusal, 'and it says why, in the parser\'s own words');
  assert.strictEqual(r.minted.length, 0);
  assert.deepStrictEqual(lib.bytes('Broken'), before, 'no manifest is ever invented over it');
}));

test('one unreadable project does not cost the rest of the sweep', run(async (lib) => {
  lib.project('Broken', 'not json at all', {});
  lib.project(GEN1, bareManifest(GEN1), GEN1_FILES);
  const { totals } = await lib.sweep(true);
  assert.strictEqual(totals.visited, 2);
  assert.strictEqual(totals.unreadable, 1);
  assert.strictEqual(totals.migrated, 1);
}));

test('a project with no manifest at all is unreadable, not skipped in silence',
  run(async (lib) => {
    fs.mkdirSync(path.join(lib.library, 'projects', 'Empty'), { recursive: true });
    const { totals, reports } = await lib.sweep(false);
    assert.strictEqual(totals.unreadable, 1);
    assert.match(reports[0].refusal, /Empty/);
  }));

// ── Clutter ────────────────────────────────────────────────────────────────

test('sync-conflict and .bak manifests are reported and never opened', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1), {
    ...GEN1_FILES,
    // A conflict copy claiming a whole different book. If it were ever read as
    // truth, these rows would carry ITS title.
    'manifest.sync-conflict-20240102-101112-ABCDEFG.json': JSON.stringify({
      projectId: GEN1, metadata: { title: 'WRONG BOOK', author: 'Nobody' }, variants: [],
    }),
    'manifest.json.bak': '{}',
    'manifest.json.bak2': '{}',
  });
  const r = await lib.one(GEN1, true);
  assert.deepStrictEqual(r.clutter.filter((c) => c.startsWith('manifest')).sort(), [
    'manifest.json.bak', 'manifest.json.bak2',
    'manifest.sync-conflict-20240102-101112-ABCDEFG.json',
  ]);
  assert.strictEqual(r.minted[0].variant.metadata.title, 'A Book',
    'the real manifest is the truth; the conflict copy was never read');
}));

// ── The absolute-path scan ─────────────────────────────────────────────────

test('an old-root path whose file IS here is repointed, project-relative', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1, {
    outputs: {
      audiobook: {
        path: `${OLD_ROOT}\\projects\\${GEN1}\\archive\\A Book. An Author. (2020).m4b`,
        completedAt: '2024-01-01T00:00:00.000Z',
      },
    },
  }), GEN1_FILES);
  const r = await lib.one(GEN1, true);
  const f = r.absolutes.find((a) => a.field === 'outputs.audiobook.path');
  assert.strictEqual(f.underOldRoot, true);
  assert.strictEqual(f.wouldBecome, 'archive/A Book. An Author. (2020).m4b');
  assert.strictEqual(f.targetExists, true);
  assert.strictEqual(f.fixed, true);
  assert.strictEqual(lib.read(GEN1).outputs.audiobook.path,
    'archive/A Book. An Author. (2020).m4b');
}));

test('a repointed record is not ALSO minted as a second row for the same file',
  run(async (lib) => {
    // The case this ordering exists for. `outputs.audiobook` names the m4b at the
    // old library root; `getVariants` folds that record into the 'audiobook' row.
    // Plan against the UNREPAIRED manifest and the fold sits at an absolute path
    // the file cannot match, so the m4b looks unlisted and gains a row of its
    // own — two versions of one narration, one of them naming a drive that is
    // not there.
    lib.project(GEN2, bareManifest(GEN2, {
      outputs: {
        audiobook: {
          path: `${OLD_ROOT}\\projects\\${GEN2}\\output\\A Book. An Author. (2020).m4b`,
          completedAt: '2024-01-01T00:00:00.000Z',
        },
      },
    }), GEN2_FILES);
    const r = await lib.one(GEN2, true);
    assert.ok(!rel(r).includes('output/A Book. An Author. (2020).m4b'),
      'the repaired outputs.audiobook already lists it');
    assert.strictEqual(
      skippedFor(r, 'output/A Book. An Author. (2020).m4b').reason, 'already-a-version');
    const mf = lib.read(GEN2);
    assert.strictEqual(mf.outputs.audiobook.path, 'output/A Book. An Author. (2020).m4b');
    const audio = mf.variants.filter((v) => v.kind === 'audiobook');
    assert.strictEqual(audio.length, 1, 'exactly one row for one m4b');
    assert.strictEqual(audio[0].path, 'output/A Book. An Author. (2020).m4b');
  }));

test('the dry run plans against the repaired paths too, and still writes nothing',
  run(async (lib) => {
    lib.project(GEN2, bareManifest(GEN2, {
      outputs: {
        audiobook: {
          path: `${OLD_ROOT}\\projects\\${GEN2}\\output\\A Book. An Author. (2020).m4b`,
          completedAt: '2024-01-01T00:00:00.000Z',
        },
      },
    }), GEN2_FILES);
    const before = lib.bytes(GEN2);
    const dry = await lib.one(GEN2, false);
    assert.ok(!rel(dry).includes('output/A Book. An Author. (2020).m4b'),
      'the dry run and the apply must plan identically, or the review is of a different act');
    assert.deepStrictEqual(lib.bytes(GEN2), before);
  }));

test('an old-root path whose file is NOT here is reported and left alone', run(async (lib) => {
  const stale = `${OLD_ROOT}\\projects\\${GEN1}\\archive\\Gone.m4b`;
  lib.project(GEN1, bareManifest(GEN1, {
    outputs: { audiobook: { path: stale, completedAt: '2024-01-01T00:00:00.000Z' } },
  }), GEN1_FILES);
  const r = await lib.one(GEN1, true);
  const f = r.absolutes.find((a) => a.field === 'outputs.audiobook.path');
  assert.strictEqual(f.targetExists, false);
  assert.strictEqual(f.fixed, false);
  assert.strictEqual(lib.read(GEN1).outputs.audiobook.path, stale,
    'a path naming where the file WAS is truthful; a relative path with nothing on it is not');
}));

test('coverPath is rebased on the LIBRARY, not the project', run(async (lib) => {
  lib.media('cover_abc123.jpg', 'JPEG');
  lib.project(GEN1, bareManifest(GEN1, {
    metadata: {
      title: 'A Book', author: 'An Author', year: '2020', language: 'en',
      coverPath: `${OLD_ROOT}\\media\\cover_abc123.jpg`,
    },
  }), GEN1_FILES);
  const r = await lib.one(GEN1, true);
  const f = r.absolutes.find((a) => a.field === 'metadata.coverPath');
  assert.strictEqual(f.wouldBecome, 'media/cover_abc123.jpg');
  assert.strictEqual(f.fixed, true);
  assert.strictEqual(lib.read(GEN1).metadata.coverPath, 'media/cover_abc123.jpg',
    'every reader joins coverPath onto getLibraryBasePath(), so the project is the wrong base');
}));

test('a path naming ANOTHER project is reported, never bent into this one', run(async (lib) => {
  const other = `${OLD_ROOT}\\projects\\Some_Other_Book\\archive\\x.epub`;
  lib.project(GEN1, bareManifest(GEN1, {
    archive: [{ path: other, role: 'original', format: 'epub', archivedAt: '2024-01-01T00:00:00.000Z' }],
  }), GEN1_FILES);
  const r = await lib.one(GEN1, true);
  const f = r.absolutes.find((a) => a.value === other);
  assert.strictEqual(f.underOldRoot, true);
  assert.strictEqual(f.wouldBecome, null, 'a cross-project reference is not this tool\'s to resolve');
  assert.strictEqual(f.fixed, false);
}));

test('an absolute path outside the old root is reported and never rewritten',
  run(async (lib) => {
    const elsewhere = 'D:\\Somewhere\\Else\\book.epub';
    lib.project(GEN1, bareManifest(GEN1, {
      pipeline: { cleanup: { status: 'complete', outputPath: elsewhere } },
    }), GEN1_FILES);
    const r = await lib.one(GEN1, true);
    const f = r.absolutes.find((a) => a.value === elsewhere);
    assert.strictEqual(f.underOldRoot, false);
    assert.strictEqual(f.wouldBecome, null);
    assert.strictEqual(f.fixed, false);
  }));

test('the scan reaches fields no hand-written list would have — ledger, diffs, families',
  run(async (lib) => {
    lib.project(GEN1, bareManifest(GEN1, {
      families: [{
        id: 'fam-0001abcd',
        source: { path: `${OLD_ROOT}\\projects\\${GEN1}\\archive\\A Book. An Author. (2020).epub`, kind: 'archive-epub' },
        epub: {
          path: `${OLD_ROOT}\\projects\\${GEN1}\\source\\book.epub`,
          appliedPasses: [{ kind: 'footnotes', at: '2024-01-01T00:00:00.000Z', diff: `${OLD_ROOT}\\projects\\${GEN1}\\stages\\d.json` }],
          ledger: [{
            id: 'led-1', dir: `${OLD_ROOT}\\projects\\${GEN1}\\source\\ledger\\led-1`,
            snapshot: `${OLD_ROOT}\\projects\\${GEN1}\\source\\ledger\\led-1\\snap.epub`,
            receipt: null,
            pass: { kind: 'footnotes', at: '2024-01-01T00:00:00.000Z', diff: `${OLD_ROOT}\\projects\\${GEN1}\\stages\\e.json` },
          }],
        },
      }],
    }), GEN1_FILES);
    const r = await lib.one(GEN1, false);
    const fields = r.absolutes.map((a) => a.field).sort();
    assert.deepStrictEqual(fields, [
      'families[0].epub.appliedPasses[0].diff',
      'families[0].epub.ledger[0].dir',
      'families[0].epub.ledger[0].pass.diff',
      'families[0].epub.ledger[0].snapshot',
      'families[0].epub.path',
      'families[0].source.path',
    ], 'the manifest is walked, not field-listed — NFC_PATH_KEYS misses four of these');
    // Only the one whose file is actually here would be repointed.
    const source = r.absolutes.find((a) => a.field === 'families[0].source.path');
    assert.strictEqual(source.targetExists, true);
    assert.strictEqual(
      r.absolutes.filter((a) => a.targetExists).length, 1,
      'everything else is report-only, because nothing is at the equivalent place');
  }));

test('ordinary prose is never mistaken for a path', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1, {
    metadata: {
      title: 'A Book', author: 'An Author', year: '2020', language: 'en',
      description: 'A study of C: the language, and of / as a symbol.',
    },
  }), GEN1_FILES);
  const r = await lib.one(GEN1, false);
  assert.deepStrictEqual(r.absolutes, []);
}));

test('a dry run never rewrites an absolute path either', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1, {
    outputs: {
      audiobook: {
        path: `${OLD_ROOT}\\projects\\${GEN1}\\archive\\A Book. An Author. (2020).m4b`,
        completedAt: '2024-01-01T00:00:00.000Z',
      },
    },
  }), GEN1_FILES);
  const before = lib.bytes(GEN1);
  const r = await lib.one(GEN1, false);
  assert.strictEqual(r.absolutes[0].targetExists, true, 'it says it could');
  assert.strictEqual(r.absolutes[0].fixed, false, 'and did not');
  assert.deepStrictEqual(lib.bytes(GEN1), before);
}));

// ── Outcomes and totals ────────────────────────────────────────────────────

test('a project with nothing to add but something to say is reported-only',
  run(async (lib) => {
    lib.project(GEN1, bareManifest(GEN1, {
      variants: [{
        id: 'v-epub', kind: 'ebook', format: 'epub',
        path: 'archive/A Book. An Author. (2020).epub',
        metadata: { title: 'A Book' }, addedAt: '2024-01-01T00:00:00.000Z',
      }],
      primaryVariantId: 'v-epub',
    }), {
      'archive/A Book. An Author. (2020).epub': 'EPUB BYTES',
      'archive/notes.txt': 'SOMETHING ELSE',
    });
    const before = lib.bytes(GEN1);
    const r = await lib.one(GEN1, true);
    assert.strictEqual(r.outcome, 'reported-only');
    assert.deepStrictEqual(lib.bytes(GEN1), before);
  }));

test('a project with nothing to add and nothing to say is clean', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1, {
    variants: [{
      id: 'v-epub', kind: 'ebook', format: 'epub',
      path: 'archive/A Book. An Author. (2020).epub',
      metadata: { title: 'A Book' }, addedAt: '2024-01-01T00:00:00.000Z',
    }],
    primaryVariantId: 'v-epub',
  }), { 'archive/A Book. An Author. (2020).epub': 'EPUB BYTES' });
  const r = await lib.one(GEN1, true);
  assert.strictEqual(r.outcome, 'clean');
}));

test('the totals account for every project visited', run(async (lib) => {
  lib.project(GEN1, bareManifest(GEN1), GEN1_FILES);
  lib.project(GEN2, bareManifest(GEN2), GEN2_FILES);
  lib.project('Broken', 'nope', {});
  lib.project('Clean', bareManifest('Clean', {
    variants: [{
      id: 'v', kind: 'ebook', format: 'epub', path: 'archive/b.epub',
      metadata: { title: 'A Book' }, addedAt: '2024-01-01T00:00:00.000Z',
    }],
    primaryVariantId: 'v',
  }), { 'archive/b.epub': 'X' });
  const { totals } = await lib.sweep(false);
  assert.strictEqual(totals.visited, 4);
  assert.strictEqual(
    totals.clean + totals.migrated + totals.reportedOnly + totals.unreadable, 4,
    'every project lands in exactly one bucket');
  assert.strictEqual(totals.clean, 1);
  assert.strictEqual(totals.unreadable, 1);
  assert.strictEqual(totals.migrated, 2);
}));

test('a project directory outside the swept library is refused, never read', run(async (lib) => {
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-legacy-stranger-'));
  try {
    fs.mkdirSync(path.join(stranger, GEN1), { recursive: true });
    fs.writeFileSync(
      path.join(stranger, GEN1, 'manifest.json'), JSON.stringify(bareManifest(GEN1)));
    lib.project(GEN1, bareManifest(GEN1), GEN1_FILES);
    const r = await migration.migrateProjectVariants(path.join(stranger, GEN1), {
      apply: true, libraryRoot: lib.library, oldLibraryRoot: OLD_ROOT,
    });
    assert.strictEqual(r.outcome, 'unreadable');
    assert.match(r.refusal, /not under the library/);
  } finally {
    fs.rmSync(stranger, { recursive: true, force: true });
  }
}));

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; }
    catch (err) { failures.push({ name, err }); }
  }
  console.log(`\nlegacy migration: ${passed}/${tests.length} passed`);
  for (const f of failures) {
    console.error(`\n  FAIL  ${f.name}\n        ${f.err.stack || f.err.message}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
})();
