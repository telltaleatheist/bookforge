/**
 * THE INSTALL DOOR — §2.6 read, watched and retried, against a scripted host.
 *
 * crucible `docs/PHASE19-AUTOMATIC-WSL.md` §2.2, §2.5, §2.6 and §3.1. Part 1
 * of this phase built the screens against a seam whose one implementation
 * answered `outcome: null` to everything; part 2 put the SDK behind it, and
 * this is what holds the two facts that swap turned on: the outcome a person
 * reads, and the rows that fill in while it happens.
 *
 * ── NOTHING HERE OPENS A SOCKET, AND THAT IS THE POINT ────────────────────
 *
 * The live Crucible on this machine answers `:7100` and `:7101` right now, and
 * a test that reached it would pass or fail on the state of somebody's desk.
 * So the host is a scripted `fetch` and a scripted `Runner` — the SDK's own
 * two seams (`installStatus`, `watchInstall` and `requestHostInstall` all take
 * exactly these), which is why this door exposes no mock of its own. A door
 * tested against a mock of itself is a test of the mock.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => path.join(os.tmpdir(), 'foundry-install-door-test', name),
    getName: () => 'Foundry', getVersion: () => 'test',
    getAppPath: () => path.dirname(import.meta.dir), isPackaged: false,
    on: () => {}, whenReady: async () => {},
  },
  BrowserWindow: class {}, dialog: {}, ipcMain: { handle: () => {}, on: () => {} },
  nativeImage: {}, net: {}, protocol: {}, session: {}, shell: {},
}));

const bootstrap = await import('@crucible/bootstrap');
const door = await import('../electron/crucible-install-door');
const wire = await import('../shared/crucible-install-wire');
afterEach(() => mock.restore());

/** `%LOCALAPPDATA%` as the fake machine spells it. */
const LOCAL = 'C:\\Users\\test\\AppData\\Local';

/**
 * A WINDOWS MACHINE WITH A HOST PACK AND A TOKEN, and nothing else.
 *
 * `fileExists` answers true for the two files the SDK tests for — the host's
 * `crucible.cmd` and its `config.toml` — and false for everything else, so a
 * reader that started testing for a third file fails here rather than silently
 * believing this machine has it.
 */
function hostRunner(overrides: { installed?: boolean } = {}): bootstrap.Runner {
  const installed = overrides.installed ?? true;
  return {
    platform: 'win32',
    env: { LOCALAPPDATA: LOCAL },
    homedir: 'C:\\Users\\test',
    run: async () => { throw new Error('nothing must be run'); },
    stream: async () => { throw new Error('nothing must be spawned'); },
    fileExists: (file: string) => {
      if (file === `${LOCAL}\\Crucible\\host\\crucible.cmd`) return installed;
      if (file === `${LOCAL}\\Crucible\\config.toml`) return true;
      return false;
    },
    readFile: (file: string) => {
      if (file === `${LOCAL}\\Crucible\\config.toml`) return '[auth]\ntoken = "scripted"\n';
      throw new Error(`nothing must read ${file}`);
    },
    realpathNative: (p: string) => p,
  } as unknown as bootstrap.Runner;
}

const outcome = (state: bootstrap.WslOutcomeState, extra: Record<string, unknown> = {}) => ({
  state, code: null, sentence: null, at: '2026-09-19T12:00:00Z', release: '1.0.5', attempts: 1, ...extra,
});

const PRESENCE = { distro: 'crucible', engine: 'stopped', owner: 'child', detail: 'native' };

/** One JSON object per line, which is what the door answers with. */
function ndjson(events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

/**
 * A SCRIPTED HOST DOOR. `GET /install` answers the statuses in order (the last
 * one repeats), `GET /install/events` answers the stream once and 404s after,
 * and every POST is recorded.
 */
function scriptedDoor(script: {
  statuses: unknown[];
  events?: unknown[];
  postStatus?: number;
}) {
  const posts: { url: string; body: unknown }[] = [];
  let statusAt = 0;
  let streamed = false;
  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
    if ((init?.method ?? 'GET') === 'POST') {
      posts.push({ url, body: init?.body === undefined ? null : JSON.parse(init.body) });
      const status = script.postStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ code: 'host_install_running' }), { status });
      }
      return new Response(ndjson(script.events ?? []), { status: 200 });
    }
    if (url.endsWith('/install/events')) {
      if (streamed || script.events === undefined) return new Response('', { status: 404 });
      streamed = true;
      return new Response(ndjson(script.events), { status: 200 });
    }
    const answer = script.statuses[Math.min(statusAt, script.statuses.length - 1)];
    statusAt += 1;
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, posts };
}

// ─────────────────────────────────────────────────────────────────────────────
// §2.2 — the outcome stops being null
// ─────────────────────────────────────────────────────────────────────────────

