/**
 * publish-app.js — upload a built BookForge installer to GitHub under a STABLE name, so
 * owenmorgan.com/tools can use a permanent "latest" URL that never needs editing per release.
 *
 * BookForge builds with electron-builder (no publish provider), so we upload with the `gh` CLI.
 *
 * The trick: the public download URLs are GitHub's permanent redirects
 *   https://github.com/<repo>/releases/latest/download/<stable-name>     (app: mac/win)
 *   https://github.com/<repo>/releases/download/extension/<stable-name>  (extension: fixed tag)
 * For /latest/download to resolve, the app release must (a) carry the STABLE-named asset and
 * (b) be marked "Latest". So per platform we copy the versioned build to a version-less name,
 * upload it to the per-version release tag v<version>, and mark that release --latest. The
 * versioned release tag still gives you history; /tools just follows "latest".
 *
 * The extension versions independently from the app, so it lives on a FIXED `extension` release
 * tag (clobbered each time) — decoupled from app version bumps.
 *
 *   node packaging/publish-app.js --mac                       # release/BookForge-<ver>-arm64.dmg  -> latest/BookForge-mac-arm64.dmg
 *   node packaging/publish-app.js --win                       # release/"BookForge Setup <ver>.exe" -> latest/BookForge-win-x64.exe
 *   node packaging/publish-app.js --win --file "<path.exe>"   # upload a win .exe built elsewhere (e.g. from the Callisto share)
 *   node packaging/publish-app.js --extension                 # extension/bookforge-reader-<ver>.zip -> extension/bookforge-reader.zip
 *   ... add --dry-run to any of the above to preview without uploading.
 *
 * Version is NOT bumped here — run `npm run version:bump` first when you want a new version,
 * commit/push it, then build + publish. Requires `gh auth login` once (or GITHUB_TOKEN/GH_TOKEN).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const VERSION = pkg.version;
const REPO = process.env.BOOKFORGE_GH_REPO || 'telltaleatheist/bookforge';
const OUT_DIR = path.join(ROOT, (pkg.build && pkg.build.directories && pkg.build.directories.output) || 'release');
const EXT_DIR = path.join(ROOT, 'extension');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const fileArg = (() => { const i = args.indexOf('--file'); return i !== -1 ? args[i + 1] : null; })();
const which = args.includes('--win') ? 'win' : args.includes('--mac') ? 'mac' : args.includes('--extension') ? 'extension' : null;

function fail(msg) { console.error(`\n[publish-app] ${msg}`); process.exit(1); }
function sh(cmd, a) { return execFileSync(cmd, a, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }

if (!which) fail('Specify --mac, --win, or --extension.');

// Per-target config: where the build lands, how to recognize it, and the STABLE asset name.
const TARGETS = {
  mac: { dir: OUT_DIR, tag: `v${VERSION}`, latest: true,
         match: (f) => f.endsWith('.dmg') && f.includes(VERSION), stable: 'BookForge-mac-arm64.dmg' },
  win: { dir: OUT_DIR, tag: `v${VERSION}`, latest: true,
         match: (f) => f.endsWith('.exe') && f.includes(VERSION), stable: 'BookForge-win-x64.exe' },
  extension: { dir: EXT_DIR, tag: 'extension', latest: false,
         match: (f) => /^bookforge-reader-.*\.zip$/.test(f), stable: 'bookforge-reader.zip' },
};
const T = TARGETS[which];

// gh availability + auth.
try { sh('gh', ['--version']); } catch { fail('GitHub CLI (gh) not found. Install it or set GITHUB_TOKEN.'); }
if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
  try { sh('gh', ['auth', 'status']); } catch { fail('Not authenticated. Run `gh auth login` once, or export GITHUB_TOKEN.'); }
}

// Resolve the built artifact: an explicit --file wins; otherwise find it in the target's dir.
let builtPath;
if (fileArg) {
  builtPath = path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), fileArg);
  if (!fs.existsSync(builtPath)) fail(`--file not found: ${builtPath}`);
} else {
  if (!fs.existsSync(T.dir)) fail(`Dir not found: ${T.dir}. Build first.`);
  const hit = fs.readdirSync(T.dir).filter((f) => !f.startsWith('._')).find(T.match);
  if (!hit) fail(`No ${which} artifact for v${VERSION} in ${T.dir}. Build first.`);
  builtPath = path.join(T.dir, hit);
}

// Copy to the stable, version-less name in a temp dir (gh names the asset after the file).
const staged = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-pub-')), T.stable);
fs.copyFileSync(builtPath, staged);

const sizeMB = (fs.statSync(builtPath).size / 1e6).toFixed(1);
const dlUrl = T.latest
  ? `https://github.com/${REPO}/releases/latest/download/${T.stable}`
  : `https://github.com/${REPO}/releases/download/${T.tag}/${T.stable}`;

console.log(`[publish-app] ${which}: ${path.basename(builtPath)} (${sizeMB} MB) -> ${T.tag}/${T.stable}${T.latest ? ' [latest]' : ''}`);
console.log(`[publish-app] permanent /tools URL: ${dlUrl}`);

const releaseExists = (() => { try { sh('gh', ['release', 'view', T.tag, '--repo', REPO]); return true; } catch { return false; } })();

if (DRY) {
  console.log(`\n[dry-run] release ${T.tag} ${releaseExists ? 'exists' : 'would be created'}${T.latest ? ', would mark --latest' : ''}; no upload.`);
  process.exit(0);
}

if (!releaseExists) {
  const title = which === 'extension' ? 'BookForge Reader (browser extension)' : `BookForge ${VERSION}`;
  console.log(`\n[publish-app] creating release ${T.tag}…`);
  execFileSync('gh', ['release', 'create', T.tag, '--repo', REPO,
    '--title', title,
    '--notes', `BookForge ${which === 'extension' ? 'browser extension' : VERSION}. Unsigned build — SmartScreen / Gatekeeper may warn (false positive). macOS: right-click → Open.`,
  ], { stdio: 'inherit' });
}

console.log(`[publish-app] uploading ${T.stable} to ${T.tag}…`);
execFileSync('gh', ['release', 'upload', T.tag, staged, '--clobber', '--repo', REPO], { stdio: 'inherit' });

if (T.latest) {
  console.log(`[publish-app] marking ${T.tag} as the latest release…`);
  execFileSync('gh', ['release', 'edit', T.tag, '--latest', '--repo', REPO], { stdio: 'inherit' });
}

console.log(`\n[publish-app] done. Permanent URL (no /tools edit needed): ${dlUrl}`);
