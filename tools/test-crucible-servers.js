#!/usr/bin/env node
/**
 * test-crucible-servers.js — ONE KIND OF SERVER, and the offer that is not one.
 *
 * ── What this keeper is for (Owen's ruling, 2026-09-15) ────────────────────
 *
 * *"it shouldnt be named 'local' anywhere. it might not be local. a local
 * crucible server shouldnt be treated any differently than a remote crucible
 * server. it should all be entered the exact same way … bookforge shouldnt even
 * know if it's local because it doesnt mater"*
 *
 * Until that ruling `local` was a RESERVED server name: `get('local')` answered
 * out of this machine's `config.toml` instead of out of the registry, a loopback
 * URL was REFUSED at the add door, and half the app carried a branch for the
 * difference. Section 3 below is what PINS ITS ABSENCE — not by reading a
 * comment, but by asking the registry what the word does and getting nothing.
 *
 * Drives the COMPILED `dist/electron/crucible/{servers,discovery}.js` (build
 * first: `npx tsc -p tsconfig.electron.json`) over a temp registry file, so
 * nothing here touches `<userData>/crucible-servers.json` or a WSL guest. Every
 * refusal is exercised by its `code`, because a caller acts on the code and a
 * reader acts on the message.
 *
 * Run:  node tools/test-crucible-servers.js
 */
'use strict';
require('../cli/electron-stub.js');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIST = path.resolve(__dirname, '..', 'dist', 'electron', 'crucible');
const servers = require(path.join(DIST, 'servers.js'));
const discovery = require(path.join(DIST, 'discovery.js'));

let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n     ') : err}`);
    process.exitCode = 1;
  }
}

