#!/usr/bin/env node
// Reversal tool for the 2026-06-10 library->projects migration.
//
//   --snapshot   Scan the live library and write an authoritative reversal
//                snapshot (which projects were created, which archive entries
//                were attached). Run this once, right after migrating.
//   (default)    DRY RUN: print exactly what reversal would remove.
//   --apply      Execute the reversal using the snapshot.
//
// What it reverses:
//   CREATED projects  -> projects with a `migratedFrom` field. Deleted whole,
//                        BUT skipped (with a warning) if the project has gained
//                        any pipeline work since migration (non-empty stages/ or
//                        output/), so user work is never destroyed.
//   ATTACHED originals -> archive entries added on the migration date to
//                        pre-existing projects. The file + manifest entry are
//                        removed; the rest of the project is untouched.
//
// ebooks/ is the source of truth and was never modified, so reversal simply
// removes the projects/copies the migration created. Safe and idempotent.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const APPLY = process.argv.includes('--apply');
const SNAPSHOT = process.argv.includes('--snapshot');
const MIGRATION_DATE = '2026-06-10'; // archive entries with this archivedAt date are migration attaches
const LIBRARY_ROOT = process.argv.find(a => a.startsWith('--root='))?.slice(7)
  || JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library/Application Support/bookforge-app/library-root.json'), 'utf8')).libraryRoot;
const PROJECTS_DIR = path.join(LIBRARY_ROOT, 'projects');
const SNAPSHOT_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), 'migration-2026-06-10-snapshot.json');

const isEmptyish = async (dir) => {
  if (!fs.existsSync(dir)) return true;
  let count = 0;
  const walk = async (d) => { for (const e of await fsp.readdir(d, { withFileTypes: true })) { if (e.isDirectory()) await walk(path.join(d, e.name)); else count++; } };
  await walk(dir);
  return count === 0;
};

async function buildSnapshot() {
  const created = [];
  const attached = [];
  for (const slug of (await fsp.readdir(PROJECTS_DIR, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)) {
    const mp = path.join(PROJECTS_DIR, slug, 'manifest.json');
    if (!fs.existsSync(mp)) continue;
    let m; try { m = JSON.parse(await fsp.readFile(mp, 'utf8')); } catch { continue; }
    if (m.migratedFrom) {
      created.push({ slug, migratedFrom: m.migratedFrom, archive: (m.archive || []).map(a => a.path) });
    } else {
      // pre-existing project: any archive entry added on the migration date is an attach
      for (const a of (m.archive || [])) {
        if ((a.archivedAt || '').startsWith(MIGRATION_DATE)) attached.push({ slug, path: a.path, format: a.format, size: a.size });
      }
    }
  }
  const snap = { migrationDate: MIGRATION_DATE, libraryRoot: LIBRARY_ROOT, generatedFromDisk: true, created, attached };
  await fsp.writeFile(SNAPSHOT_PATH, JSON.stringify(snap, null, 2));
  console.log(`Snapshot written: ${SNAPSHOT_PATH}`);
  console.log(`  created projects: ${created.length}`);
  console.log(`  attached originals: ${attached.length}`);
  return snap;
}

async function reverse() {
  if (!fs.existsSync(SNAPSHOT_PATH)) { console.error(`No snapshot at ${SNAPSHOT_PATH}. Run with --snapshot first.`); process.exit(1); }
  const snap = JSON.parse(await fsp.readFile(SNAPSHOT_PATH, 'utf8'));
  console.log(`Reversal ${APPLY ? 'APPLY' : 'DRY RUN'} — library: ${snap.libraryRoot}\n`);

  let toDelete = 0, skipped = 0, attachesRemoved = 0;

  console.log('=== CREATED projects to delete ===');
  for (const c of snap.created) {
    const dir = path.join(PROJECTS_DIR, c.slug);
    if (!fs.existsSync(dir)) { console.log(`  (gone) ${c.slug}`); continue; }
    const stagesBusy = !(await isEmptyish(path.join(dir, 'stages')));
    const outputBusy = !(await isEmptyish(path.join(dir, 'output')));
    if (stagesBusy || outputBusy) { console.log(`  SKIP (has work since migration): ${c.slug}`); skipped++; continue; }
    toDelete++;
    if (APPLY) { await fsp.rm(dir, { recursive: true, force: true }); console.log(`  deleted ${c.slug}`); }
    else console.log(`  would delete ${c.slug}`);
  }

  console.log('\n=== ATTACHED originals to remove (file + manifest entry) ===');
  for (const a of snap.attached) {
    const dir = path.join(PROJECTS_DIR, a.slug);
    const mp = path.join(dir, 'manifest.json');
    const file = path.join(dir, a.path);
    if (!fs.existsSync(mp)) { console.log(`  (project gone) ${a.slug}`); continue; }
    if (APPLY) {
      const m = JSON.parse(await fsp.readFile(mp, 'utf8'));
      m.archive = (m.archive || []).filter(e => e.path !== a.path);
      await fsp.writeFile(mp, JSON.stringify(m, null, 2));
      if (fs.existsSync(file)) await fsp.rm(file, { force: true });
      attachesRemoved++;
      console.log(`  removed ${a.path} from ${a.slug}`);
    } else console.log(`  would remove ${a.path} from ${a.slug}`);
  }

  console.log(`\nSummary: ${APPLY ? 'deleted' : 'would delete'} ${toDelete} projects, ${skipped} skipped (have work), ${APPLY ? 'removed' : 'would remove'} ${snap.attached.length} attaches.`);
  console.log(`ebooks/ is untouched and remains the source of truth.`);
  if (!APPLY) console.log(`\nDRY RUN — re-run with --apply to execute.`);
}

if (SNAPSHOT) await buildSnapshot();
else await reverse();
