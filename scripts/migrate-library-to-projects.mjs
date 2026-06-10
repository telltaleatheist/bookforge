#!/usr/bin/env node
// One-time migration: reconcile archival ebooks (ebooks/{category}/*) with
// manifest projects (projects/{slug}/) so every book becomes a project holding
// all its versions, with cleaned metadata.
//
// Classification per ebook:
//   ATTACH  - title (and agreeing author) matches an existing project. The
//             archival file is added to that project's archive/ (role:'original')
//             unless an original of that format is already there. Stages/output
//             are NEVER touched. Metadata stays the project's (already clean).
//   NEW     - no project match. A new archival-only project is created with
//             cleaned metadata parsed from the filename.
//   FOLD    - several new ebooks are the same book in different formats; they
//             collapse into ONE new project archiving every format.
//   SKIP    - true duplicate (same title+author+format) or already-archived.
//   FLAG    - needs a human: same title but a DIFFERENT author (two different
//             books), or a junk/low-confidence title. NOT written on --apply.
//
// DRY RUN by default. --apply executes. Originals in ebooks/ are never moved or
// modified; every copy is SHA-256 verified before its entry is recorded.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const APPLY = process.argv.includes('--apply');
const ATTACH_ONLY = process.argv.includes('--attach-only'); // skip new-project creation (already done)
const INCLUDE_FLAGGED = process.argv.includes('--include-flagged'); // create flagged-as-new too

// Explicit decisions for flagged title-conflicts (keyed by ebook relativePath):
//   'new'            -> genuinely a different book, create its own project
//   {attach:'slug'}  -> same book as that project, attach the archival original
const FLAG_DECISIONS = {
  'Nazism/Hitler_ A Biography. Peter Longerich [Longerich, Peter]. (2019).epub': 'new',
  'Nazism/Die Moorsoldaten. esterw. (2020).pdf': { attach: 'Die_Moorsoldaten_-_Langhoff,_Wolfgang_(1935)' },
};
// Projects with a live queue job — defer manifest-modifying attaches until the job finishes.
// Pass --include-deferred once the job is stopped to complete these.
const DEFER_ATTACH_PROJECTS = process.argv.includes('--include-deferred') ? new Set() : new Set([
  'Jehovah_s_Witnesses_Proclaimers_of_God_s_Kingdom_-_Jehovah_s_Witnesses_(1993)',
]);
const LIBRARY_ROOT = process.argv.find(a => a.startsWith('--root='))?.slice(7)
  || JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library/Application Support/bookforge-app/library-root.json'), 'utf8')).libraryRoot;

const EBOOKS_DIR = path.join(LIBRARY_ROOT, 'ebooks');
const PROJECTS_DIR = path.join(LIBRARY_ROOT, 'projects');
const METADATA_CACHE = path.join(EBOOKS_DIR, '.cache', 'metadata.json');
const COVERS_DIR = path.join(EBOOKS_DIR, '.cache', 'covers');
const MEDIA_DIR = path.join(LIBRARY_ROOT, 'media');
const REPORT_PATH = path.join(os.tmpdir(), 'bookforge-migration-report.json');
const REVIEW_TSV = path.join(os.tmpdir(), 'bookforge-metadata-review.tsv');

const EBOOK_EXTENSIONS = new Set(['.epub', '.pdf', '.azw3', '.azw', '.mobi', '.kfx', '.fb2', '.lit', '.pdb', '.cbz', '.cbr', '.djvu']);
const FORMAT_PRIORITY = { epub: 5, azw3: 4, azw: 3, mobi: 2, fb2: 2, pdf: 1 }; // which becomes source/original

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const lastNameToken = (fileAs) => norm((fileAs || '').split(',')[0].split(/\s+/).pop() || '');

