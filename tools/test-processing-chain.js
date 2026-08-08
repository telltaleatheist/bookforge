#!/usr/bin/env node
/**
 * Tests for electron/processing-chain.ts — the planner that decides what a run
 * would do before a single job is queued.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-processing-chain.js
 *
 * ── What is worth defending here ────────────────────────────────────────────
 *
 * Every refusal, and the numbering.
 *
 * A run is now two passes over ONE file — Simplify and Translate over the
 * project's book — so the ordering rules the old document pipeline needed are
 * gone with the passes that needed them. What is left is small and is exactly
 * the part a user can trip over:
 *
 *  - a run over a project with no book has to say what makes a book, because
 *    "no outputs.epub" is not a sentence anyone can act on;
 *  - a run pointed at a PDF has to say so, at plan time, rather than three hours
 *    later inside a zip reader;
 *  - a request naming a pass this build no longer has (a queue.json or a wizard
 *    from an older build) must be refused rather than mapped onto the nearest
 *    live pass;
 *  - and the stage directories must carry on from the book's existing history,
 *    because two passes sharing `stages/01-simplify` would overwrite each
 *    other's diff.
 *
 * None of this needs foundry, a model, or a real EPUB: the planner reads the
 * manifest and stats files, so the whole state space is reachable by putting
 * files in a directory.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'processing-chain.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-chain-'));
process.env.BOOKFORGE_USERDATA_DIR = process.env.BOOKFORGE_USERDATA_DIR
  || path.join(SCRATCH, 'userdata');
fs.mkdirSync(process.env.BOOKFORGE_USERDATA_DIR, { recursive: true });

const chain = require(path.join(DIST, 'processing-chain.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const SIMPLIFY = {
  kind: 'simplify',
  simplify: { mode: 'dejargon', aiProvider: 'local', aiModel: 'qwen3:4b' },
};
const TRANSLATE = {
  kind: 'translate',
  translate: { sourceLang: 'de', targetLang: 'en', aiProvider: 'local', aiModel: 'qwen3:4b' },
};

/**
 * A project laid out the way a real one is.
 *
 * `book` writes an EPUB into `source/` and records it, which is the only state
 * the planner cares about; `passes` seeds the provenance a run has to number
 * itself after.
 */
