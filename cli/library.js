/**
 * library.js — headless library mutations through BookForge's REAL compiled code.
 *
 * Nothing here is reimplemented. Every verb calls the same exported function the
 * app's ipcMain handler calls (electron/library-actions.ts, electron/import-epub-
 * project.ts), so a bug in the shipped path reproduces here identically — that is
 * the point of this CLI. The only thing this file adds is argument plumbing and a
 * progress line on stderr.
 *
 * Requires BookForge to be BUILT (dist/electron present) but NOT running:
 *   npx tsc -p tsconfig.electron.json
 *
 * Usage:
 *   node cli/library.js --list
 *   node cli/library.js --import-epub <file.epub>
 *   node cli/library.js --import-audiobook <file.m4b>
 *   node cli/library.js --add-version --project <slug> --file <a.m4b> [--file <b.m4b> ...]
 *   node cli/library.js --info <slug>
 *   node cli/library.js --list-versions --project <slug>
 *   node cli/library.js --set-primary --project <slug> --variant <id>
 *   node cli/library.js --set-version-meta --project <slug> --variant <id> [--title ..] [--year ..] [--cover img]
 *   node cli/library.js --set-professional --project <slug> --variant <id> [false]
 *   node cli/library.js --delete-project <slug>
 *
 * Options:
 *   --library <path>   override the library root (default: the app's persisted root)
 *   --dry-run          resolve and report what would happen, write nothing
 *
 * NOT yet exposed: deleting a single VERSION. main.ts's 'variant:delete' guards an
 * invariant this CLI must not get wrong — it only unlinks the file when no other
 * variant or output pointer still references that same path. Port it deliberately
 * (move the body to library-actions like the rest), don't reimplement it here.
 */
'use strict';
require('./electron-stub.js'); // intercept require('electron') for the compiled modules

const fs = require('fs');
const path = require('path');
const { USER_DATA } = require('./electron-stub.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist', 'electron');

function parseArgs(argv) {
  const a = { file: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const body = t.slice(2);
    const eq = body.indexOf('=');
    let key, val;
    if (eq >= 0) { key = body.slice(0, eq); val = body.slice(eq + 1); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { key = body; val = argv[++i]; }
    else { key = body; val = true; }
    if (key === 'file') a.file.push(val);
    else a[key] = val;
  }
  return a;
}

/** The library root the app itself would use: --library, else the root main.ts
 *  persists to userData at startup. No silent default — if neither exists we stop,
 *  because guessing would write a whole project tree into the wrong place. */
function resolveLibraryRoot(override) {
  if (override && override !== true) return override;
  const cfgPath = path.join(USER_DATA, 'library-root.json');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`No library root: ${cfgPath} does not exist and --library was not given.`);
  }
  const { libraryRoot } = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!libraryRoot) throw new Error(`${cfgPath} has no "libraryRoot" key.`);
  return libraryRoot;
}

