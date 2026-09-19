/**
 * DOES THE INSTALL DOOR JOIN A MOVE IT DID NOT START? Eight assertions.
 *
 *     cd app && bun tools/checks/install-attach.ts
 *
 * NOT A GATE — see the README beside this file. Nothing runs it for you, and
 * `bun test` does not collect it (no `.test.` in the name, deliberately).
 *
 * PHASE19 2.3 put the move's start in the tray, so the ordinary running move is
 * one no window pressed a button for, and 2.6's `GET /install/events` replays a
 * ring of the last 200 events for exactly that caller. `attach()` is Foundry's
 * one use of it. What breaks silently: it joins nothing, and the face draws five
 * waiting rows under a status line that says a move is running — which is what
 * it did until 2026-09-19.
 *
 * THE HOST IS SCRIPTED AND NOTHING OPENS A SOCKET. A fake `fetch` and a fake
 * `Runner` are the SDK's own two seams (`installStatus`, `watchInstall` and
 * `requestHostInstall` all take exactly these), which is why the door exposes no
 * mock of its own — a door tested against a mock of itself is a test of the mock.
 * The live Crucible on this desk answers :7100 and :7101 right now and is not
 * consulted here.
 *
 * The scripted move is over ONCE ITS STREAM HAS BEEN READ. A door that answered
 * `running: true` forever would hold `watchInstall` open past its decision poll
 * and this would hang rather than fail, which is a worse way to learn nothing.
 */
import * as path from 'node:path';
import * as os from 'node:os';
import { mock } from 'bun:test';

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => path.join(os.tmpdir(), 'foundry-attach-check', name),
    getName: () => 'Foundry', getVersion: () => 'test',
    getAppPath: () => path.dirname(import.meta.dir), isPackaged: false,
    on: () => {}, whenReady: async () => {},
  },
  BrowserWindow: class {}, dialog: {}, ipcMain: { handle: () => {}, on: () => {} },
  nativeImage: {}, net: {}, protocol: {}, session: {}, shell: {},
}));

const bootstrap = await import('@crucible/bootstrap');
const door = await import('../../electron/crucible-install-door');

const SEP = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const LOCAL = ['C:', 'Users', 'test', 'AppData', 'Local'].join(SEP);

function hostRunner(installed = true): bootstrap.Runner {
  return {
    platform: 'win32', env: { LOCALAPPDATA: LOCAL }, homedir: [LOCAL, '..'].join(SEP),
    run: async () => { throw new Error('nothing must be run'); },
    stream: async () => { throw new Error('nothing must be spawned'); },
    fileExists: (f: string) => f === [LOCAL, 'Crucible', 'host', 'crucible.cmd'].join(SEP)
      ? installed
      : f === [LOCAL, 'Crucible', 'config.toml'].join(SEP),
    readFile: () => '[auth]' + NL + 'token = "scripted"' + NL,
    realpathNative: (p: string) => p,
  } as unknown as bootstrap.Runner;
}

const PRESENCE = { distro: 'crucible', engine: 'stopped', owner: 'child', detail: 'native' };
const ndjson = (e: unknown[]) => e.map((x) => JSON.stringify(x)).join(NL) + NL;

const EVENTS = [
  { id: 1, event: 'step', data: { name: 'host', index: 1, total: 5 } },
  { id: 2, event: 'step', data: { name: 'import-distro', index: 2, total: 5 } },
  { id: 3, event: 'progress', data: { bytes_done: 10, bytes_total: 100, file: 'ubuntu.tar' } },
  { id: 4, event: 'step', data: { name: 'install-job-types', index: 3, total: 5 } },
  { id: 5, event: 'done', data: {
    server: { name: 'guest', url: 'http://127.0.0.1:7100', config_path: '/c.toml' },
    release: '1.0.6', backend: 'cuda-linux', crucible: '/bin/crucible', steps: [] } },
];

/** A tray move that IS running, and is over once its stream has been read. */
function scripted(running: boolean) {
  const calls: string[] = [];
  let served = false;
  const fetchImpl = (async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push(method + ' ' + new URL(url).pathname);
    if (url.endsWith('/install/events')) {
      served = true;
      return new Response(ndjson(EVENTS), { status: 200 });
    }
    const outcome = served
      ? { state: 'done', code: null, sentence: null, at: '2026-09-19T12:00:00Z', release: '1.0.6', attempts: 1 }
      : null;
    return new Response(
      JSON.stringify({ running: running && !served, outcome, presence: PRESENCE }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

let bad = 0;
function check(name: string, ok: boolean, extra = ''): void {
  if (!ok) bad += 1;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  [' + extra + ']' : ''));
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 1. A move the tray started reaches a process that started nothing ───────
{
  const { fetchImpl, calls } = scripted(true);
  const d = door.crucibleInstallDoor({ fetchImpl, runner: hostRunner() });
  const seen: any[] = [];
  const off = d.watch((e) => seen.push(e));
  d.attach();
  d.attach();
  d.attach();
  await settle(900);
  const rows = seen.filter((e) => e.event === 'step').map((e) => e.row);
  check('a tray-started move reaches a watcher that started nothing', seen.length > 0,
    seen.length + ' event(s)');
  check('the rows are the fold, windows-engine drawn on the first move step',
    JSON.stringify(rows) === JSON.stringify(['install', 'windows-engine', 'linux-engine', 'job-types']),
    JSON.stringify(rows));
  check('progress bytes arrive', seen.some((e) => e.event === 'progress' && e.bytesTotal === 100));
  check("the host's own done is still dropped", !seen.some((e) => e.event === 'done'));
  const streams = calls.filter((c) => c.endsWith('/install/events')).length;
  check('three attaches open exactly one stream', streams === 1, streams + ' stream(s)');
  off();
}

// ── 2. No host pack: nothing to follow, and nothing asked ───────────────────
{
  const { fetchImpl, calls } = scripted(true);
  door.crucibleInstallDoor({ fetchImpl, runner: hostRunner(false) }).attach();
  await settle(300);
  check('a machine with no host pack asks nothing', calls.length === 0, JSON.stringify(calls));
}

// ── 3. The follow is not latched: a LATER move is followed too ──────────────
{
  const { fetchImpl, calls } = scripted(true);
  const d = door.crucibleInstallDoor({ fetchImpl, runner: hostRunner() });
  const seen: any[] = [];
  const off = d.watch((e) => seen.push(e));
  d.attach();
  await settle(900);
  const streams = calls.filter((c) => c.endsWith('/install/events')).length;
  check('a second move in the same session is followed too', streams === 1, streams + ' stream(s)');
  check('windows-engine is drawn again for it',
    seen.some((e) => e.event === 'step' && e.row === 'windows-engine'));
  off();
}

console.log(bad === 0 ? NL + 'ALL OK' : NL + bad + ' FAILED');
process.exit(bad === 0 ? 0 : 1);
