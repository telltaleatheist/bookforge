#!/usr/bin/env node
/**
 * THE QUEUE SESSION — this app's turn holding a Crucible for a run of requests.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-session.js
 *
 * Crucible 1.0.76 replaced leases with queue sessions (crucible docs/QUEUE.md,
 * sdk/ts/MIGRATION.md). `electron/crucible/lease.ts` keeps its seam and opens a
 * session instead: it WAITS IN THE SERVER'S LINE, opens with the model resident,
 * and while it is open nothing from any other client runs there.
 *
 *  1. ON THE WIRE: one session per run, the act, the model, idle_s 300 and the
 *     batch day in the body, this install's client name in the header, and a
 *     close at the end — on success, on a throw, and on quit.
 *  2. IT WAITS ITS TURN: a session asked for while another client's is open
 *     waits in the line, says its place, and opens when that one closes.
 *  3. A SESSION THAT NEVER OPENED is read by its reason through the one removal
 *     policy: `expired` is weather (a busy line), `operator` removes the run
 *     (a removed line), `load_failed` is the error it is. Another client's
 *     `session_open` is a wait carrying the holder's own line.
 *  4. PRESENCE: a held session is touched; one the SERVER ended is dropped, so
 *     the next act opens a new one instead of being handed a dead handle.
 *  5. THE TEXT-ACT DOOR turns a held machine into `crucible_session_wait` with
 *     the line the queue parks on.
 *  6. THE ENGINE'S HEADER MAP carries this install's name, so its chats are items
 *     of the session the door opened, and the name has the host in it.
 *  7. THE STARTUP SWEEP closes a session by id AS ITS OWNER (only the opener may
 *     close one, reason `client`), and a forgotten one is gone.
 *  8. The one-job doors never reach for the module; the many-job door does.
 *
 * No GPU, no model, no network beyond 127.0.0.1, and no registry but its own.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer,
  sessionRoutes, sessionHeldRefusal,
} = require('./fake-crucible.js');
const { skipLine } = require('./keeper-skip.js');

const LEASE = path.join(REPO, 'dist', 'electron', 'crucible', 'lease.js');
if (!fs.existsSync(LEASE)) {
  console.log(skipLine('dist/electron/crucible/lease.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

installElectronStub('bf-crucible-session-');

const lease = require(LEASE);
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const textVenue = require(path.join(REPO, 'dist', 'electron', 'crucible', 'text-venue.js'));
const textActs = require(path.join(REPO, 'dist', 'electron', 'crucible', 'text-acts.js'));
const clientName = require(path.join(REPO, 'dist', 'electron', 'crucible', 'client-name.js'));
const sdk = require('@crucible/client');

const nameFake = fakeNamer(servers);
const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const opts = (server, more = {}) => ({
  server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog: () => {}, ...more,
});

const { check, summary } = makeChecker();

(async () => {
  // ── 1. On the wire ───────────────────────────────────────────────────────
  await check('a run opens ONE session — act, model, idle and wait in the body — and closes it', async () => {
    const routes = sessionRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      let inside = null;
      await lease.withCrucibleLease(opts(server), async (held) => {
        inside = held;
        assert.strictEqual(lease.openCrucibleLeaseCount(), 1, 'the session is open while the run is');
        assert.deepStrictEqual(lease.ownCrucibleSessionIds(server), new Set([held.id]),
          'the card read must know this session is ours');
      });
      assert.strictEqual(routes.session.opened.length, 1);
      const opened = routes.session.opened[0];
      assert.strictEqual(opened.act, 'clean');
      assert.strictEqual(opened.model, 'qwen3.5-9b', 'kind model opens the session WITH the model resident');
      assert.strictEqual(opened.idleS, lease.CRUCIBLE_SESSION_IDLE_S);
      assert.strictEqual(opened.maxWaitS, lease.CRUCIBLE_SESSION_MAX_WAIT_S);
      assert.strictEqual(opened.client, servers.CRUCIBLE_CLIENT_NAME,
        'membership matches on the client name, so it must be on the request');
      assert.deepStrictEqual(routes.session.closed, [{ sessionId: inside.id }]);
      assert.strictEqual(lease.openCrucibleLeaseCount(), 0, 'nothing is left open');
      assert.ok(lease.ownCrucibleSessionIds(server).has(inside.id),
        'a session closed a moment ago is still ours to the card read');
    } finally {
      await fake.close();
    }
  });

  await check('a separator session opens bare — the first job makes it resident', async () => {
    const routes = sessionRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      const held = await lease.takeCrucibleLease(opts(server, { kind: 'separator', id: 'sep', act: 'denoise' }));
      assert.strictEqual(routes.session.opened[0].model, null);
      await held.release();
      await held.release();
      assert.strictEqual(routes.session.closed.length, 1, 'release is idempotent');
    } finally {
      await fake.close();
    }
  });

  await check('a run that THROWS still closes, and the throw is not swallowed', async () => {
    const routes = sessionRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      await assert.rejects(
        lease.withCrucibleLease(opts(server), async () => { throw new Error('the act broke'); }),
        /the act broke/);
      assert.strictEqual(routes.session.closed.length, 1);
      assert.strictEqual(lease.openCrucibleLeaseCount(), 0);
    } finally {
      await fake.close();
    }
  });

  await check('the app quitting closes every session it holds', async () => {
    const routes = sessionRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      await lease.takeCrucibleLease(opts(server));
      assert.strictEqual(lease.openCrucibleLeaseCount(), 1);
      await lease.releaseAllCrucibleLeases();
      assert.strictEqual(lease.openCrucibleLeaseCount(), 0);
      assert.strictEqual(routes.session.closed.length, 1);
    } finally {
      await fake.close();
    }
  });

  // ── 2. It waits its turn ─────────────────────────────────────────────────
  await check('a session asked for while another client holds the machine waits, says its place, then opens', async () => {
    const routes = sessionRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    const foreign = new sdk.CrucibleClient({ url: fake.url, token: 't', clientName: 'foundry@other-box' });
    try {
      const theirs = await foreign.session({ act: 'translate' });
      const lines = [];
      let ran = false;
      const ours = lease.withCrucibleLease(
        opts(server, { onQueue: (line) => lines.push(line) }),
        async () => { ran = true; },
      );
      await after(100);
      assert.strictEqual(ran, false, 'nothing of ours runs while their session is open');
      assert.ok(lines.length > 0 && /#1/.test(lines[0]) && lines[0].includes(server),
        `the wait must say where it stands: ${JSON.stringify(lines)}`);
      await theirs.close();
      await ours;
      assert.strictEqual(ran, true, 'and it opens when theirs closes');
      assert.deepStrictEqual(routes.session.wire.map((w) => w.kind),
        ['open', 'queued', 'close', 'open', 'close']);
    } finally {
      await fake.close();
    }
  });

  // ── 3. A session that never opened, by its reason ───────────────────────
  for (const [reason, field] of [['expired', 'busyLine'], ['server_restart', 'busyLine'], ['operator', 'removedLine']]) {
    await check(`a session the line let go as "${reason}" is read as a ${field}`, async () => {
      const routes = sessionRoutes({
        holdLine: () => ({ position: 2, of: 3, then: { reason, message: `said ${reason}` } }),
      });
      const fake = await startFakeCrucible(routes.handler);
      const server = nameFake(fake.url);
      try {
        let caught = null;
        try { await lease.takeCrucibleLease(opts(server)); } catch (err) { caught = err; }
        assert.ok(caught instanceof sdk.CrucibleSessionClosed, `got ${caught}`);
        assert.strictEqual(caught.reason, reason);
        const wait = lease.asSessionWait(caught, server, 'clean');
        assert.ok(wait instanceof lease.CrucibleSessionWait, 'reshaped for the scheduler');
        assert.ok(typeof wait[field] === 'string' && wait[field].includes(server), wait[field]);
        const other = field === 'busyLine' ? 'removedLine' : 'busyLine';
        assert.strictEqual(wait[other], undefined, `a ${reason} must not also carry ${other}`);
        assert.strictEqual(lease.openCrucibleLeaseCount(), 0);
      } finally {
        await fake.close();
      }
    });
  }

  await check('a load_failed session is the error it is — nobody removed anything', () => {
    const err = new sdk.CrucibleSessionClosed(409, 'the model would not load', null,
      { sessionId: 'ses-9', reason: 'load_failed' });
    assert.strictEqual(lease.asSessionWait(err, 'mac', 'clean'), err);
  });

  await check('another client\'s session_open is a wait carrying the holder\'s own line', async () => {
    const fake = await startFakeCrucible(async (req, res) => {
      const refusal = sessionHeldRefusal({
        sessionId: 'ses-theirs', client: 'foundry@owens-pc', act: 'translate', since: '2026-10-01T00:00:00Z',
      });
      res.writeHead(refusal.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: refusal.code, message: refusal.message, details: refusal.details } }));
      return true;
    });
    try {
      const client = new sdk.CrucibleClient({ url: fake.url, token: 't', clientName: 'x', queue: false });
      let caught = null;
      try { await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }); } catch (err) { caught = err; }
      assert.ok(caught instanceof sdk.CrucibleSessionHeld, `got ${caught}`);
      const wait = lease.asSessionWait(caught, 'pc', 'clean');
      assert.strictEqual(wait.busyLine, caught.heldLine);
      assert.match(wait.busyLine, /foundry@owens-pc's session for translate/);
    } finally {
      await fake.close();
    }
  });

  // ── 4. Presence ─────────────────────────────────────────────────────────
  await check('a held session is touched, and one the server ended is dropped', async () => {
    const routes = sessionRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      const held = await lease.takeCrucibleLease(opts(server, { touchMs: 40 }));
      await after(150);
      assert.ok(routes.session.touched.length >= 2, `touched ${routes.session.touched.length}×`);
      // The server ends it (an operator, say): the DELETE route here stands in.
      const operator = new sdk.CrucibleClient({ url: fake.url, token: 't', clientName: 'operator' });
      await operator.removeFromQueue(held.id);
      for (let i = 0; i < 50 && !held.ended; i += 1) await after(20);
      assert.strictEqual(held.ended, true, 'the handle knows the server ended it');
      assert.strictEqual(lease.openCrucibleLeaseCount(), 0,
        'and it is dropped, so no act is handed a dead session');
      await held.release();
    } finally {
      await fake.close();
    }
  });

  // ── 5. The text-act door ────────────────────────────────────────────────
  await check('a text act on a machine whose line let it go parks on crucible_session_wait', async () => {
    const routes = sessionRoutes({
      holdLine: () => ({ position: 1, of: 1, then: { reason: 'expired', message: 'nobody followed it' } }),
    });
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      let caught = null;
      try {
        await textVenue.withCrucibleTextActLease(
          { server, endpoint: `${fake.url}/openai`, model: 'qwen3.5-9b', act: 'simplify' },
          async () => { throw new Error('must not run'); });
      } catch (err) { caught = err; }
      assert.ok(caught, 'refused');
      assert.strictEqual(caught.code, 'crucible_session_wait');
      assert.ok(typeof caught.busyLine === 'string' && caught.busyLine.includes(server), caught.busyLine);
    } finally {
      await fake.close();
    }
  });

  // ── 6. The engine's header map, and the name ────────────────────────────
  await check('the engine header map carries this install\'s name, and the name has the host', () => {
    const map = textActs.endpointHeaderMap('tok', 'clean');
    assert.strictEqual(map['X-Crucible-Client'], servers.CRUCIBLE_CLIENT_NAME);
    assert.match(servers.CRUCIBLE_CLIENT_NAME, /^bookforge@[a-z0-9-]+$/);
    assert.strictEqual(clientName.crucibleClientNameFor('bookforge', 'Owens-Mac-Studio.local'),
      'bookforge@owens-mac-studio');
    assert.strictEqual(clientName.crucibleClientNameFor('bookforge', ''), 'bookforge');
  });

  // ── 7. The startup sweep ────────────────────────────────────────────────
  await check('the sweep closes a session by id AS ITS OWNER, and a forgotten one is gone', async () => {
    const routes = sessionRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      const owner = clientName.HOSTED_FOUNDRY_CLIENT_NAME;
      assert.match(owner, /^foundry@/, 'the hosted Foundry opens under foundry@<host>');
      const foundry = new sdk.CrucibleClient({ url: fake.url, token: 't', clientName: owner });
      const theirs = await foundry.session({ act: 'clean' });
      const refused = await lease.closeCrucibleSessionById(server, theirs.id, servers.CRUCIBLE_CLIENT_NAME);
      assert.strictEqual(refused.outcome, 'refused', 'only the opener may close a session this way');
      const closed = await lease.closeCrucibleSessionById(server, theirs.id, owner);
      assert.strictEqual(closed.outcome, 'released', closed.detail);
      assert.strictEqual(routes.openId(), null, 'the machine is free');
      assert.deepStrictEqual(routes.session.wire.map((w) => w.kind), ['open', 'close'],
        'closed as the client — our own cleanup, never an operator removal');
      const gone = await lease.closeCrucibleSessionById(server, 'ses-never', owner);
      assert.strictEqual(gone.outcome, 'gone', gone.detail);
      await theirs.close().catch(() => undefined);
    } finally {
      await fake.close();
    }
  });

  // ── 8. Who reaches for the module ───────────────────────────────────────
  await check('no one-job door, and no streaming door, reaches for the session module', () => {
    const mustNot = ['render.ts', 'asr.ts', 'align.ts', 'rvc.ts', 'reroll.ts', 'stream.ts'];
    for (const name of mustNot) {
      const source = fs.readFileSync(path.join(REPO, 'electron', 'crucible', name), 'utf8');
      const imports = /(?:from\s+['"]\.\/lease(?:\.js)?['"]|require\(\s*['"]\.\/lease(?:\.js)?['"])/.test(source);
      assert.ok(!imports, `${name} imports ./lease — a one-job or streaming door opens no session`);
    }
  });

  await check('the MANY-job door does open one', () => {
    const source = fs.readFileSync(path.join(REPO, 'electron', 'crucible', 'denoise.ts'), 'utf8');
    assert.match(source, /from\s+['"]\.\/lease(?:\.js)?['"]/);
    assert.match(source, /takeCrucibleLease/);
    assert.match(source, /release\(\)/);
  });

  summary('crucible session');
})();
