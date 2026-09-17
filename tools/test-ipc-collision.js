#!/usr/bin/env node
/**
 * The IPC collision keeper: BookForge's channel names against the hosted
 * Foundry's, which now live in the same main process.
 *
 *   node tools/test-ipc-collision.js
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * `mountFoundry` registers 60-odd `ipcMain.handle` doors into THIS process,
 * beside BookForge's own several hundred. `ipcMain.handle` throws on a duplicate
 * channel — loudly, at registration — so a collision is not a subtle bug; it is
 * an app that will not start, discovered by whoever launches it next.
 *
 * The rule the two projects agreed (Foundry's docs/BOOKFORGE-HANDOFF.md, the
 * 2026-08-16 notes): a shared FAMILY is fine, a shared FULL NAME is fatal.
 * Eleven families already overlap — `app`, `book`, `dialog`, `document`,
 * `library`, `project`, `projects`, `queue`, `shell`, `window`, `wsl` — and
 * every one of them is verb-disjoint. Nobody renamed anything, which means the
 * only thing standing between the two apps is that nobody ADDS a colliding name
 * later. That is what this test is.
 *
 * ── The authorities ─────────────────────────────────────────────────────────
 *
 * FOUNDRY'S SIDE: `foundry-app/IPC-CHANNELS.md`, and deliberately not their
 * sources. Foundry's side ruled it (message channel, 2026-08-16): the doc is
 * generated from `app/electron/ipc.ts` + `preload.ts`, regenerating it every
 * wave is a standing obligation on them, and "build your keeper against the doc,
 * not against parsing our sources — the doc is the contract; the sources are
 * ours to rearrange". The doc travels with the vendored subtree, so refreshing
 * the subtree refreshes what this test checks against.
 *
 * OUR SIDE: the SOURCE — `electron/**\/*.ts` and `electron/preload.ts` — never
 * `dist/`. A channel added and not yet compiled is exactly the one this test
 * exists to catch, and a stale `dist/` would let it through.
 *
 * ── The no-op guard ─────────────────────────────────────────────────────────
 *
 * A parser is a silent thing when its input changes shape: a reformatted table
 * would make this file "pass" by finding nothing at all, forever. So the parse
 * has to find at least MIN_FOUNDRY_CHANNELS names, and this test FAILS if it
 * does not — a format change becomes a red test rather than a keeper that quietly
 * stopped keeping.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CHANNELS_DOC = path.join(REPO, 'foundry-app', 'IPC-CHANNELS.md');
const ELECTRON_DIR = path.join(REPO, 'electron');

/**
 * A FLOOR, NEVER A COUNT — and the distinction is not pedantry, it is the
 * defect Foundry's own doc has now suffered three times.
 *
 * At `e6d5424` the doc's tables parse to **148** names (130 `ipcMain.handle`
 * call sites, 130 distinct, zero `ipcMain.on`, plus 18 pushes), MEASURED HERE
 * over the vendored `foundry-app/electron/ipc.ts` and the vendored doc rather
 * than read off the doc's header. That header had claimed **119** while the
 * source held **127** — eight doors added under a stale figure — which is the
 * third time a hand-maintained number in the file whose entire job is to be
 * counted went stale (2026-08-22, 2026-08-23, 2026-09-14). Their commit fixed
 * it, and this comment records the measurement rather than inheriting the claim.
 *
 * So nothing in this test reads a stated total from anywhere. `foundryChannels`
 * parses the TABLE ROWS, and the floor below is set far under the measured size
 * on purpose: Foundry may retire a channel without this test having an opinion,
 * but a parse that suddenly returns a handful of names has stopped reading the
 * tables and must say so. Raising the floor to the current count would make this
 * file the fourth hand-maintained number.
 */
const MIN_FOUNDRY_CHANNELS = 60;

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Reading Foundry's side ──────────────────────────────────────────────────

/**
 * Every channel name in the doc's two tables.
 *
 * Both tables are `| \`family:verb\` | prose |`, so one row shape reads both:
 * the first cell, backticked, of a table row. The `family:verb` shape is
 * required rather than assumed — it is the invariant the doc exists to prove,
 * and a bare name in there would be the one collision class that cannot be
 * absorbed silently, so it is worth failing on.
 */