function refuses(fn, ErrorType, code) {
  let caught = null;
  try { fn(); } catch (err) { caught = err; }
  assert.ok(caught, 'expected a refusal, got none');
  assert.ok(caught instanceof ErrorType, `expected ${ErrorType.name}, got ${caught.name}: ${caught.message}`);
  assert.strictEqual(caught.code, code, `expected code ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-crucible-servers-'));
const file = path.join(tmp, 'crucible-servers.json');
const fresh = () => {
  fs.rmSync(file, { force: true });
  return new servers.ServerRegistry(file);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. discovery.ts — "is there a Crucible on this computer", a PREFILL
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = [
  '[server]', 'name = "crucible@example-pc-wsl"', 'host = "127.0.0.1"', 'port = 7100', '',
  '[auth]', 'token = "abcdefghijklmnop"', '',
  '[backend]', 'kind = "cuda-linux"', '',
  '[jobs]', 'enable_echo = true', 'enable_llm = true', '',
  '[accelerator]', 'desktop_allowance_bytes = 3221225472', '',
].join('\n');

check('parseCrucibleConfig reads name, host, port and token', () => {
  const got = discovery.parseCrucibleConfig(CONFIG, 'x', 'file');
  assert.deepStrictEqual(got, { name: 'crucible@example-pc-wsl', url: 'http://127.0.0.1:7100', token: 'abcdefghijklmnop', configPath: 'x', via: 'file' });
});

check('a server bound to 0.0.0.0 is connected to at 127.0.0.1 (bind is not connect)', () => {
  const got = discovery.parseCrucibleConfig(CONFIG.replace('host = "127.0.0.1"', 'host = "0.0.0.0"'), 'x', 'file');
  assert.strictEqual(got.url, 'http://127.0.0.1:7100');
  assert.strictEqual(discovery.connectHost('::'), '127.0.0.1');
  assert.strictEqual(discovery.connectHost('192.0.2.86'), '192.0.2.86');
});

check('a missing key is refused by name, exactly as the server refuses it', () => {
  const err = refuses(() => discovery.parseCrucibleConfig(CONFIG.replace('token = "abcdefghijklmnop"', ''), 'x', 'file'), discovery.CrucibleDiscoveryError, 'config_missing_key');
  assert.ok(err.message.includes('auth.token'), err.message);
  refuses(() => discovery.parseCrucibleConfig(CONFIG.replace('port = 7100', 'port = "7100"'), 'x', 'file'), discovery.CrucibleDiscoveryError, 'config_missing_key');
  refuses(() => discovery.parseCrucibleConfig(CONFIG.replace('token = "abcdefghijklmnop"', 'token = ""'), 'x', 'file'), discovery.CrucibleDiscoveryError, 'config_missing_key');
});

check('not-TOML is config_unreadable, never an empty server', () => {
  refuses(() => discovery.parseCrucibleConfig('[server\nname = ', 'x', 'file'), discovery.CrucibleDiscoveryError, 'config_unreadable');
});

/*
 * THE PAIRING-FILE DOOR IS CLOSED IN EVERY config.toml FIXTURE.
 *
 * `discoverCrucible` asks the pairing file FIRST (crucible PHASE15 §3.6/§5.1),
 * so a fixture that left `pairing` off would read the REAL machine's file and
 * the config.toml checks below would pass or fail depending on whether the
 * person running them has a Crucible host installed. Supplied explicitly, with
 * `readFile` answering `null` — which is the "no engine on this machine" fact,
 * not a stub for one.
 */
const NO_PAIRING = { platform: 'darwin', env: {}, homedir: '/home/t', readFile: () => null };

check('crucibleConfigPath honours $CRUCIBLE_HOME exactly as crucible_home() does', () => {
  assert.strictEqual(discovery.crucibleConfigPath({}, '/home/t'), path.join('/home/t', '.crucible', 'config.toml'));
  assert.strictEqual(discovery.crucibleConfigPath({ CRUCIBLE_HOME: '/srv/cru' }, '/home/t'), path.join('/srv/cru', 'config.toml'));
  assert.strictEqual(discovery.crucibleConfigPath({ CRUCIBLE_HOME: '' }, '/home/t'), path.join('/home/t', '.crucible', 'config.toml'));
});

check('on macOS/Linux the file is read directly; absent is no_local_config', () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const host = { platform: 'darwin', env: {}, homedir: home, wslDistro: undefined, pairing: NO_PAIRING, runWsl: () => { throw new Error('must not run wsl on darwin'); } };
  refuses(() => discovery.discoverCrucible(host), discovery.CrucibleDiscoveryError, 'no_local_config');
  fs.mkdirSync(path.join(home, '.crucible'));
  fs.writeFileSync(path.join(home, '.crucible', 'config.toml'), CONFIG);
  const got = discovery.discoverCrucible(host);
  assert.strictEqual(got.via, 'file');
  assert.strictEqual(got.token, 'abcdefghijklmnop');
  assert.strictEqual(got.configPath, path.join(home, '.crucible', 'config.toml'));
});

check('on Windows the file is read through wsl.exe -d <distro> --exec, and the script is the contract', () => {
  const calls = [];
  const host = {
    platform: 'win32', env: {}, homedir: 'C:\\Users\\t', wslDistro: 'Ubuntu', pairing: NO_PAIRING,
    runWsl: (distro, script) => { calls.push({ distro, script }); return { status: 0, stdout: `/home/<user>/.crucible/config.toml\n${CONFIG}`, stderr: '' }; },
  };
  const got = discovery.discoverCrucible(host);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].distro, 'Ubuntu');
  assert.ok(calls[0].script.includes('${CRUCIBLE_HOME:-$HOME/.crucible}/config.toml'), 'the guest resolves CRUCIBLE_HOME, not the host');
  assert.strictEqual(got.via, 'wsl');
  assert.strictEqual(got.configPath, 'Ubuntu:/home/<user>/.crucible/config.toml');
  assert.strictEqual(got.url, 'http://127.0.0.1:7100');
});

check('on Windows with no distro setting: no_wsl_distro, not a guessed distro', () => {
  const host = { platform: 'win32', env: {}, homedir: 'C:\\', wslDistro: undefined, pairing: NO_PAIRING, runWsl: () => { throw new Error('must not run'); } };
  refuses(() => discovery.discoverCrucible(host), discovery.CrucibleDiscoveryError, 'no_wsl_distro');
  refuses(() => discovery.discoverCrucible({ ...host, wslDistro: '  ' }), discovery.CrucibleDiscoveryError, 'no_wsl_distro');
});

check('guest exit 3 is no_local_config; any other non-zero is wsl_read_failed; a spawn error is wsl_read_failed', () => {
  const base = { platform: 'win32', env: {}, homedir: 'C:\\', wslDistro: 'Ubuntu', pairing: NO_PAIRING };
  const gone = refuses(() => discovery.discoverCrucible({ ...base, runWsl: () => ({ status: 3, stdout: '', stderr: '/home/<user>/.crucible/config.toml\n' }) }), discovery.CrucibleDiscoveryError, 'no_local_config');
  assert.ok(gone.message.includes('/home/<user>/.crucible/config.toml') && gone.message.includes('Ubuntu'), gone.message);
  refuses(() => discovery.discoverCrucible({ ...base, runWsl: () => ({ status: 1, stdout: '', stderr: 'bash: boom' }) }), discovery.CrucibleDiscoveryError, 'wsl_read_failed');
  refuses(() => discovery.discoverCrucible({ ...base, runWsl: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT wsl.exe') }) }), discovery.CrucibleDiscoveryError, 'wsl_read_failed');
});

check('NOTHING ASKS WHETHER A SERVER IS ON THIS MACHINE — Owen, 2026-09-19', () => {
  // *"Crucible is configured to be system agnostic. Doesn't matter if it's on
  // this system or on a rented DigitalOcean GPU, it should effectively be
  // treated the same locally or otherwise."* `isLoopbackUrl` and
  // `serversOnThisMachine` were the last two doors that could answer it, and
  // both are gone — the queue schedules every registered server identically.
  assert.strictEqual(discovery.isLoopbackUrl, undefined,
    'isLoopbackUrl is back: a loopback server is not a kind of server');
  assert.strictEqual(servers.serversOnThisMachine, undefined,
    'serversOnThisMachine is back: the queue must not know where a server is');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. servers.ts — the registry, and what a name may be
// ─────────────────────────────────────────────────────────────────────────────

check('an empty registry lists nothing and creates no file', () => {
  const reg = fresh();
  assert.deepStrictEqual(reg.list(), []);
  assert.strictEqual(fs.existsSync(file), false, 'reading an empty registry must not create it');
});

check('A LOOPBACK URL IS ORDINARY — added, listed and resolved like any other', () => {
  const reg = fresh();
  const added = reg.add({ name: '3090 Ti', url: 'http://127.0.0.1:7100/', token: 'here-secret-JXn0' });
  assert.strictEqual(added.url, 'http://127.0.0.1:7100', 'trailing slash trimmed');
  assert.strictEqual(added.tokenMasked, '****JXn0');
  const mac = reg.add({ name: 'mac', url: 'http://mac.example.test:7100', token: 'mac-secret-KCK0' });
  assert.strictEqual(mac.tokenMasked, '****KCK0');
  // ONE list, in the order they were added. No section, no badge, no first row.
  assert.deepStrictEqual(reg.list().map((r) => r.name), ['3090 Ti', 'mac']);
  // The SAME resolve for both: name, url, token, and nothing that says where.
  assert.deepStrictEqual(reg.get('3090 Ti'), { name: '3090 Ti', url: 'http://127.0.0.1:7100', token: 'here-secret-JXn0' });
  assert.deepStrictEqual(reg.get('mac'), { name: 'mac', url: 'http://mac.example.test:7100', token: 'mac-secret-KCK0' });
  assert.deepStrictEqual(Object.keys(reg.get('mac')).sort(), ['name', 'token', 'url']);
});

check('a listing cannot carry a plaintext token', () => {
  const reg = fresh();
  reg.add({ name: 'mac', url: 'http://mac:7100', token: 'mac-secret-KCK0' });
  assert.strictEqual(JSON.stringify(reg.list()).includes('mac-secret'), false);
  assert.strictEqual(servers.maskToken('mac-secret-KCK0'), '****KCK0');
});

check('NAMES ARE FREE TEXT: spaces, dots, dashes, @ — the shapes Owen will type', () => {
  for (const name of ['3090 Ti', 'M1 Ultra', 'mac', 'droplet-1', 'crucible@example-pc-wsl', 'Mac Studio']) {
    assert.strictEqual(servers.validateServerName(name), name, name);
  }
  assert.strictEqual(servers.validateServerName('  mac  '), 'mac', 'outer whitespace is read, not kept');
});

check('and every rule that makes a name usable refuses BY NAME', () => {
  refuses(() => servers.validateServerName('   '), servers.CrucibleRegistryError, 'invalid_name');
  refuses(() => servers.validateServerName('x'.repeat(servers.MAX_SERVER_NAME_LENGTH + 1)), servers.CrucibleRegistryError, 'invalid_name');
  refuses(() => servers.validateServerName('mac\tstudio'), servers.CrucibleRegistryError, 'invalid_name');
  // A colon would make `<server>:cloud` a guess (shared/queue/slot-sets.ts).
  const colon = refuses(() => servers.validateServerName('mac:2'), servers.CrucibleRegistryError, 'invalid_name');
  assert.ok(colon.message.includes('cloud'), colon.message);
  refuses(() => servers.validateServerName('a/b'), servers.CrucibleRegistryError, 'invalid_name');
  refuses(() => servers.validateServerName('a\\b'), servers.CrucibleRegistryError, 'invalid_name');
  refuses(() => servers.validateServerName('3090  Ti'), servers.CrucibleRegistryError, 'invalid_name');
});

check('the queue\'s OWN bench rows are the only names refused as reserved', () => {
  // Imported from shared/queue, never re-spelled — a server called `local-work`
  // would share a bench row with BookForge's own CPU work.
  assert.deepStrictEqual([...servers.RESERVED_SET_IDS].sort(),
    ['any', 'legacy-local-narrator', 'local-longform-align', 'local-work']);
  for (const id of servers.RESERVED_SET_IDS) {
    refuses(() => servers.validateServerName(id), servers.CrucibleRegistryError, 'reserved_name');
    refuses(() => servers.validateServerName(id.toUpperCase()), servers.CrucibleRegistryError, 'reserved_name');
  }
});

check('two names that differ only by case cannot both exist, and lookup stays EXACT', () => {
  const reg = fresh();
  reg.add({ name: 'Mac', url: 'http://mac:7100', token: 't1' });
  const err = refuses(() => reg.add({ name: 'mac', url: 'http://other:7100', token: 't2' }), servers.CrucibleRegistryError, 'duplicate_server');
  assert.ok(err.message.includes('"Mac"'), err.message);
  assert.strictEqual(servers.serverNameKey(' MAC '), 'mac');
  // EXACT on the way out: a typo is a typo, never a near match.
  refuses(() => reg.get('mac'), servers.CrucibleRegistryError, 'unknown_server');
  assert.strictEqual(reg.get('Mac').url, 'http://mac:7100');
});

check('ONE ENGINE, ONE ROW: a second row on the same address is refused', () => {
  /*
   * The check that protects the card, and it is not the name check above.
   * `slotSets` draws one GPU row per registered server, so two rows on one
   * address give that machine TWO lanes over ONE card: the scheduler admits to
   * both, two renders land on the same 24 GB, and nothing arbitrates. Every
   * screen reports success until the card runs out.
   *
   * Surfaced 2026-09-15 by the Foundry session, whose local-connect door refuses
   * by address. Ours refused only by name, so "3090 Ti" and "wsl" could both
   * point at 127.0.0.1:7100.
   */
  const reg = fresh();
  reg.add({ name: '3090 Ti', url: 'http://127.0.0.1:7100', token: 't1' });
  const err = refuses(
    () => reg.add({ name: 'wsl', url: 'http://127.0.0.1:7100', token: 't2' }),
    servers.CrucibleRegistryError, 'duplicate_server');
  assert.ok(err.message.includes('second GPU lane'), err.message);
  assert.ok(err.message.includes('"3090 Ti"'), 'the refusal must name the row already there');
});

check('the same address written differently is still the same address', () => {
  // A trailing slash, host case, and the port written out are not a new engine.
  // A check that missed these is one somebody works around by accident.
  const reg = fresh();
  reg.add({ name: 'a', url: 'http://localhost:7100', token: 't1' });
  refuses(() => reg.add({ name: 'b', url: 'http://localhost:7100/', token: 't2' }),
    servers.CrucibleRegistryError, 'duplicate_server');
  refuses(() => reg.add({ name: 'c', url: 'http://LOCALHOST:7100', token: 't3' }),
    servers.CrucibleRegistryError, 'duplicate_server');
  assert.strictEqual(servers.originKey('http://localhost:7100/'), 'http://localhost:7100');
  assert.strictEqual(servers.originKey('https://box'), 'https://box:443');
});

check('localhost and 127.0.0.1 are NOT folded together', () => {
  /*
   * They can genuinely differ — a hosts-file entry, an IPv6-only bind — and
   * treating a name as an address is a guess about somebody's machine. The name
   * check is what catches the ordinary version of that mistake.
   */
  const reg = fresh();
  reg.add({ name: 'by-name', url: 'http://localhost:7100', token: 't1' });
  reg.add({ name: 'by-number', url: 'http://127.0.0.1:7100', token: 't2' });
  assert.strictEqual(reg.list().length, 2);
});

check('the unchanged refusals still refuse: no scheme, /v1 suffix, empty token', () => {
  const reg = fresh();
  refuses(() => reg.add({ name: 'd', url: 'elsewhere:7100', token: 't' }), servers.CrucibleRegistryError, 'invalid_url');
  refuses(() => reg.add({ name: 'd', url: 'http://elsewhere:7100/v1', token: 't' }), servers.CrucibleRegistryError, 'invalid_url');
  refuses(() => reg.add({ name: 'd', url: 'http://elsewhere:7100', token: '  ' }), servers.CrucibleRegistryError, 'empty_token');
  assert.strictEqual(fs.existsSync(file), false, 'a refused add writes nothing');
});

check('remove forgets any row, and an unknown name is refused by name', () => {
  const reg = fresh();
  reg.add({ name: '3090 Ti', url: 'http://127.0.0.1:7100', token: 't1' });
  reg.add({ name: 'mac', url: 'http://mac:7100', token: 't2' });
  // EVERY row is removable, the one on this machine included — it used to be
  // the one that was not, because it was not a registry entry at all.
  assert.strictEqual(reg.remove('3090 Ti').name, '3090 Ti');
  assert.deepStrictEqual(reg.list().map((r) => r.name), ['mac']);
  const err = refuses(() => reg.remove('droplet'), servers.CrucibleRegistryError, 'unknown_server');
  assert.ok(err.message.includes('known: mac'), err.message);
});

check('a corrupt registry is refused, never replaced', () => {
  fs.writeFileSync(file, '{ not json');
  refuses(() => new servers.ServerRegistry(file).list(), servers.CrucibleRegistryError, 'corrupt_registry');
  fs.writeFileSync(file, JSON.stringify({ servers: [{ name: 'x', url: 'http://y', token: '', added: 'z' }] }));
  refuses(() => new servers.ServerRegistry(file).list(), servers.CrucibleRegistryError, 'corrupt_registry');
  assert.ok(fs.readFileSync(file, 'utf8').includes('"x"'), 'the corrupt file is untouched');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE ABSENCE OF A RESERVED IDENTITY — the point of the whole change
// ─────────────────────────────────────────────────────────────────────────────

check('THERE IS NO RESERVED NAME: the registry exports none and describes none', () => {
  assert.strictEqual(servers.LOCAL_SERVER_NAME, undefined,
    'LOCAL_SERVER_NAME is deleted; a constant is how a reserved name comes back');
  assert.strictEqual(servers.describeLocal, undefined,
    'describeLocal is deleted; the offer is `probe.ts serversView().discovered` and is not a server');
  assert.strictEqual(servers.ServerRegistry.length, 1,
    'the registry takes a FILE and nothing else — a second argument was the local reader it '
    + 'answered one reserved name out of');
});

check('THE WORD `local` HAS NO POWER: it is an unknown server like any other typo', () => {
  const reg = fresh();
  reg.add({ name: 'mac', url: 'http://mac:7100', token: 't' });
  const err = refuses(() => reg.get('local'), servers.CrucibleRegistryError, 'unknown_server');
  assert.ok(err.message.includes('known: mac'), err.message);
  assert.strictEqual(err.message.includes('always names'), false,
    'the message must not claim a name always resolves');
  refuses(() => reg.remove('local'), servers.CrucibleRegistryError, 'unknown_server');
});

check('…and it is not refused either — it is ordinary free text, like any other word', () => {
  // Reserving it in the OTHER direction would be the same defect upside down.
  // `retire-reserved-name.ts` reads this as "a server is genuinely called that"
  // and leaves every record alone.
  const reg = fresh();
  assert.strictEqual(reg.add({ name: 'local', url: 'http://anywhere:7100', token: 't' }).name, 'local');
  assert.strictEqual(reg.get('local').url, 'http://anywhere:7100');
});

check('no module named `local` is emitted, and nothing imports one', () => {
  assert.strictEqual(fs.existsSync(path.join(DIST, 'local.js')), false,
    'dist/electron/crucible/local.js is gone — rebuild if this fails on a stale dist');
  const SRC = path.resolve(__dirname, '..', 'electron', 'crucible');
  assert.strictEqual(fs.existsSync(path.join(SRC, 'local.ts')), false);
  for (const name of fs.readdirSync(SRC)) {
    if (!name.endsWith('.ts')) continue;
    const text = fs.readFileSync(path.join(SRC, name), 'utf8');
    assert.strictEqual(/from '\.\/local'/.test(text), false, `${name} still imports ./local`);
  }
});

check('crucibleClientFor is still the one door a token leaves by', () => {
  assert.strictEqual(typeof servers.crucibleClientFor, 'function');
  assert.strictEqual(typeof servers.getServer, 'function');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ran} checks, ${process.exitCode ? 'FAILING' : 'all passing'}`);
