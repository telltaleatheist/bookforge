/**
 * THE CONNECT CODE ON THIS MACHINE — and the two places BookForge's reader and
 * the SDK's do not agree.
 *
 * crucible `docs/PHASE15-HOST.md` §3.6 and §5.1. These checks used to live in
 * `test-crucible-settings-seam.js`, which was a suite about a stand-in for an
 * SDK that had not shipped. The SDK shipped on 2026-09-14 and that seam was
 * deleted — but `electron/crucible/pairing-file.ts` did NOT go with it, for
 * two reasons its header sets out in full, and a reader that survives its own
 * seam needs a suite of its own saying why.
 *
 * ── THE PART THAT MATTERS: SECTION 3 ──────────────────────────────────────
 *
 * Checks 1 and 2 are the ordinary thing — our reader does what §3.6 says.
 * Section 3 is the point of the file: it asserts, EXPLICITLY, where our reader
 * and `@crucible/client`'s `cruciblePairingPath` DISAGREE.
 *
 * Two implementations of one rule is the defect the contract exists to
 * prevent, and this suite does not hide it behind a comment. It states it, so
 * that the day the SDK adopts the Windows case the check goes red and says
 * what to do — and so that until then nobody reads our extra branch as an
 * oversight and "tidies" it away.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

const READER = path.join(REPO, 'dist', 'electron', 'crucible', 'pairing-file.js');
if (!fs.existsSync(READER)) {
  console.log('SKIP: dist/electron/crucible/pairing-file.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json');
  process.exit(0);
}

const pairingFile = require(READER);
const local = require(path.join(REPO, 'dist', 'electron', 'crucible', 'local.js'));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
  }
}

/** A host with the pairing door CLOSED, which is the "no engine here" fact. */
const hostWith = (over) => Object.assign({
  platform: 'linux', env: {}, homedir: '/home/t', readFile: () => null,
}, over);

