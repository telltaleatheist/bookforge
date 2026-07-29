/**
 * EPUB alignment sweep — prove alignBlocksToEpub() against the real library.
 *
 * For every project whose source is an EPUB with an archived original, this
 * analyzes the archive through the SAME analyzer path the app uses
 * (PDFAnalyzer.analyze → mupdf layout 600x900/18 → extractPageBlocks), maps
 * the blocks to EpubExportBlock, and runs the sequential alignment. It then
 * reports aligned percentages, unaligned excerpts, uncovered units and
 * collector throws, per book and in total.
 *
 * Usage:
 *   node electron/scripts/epub-align-sweep.mjs <projects-root> <json-report-path>
 *
 * Run `npx tsc -p tsconfig.electron.json` first — this imports compiled
 * output from dist/electron/. Outside Electron the managed-bins module needs
 * the app's userData dir: set BOOKFORGE_USERDATA_DIR (e.g. %APPDATA%\BookForge).
 */

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distElectron = path.join(repoRoot, 'dist', 'electron');

for (const mod of ['pdf-analyzer.js', 'epub-processor.js']) {
  if (!fs.existsSync(path.join(distElectron, mod))) {
    console.error(`Missing ${path.join(distElectron, mod)} — run: npx tsc -p tsconfig.electron.json`);
    process.exit(1);
  }
}

const { PDFAnalyzer } = require(path.join(distElectron, 'pdf-analyzer.js'));
const { alignBlocksToEpub } = require(path.join(distElectron, 'epub-processor.js'));

const projectsRoot = process.argv[2];
const jsonOutPath = process.argv[3];
if (!projectsRoot || !jsonOutPath) {
  console.error('Usage: node electron/scripts/epub-align-sweep.mjs <projects-root> <json-report-path>');
  process.exit(1);
}
if (!fs.existsSync(projectsRoot)) {
  console.error(`Projects root does not exist: ${projectsRoot}`);
  process.exit(1);
}

/** Find EPUB projects: manifest.json with source.type === 'epub' and an archived original EPUB. */
function enumerateEpubProjects(root) {
  const projects = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(root, entry.name);
    const manifestPath = path.join(projectDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      projects.push({ name: entry.name, error: `manifest.json unreadable: ${err.message}` });
      continue;
    }
    if (manifest.source?.type !== 'epub') continue;
    const original = (manifest.archive || []).find((a) => a.role === 'original' && a.format === 'epub');
    if (!original) {
      projects.push({ name: entry.name, error: 'source.type is epub but no archive entry with role:original format:epub' });
      continue;
    }
    const epubPath = path.join(projectDir, ...original.path.split('/'));
    if (!fs.existsSync(epubPath)) {
      projects.push({ name: entry.name, error: `archived original missing on disk: ${original.path}` });
      continue;
    }
    projects.push({ name: entry.name, epubPath });
  }
  return projects;
}

function toExportBlocks(analyzerBlocks) {
  return analyzerBlocks.map((b) => ({
    id: b.id,
    page: b.page,
    y: b.y,
    text: b.text,
    deleted: false,
    isImage: b.is_image,
    isFootnoteMarker: b.is_footnote_marker,
    ...(b.parent_block_id ? { parentBlockId: b.parent_block_id } : {}),
  }));
}

