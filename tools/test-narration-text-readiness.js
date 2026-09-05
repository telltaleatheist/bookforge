#!/usr/bin/env node
/**
 * test-narration-text-readiness.js — the LEDGER-side gate on a narration run.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narration-text-readiness.js
 *
 * Two gates answer "has this book had the narration text cleanup", and they are
 * not the same question:
 *
 *  - `narrationTextGate(bookPath)` asks a FILE, from the stamp on its OPF. It is
 *    what the render door and the CLI use, because they are handed a path.
 *  - `narrationTextReadiness(appliedPasses)` — this one — asks a PROJECT, from
 *    its ledger, and it is what the Narrate button uses. It knows the one thing
 *    the file cannot: whether a LATER pass rewrote the text after the cleanup
 *    ran. A simplify recorded afterwards leaves the stamp on the book (it
 *    rewrites text nodes, not the OPF) while making it a claim about text that
 *    is no longer there.
 *
 * Pure: no project, no disk, no model. The input is an `appliedPasses` array in
 * execution order, which is exactly what `readAppliedPasses` answers.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'narration-text-readiness.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const { narrationTextReadiness, NARRATION_TEXT_LABEL } =
  require(path.join(DIST, 'electron', 'narration-text-readiness.js'));
const { NORMALIZER_VERSION } = require(path.join(DIST, 'electron', 'tts-number-normalizer.js'));
const { PUNCTUATION_SPEC_VERSION } = require(path.join(DIST, 'electron', 'tts-punctuation.js'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}`);
    console.log(`      ${String(err.message).split('\n').join('\n      ')}`);
  }
}

let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 4, 12, clock++)).toISOString();

const cleanup = (overrides = {}) => ({
  kind: 'narration-text',
  at: at(),
  params: {
    normalizerVersion: NORMALIZER_VERSION,
    punctuationSpec: PUNCTUATION_SPEC_VERSION,
    model: 'qwen3.8:27b',
    ...overrides,
  },
});
const pass = (kind) => ({ kind, at: at() });

// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── missing ──');

test('a book with no passes at all has not had it', () => {
  const r = narrationTextReadiness([]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.state, 'missing');
  assert.ok(r.reason.includes(NARRATION_TEXT_LABEL), r.reason);
  assert.ok(r.reason.includes('has to run first'), r.reason);
});

test('a book with other passes and no cleanup has not had it', () => {
  const r = narrationTextReadiness([pass('vlm-convert'), pass('simplify'), pass('footnote-refs')]);
  assert.strictEqual(r.state, 'missing');
});

console.log('\n── ok ──');

test('the cleanup, and nothing after it', () => {
  const r = narrationTextReadiness([pass('vlm-convert'), pass('simplify'), cleanup()]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.model, 'qwen3.8:27b');
});

test('a CONVERSION recorded after it does not make it stale', () => {
  // `vlm-convert` is a book's ORIGIN and never a change to one. It cannot appear
  // after another pass in practice, and if it did it would still have rewritten
  // nothing.
  const r = narrationTextReadiness([cleanup(), pass('vlm-convert')]);
  assert.strictEqual(r.ok, true);
});

test('a retired pass in an old book\'s history does not make it stale', () => {
  const r = narrationTextReadiness([pass('tesseract'), cleanup(), pass('detection')]);
  assert.strictEqual(r.ok, true);
});

console.log('\n── stale ──');

test('a SIMPLIFY after the cleanup makes it stale, and says why', () => {
  const r = narrationTextReadiness([cleanup(), pass('simplify')]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.state, 'stale');
  assert.ok(r.reason.includes('a later pass rewrote the text after it'), r.reason);
  assert.ok(r.reason.includes('run again'), r.reason);
});

test('a TRANSLATE after it, and a footnote strip after it, are the same', () => {
  assert.strictEqual(narrationTextReadiness([cleanup(), pass('translate')]).state, 'stale');
  assert.strictEqual(narrationTextReadiness([cleanup(), pass('footnote-refs')]).state, 'stale');
});

test('and running it AGAIN after them clears it', () => {
  const r = narrationTextReadiness([cleanup(), pass('simplify'), cleanup()]);
  assert.strictEqual(r.ok, true);
});

test('a cleanup from an older BUILD is stale, and names both versions', () => {
  const r = narrationTextReadiness([cleanup({ normalizerVersion: 'n4' })]);
  assert.strictEqual(r.state, 'stale');
  assert.ok(r.reason.includes('n4'), r.reason);
  assert.ok(r.reason.includes(NORMALIZER_VERSION), r.reason);
});

test('a cleanup from an older PUNCTUATION spec is stale too', () => {
  const r = narrationTextReadiness([cleanup({ punctuationSpec: 's0' })]);
  assert.strictEqual(r.state, 'stale');
  assert.ok(r.reason.includes('s0'), r.reason);
});

test('a cleanup recorded with NO versions is stale — a claim nobody can check', () => {
  const r = narrationTextReadiness([{ kind: 'narration-text', at: at() }]);
  assert.strictEqual(r.state, 'stale');
  assert.ok(r.reason.includes('without the versions it ran at'), r.reason);
});

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed}/${passed + failures.length} passed`);
process.exit(failures.length === 0 ? 0 : 1);
