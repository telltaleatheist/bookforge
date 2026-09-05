#!/usr/bin/env node
/**
 * Put every project's real files on its versions page.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 *
 * Owen's old library — 385 projects — is being copied wholesale into the new
 * root. The new versions page draws the variants registry, and only 66 of the
 * 378 readable old manifests carry variants at all. The rest have full
 * `archive/`, `source/` and `output/` folders and an empty page.
 *
 * The work itself is `electron/legacy-variant-migration.ts`, which is where the
 * rules live — what counts as a version, what is a working-chain file, what is a
 * sidecar, how a variant is shaped so that a migrated row is indistinguishable
 * from one `addVariant` minted. This file is the sweep around it and the report
 * out of it, and it does no manifest surgery of its own. Read that module's
 * header before running this: it states every rule this obeys, and every one it
 * refuses to guess at.
 *
 * The design is tools/migrate-working-copies.js's, deliberately:
 *
 *   1. **A DRY RUN IS THE DEFAULT.** It reports, for every project, what it
 *      would register, what it stepped over and why, what clutter it found and
 *      which absolute paths are left over from the old library root. It opens
 *      nothing for writing. `--apply` is the only way to change that. THE REPORT
 *      IS THE DELIVERABLE — it is meant to be read before anything is written.
 *   2. **It only ever APPENDS records.** No file is moved, copied, renamed or
 *      deleted, here or in the module. The clutter it lists is listed, never
 *      cleared.
 *   3. **A refusal costs one project, not the sweep.** Unlike the working-copy
 *      migration, which stops at the first problem because it moves a book's
 *      only copy, this one carries on: the point is a complete picture of 385
 *      projects in a single pass.
 *   4. **Idempotent.** A project that is already correct is not written at all,
 *      so a second `--apply` changes nothing — no re-minted rows, no churned
 *      `modifiedAt`.
 *   5. **BookForge must not be running.** `--apply` writes manifests, and an
 *      open window holds its own copy of one.
 *
 * ── How to run it ───────────────────────────────────────────────────────────
 *
 *   node tools/migrate-legacy-variants.js "E:\Bookforge"
 *   node tools/migrate-legacy-variants.js "E:\Bookforge" --apply
 *
 * Optional: `--only <projectId>` for one project, `--verbose` to print the clean
 * projects too (by default they are counted and not listed), `--old-root <path>`
 * to name a different old library.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const MIGRATION = path.join(REPO, 'dist', 'electron', 'legacy-variant-migration.js');
if (!fs.existsSync(MIGRATION)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}
// The migration imports `sha256File` from library-actions — the very function
// that produced every `sourceFileHash` already in these manifests — and
// library-actions pulls in metadata-tools, which reaches the component catalog,
// which `require('electron')` at load time. The CLI solved this once: its stub
// intercepts that require and throws loudly on any surface it has not
// deliberately stubbed. Loaded FIRST, before anything reaches for it — the same
// arrangement cli/library.js and tools/test-foundry-landing.js run under.
if (!process.env.BOOKFORGE_USERDATA_DIR) {
  process.env.BOOKFORGE_USERDATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-legacy-ud-'));
}
require(path.join(REPO, 'cli', 'electron-stub.js'));
const migration = require(MIGRATION);

// ── Arguments ────────────────────────────────────────────────────────────────

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const ONLY = argValue('--only');

/**
 * The library being swept is the FIRST bare argument — no default, for the
 * reason tools/migrate-working-copies.js gives: a migration that guessed which
 * library it was rewriting is not one to run unattended.
 */
const LIBRARY = process.argv.slice(2).find((a, i, all) =>
  !a.startsWith('--') && (i === 0 || !['--only', '--old-root'].includes(all[i - 1])));

/**
 * The library these projects CAME FROM. Not a fallback: it is the one fact this
 * one-shot migration is about, and a stale `E:\Shared\BookForge\…` inside a
 * manifest means the same thing whichever new root it is being read from. It is
 * a flag so that a second old library (a restored backup, a test fixture) can be
 * named without editing the file.
 */
const OLD_ROOT = argValue('--old-root') ?? 'E:\\Shared\\BookForge';

if (!LIBRARY) {
  console.error(
    'Say which library to sweep:\n'
    + '  node tools/migrate-legacy-variants.js "E:\\Bookforge"          (dry run — writes nothing)\n'
    + '  node tools/migrate-legacy-variants.js "E:\\Bookforge" --apply  (registers what it found)');
  process.exitCode = 2;
  return;
}
if (!fs.existsSync(path.join(LIBRARY, 'projects'))) {
  console.error(`${LIBRARY} has no projects/ folder, so it is not a BookForge library.`);
  process.exitCode = 2;
  return;
}

// ── BookForge must not be running ────────────────────────────────────────────
//
// The same refusal tools/migrate-working-copies.js makes, for the narrower
// reason that applies here: `--apply` rewrites manifests, and an open window is
// holding its own copy of one — it would write that copy back over this one's
// work the next time the user touched anything.

function bookforgeRunning() {
  if (process.platform !== 'win32') {
    const out = execSync('ps -A -o comm=', { encoding: 'utf-8' });
    return /(^|\/)BookForge$/m.test(out) || /(^|\/)Electron$/m.test(out);
  }
  const out = execSync('tasklist /FO CSV', { encoding: 'utf-8' });
  return /"BookForge\.exe"/i.test(out) || /"electron\.exe"/i.test(out);
}

