/**
 * A module names each server the subjects THAT server can hold.
 *
 * WHY. `crucible/modules.py` used to say a module "is posted to a Mac and a PC
 * alike and must name the same subjects on both". True of everything in the
 * build except the transcribers, where it is permanently false: CTranslate2 has
 * no Metal backend, so `faster-whisper-*` is cuda-linux only and `mlx-whisper-*`
 * is mlx-darwin only. BookForge named the first, and the Mac refused the WHOLE
 * module — `validate_module` behaving exactly as designed on a file that was
 * wrong (measured on Owen's Mac, 2026-09-15):
 *
 *   invalid_module: subjects[0]: this server has no model called
 *   'faster-whisper-large-v3' for mlx-darwin
 */
const assert = require('assert');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist', 'electron');
const { moduleForBackend, BOOKFORGE_MODULE } = require(path.join(DIST, 'crucible', 'module-setup.js'));

let ran = 0, failed = 0;
function check(name, fn) {
  ran += 1;
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const idsOn = (backend) => moduleForBackend(backend).subjects.map((s) => s.id);

check('each backend is offered the transcriber it can actually hold', () => {
  assert.ok(idsOn('cuda-linux').includes('faster-whisper-large-v3'));
  assert.ok(idsOn('mlx-darwin').includes('mlx-whisper-large-v3'));
});

check('and never the other one — this is the refusal that started it', () => {
  assert.ok(!idsOn('mlx-darwin').includes('faster-whisper-large-v3'),
    'the Mac refuses the WHOLE module over this one id');
  assert.ok(!idsOn('cuda-linux').includes('mlx-whisper-large-v3'));
});

check('exactly ONE transcriber reaches either backend', () => {
  for (const backend of ['cuda-linux', 'mlx-darwin']) {
    const whispers = idsOn(backend).filter((id) => id.includes('whisper'));
    assert.strictEqual(whispers.length, 1, `${backend} got ${whispers}`);
  }
});

check('the subjects every backend shares are on both', () => {
  for (const id of ['qwen3-aligner', 'higgs-default', 'base', 'denoise-roformer']) {
    assert.ok(idsOn('cuda-linux').includes(id), `cuda-linux lost ${id}`);
    assert.ok(idsOn('mlx-darwin').includes(id), `mlx-darwin lost ${id}`);
  }
});

check('`backends` NEVER reaches a server — validate_module refuses a stray key', () => {
  for (const backend of ['cuda-linux', 'mlx-darwin']) {
    for (const subject of moduleForBackend(backend).subjects) {
      assert.deepStrictEqual(Object.keys(subject).sort(), ['id', 'kind'],
        `a subject went out as ${JSON.stringify(subject)}`);
    }
  }
});

check('the vendored file still carries the scope the generator derived', () => {
  // If this is empty the file was re-vendored from a generator that stopped
  // emitting it, and every backend would silently get every subject again.
  const scoped = BOOKFORGE_MODULE.subjects.filter((s) => Array.isArray(s.backends));
  assert.ok(scoped.length > 0, 'no subject carries `backends`');
});

check('an unscoped subject is treated as universal, not dropped', () => {
  // An older vendored file has no `backends` at all, and it meant "everywhere".
  // Dropping those would make it unpostable, which is the opposite of the point.
  const before = BOOKFORGE_MODULE.subjects;
  try {
    BOOKFORGE_MODULE.subjects = [{ kind: 'model', id: 'legacy-thing' }];
    assert.deepStrictEqual(idsOn('mlx-darwin'), ['legacy-thing']);
  } finally {
    BOOKFORGE_MODULE.subjects = before;
  }
});

console.log(`\ncrucible module backend: ${ran} check(s), ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
