/**
 * Foundry pins a Crucible release in three places and nothing held them together.
 *
 * `app/package.json` names the two vendored tarballs by filename, `app/vendor/`
 * holds the bytes, and the bytes carry their own version. Those can disagree
 * three ways — a pin updated without the download, a download without the pin,
 * or the two packages moved to different releases — and every one of them
 * installs cleanly and is wrong. BookForge has had a keeper for this shape since
 * `tools/test-crucible-install-seam.js`; Foundry had none.
 *
 * `tools/adopt-crucible-release.mjs` is what moves all three together, and it is
 * asked here about the pin this app actually carries, so its parsing is held to
 * the same fact the app is.
 */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP = path.dirname(import.meta.dir);
const REPO = path.dirname(APP);
const adopt = await import(path.join(REPO, 'tools', 'adopt-crucible-release.mjs'));

const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const PACKAGES = ['@crucible/client', '@crucible/bootstrap'] as const;

test('both Crucible packages are pinned to a vendored tarball, never a directory', () => {
  for (const name of PACKAGES) {
    const specifier = manifest.dependencies?.[name];
    expect(specifier).toBeString();
    expect(specifier).toMatch(/^file:vendor\/crucible-(client|bootstrap)-\d+\.\d+\.\d+\.tgz$/);
  }
});

test('the tarballs the pins name are actually in app/vendor/', () => {
  for (const name of PACKAGES) {
    const specifier: string = manifest.dependencies[name];
    const file = path.join(APP, specifier.replace(/^file:/, ''));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBeGreaterThan(0);
  }
});

test('vendor/ holds nothing from a release this app is not pinned to', () => {
  const pinned = new Set(PACKAGES.map((name) => path.basename(manifest.dependencies[name])));
  const stale = fs.readdirSync(path.join(APP, 'vendor'))
    .filter((file) => file.startsWith('crucible-') && !pinned.has(file));
  expect(stale).toEqual([]);
});

test('the installed package agrees with the filename it was installed from', async () => {
  const bootstrap = JSON.parse(
    fs.readFileSync(path.join(APP, 'node_modules', '@crucible', 'bootstrap', 'package.json'), 'utf8'),
  );
  const specifier: string = manifest.dependencies['@crucible/bootstrap'];
  expect(specifier).toContain(`-${bootstrap.version}.tgz`);
});

test('the adoption script reads the same release out of package.json as the pins do', () => {
  const found = adopt.findManifest();
  expect(path.resolve(found.file)).toBe(path.join(APP, 'package.json'));
  const specifier: string = manifest.dependencies['@crucible/bootstrap'];
  expect(specifier).toContain(`-${adopt.pinnedVersion(found.parsed)}.tgz`);
});
