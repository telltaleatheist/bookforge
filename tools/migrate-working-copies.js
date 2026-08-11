/**
 * Unpack every project's working copy into a folder of the book's parts.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 *
 * The working copy stopped being `source/<stem>.working.epub`, a zip, and became
 * `source/<stem>.working/`, the book's entries as real files — so that editing
 * one chapter label writes one 84 KB file rather than re-deflating a 25.7 MB
 * archive and minting a whole new cache identity for it. Every project made
 * before that flip still holds the archive, and the archive holds the user's
 * edits: strikes, folded chapter openings, renamed chapters, applied passes.
 * NONE of it is re-derivable from `archive/`.
 *
 * So this sweep is written to be boring:
 *
 *   1. **A DRY RUN IS THE DEFAULT.** It reports, for every project, which book
 *      it found, how many entries it has, what it would write, and anything it
 *      would refuse. It opens nothing for writing. `--execute` is the only way
 *      to change that.
 *   2. **Verify before removing.** Each project is unpacked, compared to the
 *      archive entry for entry (names AND bytes), its records re-stamped and its
 *      manifest repointed — and only THEN is the archive deleted. A mismatch
 *      leaves BOTH artifacts in place and says which entry disagreed.
 *   3. **One project at a time, and a failure STOPS the sweep.** A systematic
 *      fault costs one book rather than forty-three.
 *   4. **`archive/` is never read and never written.** The only file this
 *      touches is the working copy.
 *   5. **BookForge must not be running.** A migration is a rename under the feet
 *      of anything holding the book open, and on Windows an open handle is also
 *      what makes the rename fail half-way.
 *
 * The work itself is `manifestService.migrateWorkingCopyContainer`, which is
 * where the app's own sequencing lives (it goes through `requireFamily`, so
 * family reconciliation can never be racing it, and it runs the naming migration
 * first). This file is the sweep around it and nothing more — it does no
 * manifest surgery of its own.
 *
 * ── How to run it ───────────────────────────────────────────────────────────
 *
 *   node tools/migrate-working-copies.js --library "E:\Shared\BookForge"
 *   node tools/migrate-working-copies.js --library "E:\Shared\BookForge" --execute
 *
 * Optional: `--only <projectId>` to do one project, `--limit N` to stop after N.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
const MODULE = path.join(DIST, 'manifest-service.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const manifestService = require(MODULE);

// ── Arguments ────────────────────────────────────────────────────────────────

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

const EXECUTE = process.argv.includes('--execute');
const LIBRARY = argValue('--library');
const ONLY = argValue('--only');
const LIMIT = argValue('--limit') === null ? Infinity : Number(argValue('--limit'));

if (LIBRARY === null) {
  console.error(
    'Say which library to sweep: --library "E:\\Shared\\BookForge". There is no default — a '
    + 'migration that guessed which library it was rewriting is not one to run unattended.');
  process.exit(2);
}
if (!fs.existsSync(path.join(LIBRARY, 'projects'))) {
  console.error(`${LIBRARY} has no projects/ folder, so it is not a BookForge library.`);
  process.exit(2);
}

// ── BookForge must not be running ────────────────────────────────────────────
//
// The precedent is scratchpad/clear-and-queue.js, which refuses the same way and
// for the same reason: this moves a project's book while the app may be holding
// it open, and on Windows an open handle is exactly what turns a rename into an
// EPERM half-way through.

function bookforgeRunning() {
  if (process.platform !== 'win32') {
    const out = execSync('ps -A -o comm=', { encoding: 'utf-8' });
    return /(^|\/)BookForge$/m.test(out) || /(^|\/)Electron$/m.test(out);
  }
  const out = execSync('tasklist /FO CSV', { encoding: 'utf-8' });
  return /"BookForge\.exe"/i.test(out) || /"electron\.exe"/i.test(out);
}

if (EXECUTE && bookforgeRunning()) {
  console.error(
    'BookForge is running. Close it and run this again: this moves each project\'s book, and an '
    + 'open window would go on reading the archive that is about to be removed — or hold the handle '
    + 'that makes the move fail part-way. Nothing was done.');
  process.exit(3);
}

// ── The sweep ────────────────────────────────────────────────────────────────

manifestService.setLibraryBasePath(LIBRARY);

const projectsDir = path.join(LIBRARY, 'projects');
const projectIds = fs.readdirSync(projectsDir)
  .filter((name) => fs.existsSync(path.join(projectsDir, name, 'manifest.json')))
  .filter((name) => ONLY === null || name === ONLY)
  .sort();

if (ONLY !== null && projectIds.length === 0) {
  console.error(`${projectsDir} has no project called "${ONLY}".`);
  process.exit(2);
}

const bytes = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

(async () => {
  console.log(
    `${EXECUTE ? 'MIGRATING' : 'DRY RUN — nothing will be written'}: ${projectIds.length} `
    + `project(s) under ${LIBRARY}\n`);

  const counts = {
    'no-chain': 0, 'no-working-copy': 0, 'already-exploded': 0,
    'would-explode': 0, exploded: 0,
  };
  let totalEntries = 0;
  let totalBytes = 0;
  let done = 0;

  for (const projectId of projectIds) {
    if (done >= LIMIT) {
      console.log(`\nStopped at --limit ${LIMIT}.`);
      break;
    }
    const projectDir = path.join(projectsDir, projectId);
    let result;
    try {
      result = await manifestService.migrateWorkingCopyContainer(projectDir, { apply: EXECUTE });
    } catch (err) {
      // ── A failure STOPS the sweep ─────────────────────────────────────────
      //
      // Not "log and continue": every refusal in the migration leaves the
      // project exactly as it found it, so stopping costs one book — and a fault
      // that is systematic (a name too long for this filesystem, a zip this
      // build cannot read) would otherwise be discovered forty-three times.
      console.error(`\nREFUSED  ${projectId}\n  ${err.message}\n`);
      console.error(
        `Stopped. ${done} project(s) were done before this one; nothing was left half-migrated. `
        + 'Fix what the refusal names and run this again — projects already unpacked are skipped.');
      process.exit(1);
    }

    counts[result.outcome] += 1;
    done += 1;
    totalEntries += result.entries;
    totalBytes += result.bytes;

    const line = `${result.outcome.padEnd(16)} ${projectId}`;
    if (result.outcome === 'would-explode' || result.outcome === 'exploded') {
      console.log(
        `${line}\n    ${result.fromRelPath}  ->  ${result.toRelPath}`
        + `\n    ${result.entries} entr(y/ies), ${bytes(result.bytes)}`
        + (result.directoryMarkersDropped.length > 0
          ? `\n    ${result.directoryMarkersDropped.length} folder record(s) not carried across: `
            + result.directoryMarkersDropped.join(', ')
          : '')
        + (result.restamped.length > 0 ? `\n    re-stamped ${result.restamped.join(', ')}` : '')
        + (result.leftStale.length > 0
          ? `\n    left as stale as they already were: ${result.leftStale.join(', ')}`
          : ''));
    } else {
      console.log(line);
    }
  }

  console.log(
    `\n${EXECUTE ? 'Migrated' : 'Would migrate'} ${EXECUTE ? counts.exploded : counts['would-explode']} `
    + `project(s): ${totalEntries} entr(y/ies), ${bytes(totalBytes)}.`);
  console.log(
    `Already unpacked: ${counts['already-exploded']}.  No working copy: ${counts['no-working-copy']}.  `
    + `No chain: ${counts['no-chain']}.`);
  if (!EXECUTE) {
    console.log('\nNothing was written. Re-run with --execute (and BookForge closed) to do it.');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
