#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// migrate-double-dot-filenames.mjs
//
// Fixes the DOUBLE-DOT audiobook/ebook filename bug: composed names of the form
// "{Title}. {Author}. ({Year})" produced "…R.. (2017)" whenever a segment
// legitimately ended in a period — the canonical case being the "Last, First M."
// author form, e.g. "Green, Simon R." (Simon R. Green):
//
//     Deathstalker. Green, Simon R.. (2017).m4b     ← the "R.." is the bug
//     Deathstalker. Green, Simon R. (2017).m4b      ← correct
//
// The code that composed these names is fixed separately (electron/path-utils.ts
// collapseFilenameDots + call sites). This script repairs data ALREADY ON DISK:
//   1. Renames every file whose basename contains a run of 2+ dots.
//   2. Relinks every manifest.json field that referenced the old name.
//
// SAFETY / SCOPE:
//   • DRY RUN by default — prints every planned rename and manifest edit and
//     changes NOTHING. Pass --apply to actually perform the work.
//   • Only runs of 2+ dots collapse; a single "R." is preserved.
//   • The extension dot is never touched (we collapse the BASENAME only, and a
//     run of 2+ dots never includes the single ".ext" separator). Compound
//     sidecar extensions like ".m4b.preadremoval-bak" are preserved.
//   • Manifest edits are FIELD-AWARE: only path/filename/id-bearing fields are
//     rewritten (path, vttPath, outputFilename, originalFilename, and arch:* ids
//     + primaryVariantId). Prose fields (editor text, chapter titles, etc.) that
//     legitimately contain "…" ellipses are left completely alone.
//   • Idempotent: re-running finds nothing to do. Never clobbers an existing
//     target file. Manifest writes are atomic (temp file + rename).
//
// USAGE:
//   node scripts/migrate-double-dot-filenames.mjs [<libraryRoot>] [options]
//
//   <libraryRoot>            Positional path to the library root (the folder that
//                            contains projects/). Also accepted as --root=PATH.
//                            If omitted, auto-detected from the app's
//                            library-root.json (see CONFIG_CANDIDATES below).
//   --apply                  Perform the renames + manifest edits. Without this
//                            flag the script is a pure dry run.
//   --external-dir=PATH      Also scan this flat folder of exported audiobooks for
//                            double-dot files (defaults to <libraryRoot>/audiobooks).
//   --verbose                Print every project scanned, even clean ones.
//
// EXAMPLES:
//   Dry run (review the plan):
//     node scripts/migrate-double-dot-filenames.mjs /Volumes/Callisto/Shared/BookForge
//   Apply after review:
//     node scripts/migrate-double-dot-filenames.mjs /Volumes/Callisto/Shared/BookForge --apply
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const VERBOSE = argv.includes('--verbose');
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const positional = argv.find((a) => !a.startsWith('--'));

// Where the desktop app persists the chosen library root. The packaged app uses
// productName ("BookForge"); some dev builds use the lowercased name.
const CONFIG_CANDIDATES = [
  path.join(os.homedir(), 'Library/Application Support/BookForge/library-root.json'),
  path.join(os.homedir(), 'Library/Application Support/bookforge-app/library-root.json'),
  path.join(os.homedir(), 'Library/Application Support/Electron/library-root.json'),
];

function autodetectRoot() {
  for (const p of CONFIG_CANDIDATES) {
    try {
      const { libraryRoot } = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (libraryRoot) {
        console.log(`[info] library root auto-detected from ${p}`);
        return libraryRoot;
      }
    } catch { /* try next */ }
  }
  return null;
}

const LIBRARY_ROOT = positional || flag('root') || autodetectRoot();
if (!LIBRARY_ROOT) {
  console.error('ERROR: no library root given and none could be auto-detected.');
  console.error('       Pass it positionally or as --root=/path/to/library.');
  process.exit(1);
}
const PROJECTS_DIR = path.join(LIBRARY_ROOT, 'projects');
const EXTERNAL_DIR = flag('external-dir') || path.join(LIBRARY_ROOT, 'audiobooks');

if (!fs.existsSync(PROJECTS_DIR)) {
  console.error(`ERROR: ${PROJECTS_DIR} does not exist — is this a library root?`);
  process.exit(1);
}

// ── core helper (mirrors electron/path-utils.ts collapseFilenameDots) ─────────
// Collapse runs of 2+ consecutive dots in a filename BASENAME down to one.
const collapseFilenameDots = (base) => base.replace(/\.{2,}/g, '.');

// Collapse dots only in the LAST path segment of a value, so directory portions
// and the "arch:"/"bilingual:" id prefixes (which contain a "/") stay intact and
// a stray "../" parent ref could never be mangled. Bare "." / ".." are left alone.
function collapseLastSegment(value) {
  const segs = value.split('/');
  const last = segs[segs.length - 1];
  if (last === '.' || last === '..') return value;
  segs[segs.length - 1] = collapseFilenameDots(last);
  return segs.join('/');
}

// Manifest keys that hold a path/filename and are safe to rewrite. Everything
// else (text, title, description, excerpt, byline, migratedFrom, …) is prose or
// historical provenance and is intentionally excluded.
const PATHISH_KEYS = new Set(['path', 'vttPath', 'outputFilename', 'originalFilename']);
// id-bearing keys are rewritten ONLY for the "arch:<path>" form, the one variant
// id scheme that embeds a live file path. 'audiobook', 'bilingual:<pair>', and
// random-UUID ids never embed a path and are left untouched.
const ID_KEYS = new Set(['id', 'primaryVariantId']);

