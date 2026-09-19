/**
 * THE VENDORED MODULE FILE IS A COPY, AND A COPY IS A FACT WITH TWO OWNERS.
 *
 * `app/shared/foundry.module.json` is what Foundry posts to a Crucible to set
 * itself up: the job types this app needs and the subjects it names. It is not
 * written here. The crucible repo GENERATES it — `scripts/gen-modules.py`, from
 * `modules/foundry.toml` and the manifests — for the reason ARCHITECTURE.md R1
 * gives about `foundry-lineup.json`: "what ids exist on a backend" has one
 * owner, and a file typed beside the app would restate the same ids with
 * nothing comparing them. The day a manifest is renamed, the generator is
 * re-run and the vendored copy is not, and the button asks a server for a
 * subject that does not exist.
 *
 * BookForge has had that comparison since `tools/test-crucible-module-file.js`.
 * Foundry vendors the same kind of file and had none, so the only thing holding
 * this copy to its generator was somebody remembering to re-copy it. This is
 * that comparison, in Foundry's own suite. The two keepers cannot share code —
 * they are separate repos, each holding ITS OWN app's copy to the generator —
 * and they apply the same rule, stated here in full rather than referred to.
 *
 * ── WHAT IS COMPARED, AND WHY IT IS NOT THE BYTES (ruled 2026-09-18) ─────────
 *
 * `gen-modules.py` stamps `version` as `<crucible version>+<content hash>`
 * (crucible `modules.py`, `version_of`), so cutting Crucible 1.0.2 rewrites the
 * version line of every app's module file while the module itself — the job
 * types, the backends, the subjects, the hash over them — is unchanged. A
 * byte-for-byte keeper therefore goes red on every patch release BY
 * CONSTRUCTION, which is a keeper that trains its reader to ignore it.
 *
 * So the hash is what is compared: the generator's own answer to "is this the
 * same module", already in the file, and the one field a hand-edit cannot fake.
 * Every other field is compared too, because an equal hash beside a differing
 * field means one of the two copies was edited by hand. Only the release prefix
 * is forgiven, and it is reported rather than swallowed.
 *
 * ── THE SKIP, AND WHY IT IS NAMED ────────────────────────────────────────────
 *
 * The comparison needs the crucible checkout, which exists on the two machines
 * that build both and on no CI runner. A missing checkout SKIPS THAT TEST BY
 * NAME, through bun's own skip so the run reports it as skipped rather than as
 * green. The rule's own tests need no checkout and always run.
 */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP = path.dirname(import.meta.dir);
const REPO = path.dirname(APP);
const VENDORED = path.join(APP, 'shared', 'foundry.module.json');

/**
 * `version_of` in crucible's `modules.py`: the release that generated the file,
 * then `+`, then twelve hex of the hash over the module's content.
 */
const MODULE_VERSION = /^([0-9]+\.[0-9]+\.[0-9]+)\+([0-9a-f]{12})$/;

/**
 * Where the crucible checkout is, in the order a machine may have said so.
 * `CRUCIBLE_REPO` first because an override that is ignored is worse than none.
 */
function crucibleRepo(): string {
  const named = process.env.CRUCIBLE_REPO;
  if (named !== undefined && named.trim() !== '') return named.trim();
  return path.resolve(REPO, '..', 'crucible');
}

type Module = { version: string } & Record<string, unknown>;
/** `note` when the two are the same module, `why` when they are not. Never both. */
type Verdict = { note: string | null; why?: undefined } | { why: string; note?: undefined };

/**
 * The two copies compared as MODULES rather than as bytes. Takes parsed objects
 * and the names to blame, so the rule's own tests can hand it fixtures that
 * were never on disk.
 */
export function compareModules(
  vendored: Module,
  generated: Module,
  vendoredWhere: string,
  generatedWhere: string,
): Verdict {
  const [mine, theirs] = ([[vendoredWhere, vendored.version], [generatedWhere, generated.version]] as const)
    .map(([where, version]) => {
      const parts = MODULE_VERSION.exec(version);
      // No fallback: a module file whose version this keeper cannot take apart
      // is a file it cannot compare, and guessing would be the silence the
      // comparison exists to break.
      if (parts === null) {
        throw new Error(
          `${where} stamps version "${version}", which is not <release>+<12 hex of the content `
          + 'hash>. gen-modules.py writes that shape and nothing else writes this file.',
        );
      }
      return { release: parts[1]!, hash: parts[2]! };
    }) as [{ release: string; hash: string }, { release: string; hash: string }];

  if (mine.hash !== theirs.hash) {
    return {
      why: `the content hashes differ — ${vendoredWhere} carries ${mine.hash}, ${generatedWhere} `
        + `carries ${theirs.hash}. The vendored copy is NEVER edited: a change starts in `
        + "crucible's modules/foundry.toml, is regenerated with scripts/gen-modules.py, and "
        + 'travels here by copy. Re-copy it.',
    };
  }

  // An equal hash with a differing field means a hand-edit on one side: the
  // generator hashes the content, so the two cannot disagree by accident.
  const withoutVersion = (module_: Module) => {
    const { version: _version, ...rest } = module_;
    return rest;
  };
  if (!Bun.deepEquals(withoutVersion(vendored), withoutVersion(generated), true)) {
    return {
      why: `the two carry the same content hash ${mine.hash} and still differ in a field. That is `
        + 'a hand-edit on one side — the generator hashes what it writes — so neither copy can be '
        + 'trusted until crucible regenerates this file and it is re-copied.',
    };
  }

  if (mine.release === theirs.release) return { note: null };
  return {
    note: `crucible cut ${theirs.release}; this copy stamps ${mine.release} — content identical `
      + `(hash ${mine.hash}).`,
  };
}

