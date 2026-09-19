/**
 * The connect code BookForge hands out is the one Crucible would have.
 *
 * WHY THIS EXISTS. Three surfaces told people to copy a connect code from
 * somewhere else, and every route led to a locked door: the operator console
 * has the button but asks for the token before it will show you the token, and
 * the documented escape hatch — `crucible token --url` — needs a terminal on
 * that machine, which is where Owen ran aground on a Mac with no `crucible` on
 * PATH (2026-09-15). BookForge is already talking to every server in its
 * registry, so it can emit the line itself.
 *
 * Which makes FORMAT PARITY the thing to hold: a line this app writes and a
 * line `crucible token --url` writes must be the same bytes, or apps pair off
 * one and not the other. The reference below is a real line from a real
 * server, with the token replaced.
 */
const assert = require('assert');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist', 'electron');
const { connectCodeFor } = require(path.join(DIST, 'crucible', 'connect-code.js'));

let ran = 0;
let failed = 0;
function check(name, fn) {
  ran += 1;
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const TOKEN = '2SgeABHkBGZEDsljnL_BFxSZtZqKR0mdgxtTQGfJXn0';

check('it matches `crucible token --url` byte for byte', () => {
  // Measured against the real output of `crucible token --url` on example-pc-wsl.
  assert.strictEqual(
    connectCodeFor('crucible@example-pc-wsl', 'http://127.0.0.1:7100', TOKEN),
    `crucible://crucible%40example-pc-wsl@127.0.0.1:7100/#${TOKEN}`,
  );
});

check('the NAME is percent-encoded, because it carries an @ of its own', () => {
  /*
   * The half that actually bites. `crucible@example-pc-wsl` unencoded would make
   * the authority start at the wrong `@`: the line still parses, names the host
   * `example-pc-wsl`, and is wrong in a way that looks right.
   */
  const line = connectCodeFor('crucible@mac', 'http://box:7100', TOKEN);
  assert.ok(line.includes('crucible%40mac@box:7100'), line);
  assert.strictEqual(line.split('@').length - 1, 1, 'exactly one un-encoded @, the separator');
});

check('the trailing / before the fragment is part of the format', () => {
  // Without it a lenient parser reads the fragment as part of the authority and
  // a strict one refuses the line. crucible/pairing.py says so in as many words.
  assert.ok(connectCodeFor('a', 'http://h:7100', TOKEN).includes(':7100/#'));
});

check('only the AUTHORITY of the url is used — a path has nowhere to go', () => {
  assert.strictEqual(
    connectCodeFor('a', 'http://h:7100/v1/ignored', TOKEN),
    connectCodeFor('a', 'http://h:7100', TOKEN),
  );
});

check('a url with no host is refused, naming the server', () => {
  assert.throws(() => connectCodeFor('mac', 'file:///nowhere', TOKEN), /no host/);
});

check('a token with reserved characters survives the round trip', () => {
  // `secrets.token_urlsafe` emits only unreserved characters today, so this
  // changes nothing today — which is exactly when the rule should be held.
  const line = connectCodeFor('a', 'http://h:7100', 'a/b+c=d#e');
  const fragment = line.slice(line.indexOf('/#') + 2);
  assert.strictEqual(decodeURIComponent(fragment), 'a/b+c=d#e');
  assert.ok(!fragment.includes('#'), 'an unencoded # would truncate the token');
});

console.log(`\ncrucible connect code: ${ran} check(s), ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
