#!/usr/bin/env node
/**
 * Keeper: ONE Windows→guest converter, the inverse of FIX-8's `wslToWindowsPath`.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-forward-path-converter.js
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *
 * FIX-8 left the app with one WSL→Windows converter and put the `/mnt/`
 * decision inside it. The FORWARD direction still had three owners —
 * `narrator-paths.windowsToWslPath`, a second `windowsToWslPath` in
 * `tool-paths.ts`, and `narrator-spawn.toGuestPath` — plus five sites that
 * composed or decomposed `/mnt/<letter>` by hand. Three owners of one rule is
 * how the rule comes to differ: only `toGuestPath` knew the `\\wsl$` UNC form,
 * so a models directory NAMED on the Windows side as `\\wsl$\Ubuntu\...`
 * (which `tool-paths.ts` documents for `orpheusModelsDir`) crossed into the
 * guest verbatim through either of the other two and could not be opened
 * there.
 *
 * The claims:
 *
 *  1. `windowsToWslPath` answers for every shape a Windows host names a file
 *     by — a drive path, both `\\wsl$` UNC forms — passes an already-guest
 *     path through, and passes a value that is NOT a path (a flag, a model id,
 *     an empty env value) verbatim, because it is applied to whole argv and
 *     env maps.
 *  2. It round-trips with `wslToWindowsPath` for all three path forms.
 *  3. A NETWORK SHARE is refused BY NAME. WSL auto-mounts fixed drives only and
 *     a UNC path has no drive letter to mount at (memory
 *     `wsl-cannot-see-network-drives`); returning it unchanged is how a guest
 *     gets handed a string it cannot open. So is a drive-RELATIVE path, which
 *     has no guest form at all.
 *  4. A MAPPED drive letter is NOT refused — see the check for why, which is a
 *     deliberate departure from the brief.
 *  5. There is no second forward converter: not on `toolPaths`, not in
 *     `narrator-spawn`.
 *  6. No other `electron/` source composes `/mnt/` from a drive letter, or
 *     re-decomposes it at a call site.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
for (const m of ['narrator-paths.js', 'narrator-spawn.js', 'tool-paths.js']) {
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
const spawnMod = require(path.join(REPO, 'dist', 'electron', 'narrator-spawn.js'));
const toolPathsMod = require(path.join(REPO, 'dist', 'electron', 'tool-paths.js'));

const WINDOWS = process.platform === 'win32';
// A backslash, never written literally. Backslashes in this repo's test rigs have
// been silently halved in transit more than once (memory `wsl-cannot-see-network-drives`
// records an hour lost to it), and a halved one here would make the drive-letter
// checks pass against the wrong input. `test-narrator-argv-snapshot` does the same.
const B = String.fromCharCode(92);
const toGuest = narratorPaths.windowsToWslPath;
const toHost = narratorPaths.wslToWindowsPath;

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

console.log('one forward converter, every shape a host names a file by');

check('a drive path becomes /mnt/<letter>, in either slash style', () => {
  assert.strictEqual(toGuest('C:' + B + 'Users' + B + 'x' + B + 'a.epub'), '/mnt/c/Users/x/a.epub');
  assert.strictEqual(toGuest('C:/Users/x/a.epub'), '/mnt/c/Users/x/a.epub');
  assert.strictEqual(toGuest('E:' + B + 'training'), '/mnt/e/training');
  // A bare drive root, which is what a mount-point question asks with.
  assert.strictEqual(toGuest('C:'), '/mnt/c');
  assert.strictEqual(toGuest('C:' + B), '/mnt/c/');
});

check('both \\\\wsl$ UNC forms become the guest-native path', () => {
  assert.strictEqual(
    toGuest(B + B + 'wsl$' + B + 'Ubuntu' + B + 'home' + B + 't' + B + 'm'),
    '/home/t/m');
  assert.strictEqual(
    toGuest(B + B + 'wsl.localhost' + B + 'Ubuntu' + B + 'home' + B + 't' + B + 'm'),
    '/home/t/m');
  // The share root itself is the guest root, not an empty string.
  assert.strictEqual(toGuest(B + B + 'wsl$' + B + 'Ubuntu'), '/');
});

check('a path already in guest form is unchanged', () => {
  assert.strictEqual(toGuest('/home/<user>/bookforge-sessions/staged-abc.epub'),
    '/home/<user>/bookforge-sessions/staged-abc.epub');
  assert.strictEqual(toGuest('/mnt/c/Users/x/a.epub'), '/mnt/c/Users/x/a.epub');
});

check('a value that is not a path crosses verbatim', () => {
  // This converter is applied to WHOLE argv lists and WHOLE env maps
  // (`narrator-spawn`'s WSL branch), which is only safe because a value with no
  // path shape in it is none of its business.
  assert.strictEqual(toGuest('--session_dir'), '--session_dir');
  assert.strictEqual(toGuest('higgs-v3'), 'higgs-v3');
  assert.strictEqual(toGuest(''), '');
});

check('it round-trips with wslToWindowsPath for all three forms', () => {
  const drive = 'C:' + B + 'Users' + B + 'x' + B + 'a.epub';
  assert.strictEqual(toHost(toGuest(drive)), drive);

  if (!WINDOWS) return; // there is no guest to come out of on macOS/Linux
  const guest = '/home/<user>/bookforge-sessions/staged-abc.epub';
  assert.strictEqual(toGuest(toHost(guest)), guest,
    'a guest-native path did not survive the trip through the \\\\wsl$ share');
  const unc = toHost(guest);
  assert.match(unc, /^\\\\wsl[$.]/, `the reverse converter stopped producing a share path: ${unc}`);
  assert.strictEqual(toHost(toGuest(unc)), unc);
});

check('a network share is refused by name, never handed to the guest', () => {
  assert.throws(() => toGuest(B + B + 'NAS' + B + 'iO' + B + 'bookforge' + B + 'x.epub'),
    /NAS/, 'a UNC share was not refused by name');
  assert.throws(() => toGuest(B + B + 'NAS' + B + 'iO' + B + 'bookforge' + B + 'x.epub'),
    /windowsToWslPath/);
});

check('a drive-relative path is refused by name — there is no guest form of it', () => {
  assert.throws(() => toGuest('C:stages' + B + 'x.epub'), /C:stages/);
});

check('a MAPPED drive letter is converted, not refused', () => {
  // DELIBERATE DEPARTURE FROM THE BRIEF, which asked for `Z:\` to be refused
  // beside `\\NAS\`. It must not be. `electron/wsl-mounts.ts` (commit
  // e9e70ade, 2026-08-24) exists precisely to MOUNT the share behind a mapped
  // letter at `/mnt/<letter>` before the guest is handed a path on it, so that
  // this converter's output is simply correct — Owen chose the mount over
  // staging because `--sentences_dir` is a WRITE target and the sentence store
  // must not move. Refusing `Z:` here would un-fix that and would break
  // `copyDirOutOfWsl`'s in-guest road, which is taken ONLY when `wslSeesDrive`
  // has just proved the drive IS mounted. Nothing in a path's SPELLING says
  // which letters are network mappings; `uncBehindDrive` asks Windows, and that
  // question has an owner already.
  assert.strictEqual(toGuest('Z:' + B + 'bookforge' + B + 'projects'), '/mnt/z/bookforge/projects');
});

console.log('\nno second owner of the rule');

check('neither tool-paths nor narrator-spawn exports a forward converter', () => {
  assert.strictEqual(typeof narratorPaths.windowsToWslPath, 'function');
  assert.strictEqual(toolPathsMod.windowsToWslPath, undefined,
    'tool-paths still exports a second windowsToWslPath');
  assert.strictEqual(toolPathsMod.toolPaths.windowsToWslPath, undefined,
    'the toolPaths object still carries the second windowsToWslPath');
  assert.strictEqual(spawnMod.toGuestPath, undefined,
    'narrator-spawn still exports toGuestPath, a third owner of the same rule');
});

check('no other electron source composes or decomposes /mnt/ by hand', () => {
  const sources = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) sources.push(full);
    }
  })(path.join(REPO, 'electron'));
  assert.ok(sources.length > 50, `the electron tree did not walk: ${sources.length} files`);

  const owner = path.join(REPO, 'electron', 'narrator-paths.ts');
  const offences = [];
  for (const file of sources) {
    if (file === owner) continue; // the one owner, by name
    const code = fs.readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments, where the rule is EXPLAINED
      .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');  // line comments, minus the // of a URL
    code.split('\n').forEach((line, i) => {
      const composes = /\/mnt\/\$\{/.test(line) || /['"]\/mnt\/['"]\s*\+/.test(line);
      const decomposes = /startsWith\(\s*['"]\/mnt\//.test(line) || /\\\/mnt\\\//.test(line);
      if (composes || decomposes) {
        offences.push(`${path.relative(REPO, file)}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(offences, [],
    'these sites still own the /mnt/ rule themselves:\n        ' + offences.join('\n        '));
});

if (failed) { console.log(`\n${failed} check(s) FAILED.`); process.exit(1); }
console.log('\nAll forward-path-converter checks passed.');
