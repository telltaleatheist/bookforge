#!/usr/bin/env node
/**
 * build-starter-library.js — package the bundled "starter library" sample.
 *
 * Output: release/starter-library/starter-<slug>.tar.gz  (+ a starter-<slug>.json sidecar)
 *
 * This is a COMPLETE, finished public-domain project (The Mysterious Stranger — edited text +
 * audiobook m4b + video + subtitles) that the app downloads ONCE into a brand-new, EMPTY library
 * on first run, so a fresh user has something real to look at. It is downloaded + sha256-verified
 * (like the e2a env tarball), NOT bundled in the installer and NOT part of the auto-update tiers.
 *
 * The archive is rooted at the LIBRARY ROOT so it extracts straight into {library}/:
 *   projects/<slug>/        the finished project (manifest + source + cleanup + output)
 *   media/<cover>.png       the cover (manifest coverPath is library-relative → "media/…")
 *
 * Trimmed for download size: the 1.8 GB stages/03-tts session cache (per-sentence WAVs / chapter
 * FLACs — regeneration intermediates) is EXCLUDED. Studio still reports the project 100% complete
 * because it scans output/*.m4b + stages/01-cleanup/*.epub, both of which are present. Syncthing
 * sync-conflict files, logs/, and archive/ are also dropped.
 *
 * Prereq: the source sample library must contain projects/<slug>/ + media/<cover>.
 *
 * Usage:
 *   node packaging/build-starter-library.js \
 *     [--source /Volumes/Callisto/Shared/Library] \
 *     [--slug "The_Mysterious_Stranger_-_Mark_Twain_(1916)"] \
 *     [--name the-mysterious-stranger]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'release', 'starter-library');

const DEFAULTS = {
  source: '/Volumes/Callisto/Shared/Library',
  slug: 'The_Mysterious_Stranger_-_Mark_Twain_(1916)',
  name: 'the-mysterious-stranger',
};

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function fail(msg) {
  console.error(`\n[build-starter-library] ERROR: ${msg}\n`);
  process.exit(1);
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Recursive copy with an exclusion predicate (src absolute path → true = skip).
function copyTree(src, dest, skip) {
  if (skip(src)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyTree(path.join(src, entry), path.join(dest, entry), skip);
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function main() {
  const source = arg('--source', DEFAULTS.source);
  const slug = arg('--slug', DEFAULTS.slug);
  const name = arg('--name', DEFAULTS.name);

  const projectSrc = path.join(source, 'projects', slug);
  if (!fs.existsSync(projectSrc)) fail(`project not found: ${projectSrc}`);

  const manifestPath = path.join(projectSrc, 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail(`missing manifest.json in ${projectSrc}`);

  // Portability guard: a starter project must carry NO machine-absolute paths.
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const leak = manifestText.match(/\/(Volumes|Users)\/[^"]+|[A-Za-z]:\\\\/);
  if (leak) fail(`manifest.json contains an absolute path (${leak[0]}) — not portable`);

  // Resolve the library-relative cover from the manifest. coverPath lives at metadata.coverPath
  // (it's library-relative, e.g. "media/cover_xxx.png"); search defensively in case it moves.
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    fail('manifest.json is not valid JSON');
  }
  const findCover = (o) => {
    if (!o || typeof o !== 'object') return null;
    for (const [k, v] of Object.entries(o)) {
      if (/cover.*path/i.test(k) && typeof v === 'string' && v) return v;
      const nested = findCover(v);
      if (nested) return nested;
    }
    return null;
  };
  const coverRel = manifest.metadata?.coverPath || manifest.coverPath || findCover(manifest);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stage = path.join(OUT_DIR, `.stage-${name}`);
  fs.rmSync(stage, { recursive: true, force: true });

  // What to EXCLUDE from the project (download-size trim + Syncthing cruft).
  const skip = (p) => {
    const base = path.basename(p);
    const rel = path.relative(projectSrc, p);
    if (rel === 'stages/03-tts' || rel.startsWith('stages/03-tts' + path.sep)) return true; // 1.8 GB cache
    if (rel === 'archive' || rel.startsWith('archive' + path.sep)) return true;
    if (base.includes('.sync-conflict-')) return true;
    if (base === '.DS_Store') return true;
    return false;
  };

  // Stage projects/<slug>/ (trimmed) + media/<cover> at the library-root-relative layout.
  copyTree(projectSrc, path.join(stage, 'projects', slug), skip);

  if (coverRel) {
    const coverSrc = path.join(source, coverRel);
    if (!fs.existsSync(coverSrc)) fail(`manifest coverPath "${coverRel}" not found at ${coverSrc}`);
    const coverDest = path.join(stage, coverRel);
    fs.mkdirSync(path.dirname(coverDest), { recursive: true });
    fs.copyFileSync(coverSrc, coverDest);
  } else {
    console.warn('[build-starter-library] WARN: manifest has no coverPath — shipping without a cover');
  }

  // Sanity: the finished deliverables Studio keys off must be present post-trim.
  const outputDir = path.join(stage, 'projects', slug, 'output');
  const hasM4b =
    fs.existsSync(outputDir) && fs.readdirSync(outputDir).some((f) => f.toLowerCase().endsWith('.m4b'));
  if (!hasM4b) fail('staged project has no output/*.m4b — it would not show as a finished audiobook');

  const outFile = path.join(OUT_DIR, `starter-${name}.tar.gz`);
  fs.rmSync(outFile, { force: true });
  // bsdtar everywhere (build-time is mac/linux here; matches downloader's runtime extraction).
  execFileSync('tar', ['-czf', outFile, '-C', stage, '.'], { stdio: 'inherit' });
  fs.rmSync(stage, { recursive: true, force: true });

  const bytes = fs.statSync(outFile).size;
  const hash = sha256(outFile);

  const sidecar = { name, slug, file: path.basename(outFile), sha256: hash, bytes, url: null };
  fs.writeFileSync(path.join(OUT_DIR, `starter-${name}.json`), JSON.stringify(sidecar, null, 2));

  console.log('\n[build-starter-library] done');
  console.log(`  file:    ${path.relative(ROOT, outFile)}`);
  console.log(`  slug:    ${slug}`);
  console.log(`  bytes:   ${bytes.toLocaleString()}  (${(bytes / 1e6).toFixed(0)} MB)`);
  console.log(`  sha256:  ${hash}`);
  console.log('\n  manifest.starter (url filled at publish):');
  console.log(
    JSON.stringify({ name, slug, url: '<github-release-url>', sha256: hash, bytes }, null, 2)
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n')
  );
}

main();
