/**
 * resolve-project-epub.js — which book of a project a headless narration reads.
 *
 * THE RECORD IS THE ONLY ANSWER. `manifest-service.bookForAct` is the door
 * every act in the app resolves its book through (narration-export, chapters,
 * headings, categories, the ledger): the recorded working copy of the
 * project's chain, with the legacy `outputs.epub` adoption run first, and a
 * refusal when the project has more than one chain and none was named. A
 * project whose manifest records no book HAS no book — a `source/exported.epub`
 * or `source/original.epub` sitting unrecorded is a stray this does not see,
 * does not adopt, and does not complain about (manifest-service
 * `readExportEpub`, and the rule it cites).
 *
 * This file used to be a FILENAME LADDER (translated → simplified → cleaned →
 * exported → original), lifted out of orpheus-audiobook-render.js, which
 * re-created exactly the automatic adoption that rule removed: the Mac's first
 * live `--prep --project` (orpheus-mlx-mac, 2026-09-03) narrated an unrecorded
 * `source/exported.epub` on a project whose manifest said it had no book, and
 * the app itself would have refused. Owen's ruling for the CLI is that it runs
 * the code the app runs, so this now asks the app's door and nothing else.
 *
 * `manifestService` is injectable so a test can prove the two outcomes — a
 * recorded book comes back, no record refuses — without fabricating a manifest
 * the app would have to be able to read. Production omits it and gets the
 * compiled service.
 */
'use strict';
const path = require('path');

/**
 * @param {string} projectDir  `{library}/projects/{slug}`
 * @param {{ setLibraryBasePath(root: string): void,
 *           bookForAct(projectDir: string): Promise<{absPath: string} | null> }} [manifestService]
 * @returns {Promise<string>} the absolute path of the project's recorded book
 * @throws when the project records no book, or the app's door refuses
 */
async function resolveInputEpub(projectDir, manifestService) {
  const service = manifestService ?? require('../dist/electron/manifest-service.js');
  if (typeof service.bookForAct !== 'function' || typeof service.setLibraryBasePath !== 'function') {
    throw new Error(
      'compiled manifest-service missing bookForAct/setLibraryBasePath — rebuild '
      + '(npx tsc -p tsconfig.electron.json)');
  }
  // The library root is two levels up ({library}/projects/{slug}); an act
  // checks that the project is owned by the configured library before it
  // records anything, so this is stated before the door is opened — exactly as
  // orpheus-audiobook-render.js has always done for reassembly.
  service.setLibraryBasePath(path.dirname(path.dirname(projectDir)));
  const book = await service.bookForAct(projectDir);
  if (book === null) {
    throw new Error(
      `${path.basename(projectDir)} records no book (manifest outputs/families carry no EPUB). `
      + 'An unrecorded file under source/ is not adopted — export the book in the app first, '
      + 'or pass --input to narrate a file by hand.');
  }
  return book.absPath;
}

module.exports = { resolveInputEpub };
