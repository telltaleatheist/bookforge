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
  if (book !== null) return book.absPath;

  // THE SECOND DOOR THE APP HAS. A book that came out of the hosted Foundry
  // window is not on a working chain: it is recorded as an EPUB VARIANT with
  // Foundry provenance (manifest.variants[].foundrySource / promotedFrom), and
  // the app's Narrate button on that version row narrates exactly that file
  // (electron/main.ts narrationTargetOf, over `exportedEpubs()` =
  // getVariants(...).variants filtered to epub + foundryProvenanceOf). Until
  // 2026-09-06 this resolver asked only the chain door, so a Foundry-exported
  // project was refused as "records no book" while the app narrated it fine —
  // found by the training agent running the SGLang validation runbook. One
  // exported EPUB is the book; several is a choice the app makes on the version
  // row and this door refuses to guess.
  if (typeof service.readProjectManifest !== 'function'
      || typeof service.getVariants !== 'function'
      || typeof service.foundryProvenanceOf !== 'function') {
    throw new Error(
      'compiled manifest-service missing readProjectManifest/getVariants/foundryProvenanceOf — '
      + 'rebuild (npx tsc -p tsconfig.electron.json)');
  }
  const manifest = await service.readProjectManifest(projectDir);
  const exported = service.getVariants(manifest).variants.filter((v) =>
    typeof v.format === 'string' && v.format.toLowerCase() === 'epub'
    && service.foundryProvenanceOf(v) !== undefined
    && typeof v.path === 'string' && v.path.length > 0);
  if (exported.length === 1) return path.join(projectDir, exported[0].path);
  if (exported.length > 1) {
    throw new Error(
      `${path.basename(projectDir)} records ${exported.length} exported EPUBs `
      + `(${exported.map((v) => path.basename(v.path)).join('; ')}). The app's version row `
      + 'decides which one a narration reads; pass --input <that file> here.');
  }
  throw new Error(
    `${path.basename(projectDir)} records no book (no working-chain EPUB and no Foundry-exported `
    + 'EPUB variant). An unrecorded file under source/ is not adopted — export the book in the '
    + 'app first, or pass --input to narrate a file by hand.');
}

module.exports = { resolveInputEpub };