// ── stats ────────────────────────────────────────────────────────────────────
let filesRenamed = 0;
let filesSkipped = 0;
let fieldsUpdated = 0;
let manifestsChanged = 0;
let projectsScanned = 0;

// ── file scanning ─────────────────────────────────────────────────────────────
function walkFiles(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else if (e.isFile()) out.push(full);
  }
}

// Plan the renames for a set of absolute file paths. Returns [{from, to}].
function planFileRenames(files) {
  const plan = [];
  for (const from of files) {
    const dir = path.dirname(from);
    const base = path.basename(from);
    if (base.startsWith('._')) continue;          // macOS resource fork
    const fixed = collapseFilenameDots(base);
    if (fixed === base) continue;                  // already correct
    const to = path.join(dir, fixed);
    plan.push({ from, to });
  }
  return plan;
}

function applyFileRename({ from, to }) {
  const rel = path.relative(LIBRARY_ROOT, from);
  const relTo = path.basename(to);
  if (fs.existsSync(to)) {
    console.log(`    SKIP rename (target exists): ${rel}`);
    filesSkipped++;
    return;
  }
  console.log(`    RENAME ${rel}`);
  console.log(`        -> ${relTo}`);
  if (APPLY) {
    fs.renameSync(from, to);
  }
  filesRenamed++;
}

// ── manifest scanning ─────────────────────────────────────────────────────────
// Deep-walk the parsed manifest, rewriting whitelisted fields in place. Records
// each change as { jsonPath, from, to }. Returns { changed, edits }.
function fixManifestObject(obj, jsonPath, edits) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) fixManifestObject(obj[i], `${jsonPath}[${i}]`, edits);
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      const childPath = `${jsonPath}.${key}`;
      if (typeof v === 'string') {
        let next = v;
        if (PATHISH_KEYS.has(key)) {
          next = collapseLastSegment(v);
        } else if (ID_KEYS.has(key) && v.startsWith('arch:')) {
          next = collapseLastSegment(v);
        }
        if (next !== v) {
          edits.push({ jsonPath: childPath, from: v, to: next });
          obj[key] = next;
        }
      } else {
        fixManifestObject(v, childPath, edits);
      }
    }
  }
}

function processManifest(manifestPath) {
  let raw;
  try { raw = fs.readFileSync(manifestPath, 'utf8'); } catch { return; }
  let manifest;
  try { manifest = JSON.parse(raw); } catch (e) {
    console.log(`    WARN unparseable manifest, skipped: ${e.message}`);
    return;
  }
  const edits = [];
  fixManifestObject(manifest, '', edits);
  if (edits.length === 0) return;

  manifestsChanged++;
  for (const { jsonPath, from, to } of edits) {
    console.log(`    FIELD ${jsonPath}`);
    console.log(`        "${from}"`);
    console.log(`        "${to}"`);
    fieldsUpdated++;
  }

  if (APPLY) {
    const hadTrailingNewline = raw.endsWith('\n');
    const out = JSON.stringify(manifest, null, 2) + (hadTrailingNewline ? '\n' : '');
    // Atomic write: temp file in the SAME dir (same filesystem → atomic rename),
    // then rename over the original so a partial write is never observed (also
    // Syncthing-safe — it never sees a half-written manifest).
    const tmp = path.join(path.dirname(manifestPath), `.manifest.tmp-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, manifestPath);
  }
}

// ── run ────────────────────────────────────────────────────────────────────────
console.log('');
console.log(`Double-dot filename migration — ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (no changes)'}`);
console.log(`Library root: ${LIBRARY_ROOT}`);
console.log('');

const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(PROJECTS_DIR, d.name));

for (const projDir of projectDirs) {
  projectsScanned++;
  const files = [];
  walkFiles(projDir, files);
  const renames = planFileRenames(files);
  const manifestPath = path.join(projDir, 'manifest.json');
  const hasManifest = fs.existsSync(manifestPath);

  // Peek whether the manifest has any fixable field before printing a header.
  let manifestEdits = [];
  if (hasManifest) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      fixManifestObject(m, '', manifestEdits); // scan only; discard the mutated copy
    } catch { /* handled in processManifest */ }
  }

  if (renames.length === 0 && manifestEdits.length === 0) {
    if (VERBOSE) console.log(`  clean: ${path.basename(projDir)}`);
    continue;
  }

  console.log(`  ${path.basename(projDir)}`);
  for (const r of renames) applyFileRename(r);
  if (hasManifest) processManifest(manifestPath);
  console.log('');
}

// External (flat) audiobooks folder — renames only, no manifests live there.
if (fs.existsSync(EXTERNAL_DIR)) {
  const files = [];
  walkFiles(EXTERNAL_DIR, files);
  const renames = planFileRenames(files);
  if (renames.length > 0) {
    console.log(`  [external] ${EXTERNAL_DIR}`);
    for (const r of renames) applyFileRename(r);
    console.log('');
  } else if (VERBOSE) {
    console.log(`  [external] clean: ${EXTERNAL_DIR}`);
  }
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log('────────────────────────────────────────────────────────');
console.log(`Mode:               ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`Projects scanned:   ${projectsScanned}`);
console.log(`Files ${APPLY ? 'renamed' : 'to rename'}:   ${filesRenamed}`);
console.log(`Files skipped:      ${filesSkipped}  (target already exists)`);
console.log(`Manifests changed:  ${manifestsChanged}`);
console.log(`Manifest fields ${APPLY ? 'updated' : 'to update'}: ${fieldsUpdated}`);
console.log('────────────────────────────────────────────────────────');
if (!APPLY) {
  console.log('DRY RUN — nothing was modified. Re-run with --apply to execute.');
}