// Split an author string into { display:"First Last", fileAs:"Last, First" },
// stripping Calibre "[file-as]" brackets (e.g. "kirk cameron [cameron, kirk]").
function splitAuthor(raw) {
  if (!raw || raw === 'Unknown') return {};
  const b = raw.match(/^(.*?)\s*\[(.+?)\]\s*$/);
  if (b) { const fileAs = b[2].trim(); const disp = b[1].trim(); return { display: disp || fileAs, fileAs }; }
  if (raw.includes(',')) { const p = raw.split(',').map(s => s.trim()); return { display: p[1] ? `${p[1]} ${p[0]}` : p[0], fileAs: raw }; }
  if (raw.includes(' ')) { const p = raw.split(/\s+/); return { display: raw, fileAs: `${p[p.length - 1]}, ${p.slice(0, -1).join(' ')}` }; }
  return { display: raw, fileAs: raw };
}

const nameTokens = (fileAs) => (fileAs || '').toLowerCase().replace(/[,\[\]]/g, ' ')
  .split(/\s+/).map(t => t.replace(/[^a-z0-9]/g, '')).filter(t => t.length >= 3 && t !== 'unknown');
function authorsAgree(aFileAs, bFileAs) {
  const a = nameTokens(aFileAs), b = nameTokens(bFileAs);
  if (!a.length || !b.length) return true; // one side unknown -> trust the title match
  const aset = new Set(a);
  const shared = b.filter(t => aset.has(t));
  // agree if they share a surname-length token (>=5) or two+ tokens
  return shared.some(t => t.length >= 5) || shared.length >= 2;
}

// Improved filename parser: tolerates trailing ". Unknown" and (year) not at the end.
function parseFilename(filename) {
  const ext = path.extname(filename);
  let base = filename.slice(0, filename.length - ext.length);

  // strip trailing junk tokens repeatedly: ". Unknown", "(YYYY)", stray dots/spaces
  let year;
  let changed = true;
  while (changed) {
    changed = false;
    const before = base;
    base = base.replace(/[.\s]+unknown\s*$/i, '');
    const ym = base.match(/\.?\s*\((\d{4})\)\s*$/);
    if (ym) { if (!year) year = parseInt(ym[1]); base = base.slice(0, base.length - ym[0].length); }
    base = base.replace(/[.\s]+$/, '');
    if (base !== before) changed = true;
  }

  let title = base, subtitle, authorDisplay, authorFileAs;
  const dotParts = base.split(/\.\s+/);
  if (dotParts.length >= 2) {
    let authorPart = dotParts[dotParts.length - 1].trim();
    const titlePart = dotParts.slice(0, -1).join('. ').trim();
    // Calibre [file-as] bracket: "kirk cameron [cameron, kirk]"
    const bracket = authorPart.match(/^(.*?)\s*\[(.+?)\]\s*$/);
    if (bracket) { authorDisplay = bracket[1].trim(); authorFileAs = bracket[2].trim(); }
    else if (authorPart.includes(',')) { authorFileAs = authorPart; const p = authorPart.split(',').map(s => s.trim()); authorDisplay = p[1] ? `${p[1]} ${p[0]}` : p[0]; }
    else if (authorPart.includes(' ')) { authorDisplay = authorPart; const p = authorPart.split(/\s+/); authorFileAs = `${p[p.length - 1]}, ${p.slice(0, -1).join(' ')}`; }
    else { authorDisplay = authorPart; authorFileAs = authorPart; }

    const dashIdx = titlePart.indexOf(' - ');
    if (dashIdx !== -1) { title = titlePart.slice(0, dashIdx).trim(); subtitle = titlePart.slice(dashIdx + 3).trim(); }
    else title = titlePart;
  }
  return { title, subtitle, authorDisplay, authorFileAs, year };
}

// Title looks like junk / a fragment rather than a real book title.
function isJunkTitle(t) {
  const s = (t || '').trim();
  if (!s) return true;
  if (/^(untitled|cover|layout\b|page \d)/i.test(s)) return true;
  if (/\.(md|pdf|txt|docx?)\b/i.test(s)) return true;
  if (/^\d{6,}/.test(norm(s)) && norm(s).replace(/\d/g, '').length < 4) return true; // mostly digits (ISBNs)
  return false;
}

