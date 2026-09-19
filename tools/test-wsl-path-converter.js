#!/usr/bin/env node
/**
 * Keeper: ONE WSL→Windows converter, and the `/mnt/` decision is inside it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-wsl-path-converter.js
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *
 * A guest render writes `source_epub_path` into `session-state.json` as the
 * GUEST sees it. For a WSL prep that is a guest-native path
 * (`<guest sessions root>/staged-<uuid>.epub`) — all three golden fixtures
 * carry exactly that. `reassembly-bridge`'s metadata lookup converted only
 * paths beginning `/mnt/`, so a guest-native one went into `path.dirname`
 * unchanged, `project.json` was looked for at a Linux string that cannot exist
 * on Windows, and the session took the no-metadata branch WITHOUT SAYING SO:
 * the reassembled m4b lost its title, author, year, series and cover.
 *
 * The claims:
 *
 *  1. `wslToWindowsPath` answers for BOTH guest forms — `/mnt/<letter>/…` to
 *     the drive itself, guest-native to the `\\wsl$` share — and passes an
 *     already-Windows path through. Anything else is REFUSED by name; there is
 *     no third form to guess at.
 *  2. The `/mnt/` test is not re-composed by the caller: reassembly-bridge
 *     converts unconditionally.
 *  3. A session whose EPUB resolves to a directory with no `project.json` is
 *     LOUD — a console line naming the path it looked at — instead of silently
 *     returning no metadata. Driven with the three golden fixtures' own
 *     `source_epub_path` values.
 *  4. A resolvable project still yields its metadata, by `/mnt/` path and by
 *     Windows path alike.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
for (const m of ['narrator-paths.js', 'reassembly-bridge.js']) {
  if (!fs.existsSync(path.join(REPO, 'dist', 'electron', m))) {
    console.error('Compile first: npx tsc -p tsconfig.electron.json');
    process.exit(1);
  }
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'estub';
  return origResolve.call(this, request, ...rest);
};
require.cache['estub'] = {
  id: 'estub', filename: 'estub', loaded: true,
  exports: {
    app: { getPath: () => REPO, getAppPath: () => REPO, on() {}, isPackaged: false },
    ipcMain: { handle() {}, on() {} },
    BrowserWindow: class {},
    shell: {},
  },
};
const narratorPaths = require(path.join(REPO, 'dist', 'electron', 'narrator-paths.js'));
const reassembly = require(path.join(REPO, 'dist', 'electron', 'reassembly-bridge.js'));

const WINDOWS = process.platform === 'win32';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-wslpath-'));

let failed = 0;
let captured = [];
async function check(name, fn) {
  captured = [];
  const real = { warn: console.warn, error: console.error, log: console.log };
  console.warn = (...a) => captured.push(a.map(String).join(' '));
  console.error = (...a) => captured.push(a.map(String).join(' '));
  console.log = (...a) => captured.push(a.map(String).join(' '));
  try {
    await fn();
    Object.assign(console, real);
    console.log(`  ok    ${name}`);
  } catch (err) {
    Object.assign(console, real);
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

(async () => {
  console.log('one converter, both guest forms');

  await check('a mounted-drive path becomes the drive itself', () => {
    assert.strictEqual(narratorPaths.wslToWindowsPath('/mnt/c/Users/x/a.epub'), 'C:\\Users\\x\\a.epub');
    assert.strictEqual(narratorPaths.wslToWindowsPath('/mnt/e/training'), 'E:\\training');
  });

  await check('a guest-native path becomes the \\\\wsl$ share, not a Linux string', () => {
    if (!WINDOWS) {
      // There is no guest to come out of on macOS/Linux: an absolute POSIX
      // path there IS the host's own path and must not be rewritten.
      assert.strictEqual(
        narratorPaths.wslToWindowsPath('/home/<user>/bookforge-sessions/staged-abc.epub'),
        '/home/<user>/bookforge-sessions/staged-abc.epub');
      return;
    }
    const out = narratorPaths.wslToWindowsPath('/home/<user>/bookforge-sessions/staged-abc.epub');
    assert.match(out, /^\\\\wsl[$.]/, `guest-native path was not converted: ${out}`);
    assert.ok(out.endsWith('\\home\\<user>\\bookforge-sessions\\staged-abc.epub'),
      `converted path lost its tail: ${out}`);
    // And `path.dirname` on the answer is a directory Windows can open.
    assert.ok(path.dirname(out).endsWith('\\home\\<user>\\bookforge-sessions'));
  });

  await check('an already-Windows path is passed through, drive or UNC', () => {
    assert.strictEqual(narratorPaths.wslToWindowsPath('C:\\Users\\x\\a.epub'), 'C:\\Users\\x\\a.epub');
    assert.strictEqual(narratorPaths.wslToWindowsPath('Z:/<library>/projects/x'), 'Z:/<library>/projects/x');
    assert.strictEqual(narratorPaths.wslToWindowsPath('\\\\wsl$\\Ubuntu\\home\\x'), '\\\\wsl$\\Ubuntu\\home\\x');
    assert.strictEqual(narratorPaths.wslToWindowsPath('\\\\NAS\\bookforge\\x'), '\\\\NAS\\bookforge\\x');
  });

  await check('anything that is neither is refused by name, never returned as-is', () => {
    assert.throws(() => narratorPaths.wslToWindowsPath(''), /wslToWindowsPath/);
    assert.throws(() => narratorPaths.wslToWindowsPath('stages/03-tts/x.epub'), /stages\/03-tts\/x\.epub/);
  });

  await check('there is no second exported converter beside it', () => {
    assert.strictEqual(typeof narratorPaths.wslToWindowsPath, 'function');
    assert.strictEqual(narratorPaths.wslPathToWindows, undefined,
      'narrator-paths still exports a second WSL→Windows name beside wslToWindowsPath');
    assert.strictEqual(narratorPaths.narratorPaths.wslPathToWindows, undefined,
      'the narratorPaths object still carries the second name');
  });

  console.log('\nthe reassembly metadata lookup');

  await check('a project reached through /mnt/ and through its Windows path give the same metadata', async () => {
    const drive = path.parse(ROOT).root.replace(/[\\/:]/g, '').toLowerCase();
    const proj = path.join(ROOT, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'project.json'),
      JSON.stringify({ metadata: { title: 'Mutineers Moon', author: 'David Weber', year: '1991' } }));
    const epubWin = path.join(proj, 'cleaned.epub');
    fs.writeFileSync(epubWin, 'not really an epub');

    const byWindows = await reassembly.getProjectJsonMetadataFromSourcePath(epubWin);
    assert.ok(byWindows, 'no metadata for a plain Windows source path');
    assert.strictEqual(byWindows.title, 'Mutineers Moon');

    if (WINDOWS) {
      const epubMnt = `/mnt/${drive}${epubWin.slice(2).replace(/\\/g, '/')}`;
      const byMnt = await reassembly.getProjectJsonMetadataFromSourcePath(epubMnt);
      assert.ok(byMnt, `no metadata for the same project reached as ${epubMnt}`);
      assert.strictEqual(byMnt.title, 'Mutineers Moon');
    }
  });

  await check("each golden fixture's guest-native source_epub_path is resolved and the miss is loud", async () => {
    const goldenRoot = path.join(REPO, 'python', 'narrator', 'tests', 'golden');
    const fixtures = fs.readdirSync(goldenRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(goldenRoot, e.name, 'session-state.json'))
      .filter((p) => fs.existsSync(p));
    assert.ok(fixtures.length >= 3, `expected the golden fixtures, found ${fixtures.length}`);

    let guestNative = 0;
    for (const fixture of fixtures) {
      const state = JSON.parse(fs.readFileSync(fixture, 'utf-8'));
      const source = state.source_epub_path;
      if (!source || source.startsWith('/mnt/') || /^[A-Za-z]:/.test(source)) continue;
      guestNative += 1;

      captured = [];
      const got = await reassembly.getProjectJsonMetadataFromSourcePath(source);
      assert.strictEqual(got, null,
        `${fixture}: a staged EPUB in the guest has no project.json beside it`);
      const said = captured.join('\n');
      assert.ok(said.includes(source),
        `${fixture}: the lookup was SILENT about ${source}. Lines: ${JSON.stringify(captured)}`);
      if (WINDOWS) {
        assert.match(said, /\\\\wsl[$.]/,
          `${fixture}: the path it looked at was never converted out of the guest. Lines: ${JSON.stringify(captured)}`);
      }
    }
    assert.ok(guestNative >= 3, `expected 3 guest-native fixtures, saw ${guestNative}`);
  });

  await check('reassembly-bridge does not re-compose the /mnt/ test at the call site', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'reassembly-bridge.ts'), 'utf-8');
    const at = src.indexOf('export async function getProjectJsonMetadataFromSourcePath(');
    assert.ok(at > 0, 'the metadata lookup moved');
    const body = src.slice(at, at + 1600);
    assert.ok(!/startsWith\('\/mnt\/'\)/.test(body),
      'the caller still decides whether to convert — the decision belongs inside the converter');
    assert.match(body, /wslToWindowsPath\(/, 'the caller no longer converts at all');
  });

  try { fs.rmSync(ROOT, { recursive: true, force: true }); }
  catch { /* a temp dir that will not go is not a test failure */ }

  if (failed) { console.log(`\n${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\nAll wsl-path-converter checks passed.');
})().catch((err) => {
  console.error('wsl-path-converter: the suite itself failed:', err);
  process.exit(1);
});
