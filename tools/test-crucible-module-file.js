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
 *  4. **Its CONTENT is the crucible repo's `modules/bookforge.module.json`** —
 *     the `+<hash>` half of the version and every other field — when that
 *     checkout is on this machine. The release half of the version is allowed
 *     to differ and is reported as a note; see below.
 *  5. The comparison in check 4, run against two fixture pairs, so the rule it
 *     applies is itself held to a failing case.
 *
 * ── WHY CHECK 4 IS NOT BYTE FOR BYTE (ruled 2026-09-18) ──────────────────────
 *
 * It was, until the bytes started differing for a reason that is not a defect.
 * `gen-modules.py` stamps `version` as `<crucible version>+<content hash>`
 * (crucible `modules.py`, `version_of`), so cutting Crucible 1.0.2 rewrites the
 * version line of every app's module file while the module itself — the job
 * types, the backends, the subjects, the hash over them — is unchanged. A
 * byte-for-byte keeper therefore went red on every patch release BY
 * CONSTRUCTION, which is a keeper that trains its reader to ignore it, and the
 * one difference it can never distinguish is the one that matters.
 *
 * So the hash is what is compared. It is the generator's own answer to "is this
 * the same module", it is in the file already, and it is the field a hand-edit
 * cannot fake: change any content and the hash the generator writes changes
 * with it. Every other field is compared too, because an equal hash beside a
 * differing field means one of the two copies was edited by hand — exactly the
 * thing this suite exists to catch. Only the release prefix is forgiven, and
 * loudly: it prints what each side stamps.
 *
 * The stamping itself is NOT the bug and is not changed here. A vendored copy
 * that says which Crucible cut generated it is worth having; the defect was a
 * keeper reading that stamp as a content difference.
 *
 * ── THE SKIP, AND WHY IT IS NAMED ─────────────────────────────────────────────
 *
 * Check 4 needs the crucible checkout, which exists on the two machines that
 * build both and on no CI runner. A missing checkout SKIPS THAT CHECK BY NAME
 * and the first three still run: a keeper that silently passed because it could
 * not find the thing it compares against would be a keeper that reports green
 * for the one failure it exists to catch. The path is read from
 * CRUCIBLE_REPO first so a machine that keeps it elsewhere can say so. Check 5
 * needs no checkout and always runs.
 *
 * No network, no GPU, no build — it reads two files.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('util');

const REPO = path.resolve(__dirname, '..');
const VENDORED = path.join(REPO, 'shared', 'crucible', 'bookforge.module.json');

/** The five `SubjectKind` names, PHASE13-OPERATOR.md section 2. */
const SUBJECT_KINDS = new Set(['model', 'voice', 'rvc', 'rvc-base', 'denoise']);

/**
 * `version_of` in crucible's `modules.py`: the release that generated the file,
 * then `+`, then twelve hex of the hash over the module's content. Named once
 * because checks 1 and 4 are the same fact — check 1 says the field has this
 * shape, check 4 reads the two halves apart — and a second copy of the pattern
 * is how they drift.
 */
const MODULE_VERSION = /^([0-9]+\.[0-9]+\.[0-9]+)\+([0-9a-f]{12})$/;

/**
 * The two copies compared as MODULES rather than as bytes.
 *
 * Returns `{ note }` when they are the same module — `note` is null when even
 * the release stamp matches, and a sentence when it does not. Returns
 * `{ why }` when they are different modules, naming what differs. Never both.
 *
 * It takes parsed objects and paths, not file contents, so check 5 can hand it
 * fixtures that were never on disk.
 */
