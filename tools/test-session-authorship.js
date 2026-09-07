#!/usr/bin/env node
/**
 * Keeper for electron/session-authorship.ts — the ONE writer that puts the
 * book's title/author/year into narrator's session-state.json before a door
 * that builds the manifest (align, assembly) is opened.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-session-authorship.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedSessionAuthorship, narratorSessionStatePath } = require(path.join(__dirname, '..', 'dist', 'electron', 'session-authorship.js'));

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
function fresh(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-authorship-'));
  if (state !== undefined) fs.writeFileSync(narratorSessionStatePath(dir), JSON.stringify(state));
  return dir;
}
const read = (dir) => JSON.parse(fs.readFileSync(narratorSessionStatePath(dir), 'utf-8'));

console.log('the author reaches the session BEFORE narrator builds the manifest');
check("a foundry-exported book (title, creator null) gets the queue row's author", () => {
  const dir = fresh({ metadata: { title: 'X', creator: null, language: 'en-US' }, bookforge_metadata: {} });
  const out = seedSessionAuthorship(dir, { title: "Mutineer's Moon (Dahak Book 1)", author: 'David Weber', year: '1991' });
  assert.deepStrictEqual(out, { title: "Mutineer's Moon (Dahak Book 1)", creator: 'David Weber', year: '1991' });
  const s = read(dir);
  assert.strictEqual(s.metadata.creator, 'David Weber');
  assert.strictEqual(s.bookforge_metadata.author, 'David Weber');
  assert.strictEqual(s.metadata.published, '1991-01-01T00:00:00.000Z');
  assert.strictEqual(s.metadata.language, 'en-US', 'untouched fields survive');
});
check('only PROVIDED fields are written; the rest of the session is left alone', () => {
  const dir = fresh({ metadata: { title: 'Kept', creator: 'Kept Author' } });
  const out = seedSessionAuthorship(dir, { year: '2001' });
  assert.strictEqual(out.creator, 'Kept Author');
  assert.strictEqual(read(dir).metadata.title, 'Kept');
  assert.strictEqual(read(dir).bookforge_metadata.year, '2001');
});
check('nothing to write, or no session file, is null — not an error, not a write', () => {
  const dir = fresh({ metadata: {} });
  assert.strictEqual(seedSessionAuthorship(dir, {}), null);
  assert.deepStrictEqual(read(dir), { metadata: {} });
  assert.strictEqual(seedSessionAuthorship(fresh(), { author: 'X' }), null);
});
check('an unreadable session file THROWS — the refusal must carry this reason', () => {
  const dir = fresh(); fs.writeFileSync(narratorSessionStatePath(dir), '{not json');
  assert.throws(() => seedSessionAuthorship(dir, { author: 'X' }));
});

if (failed) { console.log(`\n${failed} check(s) FAILED.`); process.exit(1); }
console.log('\nAll session-authorship checks passed.');
