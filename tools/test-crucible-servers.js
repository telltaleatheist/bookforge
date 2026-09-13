#!/usr/bin/env node
/**
 * test-crucible-servers.js — the registry holds remotes; the local server has one owner.
 *
 * Drives the COMPILED `dist/electron/crucible/{servers,local}.js` (build first:
 * `npx tsc -p tsconfig.electron.json`) over a temp registry file and a scripted
 * local reader, so nothing here touches `<userData>/crucible-servers.json` or a
 * WSL guest. Every refusal is exercised by its `code`, because a caller acts on
 * the code and a reader acts on the message.
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
const local = require(path.join(DIST, 'local.js'));

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
const LOCAL = { name: 'crucible@owens-pc-wsl', url: 'http://127.0.0.1:7100', token: 'local-secret-JXn0', configPath: 'Ubuntu:/home/telltale/.crucible/config.toml', via: 'wsl' };
const withLocal = () => LOCAL;
const noLocal = () => { throw new local.CrucibleLocalError('no_local_config', 'no local Crucible: /x/config.toml does not exist'); };

// ── local.ts: the config read ────────────────────────────────────────────────

const CONFIG = [
  '[server]', 'name = "crucible@owens-pc-wsl"', 'host = "127.0.0.1"', 'port = 7100', '',
  '[auth]', 'token = "abcdefghijklmnop"', '',
  '[backend]', 'kind = "cuda-linux"', '',
  '[jobs]', 'enable_echo = true', 'enable_llm = true', '',
  '[accelerator]', 'desktop_allowance_bytes = 3221225472', '',
].join('\n');

check('parseLocalConfig reads name, host, port and token', () => {
  const got = local.parseLocalConfig(CONFIG, 'x', 'file');
  assert.deepStrictEqual(got, { name: 'crucible@owens-pc-wsl', url: 'http://127.0.0.1:7100', token: 'abcdefghijklmnop', configPath: 'x', via: 'file' });
});

check('a server bound to 0.0.0.0 is connected to at 127.0.0.1 (bind is not connect)', () => {
  const got = local.parseLocalConfig(CONFIG.replace('host = "127.0.0.1"', 'host = "0.0.0.0"'), 'x', 'file');
  assert.strictEqual(got.url, 'http://127.0.0.1:7100');
  assert.strictEqual(local.connectHost('::'), '127.0.0.1');
  assert.strictEqual(local.connectHost('192.168.68.86'), '192.168.68.86');
});

check('a missing key is refused by name, exactly as the server refuses it', () => {
  const err = refuses(() => local.parseLocalConfig(CONFIG.replace('token = "abcdefghijklmnop"', ''), 'x', 'file'), local.CrucibleLocalError, 'config_missing_key');
  assert.ok(err.message.includes('auth.token'), err.message);
  refuses(() => local.parseLocalConfig(CONFIG.replace('port = 7100', 'port = "7100"'), 'x', 'file'), local.CrucibleLocalError, 'config_missing_key');
  refuses(() => local.parseLocalConfig(CONFIG.replace('token = "abcdefghijklmnop"', 'token = ""'), 'x', 'file'), local.CrucibleLocalError, 'config_missing_key');
});

check('not-TOML is config_unreadable, never an empty server', () => {
  refuses(() => local.parseLocalConfig('[server\nname = ', 'x', 'file'), local.CrucibleLocalError, 'config_unreadable');
});

check('localConfigPath honours $CRUCIBLE_HOME exactly as crucible_home() does', () => {
  assert.strictEqual(local.localConfigPath({}, '/home/t'), path.join('/home/t', '.crucible', 'config.toml'));
  assert.strictEqual(local.localConfigPath({ CRUCIBLE_HOME: '/srv/cru' }, '/home/t'), path.join('/srv/cru', 'config.toml'));
  assert.strictEqual(local.localConfigPath({ CRUCIBLE_HOME: '' }, '/home/t'), path.join('/home/t', '.crucible', 'config.toml'));
});

check('on macOS/Linux the file is read directly; absent is no_local_config', () => {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const host = { platform: 'darwin', env: {}, homedir: home, wslDistro: undefined, runWsl: () => { throw new Error('must not run wsl on darwin'); } };
  refuses(() => local.readLocalServer(host), local.CrucibleLocalError, 'no_local_config');
  fs.mkdirSync(path.join(home, '.crucible'));
  fs.writeFileSync(path.join(home, '.crucible', 'config.toml'), CONFIG);
  const got = local.readLocalServer(host);
  assert.strictEqual(got.via, 'file');
  assert.strictEqual(got.token, 'abcdefghijklmnop');
  assert.strictEqual(got.configPath, path.join(home, '.crucible', 'config.toml'));
});

check('on Windows the file is read through wsl.exe -d <distro> --exec, and the script is the contract', () => {
  const calls = [];
  const host = {
    platform: 'win32', env: {}, homedir: 'C:\\Users\\t', wslDistro: 'Ubuntu',
    runWsl: (distro, script) => { calls.push({ distro, script }); return { status: 0, stdout: `/home/telltale/.crucible/config.toml\n${CONFIG}`, stderr: '' }; },
  };
  const got = local.readLocalServer(host);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].distro, 'Ubuntu');
  assert.ok(calls[0].script.includes('${CRUCIBLE_HOME:-$HOME/.crucible}/config.toml'), 'the guest resolves CRUCIBLE_HOME, not the host');
  assert.strictEqual(got.via, 'wsl');
  assert.strictEqual(got.configPath, 'Ubuntu:/home/telltale/.crucible/config.toml');
  assert.strictEqual(got.url, 'http://127.0.0.1:7100');
});

check('on Windows with no distro setting: no_wsl_distro, not a guessed distro', () => {
  const host = { platform: 'win32', env: {}, homedir: 'C:\\', wslDistro: undefined, runWsl: () => { throw new Error('must not run'); } };
  refuses(() => local.readLocalServer(host), local.CrucibleLocalError, 'no_wsl_distro');
  refuses(() => local.readLocalServer({ ...host, wslDistro: '  ' }), local.CrucibleLocalError, 'no_wsl_distro');
});

check('guest exit 3 is no_local_config; any other non-zero is wsl_read_failed; a spawn error is wsl_read_failed', () => {
  const base = { platform: 'win32', env: {}, homedir: 'C:\\', wslDistro: 'Ubuntu' };
  const gone = refuses(() => local.readLocalServer({ ...base, runWsl: () => ({ status: 3, stdout: '', stderr: '/home/telltale/.crucible/config.toml\n' }) }), local.CrucibleLocalError, 'no_local_config');
  assert.ok(gone.message.includes('/home/telltale/.crucible/config.toml') && gone.message.includes('Ubuntu'), gone.message);
  refuses(() => local.readLocalServer({ ...base, runWsl: () => ({ status: 1, stdout: '', stderr: 'bash: boom' }) }), local.CrucibleLocalError, 'wsl_read_failed');
  refuses(() => local.readLocalServer({ ...base, runWsl: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT wsl.exe') }) }), local.CrucibleLocalError, 'wsl_read_failed');
});

check('isLoopbackUrl names exactly the shapes that are this machine', () => {
  for (const u of ['http://127.0.0.1:7100', 'http://localhost:7100', 'http://LOCALHOST', 'http://[::1]:7100', 'http://0.0.0.0:7100', 'http://127.5.5.5', 'http://foo.localhost:1']) {
    assert.strictEqual(local.isLoopbackUrl(u), true, u);
  }
  for (const u of ['http://owens-mac-studio.hs.owenmorgan.com:7100', 'http://192.168.68.86:7100', 'http://10.0.0.1', 'not a url']) {
    assert.strictEqual(local.isLoopbackUrl(u), false, u);
  }
});

// ── servers.ts: the registry ─────────────────────────────────────────────────

check('an empty registry lists nothing, and local is answered by its config, not the registry', () => {
  const reg = new servers.ServerRegistry(file, withLocal);
  assert.deepStrictEqual(reg.list(), []);
  const got = reg.get('local');
  assert.deepStrictEqual(got, { name: 'local', url: 'http://127.0.0.1:7100', token: 'local-secret-JXn0', source: 'local', local: { serverName: 'crucible@owens-pc-wsl', configPath: LOCAL.configPath, via: 'wsl' } });
  assert.strictEqual(fs.existsSync(file), false, 'resolving local must not create a registry file');
});

check('describeLocal never carries the token, and "none" is a named state, not a throw', () => {
  const reg = new servers.ServerRegistry(file, withLocal);
  const shown = reg.describeLocal();
  assert.strictEqual(shown.present, true);
  assert.strictEqual(shown.tokenMasked, '****JXn0');
  assert.strictEqual(JSON.stringify(shown).includes('local-secret'), false);
  const none = new servers.ServerRegistry(file, noLocal).describeLocal();
  assert.strictEqual(none.present, false);
  assert.strictEqual(none.code, 'no_local_config');
});

check('get("local") with no local config is the CrucibleLocalError, by code', () => {
  refuses(() => new servers.ServerRegistry(file, noLocal).get('local'), local.CrucibleLocalError, 'no_local_config');
});

check('add refuses the reserved name and every loopback URL, by name', () => {
  const reg = new servers.ServerRegistry(file, withLocal);
  refuses(() => reg.add({ name: 'local', url: 'http://mac:7100', token: 't' }), servers.CrucibleRegistryError, 'reserved_name');
  for (const url of ['http://127.0.0.1:7100', 'http://localhost:7100', 'http://[::1]:7100']) {
    const err = refuses(() => reg.add({ name: 'wsl', url, token: 't' }), servers.CrucibleRegistryError, 'local_is_not_registered');
    assert.ok(err.message.includes('--server local'), err.message);
  }
  assert.strictEqual(fs.existsSync(file), false, 'a refused add writes nothing');
});

check('add records a remote server; list masks; get returns it from the registry', () => {
  const reg = new servers.ServerRegistry(file, withLocal);
  const added = reg.add({ name: 'mac', url: 'http://owens-mac-studio.hs.owenmorgan.com:7100/', token: 'mac-secret-KCK0' });
  assert.strictEqual(added.url, 'http://owens-mac-studio.hs.owenmorgan.com:7100', 'trailing slash trimmed');
  assert.strictEqual(added.tokenMasked, '****KCK0');
  assert.strictEqual(added.stale, null);
  assert.deepStrictEqual(reg.list().map((r) => [r.name, r.stale]), [['mac', null]]);
  const got = reg.get('mac');
  assert.deepStrictEqual(got, { name: 'mac', url: 'http://owens-mac-studio.hs.owenmorgan.com:7100', token: 'mac-secret-KCK0', source: 'registry' });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.servers.length, 1);
  assert.strictEqual(onDisk.servers[0].token, 'mac-secret-KCK0');
});

check('the pre-rule registry (a copy of the local token under "wsl") is refused at use and shown as stale', () => {
  fs.writeFileSync(file, JSON.stringify({ servers: [
    { name: 'mac', url: 'http://owens-mac-studio.hs.owenmorgan.com:7100', token: 'mac-secret-KCK0', added: '2026-09-13T01:08:17.845Z' },
    { name: 'wsl', url: 'http://127.0.0.1:7100', token: 'stale-copy-JXn0', added: '2026-09-13T02:37:57.866Z' },
  ] }));
  const reg = new servers.ServerRegistry(file, withLocal);
  assert.deepStrictEqual(reg.list().map((r) => [r.name, r.stale]), [['mac', null], ['wsl', 'loopback_duplicates_local']]);
  const err = refuses(() => reg.get('wsl'), servers.CrucibleRegistryError, 'stale_local_entry');
  assert.ok(err.message.includes('--crucible-remove --name wsl') && err.message.includes('--server local'), err.message);
  // The repair door works on the stale entry.
  const removed = reg.remove('wsl');
  assert.strictEqual(removed.stale, 'loopback_duplicates_local');
  assert.deepStrictEqual(reg.list().map((r) => r.name), ['mac']);
});

check('unknown names are refused and the message says local always exists', () => {
  const reg = new servers.ServerRegistry(file, withLocal);
  const err = refuses(() => reg.get('droplet'), servers.CrucibleRegistryError, 'unknown_server');
  assert.ok(err.message.includes('known: mac') && err.message.includes('"local" always names'), err.message);
  refuses(() => reg.remove('droplet'), servers.CrucibleRegistryError, 'unknown_server');
  refuses(() => reg.remove('local'), servers.CrucibleRegistryError, 'reserved_name');
});

check('the unchanged refusals still refuse: duplicate, no scheme, /v1 suffix, empty token, bad name', () => {
  const reg = new servers.ServerRegistry(file, withLocal);
  refuses(() => reg.add({ name: 'mac', url: 'http://elsewhere:7100', token: 't' }), servers.CrucibleRegistryError, 'duplicate_server');
  refuses(() => reg.add({ name: 'd', url: 'elsewhere:7100', token: 't' }), servers.CrucibleRegistryError, 'invalid_url');
  refuses(() => reg.add({ name: 'd', url: 'http://elsewhere:7100/v1', token: 't' }), servers.CrucibleRegistryError, 'invalid_url');
  refuses(() => reg.add({ name: 'd', url: 'http://elsewhere:7100', token: '  ' }), servers.CrucibleRegistryError, 'empty_token');
  refuses(() => reg.add({ name: '-bad', url: 'http://elsewhere:7100', token: 't' }), servers.CrucibleRegistryError, 'invalid_name');
});

check('a corrupt registry is refused, never replaced', () => {
  fs.writeFileSync(file, '{ not json');
  refuses(() => new servers.ServerRegistry(file, withLocal).list(), servers.CrucibleRegistryError, 'corrupt_registry');
  fs.writeFileSync(file, JSON.stringify({ servers: [{ name: 'x', url: 'http://y', token: '', added: 'z' }] }));
  refuses(() => new servers.ServerRegistry(file, withLocal).list(), servers.CrucibleRegistryError, 'corrupt_registry');
  assert.ok(fs.readFileSync(file, 'utf8').includes('"x"'), 'the corrupt file is untouched');
});

check('crucibleClientFor builds a client for local and for a remote, and the module-level door is the same class', () => {
  assert.strictEqual(typeof servers.crucibleClientFor, 'function');
  assert.strictEqual(servers.LOCAL_SERVER_NAME, 'local');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ran} checks, ${process.exitCode ? 'FAILING' : 'all passing'}`);
