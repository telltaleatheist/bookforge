#!/usr/bin/env node
/**
 * THE VENDORED MODULE FILE IS A COPY, AND A COPY IS A FACT WITH TWO OWNERS.
 *
 *   node tools/test-crucible-module-file.js
 *
 * `shared/crucible/bookforge.module.json` is what the **Set up for BookForge**
 * button posts to a Crucible (PHASE13-OPERATOR.md §5.4): the job types this app
 * needs and the subjects it names. It is not written here. The crucible repo
 * GENERATES it — `scripts/gen-modules.py`, from `modules/bookforge.toml` and the
 * manifests — for the reason ARCHITECTURE.md R1 gives about `foundry-lineup.json`:
 * "what ids exist on a backend" has one owner, and a file typed beside the app
 * would restate the same ids with nothing comparing them. The day a manifest is
 * renamed, the generator is re-run and the vendored copy is not, and the button
 * asks a server for a subject that does not exist.
 *
 * So the copy is checked against its source, and this suite is the thing
 * comparing them.
 *
 * ── WHAT IT CHECKS ────────────────────────────────────────────────────────────
 *
 *  1. The vendored file exists and parses, and its shape is the SDK's
 *     `CrucibleModule` — `name`, `version`, `job_types`, `subjects`, with the
 *     server's own snake_case spelling (`narrator_engine`), because posting the
 *     module means posting exactly those bytes.
 *  2. Its ids are non-empty and its kinds are the five `SubjectKind` names.
 *  3. Every `tts` entry names a narrator engine and nothing else does — the
 *     server refuses both the other way round (`narrator_engine_required`,
 *     `narrator_engine_refused`), and a module is validated WHOLE, so one wrong
 *     entry fails the lot after the operator has watched a progress bar.
 *  4. **It is byte for byte the crucible repo's `modules/bookforge.module.json`**,
 *     when that checkout is on this machine.
 *
 * ── THE SKIP, AND WHY IT IS NAMED ─────────────────────────────────────────────
 *
 * Check 4 needs the crucible checkout, which exists on the two machines that
 * build both and on no CI runner. A missing checkout SKIPS THAT CHECK BY NAME
 * and the first three still run: a keeper that silently passed because it could
 * not find the thing it compares against would be a keeper that reports green
 * for the one failure it exists to catch. The path is read from
 * CRUCIBLE_REPO first so a machine that keeps it elsewhere can say so.
 *
 * No network, no GPU, no build — it reads two files.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VENDORED = path.join(REPO, 'shared', 'crucible', 'bookforge.module.json');

/** The five `SubjectKind` names, PHASE13-OPERATOR.md section 2. */
const SUBJECT_KINDS = new Set(['model', 'voice', 'rvc', 'rvc-base', 'denoise']);

/**
 * Where the crucible checkout is, in the order a machine may have said so.
 * `CRUCIBLE_REPO` first because an override that is ignored is worse than none.
 */
function crucibleRepo() {
  const named = process.env.CRUCIBLE_REPO;
  if (named !== undefined && named.trim() !== '') return named.trim();
  return path.resolve(REPO, '..', 'crucible');
}

let checks = 0;
function check(what, fn) {
  fn();
  checks += 1;
  console.log(`  ok  ${what}`);
}

console.log('module file — the vendored copy against its generator');

// ── 1. It exists, parses, and is the SDK's CrucibleModule shape ──────────────

assert.ok(
  fs.existsSync(VENDORED),
  `${VENDORED} does not exist. It is the ONLY place BookForge states what it needs from a `
  + 'Crucible (PHASE13-OPERATOR.md section 5.4) and it replaced BOOKFORGE_JOB_TYPES and the '
  + 'printed pull list in electron/crucible/install.ts. Copy it from the crucible repo\'s '
  + 'modules/bookforge.module.json — never write one by hand.',
);

const raw = fs.readFileSync(VENDORED);
let module_;
check('the vendored module is JSON', () => {
  module_ = JSON.parse(raw.toString('utf-8'));
  assert.ok(module_ !== null && typeof module_ === 'object' && !Array.isArray(module_));
});