test('the door reports every terminal outcome the tray can write', async () => {
  for (const state of bootstrap.WSL_OUTCOME_STATES) {
    const { fetchImpl } = scriptedDoor({
      statuses: [{
        running: false,
        outcome: outcome(state, { code: 'virtualization_disabled', sentence: 'Turn virtualization on.' }),
        presence: PRESENCE,
      }],
    });
    const answered = await door.crucibleInstallDoor({ fetchImpl, runner: hostRunner() }).status();
    expect(answered.running).toBe(false);
    expect(answered.outcome?.state).toBe(state);
    // The SENTENCE IS THE OUTCOME'S, verbatim — §2.2. A door that rewrote it
    // would be a second opinion about a machine only the state table looked at.
    expect(answered.outcome?.sentence).toBe('Turn virtualization on.');
    expect(answered.outcome?.code).toBe('virtualization_disabled');
  }
});

test('a machine with no host pack is answered as the absence, not as a refusal', async () => {
  const { fetchImpl } = scriptedDoor({ statuses: [] });
  const answered = await door.crucibleInstallDoor({
    fetchImpl, runner: hostRunner({ installed: false }),
  }).status();
  /*
   * NOT A FALLBACK. There is no door on a machine nobody has installed
   * anything on, so "nothing running, nothing recorded" is the only fact
   * available. It is deliberately different from a host that IS installed and
   * will not answer, which is `host_unreachable` by name — the test below.
   */
  expect(answered).toEqual({ running: false, outcome: null });
});

