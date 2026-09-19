#!/usr/bin/env node
/**
 * The extension's type-the-address path, against a real engine where there is
 * one.
 *
 * `extension/src/pair.ts` exists because Owen's objection was right: pasting a
 * 43-character token between two windows is not how a person adds a server.
 * The engine has had `POST /v1/pairing/start` and `/v1/pairing/poll` on its
 * PUBLIC router the whole time and nothing used them.
 *
 * The URL cases run everywhere and need nothing. The handshake runs only when a
 * Crucible answers on this machine, and SAYS it is skipping rather than passing
 * quietly — a pairing test that silently no-ops on a machine with no engine is
 * a test that passes for the wrong reason forever.
 *
 * It completes the handshake for real: start, approve as the operator with the
 * token from the pairing file, then poll for the token. Approving needs a
 * credential this script can only have on the engine's own machine, which is
 * exactly why this is a local keeper and not a CI one.
 */
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
let failures = 0;
let ran = 0;

function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
  }
}

async function checkAsync(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
  }
}

/** Bundle pair.ts to CJS so this runs it, rather than a copy of its logic. */
async function loadPairModule() {
  const esbuild = require(path.join(REPO, 'extension/node_modules/esbuild'));
  const out = path.join(os.tmpdir(), `crucible-pair-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(REPO, 'extension/src/pair.ts')],
    outfile: out,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    // `servers.ts` reaches for chrome.* inside its functions; only CLIENT_NAME
    // is wanted here, so the module is stubbed rather than loaded.
    plugins: [{
      name: 'stub-servers',
      setup(build) {
        build.onResolve({ filter: /\.\/servers$/ }, () => ({ path: 'servers', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const CLIENT_NAME = "bookforge-reader";',
          loader: 'js',
        }));
      },
    }],
  });
  const loaded = require(out);
  fs.unlinkSync(out);
  return loaded;
}


function urlCases(pair) {
  check('a bare IP becomes a dialable base URL on Crucible\'s port', () => {
    assert.strictEqual(pair.normaliseServerUrl('192.0.2.79'), 'http://192.0.2.79:7100');
  });

  check('a named port is kept', () => {
    assert.strictEqual(pair.normaliseServerUrl('127.0.0.1:7101'), 'http://127.0.0.1:7101');
  });

  check('a full URL survives unchanged', () => {
    assert.strictEqual(pair.normaliseServerUrl('http://192.0.2.5:7100'), 'http://192.0.2.5:7100');
  });

  check('https is accepted and not rewritten to http', () => {
    assert.strictEqual(pair.normaliseServerUrl('https://box:8443'), 'https://box:8443');
  });

  check('a trailing slash and a copied /v1 are trimmed', () => {
    assert.strictEqual(pair.normaliseServerUrl('http://127.0.0.1:7100/v1'), 'http://127.0.0.1:7100');
    assert.strictEqual(pair.normaliseServerUrl('127.0.0.1:7100/'), 'http://127.0.0.1:7100');
  });

  check('whitespace around a pasted address is not an error', () => {
    assert.strictEqual(pair.normaliseServerUrl('  127.0.0.1  '), 'http://127.0.0.1:7100');
  });

  check('an empty box is refused with what to type', () => {
    assert.throws(() => pair.normaliseServerUrl('   '), /Type the address/);
  });

  check('a scheme that is not http(s) is refused BY NAME', () => {
    assert.throws(() => pair.normaliseServerUrl('ftp://box'), /http or https/);
  });
}

/**
 * The pairing line on this machine, from wherever the engine's home actually
 * is.
 *
 * TWO PLACES, and the native one first. On Windows the engine lives inside WSL
 * and only `wsl.exe` can read its home; everywhere else it is this user's own
 * `~/.crucible/pairing`. Asking WSL and nothing else made the whole handshake
 * below PC-ONLY: on a Mac running a live engine there is no `wsl.exe` at all,
 * the catch swallowed the ENOENT, and `localEngine` answered "no engine" about
 * a machine with one — so four checks skipped while saying the host was the
 * reason. The skip line is honest about a machine with no engine and was
 * telling the truth in the only place it had ever been run.
 */
function pairingLine() {
  const native = path.join(os.homedir(), '.crucible', 'pairing');
  try {
    if (fs.existsSync(native)) {
      return fs.readFileSync(native, 'utf8').split('\n')[0].trim();
    }
  } catch {
    // Unreadable is not "absent", but it is equally not an engine this script
    // can approve with, and WSL is still worth asking on Windows.
  }
  if (process.platform !== 'win32') return null;
  const distro = process.env.CRUCIBLE_WSL_DISTRO || 'Ubuntu';
  try {
    return execFileSync('wsl.exe', ['-d', distro, '--exec', 'bash', '-lc',
      'cat ~/.crucible/pairing 2>/dev/null | head -1'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * The engine this script can approve with, when there is one.
 *
 * The PORT comes out of the line rather than being assumed: an engine serving
 * somewhere other than 7100 is one this keeper should still dial, and a
 * hardcoded default would fail it for the address instead of the behaviour.
 */
function localEngine() {
  const line = pairingLine();
  if (line === null || !line.startsWith('crucible://')) return null;
  const token = line.split('#')[1];
  if (!token) return null;
  // One literal `@`: the name before it is percent-encoded, which is the whole
  // reason `parsePairing` refuses a second one.
  const authority = line.slice('crucible://'.length).split('/')[0];
  const at = authority.indexOf('@');
  const hostPort = at < 0 ? authority : authority.slice(at + 1);
  const port = hostPort.split(':')[1] || '7100';
  return { url: `http://127.0.0.1:${port}`, dial: `127.0.0.1:${port}`, token };
}

(async () => {
  console.log('extension pairing — typing an address instead of a token');
  const pair = await loadPairModule();

  urlCases(pair);

  const engine = localEngine();
  if (engine === null) {
    console.log('  --  the handshake is SKIPPED: no Crucible pairing file on this machine.');
    console.log('      That is a fact about this host, not a pass. Run it where an engine is.');
  } else {
    let started = null;
    await checkAsync('a typed address starts a handshake and returns a short code', async () => {
      started = await pair.startPairing(engine.dial);
      assert.match(started.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'the code a person reads');
      assert.ok(started.deviceCode.length >= 32, 'the credential a person never sees');
      assert.notStrictEqual(started.userCode, started.deviceCode);
      assert.strictEqual(started.url, engine.url);
      assert.ok(started.name.startsWith('crucible@'), `named itself: ${started.name}`);
      assert.strictEqual(typeof started.approvalRequired, 'boolean', 'it says which policy');
    });

    /*
     * WHICH POLICY THIS ENGINE IS ON is READ, never assumed. Crucible pairs
     * openly by default since 2026-09-17 (Owen: "ollama allows anybody to
     * connect if they can reach it"), and an engine from before that ruling
     * still wants an approval. This keeper has to be true of the engine it is
     * actually pointed at, and on this machine that flips the day a release
     * carrying the new default is deployed.
     */
    const openly = started !== null && started.approvalRequired === false;
    console.log(`  --  this engine pairs ${openly ? 'OPENLY' : 'with an APPROVAL step'}.`);

    if (openly) {
      await checkAsync('reaching the engine is the whole of it: a token, no approval', async () => {
        const outcome = await pair.pollForToken(started);
        assert.strictEqual(outcome.status, 'approved');
        assert.strictEqual(outcome.token, engine.token, 'the token is the engine\'s own');
        assert.ok(outcome.name.startsWith('crucible@'));
      });

      await checkAsync('nothing is left waiting for an operator to look at', async () => {
        const pending = await fetch(`${engine.url}/v1/pairing/requests`, {
          headers: { Authorization: `Bearer ${engine.token}`, 'X-Crucible-Api': '1' },
        }).then((r) => r.json());
        assert.ok(!pending.requests.some((r) => r.id === started.id),
          'an auto-approved request is not a chore on somebody\'s screen');
      });

      await checkAsync('open is not "any poll gets a token"', async () => {
        // Anyone may ASK and be approved. Nobody may collect somebody else's
        // approval: the device secret still ties a poll to the request that
        // made it, and that is the part an open door does NOT give away.
        await assert.rejects(
          () => pair.pollForToken({ ...started, deviceCode: 'x'.repeat(43) }),
          /refused this|HTTP 403/,
        );
      });
    } else {
      await checkAsync('the operator approves that code, and only then is a token sent', async () => {
        const pending = await fetch(`${engine.url}/v1/pairing/requests`, {
          headers: { Authorization: `Bearer ${engine.token}`, 'X-Crucible-Api': '1' },
        }).then((r) => r.json());
        const mine = pending.requests.find((r) => r.id === started.id);
        assert.ok(mine, 'the engine lists it as pending for an operator to see');
        assert.strictEqual(mine.client_name, 'bookforge-reader', 'it names the asker');

        const decided = await fetch(`${engine.url}/v1/pairing/decision`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${engine.token}`,
            'X-Crucible-Api': '1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ id: started.id, user_code: started.userCode, allow: true }),
        }).then((r) => r.json());
        assert.strictEqual(decided.status, 'approved');

        const outcome = await pair.pollForToken(started);
        assert.strictEqual(outcome.status, 'approved');
        assert.strictEqual(outcome.token, engine.token, 'the token is the engine\'s own');
        assert.ok(outcome.name.startsWith('crucible@'));
      });

      await checkAsync('a denied request yields no token and says it was denied', async () => {
        // `connect.py` allows one start per address every five seconds and answers
        // `pairing_busy` otherwise. That is the engine's rule and this waits it out
        // rather than treating our own haste as a defect - the first draft of this
        // test failed exactly that way.
        await new Promise((done) => { setTimeout(done, 6000); });
        const asked = await pair.startPairing(engine.dial);
        await fetch(`${engine.url}/v1/pairing/decision`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${engine.token}`,
            'X-Crucible-Api': '1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ id: asked.id, user_code: asked.userCode, allow: false }),
        }).then((r) => r.json());
        const outcome = await pair.pollForToken(asked);
        assert.strictEqual(outcome.status, 'denied');
        assert.strictEqual(outcome.token, undefined, 'a refusal carries nothing');
      });
    }

    await checkAsync('something that is not a Crucible is told apart from a bad address', async () => {
      await assert.rejects(
        () => pair.startPairing('127.0.0.1:9'),
        /Nothing answered|is not a Crucible/,
      );
    });
  }

  console.log(`\nextension pairing: ${ran - failures} passed, ${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