async function main() {
  const projects = enumerateEpubProjects(projectsRoot);
  const analyzable = projects.filter((p) => p.epubPath);
  console.log(`Found ${projects.length} EPUB project(s) (${analyzable.length} analyzable) under ${projectsRoot}\n`);

  const analyzer = new PDFAnalyzer();
  const results = [];
  const totals = {
    books: 0, failedBooks: 0,
    blocks: 0, alignable: 0, aligned: 0, unaligned: 0,
    uncoveredUnits: 0, uncoveredUnitChars: 0, catchAllUnits: 0,
  };

  let bookIdx = 0;
  for (const project of projects) {
    bookIdx++;
    const label = `[${bookIdx}/${projects.length}] ${project.name}`;
    if (project.error) {
      console.log(`${label}\n  SKIPPED (project problem): ${project.error}\n`);
      results.push({ project: project.name, status: 'skipped', error: project.error });
      totals.failedBooks++;
      continue;
    }

    let analysis;
    try {
      analysis = await analyzer.analyze(project.epubPath);
    } catch (err) {
      console.log(`${label}\n  ANALYZER FAILED: ${err.message}\n`);
      results.push({ project: project.name, status: 'analyzer-failed', error: err.message });
      totals.failedBooks++;
      continue;
    }

    const blocks = toExportBlocks(analysis.blocks);
    let alignment;
    try {
      alignment = await alignBlocksToEpub(project.epubPath, blocks);
    } catch (err) {
      console.log(`${label}\n  COLLECTOR/ALIGNMENT THREW: ${err.message}\n`);
      results.push({ project: project.name, status: 'collector-threw', blockCount: blocks.length, error: err.message });
      totals.failedBooks++;
      continue;
    }

    const aligned = alignment.blockToUnits.size;
    const unaligned = alignment.unaligned.length;
    const alignable = aligned + unaligned; // skipped image/marker/empty blocks are not alignable
    const pct = alignable > 0 ? (100 * aligned) / alignable : 100;
    const uncoveredChars = alignment.uncoveredUnits
      .reduce((sum, i) => sum + alignment.units[i].normText.length, 0);
    const catchAllUnits = alignment.units.filter((u) => u.fromCatchAll).length;

    totals.books++;
    totals.blocks += blocks.length;
    totals.alignable += alignable;
    totals.aligned += aligned;
    totals.unaligned += unaligned;
    totals.uncoveredUnits += alignment.uncoveredUnits.length;
    totals.uncoveredUnitChars += uncoveredChars;
    totals.catchAllUnits += catchAllUnits;

    const unalignedSamples = alignment.unaligned.slice(0, 5).map((ua) => ({
      page: ua.page,
      reason: ua.reason,
      excerpt: ua.excerpt,
    }));

    results.push({
      project: project.name,
      status: 'ok',
      blockCount: blocks.length,
      alignable,
      aligned,
      unaligned,
      alignedPct: Number(pct.toFixed(3)),
      uncoveredUnits: alignment.uncoveredUnits.length,
      uncoveredUnitChars: uncoveredChars,
      unitCount: alignment.units.length,
      catchAllUnits,
      unalignedSamples,
    });

    const flag = unaligned > 0 ? '  <-- unaligned' : '';
    console.log(`${label}`);
    console.log(`  blocks ${blocks.length}, alignable ${alignable}, aligned ${aligned} (${pct.toFixed(2)}%), `
      + `unaligned ${unaligned}, uncovered units ${alignment.uncoveredUnits.length} (${uncoveredChars} chars), `
      + `catch-all units ${catchAllUnits}${flag}`);
    for (const s of unalignedSamples) {
      console.log(`    p${s.page} [${s.reason}] "${s.excerpt}"`);
    }
    console.log('');
  }

  const overallPct = totals.alignable > 0 ? (100 * totals.aligned) / totals.alignable : 100;
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`Books analyzed:        ${totals.books} (${totals.failedBooks} failed/skipped)`);
  console.log(`Blocks total:          ${totals.blocks}`);
  console.log(`Alignable blocks:      ${totals.alignable}`);
  console.log(`Aligned:               ${totals.aligned} (${overallPct.toFixed(4)}%)`);
  console.log(`Unaligned:             ${totals.unaligned}`);
  console.log(`Uncovered units:       ${totals.uncoveredUnits} (${totals.uncoveredUnitChars} normalized chars)`);
  console.log(`Catch-all units:       ${totals.catchAllUnits}`);
  const collectorThrows = results.filter((r) => r.status === 'collector-threw').length;
  console.log(`Collector throws:      ${collectorThrows}`);
  console.log(`ACCEPTANCE (>=99.5% aligned, 0 collector throws): `
    + `${overallPct >= 99.5 && collectorThrows === 0 ? 'PASS' : 'FAIL'}`);

  fs.writeFileSync(jsonOutPath, JSON.stringify({
    projectsRoot,
    generatedAt: new Date().toISOString(),
    totals: { ...totals, overallAlignedPct: Number(overallPct.toFixed(4)), collectorThrows },
    books: results,
  }, null, 2));
  console.log(`\nJSON report written to ${jsonOutPath}`);
}

main().catch((err) => {
  console.error('Sweep failed:', err);
  process.exit(1);
});
