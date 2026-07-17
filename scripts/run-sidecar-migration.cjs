#!/usr/bin/env node
// Migrate the library to hash-bound sidecars (bookforge-sidecar-binding-v1):
// extract each audiobook's embedded transcript + cover into `<m4b>.vtt`,
// `<m4b>.cover.<ext>`, and `<m4b>.sidecars.json`, each provably tied to its m4b.
//
// Usage:
//   node scripts/run-sidecar-migration.cjs [--apply] [--limit N] [--project SLUG] [--library PATH]
//   npm run migrate:sidecars -- --apply
//
// Default is a DRY-RUN (writes nothing). Pass --apply to write. Additive and
// reversible: delete the three sidecar files per m4b to undo.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

// Resolve the library root: --library, then $LIB, then the per-user config file.
function resolveLibraryRoot() {
  const override = getArg('--library') || process.env.LIB;
  if (override) return override;
  const stub = require('./electron-stub.cjs');
  const cfgPath = path.join(stub.app.getPath('userData'), 'library-root.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.libraryRoot) return cfg.libraryRoot;
  } catch { /* fall through */ }
  return path.join(stub.app.getPath('documents'), 'BookForge');
}

const outfile = path.join(os.tmpdir(), `bookforge-sidecar-migration-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'electron', 'sidecar-migration.ts')],
  outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning',
  external: ['esbuild'],
  alias: { electron: path.join(__dirname, 'electron-stub.cjs') },
});
const { migrateLibrary } = require(outfile);

(async () => {
  const libraryRoot = resolveLibraryRoot();
  const dryRun = !args.includes('--apply');
  console.log(`[sidecar-migration] library: ${libraryRoot}`);
  console.log(`[sidecar-migration] mode:    ${dryRun ? 'DRY-RUN (no writes) — pass --apply to write' : 'APPLY'}`);
  let n = 0;
  const summary = await migrateLibrary({
    libraryRoot,
    dryRun,
    limit: getArg('--limit') ? Number(getArg('--limit')) : undefined,
    onlyProject: getArg('--project'),
    onProgress: () => { if (++n % 25 === 0) process.stderr.write(`  …${n} variants\n`); },
  });
  const { outcomes, ...totals } = summary;
  console.log('\n=== SIDECAR MIGRATION', dryRun ? '(DRY-RUN)' : '(APPLIED)', '===');
  console.log(totals);
  const issues = outcomes.filter(o => o.flags.length || o.vtt.action === 'error' || o.cover.action === 'error');
  if (issues.length) {
    console.log(`\n--- issues (${issues.length}) ---`);
    for (const o of issues) console.log(' ', o.projectId, '·', o.variantId,
      '| flags:', o.flags.join(',') || '-', '| vtt:', o.vtt.action, o.vtt.error || '', '| cover:', o.cover.action, o.cover.error || '');
  }
  try { fs.unlinkSync(outfile); } catch { /* temp cleanup best-effort */ }
})().catch(e => { console.error('[sidecar-migration] FAILED:', e); process.exit(1); });