function foundryChannels() {
  const text = fs.readFileSync(CHANNELS_DOC, 'utf-8');
  const names = new Set();
  const malformed = [];
  for (const line of text.split(/\r?\n/)) {
    const row = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (!row) continue;
    const name = row[1].trim();
    if (/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(name)) names.add(name);
    else malformed.push(name);
  }
  return { names, malformed };
}

// ── Reading ours ────────────────────────────────────────────────────────────

function tsFilesUnder(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'data') continue;
      found.push(...tsFilesUnder(full));
    } else if (entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Every channel literal BookForge names, with the file it is named in.
 *
 * Both ends, because both ends collide for different reasons: a `ipcMain.handle`
 * that duplicates one of Foundry's throws at registration, and an
 * `ipcRenderer.on` that duplicates one of their PUSHES silently receives their
 * messages — a listener firing on somebody else's event, which is worse than a
 * crash because nothing says so.
 *
 * Only string LITERALS. A channel composed at runtime is not something a static
 * reader can answer for, and pretending otherwise would be the more dangerous
 * half-measure; the convention in this tree is a literal at every call site.
 */
function bookforgeChannels() {
  const owned = new Map(); // channel -> Set<file>
  const CALLS = [
    /ipcMain\s*\.\s*handle\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /ipcMain\s*\.\s*on\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /ipcRenderer\s*\.\s*invoke\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /ipcRenderer\s*\.\s*on\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /ipcRenderer\s*\.\s*once\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /ipcRenderer\s*\.\s*send\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /ipcRenderer\s*\.\s*removeListener\s*\(\s*['"`]([^'"`]+)['"`]/g,
  ];
  for (const file of tsFilesUnder(ELECTRON_DIR)) {
    const text = fs.readFileSync(file, 'utf-8');
    for (const pattern of CALLS) {
      pattern.lastIndex = 0;
      let hit;
      while ((hit = pattern.exec(text)) !== null) {
        const name = hit[1];
        if (!owned.has(name)) owned.set(name, new Set());
        owned.get(name).add(path.relative(REPO, file));
      }
    }
  }
  return owned;
}

// ── The tests ───────────────────────────────────────────────────────────────

test('the vendored channel list is where the keeper expects it', () => {
  assert.ok(fs.existsSync(CHANNELS_DOC),
    `${path.relative(REPO, CHANNELS_DOC)} is missing. It is copied out of the Foundry repo `
    + 'alongside the subtree (see foundry-app/VENDORED.md) and is the authority this test reads.');
});

test('the parse still finds Foundry\'s channels — it has not become a no-op', () => {
  const { names } = foundryChannels();
  assert.ok(names.size >= MIN_FOUNDRY_CHANNELS,
    `only ${names.size} channel names were parsed out of ${path.basename(CHANNELS_DOC)}, and at `
    + `least ${MIN_FOUNDRY_CHANNELS} are expected. The doc's table format has changed, so this `
    + 'test is no longer reading it — fix the parse rather than lowering the floor.');
});

test('every name Foundry publishes is family:verb', () => {
  const { malformed } = foundryChannels();
  assert.deepStrictEqual(malformed, [],
    `${malformed.join(', ')} in ${path.basename(CHANNELS_DOC)} ${malformed.length === 1 ? 'is' : 'are'} `
    + 'not `family:verb`. A bare name is the one collision class hosting cannot absorb.');
});

test('BookForge\'s own channels were found — the source scan is not a no-op', () => {
  const owned = bookforgeChannels();
  assert.ok(owned.size >= 200,
    `only ${owned.size} channel literals were found under electron/. This tree registers several `
    + 'hundred; the scan has stopped matching the call sites.');
});

test('NO channel name is shared between BookForge and the hosted Foundry', () => {
  const { names: theirs } = foundryChannels();
  const ours = bookforgeChannels();
  const collisions = [];
  for (const name of theirs) {
    const where = ours.get(name);
    if (where) collisions.push(`${name} (ours in ${[...where].join(', ')})`);
  }
  assert.deepStrictEqual(collisions, [],
    'These channel names are claimed by BOTH apps, which now share one main process:\n'
    + collisions.map((c) => `        ${c}`).join('\n')
    + '\n        A duplicate ipcMain.handle throws at registration — BookForge will not start with '
    + 'the Foundry window mounted. A duplicate renderer event is worse: it fires on the other app\'s '
    + 'messages and says nothing. Rename OURS; the vendored subtree is sealed.');
});

test('the families that overlap are named, so the near-misses stay visible', () => {
  // Not a rule — a report, and it fails only if the overlap is empty, which
  // would mean one of the two scans read nothing.
  const { names: theirs } = foundryChannels();
  const ours = bookforgeChannels();
  const familyOf = (n) => n.slice(0, n.indexOf(':'));
  const theirFamilies = new Set([...theirs].map(familyOf));
  const ourFamilies = new Set([...ours.keys()].filter((n) => n.includes(':')).map(familyOf));
  const shared = [...theirFamilies].filter((f) => ourFamilies.has(f)).sort();
  assert.ok(shared.length > 0,
    'no family is shared at all, which is not what either side reported — one of the two scans '
    + 'has read nothing.');
  console.log(`        shared families (verb-disjoint, by the test above): ${shared.join(', ')}`);
});

test('this audit says how old the list it audited is', () => {
  /**
   * A GREEN CHECK THAT PROVES NOTHING IS WORSE THAN A RED ONE.
   *
   * 2026-09-16: Foundry reported nine channels it had just added and asked
   * whether any collided. This file answered 6/6 passed — against a vendored
   * `IPC-CHANNELS.md` that was NINETEEN Foundry commits old and listed five of
   * the nine nowhere. There was no collision (checked by hand against
   * electron/main.ts and electron/preload.ts), so the answer was right; the
   * check is not what made it right.
   *
   * The design above is NOT the defect and is not changed here. Foundry ruled
   * the doc is the contract and their sources are theirs to rearrange, and
   * "refreshing the subtree refreshes what this test checks against" is exactly
   * right. What was missing is that a reader could not tell, from a pass, WHEN
   * the thing that passed was written.
   *
   * So: when Foundry's own checkout is beside this one — a developer machine,
   * not CI — say how far behind the vendored point is. When it is not there,
   * say THAT, rather than letting silence read as freshness.
   */
  const vendored = fs.readFileSync(path.join(REPO, 'foundry-app', 'VENDORED.md'), 'utf-8');
  /**
   * THE TABLE'S `Source sha` ROW, AND NOTHING ELSE.
   *
   * The first cut of this matched on the words "committed at" followed by a
   * bold sha, and found a line in a HISTORICAL section fifty lines down —
   * reporting the subtree as 19 commits
   * behind when the table said `24f586b` and the true answer was 14. A file that
   * keeps its own history is a file where "the first sha I find" is the wrong
   * sha — the same defect as reading a stated total instead of counting, one
   * section along, and committed in the very change that was about checks
   * lagging their input.
   */
  const at = /^\|\s*Source sha\s*\|\s*\*\*([0-9a-f]{7,40})\*\*/m.exec(vendored);
  assert.ok(at, 'foundry-app/VENDORED.md no longer has a `| Source sha | **<sha>** |` row in its '
    + 'header table, which is the only thing that makes this audit datable. A "committed at" '
    + 'mention further down is NOT it: those are older vendoring points, and reading one reports '
    + 'the subtree as staler than it is.');

  const sibling = path.resolve(REPO, '..', 'foundry');
  if (!fs.existsSync(path.join(sibling, '.git'))) {
    console.log(`        vendored at ${at[1]}; Foundry's checkout is not beside this one, so how `
      + 'far behind that is was NOT checked.');
    return;
  }
  const { execFileSync } = require('child_process');
  const git = (...args) => execFileSync('git', ['-C', sibling, ...args], { encoding: 'utf-8' }).trim();
  let behind;
  try { behind = Number(git('rev-list', '--count', `${at[1]}..HEAD`)); }
  catch {
    console.log(`        vendored at ${at[1]}; that commit is not in the checkout beside this one, `
      + 'so how far behind it is was NOT checked.');
    return;
  }
  const { names } = foundryChannels();
  console.log(`        audited ${names.size} channels, vendored at ${at[1]}, `
    + `${behind} Foundry commit(s) behind that checkout's HEAD.`);
  // NOT AN ASSERTION. Being behind is the ordinary state — the subtree is
  // vendored deliberately and on Owen's schedule, not on Foundry's. Failing
  // here would make an unrelated app's commit turn this repo red, which is the
  // coupling the vendoring exists to avoid. The number is the point.
});

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; }
    catch (err) { failures.push({ name, err }); }
  }
  console.log(`\nipc collision: ${passed}/${tests.length} passed`);
  for (const f of failures) {
    console.error(`\n  FAIL  ${f.name}\n        ${f.err.message}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
})();