test('a host that is installed and will not answer refuses by name', async () => {
  const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const asked = door.crucibleInstallDoor({ fetchImpl, runner: hostRunner() }).status();
  // THE CODE, not the sentence: the sentence is the SDK's to word and this is
  // the fact an app switches on.
  await expect(asked).rejects.toMatchObject({ code: 'host_unreachable' });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2.5 — Try again is a POST, and a 409 attaches instead of failing
// ─────────────────────────────────────────────────────────────────────────────

test('Try again POSTs the move for the release the outcome records', async () => {
  const { fetchImpl, posts } = scriptedDoor({
    statuses: [{ running: false, outcome: outcome('cannot', { release: '1.0.5' }), presence: PRESENCE }],
    events: [
      { id: 1, event: 'step', data: { name: 'wsl-state', index: 1, total: 4 } },
      { id: 2, event: 'done', data: {
        server: { name: 'guest', url: 'http://127.0.0.1:7100', config_path: '/home/c/config.toml' },
        release: '1.0.5', backend: 'cuda-linux', crucible: '/home/c/server/bin/crucible', steps: [],
      } },
    ],
  });
  await door.crucibleInstallDoor({ fetchImpl, runner: hostRunner() }).retry();
  expect(posts.length).toBe(1);
  expect(posts[0]!.url).toContain('/install');
  // THE OUTCOME'S OWN RELEASE. Asking the channel here would turn a retry into
  // an upgrade nobody pressed a button for.
  expect((posts[0]!.body as { release: string }).release).toBe('1.0.5');
});

test('Try again on a machine with no recorded move refuses rather than starting one', async () => {
  const { fetchImpl, posts } = scriptedDoor({
    statuses: [{ running: false, outcome: null, presence: PRESENCE }],
  });
  const asked = door.crucibleInstallDoor({ fetchImpl, runner: hostRunner() }).retry();
  await expect(asked).rejects.toThrow(/nothing to try again/);
  expect(posts.length).toBe(0);
});

test('a 409 on Try again attaches to the move already running', async () => {
  const { fetchImpl, posts } = scriptedDoor({
    statuses: [
      { running: true, outcome: outcome('failed'), presence: PRESENCE },
      { running: false, outcome: outcome('done'), presence: PRESENCE },
    ],
    postStatus: 409,
    events: [{ id: 1, event: 'step', data: { name: 'guest-install', index: 2, total: 4 } }],
  });
  const seen: string[] = [];
  const it = door.crucibleInstallDoor({ fetchImpl, runner: hostRunner() });
  const detach = it.watch((event) => { if (event.event === 'step') seen.push(event.row); });
  await it.retry();
  detach();
  expect(posts.length).toBe(1);
  /*
   * THE RING REPLAY IS WHAT MAKES THIS WORTH DOING (§2.6): the door keeps the
   * last 200 events, so a client that arrives late is handed the step it
   * joined at rather than silence until the next one. `guest-install` is that
   * step, and `windows-engine` is drawn in front of it because a tray
   * answering at all proves the native engine is up (§2.8).
   */
  expect(seen).toEqual(['windows-engine', 'linux-engine']);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 — the host's steps, folded into the rows a person reads
// ─────────────────────────────────────────────────────────────────────────────

test('every step the host installer names lands on a row, and an unknown one on none', () => {
  const ROWS: Record<string, string> = {
    'host': 'install',
    'wsl-state': 'linux-engine',
    'import-distro': 'linux-engine',
    'guest-ready': 'linux-engine',
    'guest-install': 'linux-engine',
    'migrate-config': 'linux-engine',
    'lan-door': 'linux-engine',
    'stop-windows-server': 'linux-engine',
    'switch-pairing': 'linux-engine',
    'install-job-types': 'job-types',
    'prepare-weights': 'models',
    'migrate-weights': 'models',
  };
  for (const [step, row] of Object.entries(ROWS)) expect(door.rowForHostStep(step)).toBe(row as never);
  // A Crucible newer than this app moves no row rather than inventing one.
  expect(door.rowForHostStep('reticulate-splines')).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// The reducer — the row ladder, driven by hand
// ─────────────────────────────────────────────────────────────────────────────

const SKELETON = wire.initialInstallRows([
  { id: 'install', label: 'Installing Crucible' },
  { id: 'windows-engine', label: 'Starting the Windows engine' },
  { id: 'linux-engine', label: 'Setting up the Linux engine' },
  { id: 'job-types', label: 'Installing what Foundry needs' },
  { id: 'models', label: 'Downloading models' },
]);

const play = (events: readonly import('../shared/crucible-install-wire').CrucibleInstallEvent[]) =>
  events.reduce<import('../shared/crucible-install-wire').CrucibleInstallRow[]>(
    (rows, event) => wire.applyInstallEvent(rows, event), SKELETON,
  );

const states = (rows: readonly { id: string; state: string }[]) =>
  Object.fromEntries(rows.map((row) => [row.id, row.state]));

test('a later row starting is what finishes the one before it', () => {
  const rows = play([
    { event: 'step', row: 'install', jobType: null },
    { event: 'step', row: 'linux-engine', jobType: null },
  ]);
  expect(states(rows)).toEqual({
    'install': 'done',
    // NEVER STARTED AND NOT GUESSED AT. The stream is ordered, so a later row
    // starting finishes what was RUNNING; a row nothing reported is still
    // waiting, and it is `done` that decides what that meant.
    'windows-engine': 'waiting',
    'linux-engine': 'running',
    'job-types': 'waiting',
    'models': 'waiting',
  });
});

test('done finishes what ran and skips what never did, so no grey row sits under it', () => {
  const rows = play([
    { event: 'step', row: 'install', jobType: null },
    { event: 'step', row: 'windows-engine', jobType: null },
    { event: 'done', backend: 'llama-windows' },
  ]);
  expect(states(rows)).toEqual({
    'install': 'done', 'windows-engine': 'done',
    'linux-engine': 'skipped', 'job-types': 'skipped', 'models': 'skipped',
  });
});

test('failed stops the row that was running and skips the rest', () => {
  const rows = play([
    { event: 'step', row: 'install', jobType: null },
    { event: 'step', row: 'linux-engine', jobType: null },
    { event: 'failed', code: 'virtualization_disabled', message: 'Turn virtualization on.' },
  ]);
  expect(states(rows)).toEqual({
    'install': 'done', 'windows-engine': 'skipped', 'linux-engine': 'failed',
    'job-types': 'skipped', 'models': 'skipped',
  });
  expect(rows.find((row) => row.id === 'linux-engine')?.detail).toBe('Turn virtualization on.');
});

test('bytes, lines and state sentences land on whichever row is running', () => {
  const rows = play([
    { event: 'step', row: 'linux-engine', jobType: null },
    { event: 'progress', bytesDone: 4_194_304, bytesTotal: 340_000_000, file: 'ubuntu-24.04.tar.gz' },
    { event: 'state', code: 'no_crucible_distro', sentence: 'Importing Ubuntu.', action: 'run' },
  ]);
  const row = rows.find((it) => it.id === 'linux-engine')!;
  expect(row.bytesDone).toBe(4_194_304);
  expect(row.bytesTotal).toBe(340_000_000);
  // The state sentence replaced the file name, because both are "what this row
  // is saying now" and the newer one is the answer.
  expect(row.detail).toBe('Importing Ubuntu.');
});

test('a job type gets its own child row and pip lines land under it, never on the heading', () => {
  const rows = play([
    { event: 'step', row: 'job-types', jobType: null },
    { event: 'step', row: 'job-types', jobType: 'llm' },
    { event: 'line', text: 'Collecting torch==2.5.1', stream: 'stdout' },
    { event: 'step', row: 'job-types', jobType: 'tts' },
    { event: 'line', text: 'Collecting boson-multimodal', stream: 'stdout' },
  ]);
  const row = rows.find((it) => it.id === 'job-types')!;
  expect(row.children.map((child) => [child.jobType, child.state, child.detail])).toEqual([
    ['llm', 'done', 'Collecting torch==2.5.1'],
    ['tts', 'running', 'Collecting boson-multimodal'],
  ]);
  // §2.12: pip has no byte total, so the row carries no bar and never invents one.
  expect(row.bytesTotal).toBeNull();
  expect(row.detail).toBeNull();
});

test('a row this platform does not have is dropped rather than appended', () => {
  const mac = wire.initialInstallRows([
    { id: 'install', label: 'Installing Crucible' },
    { id: 'job-types', label: 'Installing what Foundry needs' },
  ]);
  const rows = wire.applyInstallEvent(mac, { event: 'step', row: 'windows-engine', jobType: null });
  expect(rows.map((row) => row.id)).toEqual(['install', 'job-types']);
  expect(states(rows)).toEqual({ 'install': 'waiting', 'job-types': 'waiting' });
});
