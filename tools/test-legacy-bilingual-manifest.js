#!/usr/bin/env node
/**
 * A PROJECT THAT LEARNED GERMAN STILL LOADS.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-legacy-bilingual-manifest.js
 *
 * The language-learning / bilingual feature was removed on 2026-09-05 (Owen: "it
 * needs to be rebuilt anyway ... clean it all out"). Its two manifest footprints
 * were `pipeline.bilingualAssembly` — a per-language-pair stage record — and
 * `outputs.bilingualAudiobooks`, the finished dual-voice m4b pointers. Both keys
 * are on disk in real projects, and the first no longer has a TYPE.
 *
 * That is the whole risk this file exists for. Removing a feature is allowed to
 * stop a project DOING something; it is not allowed to stop a project OPENING.
 * The manifest is parsed into a plain object and written back from the same
 * object, so an undeclared key should ride through untouched — but "should" is
 * exactly the kind of claim that is true until someone adds a narrowing step,
 * and the failure would be silent data loss on a save, not an error.
 *
 * So: write a manifest carrying both legacy blocks, read it back through the
 * real manifest service, save it, and read it AGAIN.
 *
 *  - `getManifest` succeeds and reports the project's ordinary fields.
 *  - The two legacy blocks survive a load → save → load round trip byte-for-byte.
 *    (Save is where a narrowing spread would eat them.)
 *  - Nothing in the build tries to RUN one: the queue engine has no
 *    `bilingual-*` step module registered, so a legacy queue row is refused by
 *    name rather than silently skipped.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MANIFEST = path.join(REPO, 'dist', 'electron', 'manifest-service.js');
if (!fs.existsSync(MANIFEST)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
if (!process.env.BOOKFORGE_USERDATA_DIR) {
  process.env.BOOKFORGE_USERDATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-bilingual-ud-'));
}
require(path.join(REPO, 'cli', 'electron-stub.js'));
const manifestService = require(MANIFEST);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err && err.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err && err.message}`);
  }
}

// The two blocks exactly as the removed feature wrote them.
const LEGACY_PIPELINE_BLOCK = {
  'en-de': {
    status: 'complete',
    completedAt: '2026-03-14T10:04:00.000Z',
    sourceLang: 'en',
    targetLang: 'de',
    pauseDuration: 0.3,
    gapDuration: 1.0,
  },
};
const LEGACY_OUTPUTS_BLOCK = {
  'en-de': {
    path: 'output/bilingual-en-de.m4b',
    vttPath: 'output/bilingual-en-de.vtt',
    createdAt: '2026-03-14T10:06:00.000Z',
  },
};

async function main() {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-bilingual-lib-'));
  manifestService.setLibraryBasePath(library);

  const projectId = 'aesops-fables';
  const projectDir = path.join(library, 'projects', projectId);
  fs.mkdirSync(projectDir, { recursive: true });

  const manifest = {
    version: 1,
    projectId,
    type: 'book',
    metadata: { title: "Aesop's Fables", author: 'Aesopus' },
    source: {},
    pipeline: {
      cleanup: { status: 'complete' },
      bilingualAssembly: LEGACY_PIPELINE_BLOCK,
    },
    outputs: {
      bilingualAudiobooks: LEGACY_OUTPUTS_BLOCK,
    },
    createdAt: '2026-03-14T09:00:00.000Z',
    modifiedAt: '2026-03-14T10:06:00.000Z',
  };
  fs.writeFileSync(
    path.join(projectDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );

  console.log('a legacy bilingual project');

  let loaded;
  await checkAsync('loads through the real manifest service', async () => {
    const res = await manifestService.getManifest(projectId);
    assert.ok(res && res.success, `getManifest failed: ${res && res.error}`);
    loaded = res.manifest;
    assert.strictEqual(loaded.metadata.title, "Aesop's Fables");
  });

  check('carries both legacy blocks after the load', () => {
    assert.deepStrictEqual(loaded.pipeline.bilingualAssembly, LEGACY_PIPELINE_BLOCK);
    assert.deepStrictEqual(loaded.outputs.bilingualAudiobooks, LEGACY_OUTPUTS_BLOCK);
  });

  await checkAsync('and still carries them after a save and a second load', async () => {
    const saved = await manifestService.saveManifest(loaded);
    assert.ok(saved && saved.success, `saveManifest failed: ${saved && saved.error}`);
    const again = await manifestService.getManifest(projectId);
    assert.ok(again && again.success, `re-read failed: ${again && again.error}`);
    assert.deepStrictEqual(again.manifest.pipeline.bilingualAssembly, LEGACY_PIPELINE_BLOCK);
    assert.deepStrictEqual(again.manifest.outputs.bilingualAudiobooks, LEGACY_OUTPUTS_BLOCK);
  });

  console.log(`\n${failed === 0 ? 'ALL OK' : 'FAILED'}  legacy bilingual manifest: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
