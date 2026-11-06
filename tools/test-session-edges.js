#!/usr/bin/env node
/**
 * A voice's edges: recorded in the session when it renders, read at assembly.
 *
 *   node tools/test-session-edges.js
 *
 * A wrong fade is a book that clicks at every join, so the record's numbers are followed
 * into the manifest assembly reads. Against the compiled dist; no server.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Module = require('module');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-session-edges-'));
// A userData of our own, and an electron that answers for it (see tools/test-crucible-render.js).
const electronStub = { app: { getPath: () => WORK, getName: () => 'test', getVersion: () => '0', isPackaged: false } };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

const DIST = path.resolve(__dirname, '..', 'dist', 'electron');
const { recordSessionEdges } = require(path.join(DIST, 'crucible', 'session-edges.js'));
const S = require(path.join(DIST, 'narrator', 'session', 'session-v1.js'));
const { PRE_FLIP_EDGES } = require(path.join(DIST, 'narrator', 'assemble', 'engine-profiles.js'));
const fixture = require('./fixtures/narrator-session-cases.json');

const ROW = { pads: false, fadeInMs: 20, fadeOutMs: 40 };
const RECORD = { pads: false, fade_in_ms: 20, fade_out_ms: 40 };

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

let serial = 0;
function session(state) {
  serial += 1;
  const processDir = path.join(WORK, `s${serial}`);
  const sentencesDir = path.join(processDir, 'chapters', 'sentences');
  fs.mkdirSync(sentencesDir, { recursive: true });
  if (state !== null) fs.writeFileSync(path.join(processDir, 'session-state.json'), JSON.stringify(state));
  return { sentencesDir, state: () => JSON.parse(fs.readFileSync(path.join(processDir, 'session-state.json'), 'utf8')) };
}
const record = (sentencesDir, edges) => recordSessionEdges(sentencesDir, 'pc', 'mistborn', edges, () => {});
const chunk = (sentencesDir, index) => fs.writeFileSync(path.join(sentencesDir, `${index}.flac`), Buffer.alloc(2048));

/** The fixture's first Higgs book, as a real tree, with its state changed by `change`. */
function plantedBook(change) {
  const c = fixture.cases.find((x) => x.text !== undefined && /higgs-v3/.test(x.text));
  serial += 1;
  const root = path.join(WORK, `book${serial}`);
  for (const [rel, entry] of Object.entries(c.tree)) {
    const file = path.join(root, rel);
    if (entry === null) { fs.mkdirSync(file, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof entry === 'string') fs.writeFileSync(file, entry);
    else if (typeof entry.text === 'number') fs.writeFileSync(file, fixture.texts[entry.text]);
    else {
      const blob = entry.flac === undefined ? { head: entry.bytes, size: entry.size } : fixture.blobs[entry.flac];
      const bytes = Buffer.alloc(blob.size);
      Buffer.from(blob.head, 'base64').copy(bytes);
      fs.writeFileSync(file, bytes);
    }
  }
  const processDir = path.join(root, c.process);
  const file = path.join(processDir, 'session-state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(state);
  fs.writeFileSync(file, JSON.stringify(state));
  return processDir;
}
const build = (processDir) => S.buildManifest(processDir, { sentencesDir: null, log: () => {} });

(async () => {
  await check('a new render records the row\'s edges and keeps the rest of the state', async () => {
    const s = session({ version: 2, total_sentences: 3, title: 'x' });
    await record(s.sentencesDir, ROW);
    assert.deepStrictEqual(s.state(), { version: 2, total_sentences: 3, title: 'x', edges: RECORD });
  });

  await check('a new render on a row with no edges refuses by name and records nothing', async () => {
    const s = session({ version: 2, total_sentences: 3 });
    await assert.rejects(() => record(s.sentencesDir, null), (err) => err.code === 'crucible_voice_states_no_edges');
    assert.ok(!('edges' in s.state()));
  });

  await check('the first record wins: a resume does not rewrite it, whatever the server says now', async () => {
    const s = session({ version: 2, total_sentences: 3, edges: RECORD });
    chunk(s.sentencesDir, 0);
    await record(s.sentencesDir, { pads: false, fadeInMs: 1, fadeOutMs: 2 });
    await record(s.sentencesDir, null);
    assert.deepStrictEqual(s.state().edges, RECORD);
  });

  await check('a pre-flip session with chunks gets no record and is not refused', async () => {
    const s = session({ version: 2, total_sentences: 3 });
    chunk(s.sentencesDir, 1);
    await record(s.sentencesDir, ROW);
    await record(s.sentencesDir, null);
    assert.ok(!('edges' in s.state()));
  });

  await check('a session with no state refuses by name', async () => {
    const s = session(null);
    await assert.rejects(() => record(s.sentencesDir, ROW), (err) => err.code === 'crucible_session_state_missing');
  });

  await check('assembly reads the session\'s record, not the table', async () => {
    const manifest = await build(plantedBook((state) => { state.edges = RECORD; }));
    assert.deepStrictEqual(manifest.engine.edgeFadeMs, { in: 20, out: 40 });
    assert.strictEqual(manifest.engine.pads, false);
  });

  await check('a session with no record reads the pre-flip table', async () => {
    const manifest = await build(plantedBook((state) => { delete state.edges; }));
    const { pads, fadeInMs, fadeOutMs } = PRE_FLIP_EDGES['higgs-v3'];
    assert.deepStrictEqual(manifest.engine.edgeFadeMs, { in: fadeInMs, out: fadeOutMs });
    assert.strictEqual(manifest.engine.pads, pads);
  });

  for (const [name, bad] of [['null', null], ['no fades', { pads: false }], ['a string fade', { pads: false, fade_in_ms: '10', fade_out_ms: 25 }]]) {
    await check(`a malformed record refuses by name: ${name}`, async () => {
      await assert.rejects(() => build(plantedBook((state) => { state.edges = bad; })), /'edges' must state pads/);
    });
  }

  await check('the catalog carries no fades of its own', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'data', 'higgs-models.json'), 'utf8');
    assert.ok(!/edgeFade/.test(text));
  });

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\ntest-session-edges: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
})();