function project(name, { book = true, pdf = false, passes = [] } = {}) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });

  const manifest = {
    projectId: name,
    type: 'book',
    createdAt: new Date().toISOString(),
    metadata: { title: 'A Test Book' },
    source: { type: 'file', originalFilename: 'A Test Book.epub' },
    outputs: {},
  };

  if (book) {
    fs.writeFileSync(path.join(dir, 'source', 'A Test Book.epub'), 'not really a zip');
    manifest.outputs.epub = {
      path: 'source/A Test Book.epub',
      modifiedAt: new Date().toISOString(),
      ...(passes.length ? { appliedPasses: passes } : {}),
    };
  }
  if (pdf) {
    fs.writeFileSync(path.join(dir, 'archive', 'A Test Book.pdf'), '%PDF-1.7\n');
    manifest.archive = [{ path: 'archive/A Test Book.pdf', role: 'original', format: 'pdf' }];
    manifest.variants = [{
      id: 'v-pdf', kind: 'ebook', format: 'pdf', path: 'archive/A Test Book.pdf',
      metadata: {}, addedAt: new Date().toISOString(),
    }];
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

/** Plan, expecting a refusal, and hand back the message. */
async function refusal(request) {
  try {
    await chain.planProcessingChain(request);
  } catch (err) {
    return err.message;
  }
  assert.fail('the plan was accepted, and it should have been refused');
}

// ── a run that works ────────────────────────────────────────────────────────

test('two passes over a book plan as two jobs, in the order given', async () => {
  const dir = project('plain');
  const plan = await chain.planProcessingChain({
    projectDir: dir, passes: [SIMPLIFY, TRANSLATE],
  });

  assert.deepStrictEqual(plan.jobs.map((j) => j.jobType), ['simplify', 'translate-pass']);
  assert.deepStrictEqual(plan.jobs.map((j) => j.label), ['Simplify', 'Translate']);
  assert.strictEqual(path.basename(plan.sourcePath), 'A Test Book.epub');
  assert.strictEqual(plan.bookEpubPath, plan.sourcePath,
    'both passes rewrite the book in place, so the input and the book are one file');
  assert.strictEqual(plan.title, 'A Test Book');
});

test('each pass gets its own stage directory, numbered in execution order', async () => {
  const dir = project('numbering');
  const plan = await chain.planProcessingChain({
    projectDir: dir, passes: [SIMPLIFY, TRANSLATE],
  });
  assert.deepStrictEqual(
    plan.jobs.map((j) => j.config.stageRelDir),
    ['stages/01-simplify', 'stages/02-translate']
  );
});

test('numbering carries on from what the book already records', async () => {
  // A pass writes the book IN PLACE, so a second run adds to that book's history
  // rather than starting one. Restarting at 01 would put the new diff on top of
  // the old one — the same directory, the same filename — and the earlier
  // review would silently become a review of the later pass.
  const dir = project('history', {
    passes: [
      { kind: 'vlm-convert', at: new Date().toISOString() },
      { kind: 'simplify', at: new Date().toISOString(), diff: 'stages/02-simplify/diff.json' },
    ],
  });
  const plan = await chain.planProcessingChain({ projectDir: dir, passes: [TRANSLATE] });
  assert.strictEqual(plan.jobs[0].config.stageRelDir, 'stages/03-translate');
});

test('the pass settings travel into the job config verbatim', async () => {
  const dir = project('settings');
  const plan = await chain.planProcessingChain({ projectDir: dir, passes: [TRANSLATE] });
  assert.deepStrictEqual(plan.jobs[0].config.translate, TRANSLATE.translate);
  assert.strictEqual(plan.jobs[0].config.projectDir, dir);
});

// ── refusals ────────────────────────────────────────────────────────────────

test('a project with no book says what makes one', async () => {
  const dir = project('bookless', { book: false, pdf: true });
  const message = await refusal({ projectDir: dir, passes: [SIMPLIFY] });
  assert.match(message, /no book EPUB/i);
  assert.match(message, /Convert to EPUB/,
    'the refusal has to name the thing that makes a book, not just report its absence');
});

test('a run pointed at the PDF version is refused at plan time', async () => {
  const dir = project('pdf-pick', { pdf: true });
  const message = await refusal({ projectDir: dir, variantId: 'v-pdf', passes: [SIMPLIFY] });
  assert.match(message, /A Test Book\.pdf/);
  assert.match(message, /Convert to EPUB/);
});

test('a pass this build no longer has is refused, and named', async () => {
  // A wizard or a queue.json from before Aug 2026. Nothing knows what `reflow`
  // would do now, and the nearest live pass is not the same pass.
  const dir = project('retired');
  for (const kind of ['get-text', 'blocks', 'reflow', 'footnotes', 'detection']) {
    const message = await refusal({ projectDir: dir, passes: [{ kind }] });
    assert.match(message, /is not a pass any more/, `${kind}: ${message}`);
    assert.match(message, /Convert to EPUB/, `${kind}: ${message}`);
  }
});

test('a kind nobody has ever had is refused by its own name', async () => {
  const dir = project('nonsense');
  const message = await refusal({ projectDir: dir, passes: [{ kind: 'sharpen' }] });
  assert.match(message, /There is no "sharpen" pass/);
});

test('a run with no passes is refused', async () => {
  const dir = project('empty');
  assert.match(await refusal({ projectDir: dir, passes: [] }), /at least one pass/);
});

test('a pass with no settings is refused rather than defaulted', async () => {
  const dir = project('bare');
  assert.match(await refusal({ projectDir: dir, passes: [{ kind: 'simplify' }] }),
    /needs a mode and a model/);
  assert.match(await refusal({ projectDir: dir, passes: [{ kind: 'translate' }] }),
    /needs source and target languages/);
});

test('a directory that is not a project is refused', async () => {
  const dir = path.join(SCRATCH, 'not-a-project');
  fs.mkdirSync(dir, { recursive: true });
  assert.match(await refusal({ projectDir: dir, passes: [SIMPLIFY] }), /not a BookForge project/);
});

test('a recorded book that is not on disk is named', async () => {
  const dir = project('missing-file');
  fs.unlinkSync(path.join(dir, 'source', 'A Test Book.epub'));
  assert.match(await refusal({ projectDir: dir, passes: [SIMPLIFY] }), /but that file is not there/);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
  }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`\nprocessing-chain: ${passed} test(s) passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});