console.log('the connect code on this machine');

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. Where it is (§3.6)
  // ───────────────────────────────────────────────────────────────────────────

  await check('the pairing file is where PHASE15 3.6 pins it, on each platform', () => {
    assert.strictEqual(
      pairingFile.cruciblePairingFilePath(hostWith({ platform: 'linux' })),
      path.join('/home/t', '.crucible', 'pairing'));
    assert.strictEqual(
      pairingFile.cruciblePairingFilePath(hostWith({ platform: 'darwin' })),
      path.join('/home/t', '.crucible', 'pairing'));
    assert.strictEqual(
      pairingFile.cruciblePairingFilePath(hostWith({
        platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' },
      })),
      path.join('C:\\Users\\t\\AppData\\Local', 'Crucible', 'pairing'));
  });

  await check('$CRUCIBLE_HOME overrides on every platform; an empty one does not', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      assert.strictEqual(
        pairingFile.cruciblePairingFilePath(hostWith({
          platform, env: { CRUCIBLE_HOME: '/srv/cru', LOCALAPPDATA: 'C:\\L' },
        })),
        path.join('/srv/cru', 'pairing'), platform);
    }
    assert.strictEqual(
      pairingFile.cruciblePairingFilePath(hostWith({ env: { CRUCIBLE_HOME: '' } })),
      path.join('/home/t', '.crucible', 'pairing'));
  });

  await check('Windows with no LOCALAPPDATA is refused by name, never assembled from a username', () => {
    let caught = null;
    try {
      pairingFile.cruciblePairingFilePath(hostWith({ platform: 'win32', env: {} }));
    } catch (err) { caught = err; }
    assert.ok(caught !== null, 'a path was produced out of nothing');
    assert.strictEqual(caught.code, 'no_local_app_data');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. What it reads
  // ───────────────────────────────────────────────────────────────────────────

  await check('no file is null — a FACT, not a throw and not a retry', () => {
    assert.strictEqual(pairingFile.readCruciblePairingFile(hostWith({})), null);
  });

  await check('a connect code is read and parsed by the SDK parser, with its file named', () => {
    const line = 'crucible://crucible%40owens-pc@127.0.0.1:7100/#tok-abcdefghij\n';
    const got = pairingFile.readCruciblePairingFile(hostWith({ readFile: () => line }));
    assert.strictEqual(got.pairing.name, 'crucible@owens-pc');
    assert.strictEqual(got.pairing.url, 'http://127.0.0.1:7100');
    assert.strictEqual(got.pairing.token, 'tok-abcdefghij');
    assert.strictEqual(got.file, path.join('/home/t', '.crucible', 'pairing'));
  });

  await check('an empty or malformed pairing file is NOT read as "no engine"', () => {
    let caught = null;
    try { pairingFile.readCruciblePairingFile(hostWith({ readFile: () => '  \n' })); } catch (e) { caught = e; }
    assert.strictEqual(caught && caught.code, 'pairing_file_empty');
    caught = null;
    try { pairingFile.readCruciblePairingFile(hostWith({ readFile: () => 'http://127.0.0.1:7100' })); } catch (e) { caught = e; }
    assert.strictEqual(caught && caught.code, 'pairing_file_invalid');
    assert.ok(caught.message.includes('pairing'), 'the refusal names the file');
    assert.ok(!caught.message.includes('tok-'), 'a refusal never carries a token');
  });

  await check('readLocalServer asks the pairing file FIRST, and does not touch WSL when it answers', () => {
    const line = 'crucible://crucible%40owens-pc-wsl@127.0.0.1:7100/#tok-abcdefghij\n';
    const got = local.readLocalServer({
      platform: 'win32',
      env: {},
      homedir: 'C:\\Users\\t',
      wslDistro: 'crucible',
      pairing: hostWith({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, readFile: () => line }),
      runWsl: () => { throw new Error('the WSL door was opened although a connect code was there'); },
    });
    assert.strictEqual(got.via, 'pairing');
    assert.strictEqual(got.name, 'crucible@owens-pc-wsl');
    assert.strictEqual(got.url, 'http://127.0.0.1:7100');
    assert.strictEqual(got.token, 'tok-abcdefghij');
    assert.strictEqual(got.configPath, path.join('C:\\L', 'Crucible', 'pairing'));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. WHERE WE AND THE SDK DISAGREE — stated, not hidden
  // ───────────────────────────────────────────────────────────────────────────

  const sdk = require('@crucible/client');

  await check('the SDK HAS a pairing reader, and it is async — which is reason one', () => {
    /*
     * If this ever goes red because the names are gone, the SDK has changed
     * its mind and `pairing-file.ts`'s first reason needs re-reading before
     * anything else in this section is believed.
     */
    assert.strictEqual(typeof sdk.readPairingFile, 'function');
    assert.strictEqual(typeof sdk.cruciblePairingPath, 'function');
    const promise = sdk.cruciblePairingPath('/srv/cru');
    assert.ok(promise instanceof Promise,
      'cruciblePairingPath is synchronous now — then reason one is gone: delete '
      + 'electron/crucible/pairing-file.ts and have readLocalServer use the SDK.');
    return promise.then(() => undefined);
  });

  await check('we AGREE with the SDK on $CRUCIBLE_HOME and on linux/darwin', async () => {
    // The part that is genuinely one rule, checked rather than assumed.
    const ours = pairingFile.cruciblePairingFilePath(
      hostWith({ platform: 'linux', env: { CRUCIBLE_HOME: '/srv/cru' } }));
    assert.strictEqual(await sdk.cruciblePairingPath('/srv/cru'), ours);
    assert.strictEqual(sdk.CRUCIBLE_HOME_ENV, pairingFile.CRUCIBLE_HOME_ENV);
    assert.strictEqual(sdk.PAIRING_FILE, pairingFile.PAIRING_FILE_NAME);
  });

  await check('WE DISAGREE ON WINDOWS — a known SDK defect, and this is its tripwire', async () => {
    /*
     * §3.6's table: on Windows the file is `%LOCALAPPDATA%\\Crucible\\pairing`,
     * because the thing that writes a Windows-side copy is `crucible host` and
     * that is already its per-machine root (`wsl\\`, `downloads\\`, `host\\`).
     * `cruciblePairingPath` implements `$CRUCIBLE_HOME`, else
     * `~/.crucible/pairing`, on every platform.
     *
     * The Crucible side confirmed this on 2026-09-14 as a DEFECT IN THE SDK
     * rather than a question about the contract — Foundry measured the same
     * thing against Owen's live server — and a re-packed tarball is coming.
     * BookForge does not work around it: it follows the DOC, because the doc
     * is the owner of every name on the wire (PHASE15's preamble), and the
     * instruction is to read the path from the SDK once it is fixed.
     *
     * The disagreement is asserted here so that the re-vendor turns this red
     * and says what to delete, instead of quietly leaving our extra branch as
     * dead code nobody dares remove.
     *
     * It is not load-bearing yet: on Windows the writer is `crucible host`,
     * which does not exist, so there is no file at either path and the
     * `config.toml`-through-`wsl.exe` door is the live one. It becomes
     * load-bearing the moment the host ships.
     */
    if (process.platform !== 'win32') {
      console.log('        (not on win32 — the SDK default cannot be compared here)');
      return;
    }
    const os = require('os');
    const sdkDefault = await sdk.cruciblePairingPath();
    assert.strictEqual(sdkDefault, path.join(os.homedir(), '.crucible', 'pairing'),
      'the SDK no longer resolves ~/.crucible on Windows — read its pairing-file.js before '
      + 'trusting anything below');

    const localAppData = process.env['LOCALAPPDATA'];
    assert.ok(localAppData, 'this machine has no LOCALAPPDATA, so the comparison cannot be made');
    const ours = pairingFile.cruciblePairingFilePath(pairingFile.processPairingFileHost());
    assert.strictEqual(ours, path.join(localAppData, 'Crucible', 'pairing'));

    assert.notStrictEqual(ours, sdkDefault,
      'THE SDK HAS BEEN FIXED — which is the thing this check was waiting for.\n'
      + '        Do this: take the Windows path FROM the SDK rather than composing it here '
      + '(cruciblePairingPath), delete reason TWO from '
      + 'electron/crucible/pairing-file.ts\'s header, and delete this check.\n'
      + '        If reason ONE has also gone (the SDK grew a synchronous reader, or '
      + 'readLocalServer became async), delete the whole file and await the SDK instead.');
  });

  await check('an EMPTY file: we throw, the SDK answers null — the third divergence', async () => {
    /*
     * Ours throws `pairing_file_empty`; the SDK returns `null`. We keep ours,
     * and the reason is the SDK's OWN argument applied consistently: its
     * header says a malformed file must throw "because a line somebody's
     * installer wrote badly is a broken install, and answering 'there is no
     * server here' would send the user to install a second one". A
     * zero-length file is an interrupted write, which is the same broken
     * install; answering `null` sends the same user to the same wrong place.
     *
     * Small, and recorded because two readers of one file that disagree about
     * what a case MEANS is worth a line even when the case is rare.
     */
    let caught = null;
    try { pairingFile.readCruciblePairingFile(hostWith({ readFile: () => '' })); } catch (e) { caught = e; }
    assert.strictEqual(caught && caught.code, 'pairing_file_empty');

    const src = fs.readFileSync(
      path.join(REPO, 'node_modules', '@crucible', 'client', 'dist', 'esm', 'pairing-file.js'),
      'utf-8');
    assert.ok(/if \(line === ''\)\s*\n?\s*return null;/.test(src),
      'the SDK no longer answers null for an empty file — re-read it; the divergence may be over');
  });

  console.log(`\nthe connect code on this machine: ${failures === 0 ? 'all clear' : `${failures} failing`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