async function sha256(file) {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file)) h.update(c);
  return h.digest('hex');
}
function toAsciiSlug(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9_()\-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}
function computeProjectSlug(title, fileAs, year) {
  const t = toAsciiSlug((title || '').replace(/\s+/g, '_'));
  const a = toAsciiSlug((fileAs || 'Unknown').replace(/\s+/g, '_'));
  return toAsciiSlug(`${t}_-_${a}${year ? `_(${year})` : ''}`).substring(0, 150);
}
function sanitize(s) { return (s || '').replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim(); }
function descriptiveFilename(meta, ext) {
  const parts = [meta.title];
  if (meta.authorFileAs && meta.authorFileAs !== 'Unknown') parts.push(meta.authorFileAs);
  if (meta.year) parts.push(`(${meta.year})`);
  return sanitize(parts.join('. ')) + ext;
}

async function main() {
  console.log(`Library root: ${LIBRARY_ROOT}`);
  console.log(`Mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (read-only)'}${INCLUDE_FLAGGED ? ' +flagged' : ''}\n`);

  const cache = JSON.parse(await fsp.readFile(METADATA_CACHE, 'utf8'));

  // Index existing projects by exact key and by title
  const projExact = new Map(); // title|last -> project
  const projByTitle = new Map(); // titleNorm -> [projects]
  const projects = [];
  for (const slug of (await fsp.readdir(PROJECTS_DIR, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)) {
    const mp = path.join(PROJECTS_DIR, slug, 'manifest.json');
    if (!fs.existsSync(mp)) continue;
    let m; try { m = JSON.parse(await fsp.readFile(mp, 'utf8')); } catch { continue; }
    const title = m.metadata?.title || '';
    const fileAs = m.metadata?.authorFileAs || m.metadata?.author || '';
    const originalFormats = new Set((m.archive || []).filter(a => a.role === 'original').map(a => (a.format || '').toLowerCase()));
    const proj = { slug, title, fileAs, originalFormats };
    projects.push(proj);
    projExact.set(norm(title) + '|' + lastNameToken(fileAs), proj);
    const tk = norm(title);
    if (!projByTitle.has(tk)) projByTitle.set(tk, []);
    projByTitle.get(tk).push(proj);
  }

  // Build cleaned ebook records
  const records = [];
  for (const [relativePath, c] of Object.entries(cache)) {
    const ext = path.extname(relativePath).toLowerCase();
    if (!EBOOK_EXTENSIONS.has(ext)) continue;
    if (!fs.existsSync(path.join(EBOOKS_DIR, relativePath))) continue;
    const filename = path.basename(relativePath);
    const parsed = parseFilename(filename);
    // Prefer cache title if cleaner (shorter, no leftover author/year), else parsed.
    const cacheTitle = c.title || '';
    const cacheClean = cacheTitle && !/\.\s/.test(cacheTitle) && !/\(\d{4}\)/.test(cacheTitle);
    const title = cacheClean ? cacheTitle : (parsed.title || cacheTitle);
    // Author: clean cache author (strip [file-as] brackets); recover from filename when cache is Unknown
    const cacheRaw = (c.authorFull && c.authorFull !== 'Unknown') ? c.authorFull
      : (c.authorLast && c.authorLast !== 'Unknown') ? c.authorLast : undefined;
    const cleaned = cacheRaw ? splitAuthor(cacheRaw) : {};
    const authorFileAs = cleaned.fileAs || parsed.authorFileAs || 'Unknown';
    const authorDisplay = cleaned.display || parsed.authorDisplay || authorFileAs;
    const year = c.year || parsed.year;
    records.push({
      relativePath, filename, category: relativePath.split('/')[0], format: ext.replace('.', ''),
      title, subtitle: parsed.subtitle, authorFileAs, authorDisplay,
      year, language: c.language || 'en', tags: c.tags || [], coverFile: c.coverFile,
      size: c.fileSize || 0,
      titleKeys: [norm(title), norm(cacheTitle), norm(parsed.title)].filter(Boolean),
    });
  }

  // Classify
  const plan = { attach: [], newGroups: [], skip: [], flag: [], deferred: [] };
  const newCandidates = [];

  for (const r of records) {
    // Explicit human decision overrides automatic classification.
    const decision = FLAG_DECISIONS[r.relativePath];
    if (decision === 'new') { newCandidates.push(r); continue; }
    if (decision && decision.attach) { plan.attach.push({ ...kv(r), project: decision.attach }); continue; }

    // exact match
    let matched = projExact.get(norm(r.title) + '|' + lastNameToken(r.authorFileAs));
    let titleConflict = false;
    if (!matched) {
      // title match (any of our title keys)
      let candidates = [];
      for (const tk of new Set(r.titleKeys)) if (projByTitle.has(tk)) candidates.push(...projByTitle.get(tk));
      candidates = [...new Set(candidates)];
      if (candidates.length) {
        const agreeing = candidates.find(p => authorsAgree(r.authorFileAs, p.fileAs));
        if (agreeing) matched = agreeing;
        else titleConflict = candidates[0]; // same title, different author
      }
    }
    if (matched) {
      if (matched.originalFormats.has(r.format)) plan.skip.push({ ...kv(r), project: matched.slug, reason: `already has .${r.format}` });
      else plan.attach.push({ ...kv(r), project: matched.slug });
      continue;
    }
    if (titleConflict) { plan.flag.push({ ...kv(r), reason: `same title as project "${titleConflict.slug}" but different author (${r.authorFileAs} vs ${titleConflict.fileAs})` }); continue; }
    if (isJunkTitle(r.title)) { plan.flag.push({ ...kv(r), reason: 'junk/low-confidence title' }); continue; }
    newCandidates.push(r);
  }

  // Group new candidates -> fold multi-format, drop true dupes
  const groups = new Map(); // titleNorm|last -> [records]
  for (const r of newCandidates) {
    const k = norm(r.title) + '|' + lastNameToken(r.authorFileAs);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const usedSlugs = new Set(projects.map(p => p.slug.toLowerCase()));
  for (const items of groups.values()) {
    // dedup identical formats: keep largest
    const byFormat = new Map();
    for (const it of items.sort((a, b) => b.size - a.size)) {
      if (byFormat.has(it.format)) plan.skip.push({ ...kv(it), reason: `duplicate of same-title .${it.format}` });
      else byFormat.set(it.format, it);
    }
    const formats = [...byFormat.values()];
    const primary = formats.sort((a, b) => (FORMAT_PRIORITY[b.format] || 0) - (FORMAT_PRIORITY[a.format] || 0))[0];
    let slug = computeProjectSlug(primary.title, primary.authorFileAs, primary.year);
    let uniq = slug, n = 1; while (usedSlugs.has(uniq.toLowerCase())) uniq = `${slug}_${++n}`;
    usedSlugs.add(uniq.toLowerCase());
    plan.newGroups.push({ slug: uniq, primary: kv(primary), formats: formats.map(kv) });
  }

  // Report
  const sum = (a) => a.reduce((s, x) => s + (x.size || x.primary?.size || 0), 0);
  const gb = (b) => (b / 1e9).toFixed(2) + ' GB';
  const newBytes = plan.newGroups.reduce((s, g) => s + g.formats.reduce((t, f) => t + (f.size || 0), 0), 0);
  console.log('=== RECONCILIATION ===');
  console.log(`ebook files:              ${records.length}`);
  console.log(`existing projects:        ${projects.length}`);
  console.log('-');
  console.log(`ATTACH to existing:       ${plan.attach.length}  (${gb(sum(plan.attach))})`);
  console.log(`NEW projects:             ${plan.newGroups.length}  (${gb(newBytes)})`);
  console.log(`  (folding ${plan.newGroups.reduce((s, g) => s + g.formats.length, 0)} files; ${plan.newGroups.filter(g => g.formats.length > 1).length} multi-format)`);
  console.log(`SKIP (dupe/already):      ${plan.skip.length}`);
  console.log(`FLAG (need decision):     ${plan.flag.length}`);
  console.log(`-`);
  console.log(`bytes to copy:            ${gb(sum(plan.attach) + newBytes)}`);

  console.log(`\n=== FLAGGED — need your decision (not written without --include-flagged) ===`);
  for (const f of plan.flag) console.log(`  [${f.category}] ${f.relativePath}\n      -> ${f.reason}`);

  console.log(`\n=== ATTACH to existing projects (${plan.attach.length}) ===`);
  for (const a of plan.attach) console.log(`  "${a.title}" (.${a.format}) -> ${a.project}`);

  // Metadata review TSV + low-confidence highlights
  const rows = [['relativePath', 'finalTitle', 'finalAuthor(FileAs)', 'year', 'category', 'formats', 'confidence']];
  for (const g of plan.newGroups) {
    const p = g.primary;
    const conf = (p.authorFileAs === 'Unknown' ? 'LOW(author)' : '') + (isJunkTitle(p.title) ? ' LOW(title)' : '') || 'ok';
    rows.push([p.relativePath, p.title, p.authorFileAs, p.year || '', p.category, g.formats.map(f => f.format).join('+'), conf]);
  }
  await fsp.writeFile(REVIEW_TSV, rows.map(r => r.join('\t')).join('\n'));
  const lowConf = plan.newGroups.filter(g => g.primary.authorFileAs === 'Unknown');
  console.log(`\n=== NEW projects still missing author after recovery (${lowConf.length}) ===`);
  for (const g of lowConf) console.log(`  [${g.primary.category}] "${g.primary.title}"  <-  ${g.primary.filename}`);

  await fsp.writeFile(REPORT_PATH, JSON.stringify(plan, null, 2));
  console.log(`\nReport:           ${REPORT_PATH}`);
  console.log(`Metadata review:  ${REVIEW_TSV}  (open to verify all ${plan.newGroups.length} new projects)`);

  if (!APPLY) { console.log(`\nDRY RUN complete. No files changed.`); return; }
  await applyPlan(plan);
}

// compact record
function kv(r) {
  return { relativePath: r.relativePath, filename: r.filename, category: r.category, format: r.format,
    title: r.title, subtitle: r.subtitle, authorFileAs: r.authorFileAs, authorDisplay: r.authorDisplay,
    year: r.year, language: r.language, tags: r.tags, coverFile: r.coverFile, size: r.size };
}

async function applyPlan(plan) {
  console.log(`\n=== APPLYING ===`);
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  const now = new Date().toISOString();
  let created = 0, attached = 0, failed = 0; const failures = [];
  const groups = ATTACH_ONLY ? [] : plan.newGroups;

  for (const g of groups) {
    try {
      const dir = path.join(PROJECTS_DIR, g.slug);
      const p = g.primary;
      for (const sub of ['source', 'archive', 'output', 'stages/01-cleanup', 'stages/02-translate', 'stages/03-tts'])
        await fsp.mkdir(path.join(dir, sub), { recursive: true });
      const archive = [];
      // source/original.{primaryExt}
      const srcPrimary = path.join(EBOOKS_DIR, p.relativePath);
      const primHash = await sha256(srcPrimary);
      const originalDest = path.join(dir, 'source', `original.${p.format}`);
      await fsp.copyFile(srcPrimary, originalDest);
      if (await sha256(originalDest) !== primHash) throw new Error('checksum source/original');
      // archive every format
      for (const f of g.formats) {
        const src = path.join(EBOOKS_DIR, f.relativePath);
        const h = await sha256(src);
        const name = descriptiveFilename({ title: p.title, authorFileAs: p.authorFileAs, year: p.year }, `.${f.format}`);
        const dest = path.join(dir, 'archive', name);
        await fsp.copyFile(src, dest);
        if (await sha256(dest) !== h) throw new Error('checksum archive ' + f.format);
        archive.push({ path: `archive/${name}`, role: 'original', format: f.format, label: `Original ${f.format.toUpperCase()}`, archivedAt: now, size: (await fsp.stat(dest)).size });
      }
      // cover
      let coverPath;
      if (p.coverFile && fs.existsSync(path.join(COVERS_DIR, p.coverFile))) {
        const cd = `cover_${g.slug}.jpg`;
        await fsp.copyFile(path.join(COVERS_DIR, p.coverFile), path.join(MEDIA_DIR, cd));
        coverPath = `media/${cd}`;
      }
      const tags = [...new Set([...(p.tags || []), p.category].filter(c => c && c !== 'Uncategorized'))];
      const manifest = {
        version: 2, projectId: g.slug, projectType: 'book', createdAt: now, modifiedAt: now,
        source: { type: p.format === 'pdf' ? 'pdf' : 'epub', originalFilename: p.filename },
        metadata: { title: p.title, subtitle: p.subtitle, author: p.authorDisplay, authorFileAs: p.authorFileAs,
          year: p.year ? String(p.year) : undefined, language: p.language, coverPath, tags },
        chapters: [], pipeline: {}, outputs: {}, archive, sortOrder: -1, migratedFrom: p.relativePath,
      };
      await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      created++;
    } catch (e) { failed++; failures.push({ item: g.slug, error: String(e) }); console.error(`  FAIL ${g.slug}: ${e}`); }
  }

  for (const a of plan.attach) {
    if (DEFER_ATTACH_PROJECTS.has(a.project)) { plan.deferred.push(a); console.log(`  DEFER attach -> ${a.project} (live job; do after it finishes)`); continue; }
    try {
      const dir = path.join(PROJECTS_DIR, a.project);
      const mp = path.join(dir, 'manifest.json');
      const m = JSON.parse(await fsp.readFile(mp, 'utf8'));
      const src = path.join(EBOOKS_DIR, a.relativePath);
      const h = await sha256(src);
      await fsp.mkdir(path.join(dir, 'archive'), { recursive: true });
      const name = descriptiveFilename({ title: m.metadata.title, authorFileAs: m.metadata.authorFileAs || m.metadata.author, year: m.metadata.year }, `.${a.format}`);
      const dest = path.join(dir, 'archive', name);
      if (fs.existsSync(dest)) { console.log(`  skip ${a.project}: ${name} exists`); continue; }
      await fsp.copyFile(src, dest);
      if (await sha256(dest) !== h) throw new Error('checksum');
      (m.archive ||= []).push({ path: `archive/${name}`, role: 'original', format: a.format, label: `Original ${a.format.toUpperCase()}`, archivedAt: now, size: (await fsp.stat(dest)).size });
      m.modifiedAt = now;
      await fsp.writeFile(mp, JSON.stringify(m, null, 2));
      attached++;
    } catch (e) { failed++; failures.push({ item: a.relativePath, error: String(e) }); console.error(`  FAIL attach ${a.relativePath}: ${e}`); }
  }

  console.log(`\nCreated ${created} projects, attached ${attached} originals, ${failed} failures.`);
  if (failures.length) await fsp.writeFile(path.join(os.tmpdir(), 'bookforge-migration-failures.json'), JSON.stringify(failures, null, 2));
  console.log(`ebooks/ untouched. Verify in-app before removing ebooks/.`);
}

main().catch(e => { console.error(e); process.exit(1); });
