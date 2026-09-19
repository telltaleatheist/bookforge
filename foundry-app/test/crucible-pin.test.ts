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
    expect(specifier).toMatch(/^file:vendor\/crucible-(client|bootstrap)-\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?\.tgz$/);
  }
});

/**
 * A PRE-RELEASE PACK IS ALLOWED AND MAY NOT BE SILENT.
 *
 * An app is sometimes built against a crucible BRANCH — PHASE19 part 2 is
 * built against `feat/phase19-automatic-wsl`, whose pack calls itself 1.0.5
 * because that is the release it will become. Two tarballs with one version
 * string is precisely the shape this file exists to catch, so the labelled one
 * is legal only while `app/package.json` carries a key saying where it came
 * from and what replaces it. Drop the pack and forget the note and the next
 * test fails; drop the note and keep the pack and this one does.
 */
test('a labelled pre-release pack is declared in package.json, never pinned quietly', () => {
  const labelled = PACKAGES
    .map((name) => manifest.dependencies[name] as string)
    .filter((specifier) => /-\d+\.\d+\.\d+-[A-Za-z0-9.]+\.tgz$/.test(specifier));
  if (labelled.length === 0) return;
  const notes = Object.entries(manifest)
    .filter(([key, value]) => key.startsWith('_crucible') && typeof value === 'string')
    .map(([, value]) => value as string)
    .join(' ');
  for (const specifier of labelled) {
    const file = path.basename(specifier);
    // The NOTE NAMES THE FILE, so a second pre-release pack cannot hide behind
    // the first one's paragraph.
    expect(notes).toContain(file);
    // And it says what ends it. A pre-release pin with no way back is a pin
    // nobody remembers to undo.
    expect(notes).toMatch(/replaced by|release tarball/);
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
  /*
   * THE VERSION IS THE FILENAME'S, LABEL OR NO LABEL. A pre-release pack
   * carries the version it will be released as, so the comparison is against
   * the version SEGMENT rather than the whole tail — and the label is checked
   * by the test above, which is where it belongs.
   */
  expect(path.basename(specifier)).toMatch(
    new RegExp(`-${bootstrap.version.replace(/\./g, '\\.')}(-[A-Za-z0-9.]+)?\\.tgz$`),
  );
});

test('the adoption script reads the same release out of package.json as the pins do', () => {
  const found = adopt.findManifest();
  expect(path.resolve(found.file)).toBe(path.join(APP, 'package.json'));
  const specifier: string = manifest.dependencies['@crucible/bootstrap'];
  expect(path.basename(specifier)).toMatch(
    new RegExp(`-${adopt.pinnedVersion(found.parsed).replace(/\./g, '\\.')}(-[A-Za-z0-9.]+)?\\.tgz$`),
  );
});
