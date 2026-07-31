#!/usr/bin/env node
/**
 * export-epub — drive BookForge's OWN PDF→EPUB generator over a project, headlessly.
 *
 *   node cli/export-epub.js --project <projectDir> --out <book.epub>
 *        [--dump <dir>] [--language en] [--quiet]
 *
 * This is a THIN driver, in the same sense as cli/ocr-pdf.js. Everything that
 * decides the shape of the book — the category→markup map, the paragraph rule,
 * chapter planning, footnote placement, the stylesheet, the zip — lives in
 * `src/app/features/pdf-picker/services/export.service.ts` and is CALLED here,
 * never reimplemented. A bug this surfaces is a bug the app has.
 *
 * WHY IT BUNDLES INSTEAD OF IMPORTING. The generator is a renderer service, so
 * unlike the OCR path there is no main-process entry point to invoke. The file
 * is therefore bundled from SOURCE on every run (esbuild, in memory) and the
 * class constructed against a stub `inject`. Bundling per-run is deliberate:
 * a checked-in build artifact would let this pass against yesterday's code.
 *
 * WHAT IT EXERCISES, and what it does not. It runs the real generator over the
 * real blocks a project carries, which is the half that was never covered by
 * anything. It does NOT run the picker's own edit state — text corrections,
 * paragraph breaks placed by hand, deleted highlights and hand-placed chapter
 * markers live in the .bookforge project file rather than the manifest, so a
 * manifest-only run sees none of them and reports that it didn't.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const tilde = (p) => p.replace(/^~(?=\/)/, os.homedir());

if (has('help') || has('h') || argv.length === 0) {
  console.error(
    'usage: node cli/export-epub.js --project <projectDir> --out <book.epub>\n' +
    '         [--dump <dir>]      also write each generated XHTML file for inspection\n' +
    '         [--language <code>] override the book language (dc:language is required)\n' +
    '         [--drop a,b]        delete every block of these categories first,\n' +
    '                             the way the picker\'s category delete does\n' +
    '         [--quiet]           structure summary only, no per-chapter lines');
  process.exit(has('help') || has('h') ? 0 : 1);
}

const projectDir = opt('project', null);
const outPath = opt('out', null);
const dumpDir = opt('dump', null);
const quiet = has('quiet');

if (!projectDir) { console.error('export-epub: --project <projectDir> is required.'); process.exit(1); }
if (!outPath) {
  console.error('export-epub: --out <book.epub> is required. It is deliberately not defaulted to\n' +
    "the project's source/exported.epub — a test run must not overwrite the real artifact.");
  process.exit(1);
}

const projectPath = path.resolve(tilde(projectDir));
const manifestPath = path.join(projectPath, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`export-epub: ${manifestPath} does not exist — not a manifest project.`);
  process.exit(1);
}
const outFile = path.resolve(tilde(outPath));
const sourceEpub = path.join(projectPath, 'source', 'exported.epub');
if (path.resolve(outFile) === path.resolve(sourceEpub)) {
  console.error(`export-epub: refusing to write over ${sourceEpub}, the project's real export.\n` +
    'Pick a scratch path; comparing the two is the point.');
  process.exit(1);
}

// ── build the live service ──────────────────────────────────────────────────
async function loadExportService() {
  let esbuild;
  try { esbuild = require(path.join(REPO_ROOT, 'node_modules', 'esbuild')); }
  catch { console.error('export-epub: esbuild not installed — run npm install.'); process.exit(1); }

  const entry = path.join(REPO_ROOT, 'src/app/features/pdf-picker/services/export.service.ts');
  if (!fs.existsSync(entry)) { console.error(`export-epub: ${entry} not found.`); process.exit(1); }

  const ANGULAR_STUB = path.join(__dirname, 'stubs', 'angular-core.js');
  const SERVICE_STUB = path.join(__dirname, 'stubs', 'empty-services.js');

  // Everything export.service.ts imports is either an Angular decorator, an
  // injection token, or a type. None of it participates in generating a book, and
  // left in the graph it pulls a prebuilt Angular library whose compiled factory
  // calls run at module load and cannot work outside Angular. So the graph is cut
  // to exactly the file under test.
  const prune = {
    name: 'prune-renderer-graph',
    setup(build) {
      build.onResolve({ filter: /^@angular\// }, () => ({ path: ANGULAR_STUB }));
      build.onResolve({ filter: /(electron\.service|pdf\.service|pdf-picker\.component|queue\.types)$/ },
        (args) => (args.importer === entry ? { path: SERVICE_STUB } : undefined));
    },
  };

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    logLevel: 'error',
    plugins: [prune],
  });

  const code = result.outputFiles[0].text;
  const tmp = path.join(os.tmpdir(), `bookforge-export-service-${process.pid}.cjs`);
  fs.writeFileSync(tmp, code);
  try {
    const mod = require(tmp);
    if (!mod.ExportService) throw new Error('bundle exposes no ExportService export');
    return new mod.ExportService();
  } finally {
    fs.unlinkSync(tmp);
  }
}

// ── read the project ────────────────────────────────────────────────────────
// Everything the picker edits round-trips through manifest.json — BFP files are
// gone. `project:save-to-path` in electron/main.ts is the authority for these
// paths, and the load handler around :3325 is its mirror; read both before
// changing anything here.
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const editor = manifest.editor ?? {};
const source = manifest.source ?? {};
const meta = manifest.metadata ?? {};

const ocrBlocks = editor.ocrBlocks ?? [];
const manualBlocks = editor.manualBlocks ?? [];
const blocks = [...ocrBlocks, ...manualBlocks];
if (blocks.length === 0) {
  console.error(
    `export-epub: ${manifestPath} carries no editor.ocrBlocks, so there is nothing to export.\n` +
    'OCR the book first: node --require cli/electron-stub.js cli/ocr-pdf.js <book.pdf> --project ' +
    projectPath);
  process.exit(1);
}

const deletedBlockIds = new Set(source.deletedBlockIds ?? []);
const deletedPages = new Set(source.deletedPages ?? []);
const deletedHighlights = source.deletedHighlightIds ?? [];
const paragraphBreaks = new Set(editor.paragraphBreaks ?? []);
const textCorrections = new Map(Object.entries(editor.textCorrections ?? {}));
const chapters = manifest.chapters ?? [];

const language = opt('language', meta.language || '');
const metadata = {
  title: meta.title ?? '',
  author: meta.author ?? '',
  year: meta.year != null ? String(meta.year) : '',
  language,
};

// Stand in for the picker's "delete every block of this category" action, so the
// export can be tested the way a book is actually prepared. Page furniture is the
// interesting case: header and footer blocks sit between the last line of one page
// and the first of the next, so leaving them in breaks every paragraph that spans
// a page turn — visible as the <p> count in the summary below.
const dropCategories = new Set(
  (opt('drop', '') || '').split(',').map(x => x.trim()).filter(Boolean));
if (dropCategories.size > 0) {
  let dropped = 0;
  for (const b of blocks) {
    if (dropCategories.has(b.category_id) && !deletedBlockIds.has(b.id)) {
      deletedBlockIds.add(b.id);
      dropped++;
    }
  }
  console.log(`[export-epub] dropped ${dropped} block(s) in: ${[...dropCategories].join(', ')}`);
}

(async () => {
const service = await loadExportService();

// `generateEpubBlobInternal` is private in TypeScript only; at runtime it is an
// ordinary method. Reached directly rather than through exportEpubWithChapters
// because that wrapper's job is browser download, which has no meaning here.
const generate = service.generateEpubBlobInternal;
if (typeof generate !== 'function') {
  console.error('export-epub: ExportService has no generateEpubBlobInternal — the generator was ' +
    'renamed or restructured, and this driver needs updating to match.');
  process.exit(1);
}

const result = generate.call(
  service,
  blocks,                    // every block; deletion is the caller's decision
  deletedBlockIds,
  chapters,
  meta.title || path.basename(projectPath),
  textCorrections,
  deletedPages,
  deletedHighlights,
  metadata,
  paragraphBreaks.size > 0 ? paragraphBreaks : undefined,
);

if (!result.success || !result.blob) {
  console.error(`\nexport-epub FAILED: ${result.message ?? 'no message'}`);
  process.exit(1);
}

  const buf = Buffer.from(await result.blob.arrayBuffer());
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, buf);

  // ── report the STRUCTURE, which is the thing under test ──────────────────
  const zipText = buf.toString('latin1');
  const docs = [...zipText.matchAll(/chapter(\d+)\.xhtml/g)].map(m => m[1]);
  const uniqueDocs = new Set(docs).size;

  const counts = {};
  for (const b of blocks) {
    if (deletedBlockIds.has(b.id)) continue;
    counts[b.category_id || '(unlabelled)'] = (counts[b.category_id || '(unlabelled)'] || 0) + 1;
  }

  console.log(`\nexport-epub: wrote ${outFile} (${(buf.length / 1024).toFixed(0)} KB)`);
  console.log(`  blocks in:        ${blocks.length} (${deletedBlockIds.size} deleted)`);
  console.log(`  chapters out:     ${result.chapterCount}`);
  console.log(`  blocks exported:  ${result.blockCount}`);
  console.log(`  xhtml documents:  ${uniqueDocs}`);
  if (result.warning) console.log(`  warning:          ${result.warning}`);
  console.log('\n  blocks by category:');
  for (const [cat, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cat.padEnd(14)} ${n}`);
  }

  console.log('\n  editor state applied:');
  console.log(`    manual blocks     ${manualBlocks.length}`);
  console.log(`    paragraph breaks  ${paragraphBreaks.size}`);
  console.log(`    text corrections  ${textCorrections.size}`);
  console.log(`    chapter markers   ${chapters.length}`);
  console.log(`    deleted pages     ${deletedPages.size}`);
  if (paragraphBreaks.size === 0) {
    console.log('\n  No paragraph breaks recorded, so each uninterrupted prose run should be\n' +
      '  ONE <p> — that is the paragraph rule, and it is what to check in --dump.');
  }

  if (dumpDir) {
    const dir = path.resolve(tilde(dumpDir));
    fs.mkdirSync(dir, { recursive: true });
    // Pull the stored (uncompressed) entries straight out of the zip: the writer
    // stores rather than deflates, so the payloads are readable as-is.
    let written = 0;
    const re = /PK\x03\x04/g;
    let m;
    while ((m = re.exec(zipText))) {
      const off = m.index;
      const nameLen = buf.readUInt16LE(off + 26);
      const extraLen = buf.readUInt16LE(off + 28);
      const size = buf.readUInt32LE(off + 22);
      const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
      const start = off + 30 + nameLen + extraLen;
      if (!/\.(xhtml|css|opf)$/.test(name)) continue;
      const target = path.join(dir, path.basename(name));
      fs.writeFileSync(target, buf.subarray(start, start + size));
      written++;
    }
    console.log(`\n  dumped ${written} document(s) to ${dir}`);
  }
})().catch((err) => {
  console.error('\nexport-epub failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