function compareModules(vendored, generated, vendoredWhere, generatedWhere) {
  const versions = [
    [vendoredWhere, vendored.version],
    [generatedWhere, generated.version],
  ].map(([where, version]) => {
    const parts = MODULE_VERSION.exec(version);
    // No fallback: a module file whose version this keeper cannot take apart is
    // a file it cannot compare, and guessing would be the silence check 4 is for.
    assert.ok(
      parts !== null,
      `${where} stamps version "${version}", which is not `
      + '<release>+<12 hex of the content hash>. gen-modules.py writes that shape and nothing '
      + 'else writes this file.',
    );
    return { release: parts[1], hash: parts[2] };
  });
  const [mine, theirs] = versions;

  if (mine.hash !== theirs.hash) {
    return {
      why: `the content hashes differ — ${vendoredWhere} carries ${mine.hash}, `
        + `${generatedWhere} carries ${theirs.hash}. The vendored copy is NEVER edited: a change `
        + 'starts in crucible\'s modules/bookforge.toml, is regenerated with '
        + 'scripts/gen-modules.py, and travels here by copy. Re-copy it.',
    };
  }

  // An equal hash with a differing field means a hand-edit on one side: the
  // generator hashes the content, so the two cannot disagree by accident.
  const withoutVersion = (module_) => {
    const rest = { ...module_ };
    delete rest.version;
    return rest;
  };
  if (!util.isDeepStrictEqual(withoutVersion(vendored), withoutVersion(generated))) {
    return {
      why: `the two carry the same content hash ${mine.hash} and still differ in a field. `
        + 'That is a hand-edit on one side — the generator hashes what it writes — so neither '
        + 'copy can be trusted until crucible regenerates this file and it is re-copied.',
    };
  }

  if (mine.release === theirs.release) return { note: null };
  return {
    note: `crucible cut ${theirs.release}; this copy stamps ${mine.release} — content identical `
      + `(hash ${mine.hash}).`,
  };
}

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
    MODULE_VERSION,
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

// ── 4. Same module as the generator's output ─────────────────────────────────

const source = path.join(crucibleRepo(), 'modules', 'bookforge.module.json');
if (!fs.existsSync(source)) {
  console.log(
    `  SKIP  content against the generator — no crucible checkout at ${source}. `
    + 'Set CRUCIBLE_REPO to where it is. Every shape check above ran, and the comparison\'s own '
    + 'fixtures below run without a checkout; only this one needs the '
    + 'file it compares against, and passing without it would be the silence this suite exists '
    + 'to break.',
  );
} else {
  check('it is the crucible repo\'s generated module, content for content', () => {
    const generated = JSON.parse(fs.readFileSync(source, 'utf-8'));
    const verdict = compareModules(module_, generated, VENDORED, source);
    assert.ok(verdict.why === undefined, `${VENDORED} differs from ${source}: ${verdict.why}`);
    if (verdict.note !== null) console.log(`  NOTE  ${verdict.note}`);
  });
}

// ── 5. The comparison itself, against a pair it must pass and one it must fail ─

check('the comparison forgives a restamp and refuses a different hash', () => {
  // Not the real files: the point is to drive `compareModules` past the case
  // the old byte-for-byte check could not tell apart, and the only way to have
  // BOTH a restamp and a content change on hand is to write them.
  const base = { name: 'probe', job_types: [{ type: 'llm' }], subjects: [] };
  const restamped = compareModules(
    { ...base, version: '1.0.0+a37ab17a8f1e' },
    { ...base, version: '1.0.2+a37ab17a8f1e' },
    '<vendored fixture>',
    '<generated fixture>',
  );
  assert.strictEqual(restamped.why, undefined, 'a release restamp alone is not a difference');
  assert.match(restamped.note, /crucible cut 1\.0\.2; this copy stamps 1\.0\.0/);

  const identical = compareModules(
    { ...base, version: '1.0.2+a37ab17a8f1e' },
    { ...base, version: '1.0.2+a37ab17a8f1e' },
    '<vendored fixture>',
    '<generated fixture>',
  );
  assert.strictEqual(identical.note, null, 'two copies of one cut have nothing to report');

  const rehashed = compareModules(
    { ...base, version: '1.0.2+a37ab17a8f1e' },
    { ...base, job_types: [{ type: 'tts' }], version: '1.0.2+b41cd90ef227' },
    '<vendored fixture>',
    '<generated fixture>',
  );
  assert.match(rehashed.why, /content hashes differ/);
  assert.strictEqual(rehashed.note, undefined);

  // The hand-edit: the hashes agree and a field does not, which the hash alone
  // would wave through.
  const edited = compareModules(
    { ...base, subjects: [{ kind: 'model', id: 'typed-in-by-hand' }], version: '1.0.2+a37ab17a8f1e' },
    { ...base, version: '1.0.2+a37ab17a8f1e' },
    '<vendored fixture>',
    '<generated fixture>',
  );
  assert.match(edited.why, /same content hash .* and still differ in a field/);

  // And a version it cannot take apart is refused rather than guessed at.
  assert.throws(
    () => compareModules({ ...base, version: '1.0.2' }, { ...base, version: '1.0.2+a37ab17a8f1e' },
      '<vendored fixture>', '<generated fixture>'),
    /is not <release>\+<12 hex of the content hash>/,
  );
});

console.log(`\nPASS — ${checks} checks`);
