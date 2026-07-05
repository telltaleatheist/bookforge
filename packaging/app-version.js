#!/usr/bin/env node
/**
 * The build version — derived automatically so NO manual package.json bump is ever
 * needed for packaging or publishing.
 *
 *   version = <major>.<minor>.<git-commit-count>
 *
 * major.minor come from package.json (bump those only for an intentional headline
 * release); the patch is `git rev-list --count HEAD`, which increases by one per
 * commit. So every commit yields a higher, monotonic version — what the
 * component-updater's requiresApp gate compares against, with zero human
 * bookkeeping.
 *
 * Falls back to the literal package.json version when git isn't available (e.g. a
 * source tarball with no .git), so a build never breaks.
 *
 * Injected into electron-builder via extraMetadata.version by build-dmg.js (mac),
 * run-builder.js and package-win.js (win) — app.getVersion() returns it at runtime.
 */
const { execSync } = require('node:child_process');
const path = require('node:path');

function computeVersion() {
  const pkg = require(path.resolve(__dirname, '..', 'package.json'));
  const [major = '0', minor = '0'] = String(pkg.version).split('.');
  let count;
  try {
    count = execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return String(pkg.version); // no git — use package.json as-is
  }
  if (!/^\d+$/.test(count)) return String(pkg.version);
  return `${major}.${minor}.${count}`;
}

module.exports = { computeVersion };

// CLI: `node packaging/app-version.js` prints the version (handy for shells/CI).
if (require.main === module) {
  process.stdout.write(computeVersion() + '\n');
}
