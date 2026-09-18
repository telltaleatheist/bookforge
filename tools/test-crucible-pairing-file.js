/**
 * THE CONNECT CODE ON THIS MACHINE — and the one thing left that BookForge's
 * reader does differently from the SDK's.
 *
 * crucible `docs/PHASE15-HOST.md` §3.6 and §5.1. These checks used to live in
 * `test-crucible-settings-seam.js`, which was a suite about a stand-in for an
 * SDK that had not shipped. The SDK shipped on 2026-09-14 and that seam was
 * deleted — but `electron/crucible/pairing-file.ts` did NOT go with it, for
 * two reasons its header sets out in full, and a reader that survives its own
 * seam needs a suite of its own saying why.
 *
 * ── SECTION 3 WAS TWO TRIPWIRES. BOTH FIRED, AND THIS IS WHAT THEY BECAME ──
 *
 * Checks 1 and 2 are the ordinary thing — our reader does what §3.6 says.
 * Section 3 used to assert, EXPLICITLY, where our reader and
 * `@crucible/client`'s disagreed: the Windows path, and what an empty file
 * means. Two implementations of one rule is the defect the contract exists to
 * prevent, so the disagreements were stated rather than hidden behind a
 * comment, in order to go red the day the SDK adopted them.
 *
 * They went red on 2026-09-14, against the 0.6.0 re-pack (`1a1fb892`). The SDK
 * carries §3.6's Windows case and refuses an empty file, and it refuses a
 * multi-line one, which ours did not. So the divergences are gone: ours took
 * the SDK's line rule whole, IMPORTS the three constants the path is composed
 * of, and section 3 is now a plain AGREEMENT check on both.
 *
 * ONE reason for this file's existence survives, and it is the first one: the
 * SDK's reader is async (a packaging rule of theirs — its imports are
 * assembled at run time) and `discoverCrucible` is synchronous (an
 * architectural constraint of ours — `readRouting()` runs inside the queue's
 * synchronous pump). This is that one rule executed twice, not read twice, and
 * check 3.1 is the tripwire for the day even that ends.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');

const READER = path.join(REPO, 'dist', 'electron', 'crucible', 'pairing-file.js');
if (!fs.existsSync(READER)) {
  console.log(skipLine('dist/electron/crucible/pairing-file.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

const pairingFile = require(READER);
const discovery = require(path.join(REPO, 'dist', 'electron', 'crucible', 'discovery.js'));

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

  await check('discoverCrucible asks the pairing file FIRST, and does not touch WSL when it answers', () => {
    const line = 'crucible://crucible%40owens-pc-wsl@127.0.0.1:7100/#tok-abcdefghij\n';
    const got = discovery.discoverCrucible({
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
  // 3. WE AND THE SDK, COMPARED — one rule, executed twice
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
      + 'electron/crucible/pairing-file.ts and have discoverCrucible use the SDK.');
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

  await check('WE AGREE ON WINDOWS — the tripwire fired and this is what it became', async () => {
    /*
     * §3.6's table: on Windows the file is `%LOCALAPPDATA%\\Crucible\\pairing`,
     * because the thing that writes a Windows-side copy is `crucible host` and
     * that is already its per-machine root (`wsl\\`, `downloads\\`, `host\\`).
     *
     * Until the 0.6.0 re-pack (`1a1fb892`) `cruciblePairingPath` implemented
     * `$CRUCIBLE_HOME`, else `~/.crucible/pairing`, on EVERY platform, and
     * this check asserted the disagreement in the open so that the re-vendor
     * would turn it red rather than leave our extra branch as dead code
     * nobody dared remove. It went red on 2026-09-14. THE SDK CARRIES §3.6'S
     * WINDOWS CASE NOW, so there is one rule again and this is the agreement
     * check it turned into.
     *
     * What is compared is the composed PATH, not the sentence — and
     * `pairing-file.ts` imports the three names it composes out of (the env
     * var, the file name, the Windows directory) from the SDK, so the only
     * thing left that could drift is the shape of the composition, which is
     * exactly what this asserts.
     */
    assert.strictEqual(pairingFile.CRUCIBLE_HOME_ENV, sdk.CRUCIBLE_HOME_ENV);
    assert.strictEqual(pairingFile.PAIRING_FILE_NAME, sdk.PAIRING_FILE);
    assert.strictEqual(pairingFile.WINDOWS_HOME_DIRNAME, sdk.WINDOWS_HOME_DIRNAME);

    if (process.platform !== 'win32') {
      // `cruciblePairingPath()` reads `process.platform` itself, so the win32
      // default is only comparable ON win32. Said out loud rather than
      // silently skipped.
      console.log('        (not on win32 — the SDK\'s default path cannot be compared here)');
      return;
    }
    const localAppData = process.env['LOCALAPPDATA'];
    assert.ok(localAppData, 'this machine has no LOCALAPPDATA, so the comparison cannot be made');
    const ours = pairingFile.cruciblePairingFilePath(pairingFile.processPairingFileHost());
    assert.strictEqual(ours, path.join(localAppData, sdk.WINDOWS_HOME_DIRNAME, sdk.PAIRING_FILE));
    assert.strictEqual(await sdk.cruciblePairingPath(), ours,
      'the SDK and this reader compose DIFFERENT Windows paths again. Read its '
      + 'pairing-file.js: one of the two has moved, and two readers of one file that '
      + 'look in different places is the defect PHASE15 §3.6 exists to prevent.');
  });

  await check('an EMPTY file and a MULTI-LINE file: both refuse, on both sides', async () => {
    /*
     * The third divergence, also over. Ours threw `pairing_file_empty` where
     * the SDK answered `null`, and ours was right for the SDK's OWN stated
     * reason — a malformed file must throw "because a line somebody's
     * installer wrote badly is a broken install, and answering 'there is no
     * server here' would send the user to install a second one"; a zero-length
     * file is the same broken install. The re-pack applies that argument to
     * the empty file, and adds the case ours did not have: MORE THAN ONE line,
     * where picking one would be guessing at a bearer token.
     *
     * So this reader took the SDK's line rule whole (split, trim, drop blanks,
     * then exactly one), and what is checked here is that both sides refuse
     * both files — ours by its own code, the SDK by throwing at all.
     */
    let caught = null;
    try { pairingFile.readCruciblePairingFile(hostWith({ readFile: () => '' })); } catch (e) { caught = e; }
    assert.strictEqual(caught && caught.code, 'pairing_file_empty');

    const two = 'crucible://a@127.0.0.1:7100/#tok-aaaaaaaaaa\n'
      + 'crucible://b@127.0.0.1:7101/#tok-bbbbbbbbbb\n';
    caught = null;
    try { pairingFile.readCruciblePairingFile(hostWith({ readFile: () => two })); } catch (e) { caught = e; }
    assert.strictEqual(caught && caught.code, 'pairing_file_multiline',
      'a two-line pairing file was read rather than refused — which line is the server\'s?');
    assert.ok(caught.message.includes('2 lines'), caught.message);
    assert.ok(!caught.message.includes('tok-'), 'a refusal never carries a token');

    // The SDK's half, read against a real directory it is pointed at with
    // $CRUCIBLE_HOME — no network, no server, two tiny files.
    const os = require('os');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-pairing-'));
    try {
      fs.writeFileSync(path.join(home, sdk.PAIRING_FILE), '\n  \n');
      await assert.rejects(() => sdk.readPairingFile(home), /empty|one line/i,
        'the SDK answers for an empty file instead of refusing — the divergence is back, '
        + 'and it is now OURS that is the odd one out');
      fs.writeFileSync(path.join(home, sdk.PAIRING_FILE), two);
      await assert.rejects(() => sdk.readPairingFile(home), /exactly one/i,
        'the SDK reads a two-line pairing file — re-read its line rule before trusting ours');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  console.log(`\nthe connect code on this machine: ${failures === 0 ? 'all clear' : `${failures} failing`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