check('it carries name, version, job_types and subjects', () => {
  assert.strictEqual(typeof module_.name, 'string');
  assert.ok(module_.name.length > 0);
  assert.strictEqual(module_.name, 'bookforge', 'the module BookForge posts names bookforge');
  // The version is DERIVED by the generator (<crucible version>+<12 hex>), never
  // typed. Checking the shape rather than the value is the point: a hand-bumped
  // semver on a generated file is the number somebody forgets.
  assert.strictEqual(typeof module_.version, 'string');
  assert.match(
    module_.version,
    /^[0-9]+\.[0-9]+\.[0-9]+\+[0-9a-f]{12}$/,
    'version is <crucible version>+<12 hex of the content hash>, derived by gen-modules.py',
  );
  assert.ok(Array.isArray(module_.job_types) && module_.job_types.length > 0);
  assert.ok(Array.isArray(module_.subjects) && module_.subjects.length > 0);
});

check('the keys are the SERVER\'s spelling, not camelCase', () => {
  // Posting the module means posting exactly these bytes, so a camelCased
  // mirror would make every app transform a file whose whole point is that it
  // is not edited (the SDK's CrucibleModule says so in as many words).
  const text = raw.toString('utf-8');
  assert.ok(!text.includes('jobTypes'), 'job_types, not jobTypes');
  assert.ok(!text.includes('narratorEngine'), 'narrator_engine, not narratorEngine');
});

// ── 2 and 3. Every entry is one the server can read ──────────────────────────

check('every job type names a type, and only tts names a narrator engine', () => {
  for (const entry of module_.job_types) {
    assert.strictEqual(typeof entry.type, 'string', `a job_types entry with no type: ${JSON.stringify(entry)}`);
    assert.ok(entry.type.length > 0);
    if (entry.type === 'tts') {
      assert.strictEqual(
        typeof entry.narrator_engine, 'string',
        'crucible refuses `install tts` without one (narrator_engine_required): cuda-linux has '
        + 'one venv per narrator engine.',
      );
      assert.ok(entry.narrator_engine.length > 0);
    } else {
      assert.strictEqual(
        entry.narrator_engine, undefined,
        `${entry.type} carries a narrator_engine, which the server refuses by name `
        + '(narrator_engine_refused).',
      );
    }
  }
});

check('every subject is one of the five kinds, with a non-empty id', () => {
  for (const subject of module_.subjects) {
    assert.ok(
      SUBJECT_KINDS.has(subject.kind),
      `"${subject.kind}" is not one of ${[...SUBJECT_KINDS].join(', ')}`,
    );
    assert.strictEqual(typeof subject.id, 'string');
    assert.ok(subject.id.length > 0);
  }
});

check('no subject is named twice', () => {
  const seen = new Set();
  for (const subject of module_.subjects) {
    const key = `${subject.kind}/${subject.id}`;
    assert.ok(!seen.has(key), `${key} appears twice; a module is validated whole`);
    seen.add(key);
  }
});

// ── 4. Byte for byte against the generator's output ──────────────────────────

const source = path.join(crucibleRepo(), 'modules', 'bookforge.module.json');
if (!fs.existsSync(source)) {
  console.log(
    `  SKIP  byte-for-byte against the generator — no crucible checkout at ${source}. `
    + 'Set CRUCIBLE_REPO to where it is. The first four checks ran; this one needs the '
    + 'file it compares against, and passing without it would be the silence this suite exists '
    + 'to break.',
  );
} else {
  check('it is byte for byte the crucible repo\'s generated module', () => {
    const generated = fs.readFileSync(source);
    assert.ok(
      raw.equals(generated),
      `${VENDORED} differs from ${source}.\n`
      + 'The vendored copy is NEVER edited: a change starts in crucible\'s modules/bookforge.toml, '
      + 'is regenerated with scripts/gen-modules.py, and travels here by copy. If the two differ '
      + 'now, re-copy — and if the working tree shows a CRLF difference, .gitattributes pins this '
      + 'file `-text` for exactly that reason.',
    );
  });
}

console.log(`\nPASS — ${checks} checks`);