const SOURCE = path.join(crucibleRepo(), 'modules', 'foundry.module.json');
const HAVE_SOURCE = fs.existsSync(SOURCE);

test('the vendored module parses and carries the generator\'s stamp', () => {
  const module_ = JSON.parse(fs.readFileSync(VENDORED, 'utf8'));
  expect(module_.name).toBe('foundry');
  // The version is DERIVED by the generator, never typed. Checking the shape
  // rather than the value is the point: a hand-bumped semver on a generated
  // file is the number somebody forgets.
  expect(module_.version).toMatch(MODULE_VERSION);
  expect(Array.isArray(module_.job_types) && module_.job_types.length > 0).toBe(true);
  // `subjects` is EMPTY for Foundry and that is the truth about this app, not a
  // gap: Foundry names model CLASSES in `needs` and lets the server pick what
  // serves them, where BookForge pins voices and models by id. Asserting it is
  // an array, not that it has entries, is the difference between the two.
  expect(Array.isArray(module_.subjects)).toBe(true);
  expect(Array.isArray(module_.needs) && module_.needs.length > 0).toBe(true);
});

test.skipIf(!HAVE_SOURCE)(
  `the vendored module is crucible's generated one, content for content (source: ${SOURCE})`,
  () => {
    const vendored = JSON.parse(fs.readFileSync(VENDORED, 'utf8'));
    const generated = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
    const verdict = compareModules(vendored, generated, VENDORED, SOURCE);
    if (verdict.why !== undefined) throw new Error(`${VENDORED} differs from ${SOURCE}: ${verdict.why}`);
    if (verdict.note !== null) console.log(`  NOTE  ${verdict.note}`);
  },
);

// ── The rule itself, against a pair it must pass and pairs it must fail ──────

const BASE = { name: 'probe', job_types: [{ type: 'vlm-pages' }], subjects: [] };

test('a release restamp alone is not a difference, and says so', () => {
  const verdict = compareModules(
    { ...BASE, version: '1.0.0+92b04d4bd398' },
    { ...BASE, version: '1.0.2+92b04d4bd398' },
    '<vendored fixture>',
    '<generated fixture>',
  );
  expect(verdict.why).toBeUndefined();
  expect(verdict.note).toMatch(/crucible cut 1\.0\.2; this copy stamps 1\.0\.0/);
});

test('two copies of one cut have nothing to report', () => {
  const verdict = compareModules(
    { ...BASE, version: '1.0.2+92b04d4bd398' },
    { ...BASE, version: '1.0.2+92b04d4bd398' },
    '<vendored fixture>',
    '<generated fixture>',
  );
  expect(verdict.note).toBeNull();
});

test('a different content hash is the red', () => {
  const verdict = compareModules(
    { ...BASE, version: '1.0.2+92b04d4bd398' },
    { ...BASE, job_types: [{ type: 'llm' }], version: '1.0.2+7c1de044ab90' },
    '<vendored fixture>',
    '<generated fixture>',
  );
  expect(verdict.why).toMatch(/content hashes differ/);
  expect(verdict.note).toBeUndefined();
});

test('an equal hash beside a differing field is a hand-edit, and is the red too', () => {
  const verdict = compareModules(
    { ...BASE, subjects: [{ kind: 'model', id: 'typed-in-by-hand' }], version: '1.0.2+92b04d4bd398' },
    { ...BASE, version: '1.0.2+92b04d4bd398' },
    '<vendored fixture>',
    '<generated fixture>',
  );
  expect(verdict.why).toMatch(/same content hash .* and still differ in a field/);
});

test('a version this keeper cannot take apart is refused, not guessed at', () => {
  expect(() => compareModules(
    { ...BASE, version: '1.0.2' },
    { ...BASE, version: '1.0.2+92b04d4bd398' },
    '<vendored fixture>',
    '<generated fixture>',
  )).toThrow(/is not <release>\+<12 hex of the content hash>/);
});
