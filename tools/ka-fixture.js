'use strict';
/**
 * ka-fixture.js — WHERE THE KILLING AMERICA EPUB IS ON THIS MACHINE.
 *
 * `test-quire.js` paginates a real book, and the book it paginates is not in
 * the repository: it is a regression fixture naming three specific plates, so
 * no other book will do. The suite therefore has to be TOLD where it is, and
 * until 2026-09-18 the only way to tell it was `BOOKFORGE_KA_EPUB` — which
 * nothing sets. The result was a guard that skipped by name on the one machine
 * that owns the book, every run, for as long as it had been listed: the R2
 * shape (crucible/docs/ARCHITECTURE.md), one step short of not being listed at
 * all.
 *
 * SO THE PATH IS DERIVED RATHER THAN DECLARED. The app already records where
 * the library is (`<userData>/library-root.json`, written by
 * electron/main.ts), and it already owns the layout underneath it —
 * `getProjectPath()` knows about `projects/` and `getAbsolutePath()` knows
 * about `archive/`. Both are asked here rather than re-spelled, because a
 * second copy of a layout is the defect this repository keeps finding
 * (ARCHITECTURE.md R1): the day the archive folder is renamed, a keeper that
 * spelled it itself skips by name and looks like it is behaving.
 *
 * WHAT IS DECLARED IS THE BOOK'S IDENTITY, and only that — the project id and
 * the filename. Nothing in the app knows which book a keeper wants, so there
 * is nobody to import it from.
 *
 * `BOOKFORGE_KA_EPUB` STAYS, as an override: it is how a machine whose copy
 * lives somewhere else, or a bisect against a second copy, points the suite at
 * one. It is only ever READ.
 *
 * NO FALLBACK ANYWHERE IN HERE. Every way this can fail to find the book
 * returns the reason it failed, by name, for the caller to SKIP on — it never
 * guesses a second location and never returns a path it has not seen.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

/**
 * THE FIXTURE'S IDENTITY. Not path components — the name of one book, which is
 * the only part of the address the app cannot answer for.
 */
const KA_PROJECT_ID =
  'Killing_America_-_Turning_the_Tide_on_the_Tsunami_of_Darkness_-_Gene_Bailey_(2024)';
const KA_FILENAME = 'Killing America. Bailey, Gene.epub';

/**
 * The userData folder the APP would read, asked of the same `app.getPath`
 * every compiled module asks. Under bare node that is `cli/electron-stub.js`'s
 * shim (which honours `BOOKFORGE_USER_DATA`, so a keeper can drive this over
 * records of its own); under Electron it is the real thing. Loading the shim
 * under Electron would replace the runtime `electron` module for the whole
 * process, which is why it is conditional and why that is not a fallback: the
 * two branches are two different runtimes answering one question.
 */
function userDataDir() {
  if (!process.versions.electron) require(path.join(REPO, 'cli', 'electron-stub.js'));
  const { app } = require('electron');
  return app.getPath('userData');
}

/**
 * The library root this machine has RECORDED, or the reason there is none.
 * Same file and same key as `cli/library.js::resolveLibraryRoot`.
 */
function recordedLibraryRoot() {
  const configPath = path.join(userDataDir(), 'library-root.json');
  if (!fs.existsSync(configPath)) {
    return { root: null, why: `${configPath} does not exist, so this machine has no recorded library` };
  }
  // A corrupt record THROWS rather than reading as "no library": a keeper
  // skipping because a JSON file lost a brace is a keeper hiding a broken
  // install.
  const { libraryRoot } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!libraryRoot) return { root: null, why: `${configPath} has no "libraryRoot" key` };
  return { root: libraryRoot, why: null };
}

/**
 * The address of the fixture inside a library, composed BY THE APP'S OWN
 * RESOLVER. `getAbsolutePath` is what turns an `__archive__/…` catalog address
 * into a path, and it is the owner of both `projects/` and `archive/`.
 *
 * Exported separately from the lookup so the keeper can drive the derivation
 * against a fake library root without a book on disk.
 */
function epubPathIn(libraryRoot) {
  const manifestService = require(path.join(DIST, 'manifest-service.js'));
  const { getAbsolutePath } = require(path.join(DIST, 'ebook-library.js'));
  manifestService.setLibraryBasePath(libraryRoot);
  return getAbsolutePath(`__archive__/${KA_PROJECT_ID}/${KA_FILENAME}`);
}

/**
 * The book, or the reason there is not one. `{ book }` on success;
 * `{ reason }` otherwise, worded for a SKIP line.
 */
function killingAmericaEpub() {
  const override = (process.env.BOOKFORGE_KA_EPUB || '').trim();
  if (override) {
    if (fs.existsSync(override)) return { book: override, from: 'BOOKFORGE_KA_EPUB' };
    return {
      reason: `BOOKFORGE_KA_EPUB names a file that is not there (${override}). The variable is an `
        + 'override and is taken at its word — unset it to use this machine\'s recorded library.',
    };
  }

  const { root, why } = recordedLibraryRoot();
  if (root === null) {
    return {
      reason: `${why} — this suite needs the Killing America EPUB, which lives on the shared `
        + `library at <library>/projects/${KA_PROJECT_ID}/archive/${KA_FILENAME} (Windows `
        + 'Z:\\<library>\\…, Mac /Volumes/<share>/bookforge/…). Point BOOKFORGE_KA_EPUB at it, or set '
        + 'the library root in the app.',
    };
  }

  const at = epubPathIn(root);
  if (!fs.existsSync(at)) {
    return {
      reason: `the recorded library (${root}) does not hold the Killing America EPUB — nothing at `
        + `${at}. This suite is a regression test naming three specific plates, so no other book `
        + 'will do; point BOOKFORGE_KA_EPUB at a copy if you have one elsewhere.',
    };
  }
  return { book: at, from: `${path.join(userDataDir(), 'library-root.json')} → ${root}` };
}

module.exports = { KA_PROJECT_ID, KA_FILENAME, recordedLibraryRoot, epubPathIn, killingAmericaEpub };