if (APPLY && bookforgeRunning()) {
  console.error(
    'BookForge is running. Close it and run this again: this rewrites project manifests, and an '
    + 'open window holding its own copy of one would put that copy back over this. Nothing was done.');
  process.exitCode = 3;
  return;
}

// ── Printing ─────────────────────────────────────────────────────────────────

const SKIP_WORDING = {
  'already-a-version': 'already a version',
  'same-bytes': 'same bytes as',
  'chain-artifact': 'working-chain file',
  sidecar: 'sidecar of',
  backup: 'backup copy',
  'not-a-book': 'not a book or a narration',
  'os-metadata': 'macOS metadata junk',
  folder: 'a folder, not looked into',
};

/** One project, in the order a person reads it: what changes, then what did not,
 *  then what somebody has to decide. */
function printProject(r) {
  if (r.outcome === 'unreadable') {
    console.log(`REFUSED   ${r.projectId}\n    ${r.refusal}`);
    for (const c of r.clutter) console.log(`    clutter   ${c}`);
    console.log('');
    return;
  }
  if (r.outcome === 'clean' && !VERBOSE) return;

  console.log(`${r.outcome.toUpperCase().padEnd(9)} ${r.projectId}`);
  for (const m of r.minted) {
    const label = APPLY ? 'registered' : 'would add ';
    console.log(`    ${label} ${m.kind}/${m.format}  ${m.relPath}`
      + (m.sidecars.length > 0
        ? `\n                 + ${m.sidecars.length} sidecar(s): ${m.sidecars.map((s) => path.basename(s)).join(', ')}`
        : ''));
  }
  if (r.primarySeeded !== null) {
    console.log(`    primary    seeded ${r.primarySeeded} (it had none)`);
  } else if (r.minted.length > 0 && APPLY) {
    console.log('    primary    left as it was');
  }
  for (const a of r.absolutes) {
    const verdict = a.fixed ? 'REPOINTED'
      : a.wouldBecome !== null && a.targetExists ? 'would repoint to'
        : a.underOldRoot ? 'REPORT ONLY — the file is not at the equivalent place here'
          : 'REPORT ONLY — not under the old library root';
    console.log(`    absolute   ${a.field} = ${a.value}`
      + `\n                 ${verdict}${a.wouldBecome !== null && (a.fixed || a.targetExists) ? ` ${a.wouldBecome}` : ''}`);
  }
  for (const s of r.skipped) {
    // The uninteresting skips are counted, not listed: every project has a
    // sidecar and a folder, and a line each would bury the four that matter.
    if (!VERBOSE && (s.reason === 'sidecar' || s.reason === 'folder' || s.reason === 'already-a-version')) continue;
    console.log(`    skipped    ${s.relPath}  — ${SKIP_WORDING[s.reason]}${s.detail ? ` ${s.detail}` : ''}`);
  }
  for (const c of r.clutter) console.log(`    clutter    ${c}`);
  for (const n of r.notes) console.log(`    note       ${n}`);
  console.log('');
}

// ── The sweep ────────────────────────────────────────────────────────────────

(async () => {
  console.log(
    `${APPLY ? 'APPLYING' : 'DRY RUN — nothing will be written'}\n`
    + `  library:  ${LIBRARY}\n`
    + `  old root: ${OLD_ROOT}  (absolute paths under it are reported; only the ones whose file `
    + 'is provably here are repointed)\n');

  // `only` NARROWS THE SWEEP, it does not filter the printing. Under `--apply`
  // those are different acts: a run that wrote 385 manifests while showing one
  // is the opposite of what asking for one project means.
  const { totals, reports } = await migration.sweepLegacyVariants(LIBRARY, {
    apply: APPLY,
    oldLibraryRoot: OLD_ROOT,
    ...(ONLY === null ? {} : { only: ONLY }),
    onProject: printProject,
  });

  if (ONLY !== null && reports.length === 0) {
    console.error(`${LIBRARY} has no project called "${ONLY}".`);
    process.exitCode = 2;
    return;
  }

  const clutter = reports.reduce((n, r) => n + r.clutter.length, 0);
  const absolutes = reports.reduce((n, r) => n + r.absolutes.length, 0);
  const repointed = reports.reduce((n, r) => n + r.absolutes.filter((a) => a.fixed).length, 0);
  const repointable = reports.reduce(
    (n, r) => n + r.absolutes.filter((a) => !a.fixed && a.wouldBecome !== null && a.targetExists).length, 0);

  console.log('─'.repeat(78));
  console.log(
    `projects visited ${totals.visited}   clean ${totals.clean}   `
    + `${APPLY ? 'migrated' : 'to migrate'} ${totals.migrated}   `
    + `reported-only ${totals.reportedOnly}   unreadable ${totals.unreadable}`);
  console.log(
    `versions ${APPLY ? 'registered' : 'to register'}: ${totals.variants}`);
  console.log(
    `absolute paths found: ${absolutes}  `
    + `(${APPLY ? `${repointed} repointed` : `${repointable} would be repointed`}, `
    + `${absolutes - (APPLY ? repointed : repointable)} report-only)`);
  console.log(`clutter files listed: ${clutter}  (none were deleted — that is a person's call)`);
  if (!APPLY) {
    console.log('\nNothing was written. Re-run with --apply (and BookForge closed) to register it.');
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