function progress(name, fraction) {
  if (!process.stderr.isTTY) return;
  process.stderr.write(`\r  ${name}: ${Math.round(fraction * 100)}%   `);
}
function progressDone() { if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(72) + '\r'); }

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(DIST)) {
    throw new Error(`dist/electron missing — build first:  npx tsc -p tsconfig.electron.json`);
  }

  const manifestService = require(path.join(DIST, 'manifest-service.js'));
  const libraryActions = require(path.join(DIST, 'library-actions.js'));
  const { importEpubProject } = require(path.join(DIST, 'import-epub-project.js'));

  const libraryRoot = resolveLibraryRoot(args.library);
  manifestService.setLibraryBasePath(libraryRoot);
  console.log(`[library] root: ${libraryRoot}`);

  // ── --list ────────────────────────────────────────────────────────────────
  if (args.list) {
    const res = await manifestService.listProjects();
    if (!res.success) throw new Error(res.error);
    for (const p of res.projects) {
      console.log(`${p.projectId}`);
    }
    console.log(`\n${res.projects.length} projects`);
    return;
  }

  // ── --import-epub ─────────────────────────────────────────────────────────
  if (args['import-epub']) {
    const src = path.resolve(args['import-epub']);
    if (args['dry-run']) { console.log(`would import epub: ${src}`); return; }
    const res = await importEpubProject(src, { projectType: 'book' });
    if (!res.success) throw new Error(res.error || 'import failed');
    console.log(`imported: ${res.projectId}`);
    return;
  }

  // ── --import-audiobook ────────────────────────────────────────────────────
  if (args['import-audiobook']) {
    const src = path.resolve(args['import-audiobook']);
    if (args['dry-run']) { console.log(`would import audiobook: ${src}`); return; }
    const res = await libraryActions.importAudiobookProject(src, { onProgress: progress });
    progressDone();
    if (!res.success) throw new Error(res.error || 'import failed');
    console.log(`imported: ${res.projectId}  (professionally read)`);
    return;
  }

  // ── --add-version ─────────────────────────────────────────────────────────
  if (args['add-version']) {
    const projectId = args.project;
    if (!projectId) throw new Error('--add-version requires --project <slug>');
    if (!args.file.length) throw new Error('--add-version requires at least one --file');
    const got = await manifestService.getManifest(projectId);
    if (!got.manifest) throw new Error(`Project not found: ${projectId}`);
    console.log(`[library] project: ${got.manifest.metadata.title}`);

    let failures = 0;
    for (const f of args.file) {
      const src = path.resolve(f);
      if (!fs.existsSync(src)) throw new Error(`No such file: ${src}`);
      if (args['dry-run']) { console.log(`  would add: ${path.basename(src)}`); continue; }
      const res = await libraryActions.addVariant(projectId, src, { onProgress: progress });
      progressDone();
      if (!res.success) { console.error(`  FAILED  ${path.basename(src)}: ${res.error}`); failures++; continue; }
      const kind = res.variant.kind === 'audiobook' ? 'audiobook, professionally read' : res.variant.kind;
      console.log(`  added   ${res.variant.path}   [${kind}]`);
    }
    if (failures) process.exitCode = 1;
    return;
  }

  // ── --delete-project ──────────────────────────────────────────────────────
  // Same call the app's 'manifest:delete' handler makes: rm -rf the project dir.
  // Prints what it is about to destroy first — this is not undoable from here.
  if (args['delete-project']) {
    const projectId = args['delete-project'] === true ? args.project : args['delete-project'];
    if (!projectId) throw new Error('--delete-project requires a project slug');
    const got = await manifestService.getManifest(projectId);
    if (!got.manifest) throw new Error(`Project not found: ${projectId}`);
    const dir = manifestService.getProjectPath(projectId);
    const { variants } = manifestService.getVariants(got.manifest);
    console.log(`  ${got.manifest.metadata.title} — ${variants.length} version(s):`);
    for (const v of variants) console.log(`     [${v.kind}] ${v.path}`);
    if (args['dry-run']) { console.log(`  would delete: ${dir}`); return; }
    const res = await manifestService.deleteProject(projectId);
    if (!res.success) throw new Error(res.error);
    console.log(`  DELETED ${dir}`);
    return;
  }

  // ── --list-versions ───────────────────────────────────────────────────────
  if (args['list-versions']) {
    const projectId = args.project;
    if (!projectId) throw new Error('--list-versions requires --project <slug>');
    const got = await manifestService.getManifest(projectId);
    if (!got.manifest) throw new Error(`Project not found: ${projectId}`);
    const { variants, primaryVariantId } = manifestService.getVariants(got.manifest);
    for (const v of variants) {
      const star = v.id === primaryVariantId ? '*' : ' ';
      const yr = v.metadata.year ? ` (${v.metadata.year})` : '';
      console.log(`${star} ${v.id}  [${v.kind}] ${v.metadata.title}${yr}`);
    }
    return;
  }

  // ── --info ────────────────────────────────────────────────────────────────
  // Read-only: what the shelf believes about a project, and whether the files it
  // points at actually exist. The fastest way to spot a half-applied edit.
  if (args.info) {
    const projectId = args.info === true ? args.project : args.info;
    if (!projectId) throw new Error('--info requires a project slug');
    const got = await manifestService.getManifest(projectId);
    if (!got.manifest) throw new Error(`Project not found: ${projectId}`);
    const m = got.manifest;
    const dir = manifestService.getProjectPath(projectId);
    const md = m.metadata;
    const exists = (rel) => rel && fs.existsSync(path.join(dir, rel.replace(/\//g, path.sep)));
    console.log(`  title      ${md.title}`);
    console.log(`  author     ${md.author}   year ${md.year ?? '-'}`);
    console.log(`  source     ${m.source?.type}`);
    console.log(`  cover      ${md.coverPath ?? '-'}${md.coverPath && !fs.existsSync(path.join(libraryRoot, md.coverPath.replace(/\//g, path.sep))) ? '   <-- MISSING' : ''}`);
    console.log(`  outputFile ${md.outputFilename ?? '-'}`);
    const ab = m.outputs?.audiobook;
    if (ab) console.log(`  shelf m4b  ${ab.path}${exists(ab.path) ? '' : '   <-- MISSING'}   professionallyRead=${ab.professionallyRead}`);
    const { variants, primaryVariantId } = manifestService.getVariants(m);
    console.log(`  versions   ${variants.length}`);
    for (const v of variants) {
      const star = v.id === primaryVariantId ? '*' : ' ';
      console.log(`   ${star} [${v.kind}] ${v.metadata.title}${v.metadata.year ? ` (${v.metadata.year})` : ''}`);
      console.log(`       ${v.path}${exists(v.path) ? '' : '   <-- MISSING'}`);
    }
    return;
  }

  // ── --set-professional ────────────────────────────────────────────────────
  if (args['set-professional'] !== undefined) {
    const projectId = args.project;
    const variantId = args.variant;
    if (!projectId || !variantId) throw new Error('--set-professional requires --project and --variant');
    const value = !(args['set-professional'] === 'false' || args['set-professional'] === 'no');
    const res = await libraryActions.setVariantProfessional(projectId, variantId, value);
    if (!res.success) throw new Error(res.error);
    console.log(`professionallyRead=${value} -> ${variantId}`);
    return;
  }

  // ── --set-primary ─────────────────────────────────────────────────────────
  if (args['set-primary']) {
    const projectId = args.project;
    const variantId = args.variant === undefined ? args['set-primary'] : args.variant;
    if (!projectId || variantId === true || !variantId) throw new Error('--set-primary requires --project <slug> and --variant <id>');
    if (args['dry-run']) { console.log(`would set primary: ${variantId}`); return; }
    const res = await libraryActions.setPrimaryVariant(projectId, variantId);
    if (!res.success) throw new Error(res.error);
    console.log(`primary -> ${variantId}`);
    return;
  }

  // ── --set-version-meta ────────────────────────────────────────────────────
  if (args['set-version-meta']) {
    const projectId = args.project;
    const variantId = args.variant;
    if (!projectId || !variantId) throw new Error('--set-version-meta requires --project and --variant');
    const meta = {};
    for (const k of ['title', 'author', 'year', 'narrator', 'series', 'description', 'descriptor']) {
      if (args[k] !== undefined) meta[k] = args[k];
    }
    // --cover <image> travels as a data URL, exactly as the renderer sends it, so
    // it lands in media/ under the same content-hashed name the app would mint.
    let coverData;
    if (args.cover) {
      const cp = path.resolve(args.cover);
      if (!fs.existsSync(cp)) throw new Error(`No such cover file: ${cp}`);
      const mime = path.extname(cp).toLowerCase() === '.png' ? 'png' : 'jpeg';
      coverData = `data:image/${mime};base64,${fs.readFileSync(cp).toString('base64')}`;
    }
    if (!Object.keys(meta).length && !coverData) throw new Error('nothing to set — pass at least one of --title/--author/--year/--narrator/--series/--description/--descriptor/--cover');
    if (args['dry-run']) { console.log(`would set on ${variantId}:`, meta, coverData ? '(+cover)' : ''); return; }
    const res = await libraryActions.saveVariantMetadata(projectId, variantId, meta, coverData);
    if (!res.success) throw new Error(res.error);
    console.log(`updated ${variantId}: ${JSON.stringify(meta)}`);
    return;
  }

  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(11, 22).map(l => l.replace(/^ \* ?/, '')).join('\n'));
})().catch((err) => {
  console.error(`[library] ${err.message}`);
  process.exit(1);
});
