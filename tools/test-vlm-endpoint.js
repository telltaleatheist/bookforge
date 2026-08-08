/**
 * Tests for WHICH MACHINE reads the pages — the endpoint setting behind
 * Convert to EPUB.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-vlm-endpoint.js
 *
 * Everything here is pure (shared/vlm/conversion.ts), and it is the part of the
 * feature that is worth testing without a GPU or a server, because it is the
 * part that decides where ninety minutes of work goes.
 *
 * THE ARGV, because a flag that does not reach foundry is a run that silently
 * used the other route: an endpoint produces --vlm-endpoint, the optional parts
 * appear only when the user set them (foundry owns the defaults), and no
 * endpoint produces no flags at all.
 *
 * THE REFUSALS, because the alternative on Windows is a Python traceback about
 * MLX — a library the user never chose — instead of a sentence naming the
 * setting they can change. Half a setting is refused for the same reason: a
 * model name with no URL can only mean somebody believes a server is in use.
 *
 * THE SENTENCE the Test button prints, because "it didn't work" is not an
 * answer: unreachable, wrong shape, empty list and wrong model are four
 * different problems with four different fixes.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
const MODULE = path.join(DIST, 'shared', 'vlm', 'conversion.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const {
  DEFAULT_VLM_CONCURRENCY,
  DEFAULT_VLM_ENDPOINT_CONFIG,
  describeVlmEndpointCheck,
  resolveVlmEndpoint,
  resolveVlmRoute,
  vlmEndpointArgs,
  vlmEndpointModelsUrl,
  vlmLocalReadingRefusal,
  vlmRouteLabel,
  vlmSkipPagesArgs,
} = require(MODULE);

const results = [];
let failures = 0;
function check(name, fn) {
  try {
    fn();
    results.push(['ok', name, '']);
  } catch (err) {
    failures += 1;
    results.push(['FAIL', name, err && err.message ? err.message : String(err)]);
  }
}

// ── resolve ────────────────────────────────────────────────────────────────

check('nothing configured is the local route', () => {
  assert.strictEqual(resolveVlmEndpoint(DEFAULT_VLM_ENDPOINT_CONFIG), null);
  assert.strictEqual(resolveVlmEndpoint(undefined), null);
  assert.strictEqual(resolveVlmEndpoint(null), null);
});

check('a URL is trimmed and kept', () => {
  const endpoint = resolveVlmEndpoint({ url: '  http://127.0.0.1:8000/v1 ', model: ' dots ', concurrency: 24 });
  assert.deepStrictEqual(endpoint, { url: 'http://127.0.0.1:8000/v1', model: 'dots', concurrency: 24 });
});

check('a model name with no URL is refused, not ignored', () => {
  assert.throws(
    () => resolveVlmEndpoint({ url: '', model: 'dots.ocr', concurrency: 0 }),
    /dots\.ocr.*no endpoint URL/s);
});

check('a concurrency with no URL is refused', () => {
  assert.throws(
    () => resolveVlmEndpoint({ url: '  ', model: '', concurrency: 12 }),
    /concurrency \(12\) is set with no endpoint URL/);
});

check('a URL that is not a URL is refused by name', () => {
  assert.throws(
    () => resolveVlmEndpoint({ url: '127.0.0.1:8000', model: '', concurrency: 0 }),
    /"127\.0\.0\.1:8000" is not a URL/);
  assert.throws(
    () => resolveVlmEndpoint({ url: 'ftp://host/v1', model: '', concurrency: 0 }),
    /is not a URL/);
});

check('a fractional or negative concurrency is refused', () => {
  for (const concurrency of [1.5, -4]) {
    assert.throws(
      () => resolveVlmEndpoint({ url: 'http://h:8000/v1', model: '', concurrency }),
      /not a whole number of pages/);
  }
});

// ── argv ───────────────────────────────────────────────────────────────────

check('the local route passes no endpoint flags at all', () => {
  assert.deepStrictEqual(vlmEndpointArgs(null), []);
});

check('an endpoint alone passes only --vlm-endpoint', () => {
  assert.deepStrictEqual(
    vlmEndpointArgs(resolveVlmEndpoint({ url: 'http://127.0.0.1:8000/v1', model: '', concurrency: 0 })),
    ['--vlm-endpoint', 'http://127.0.0.1:8000/v1']);
});

check("the model and concurrency travel only when the user set them", () => {
  assert.deepStrictEqual(
    vlmEndpointArgs(resolveVlmEndpoint({
      url: 'http://gpu.local:8000/v1', model: 'rednote-hilab/dots.ocr', concurrency: 24,
    })),
    [
      '--vlm-endpoint', 'http://gpu.local:8000/v1',
      '--vlm-endpoint-model', 'rednote-hilab/dots.ocr',
      '--vlm-concurrency', '24',
    ]);
});

check('concurrency 0 means foundry decides, so no flag is passed', () => {
  const args = vlmEndpointArgs(resolveVlmEndpoint({ url: 'http://h:8000/v1', model: '', concurrency: 0 }));
  assert.ok(!args.includes('--vlm-concurrency'), `${DEFAULT_VLM_CONCURRENCY} was frozen into argv`);
});

// ── the platform ───────────────────────────────────────────────────────────

check('an Apple Silicon Mac can read the pages itself', () => {
  assert.strictEqual(vlmLocalReadingRefusal('darwin', 'arm64'), null);
});

check('an Intel Mac cannot, and neither can Windows or Linux', () => {
  for (const [platform, arch] of [['darwin', 'x64'], ['win32', 'x64'], ['linux', 'arm64']]) {
    const refusal = vlmLocalReadingRefusal(platform, arch);
    assert.ok(refusal, `${platform}/${arch} was allowed a local reader`);
    // It names the machine it is talking about. It does NOT say what to do
    // instead: this is one of three facts `resolveVlmRoute` weighs, and a
    // machine with a WSL reader configured is never shown it at all.
    assert.ok(refusal.includes(`${platform}/${arch}`), 'the refusal does not name the machine');
  }
});

// ── which of the three routes applies ───────────────────────────────────────

check('a configured endpoint wins, even where a local reader exists', () => {
  const endpoint = resolveVlmEndpoint({ url: 'http://gpu.local:8000/v1', model: '', concurrency: 0 });
  const route = resolveVlmRoute({
    platform: 'darwin', arch: 'arm64', endpoint, wslReaderRefusal: null,
  });
  // A server someone configured by hand is a deliberate choice about which GPU
  // does the work; preferring the local one would overrule them.
  assert.strictEqual(route.kind, 'endpoint');
  assert.strictEqual(route.endpoint.url, 'http://gpu.local:8000/v1');
});

check('Apple silicon with nothing configured reads its own pages', () => {
  const route = resolveVlmRoute({
    platform: 'darwin', arch: 'arm64', endpoint: null, wslReaderRefusal: 'not on a Mac',
  });
  assert.strictEqual(route.kind, 'mlx-local');
});

check('Windows with the WSL reader ready uses it', () => {
  const route = resolveVlmRoute({
    platform: 'win32', arch: 'x64', endpoint: null, wslReaderRefusal: null,
  });
  assert.strictEqual(route.kind, 'wsl-server');
});

check('with no route at all, both reasons are given and neither is buried', () => {
  const route = resolveVlmRoute({
    platform: 'win32',
    arch: 'x64',
    endpoint: null,
    wslReaderRefusal: 'WSL2 for page reading is switched off.',
  });
  assert.strictEqual(route.kind, 'refused');
  // The hardware fact, which never changes...
  assert.ok(route.reason.includes('win32/x64'), 'the refusal does not name the machine');
  // ...the setting the user CAN act on, which a message about Apple silicon
  // alone would hide behind "buy a Mac"...
  assert.ok(/switched off/.test(route.reason), 'the refusal drops the WSL reason');
  // ...and the third way out.
  assert.ok(/Settings/.test(route.reason), 'the refusal does not say where to set an endpoint');
});

check('the route is named either way', () => {
  assert.match(vlmRouteLabel(null), /MLX/);
  assert.strictEqual(
    vlmRouteLabel({ url: 'http://gpu.local:8000/v1', model: '', concurrency: 0 }),
    'http://gpu.local:8000/v1');
});

// ── the check ──────────────────────────────────────────────────────────────

check('the models URL is built the way foundry builds its own', () => {
  assert.strictEqual(vlmEndpointModelsUrl('http://h:8000/v1'), 'http://h:8000/v1/models');
  assert.strictEqual(vlmEndpointModelsUrl(' http://h:8000/v1// '), 'http://h:8000/v1/models');
});

check('an unreachable server reports its own reason', () => {
  const said = describeVlmEndpointCheck('http://h:8000/v1', {
    reachable: false, models: [], error: 'connect ECONNREFUSED 127.0.0.1:8000',
  });
  assert.match(said, /ECONNREFUSED/);
});

// ── the pages that are NOT read ────────────────────────────────────────────
//
// The one place in the app where the working document's zero-based page indexes
// become the one-based page numbers foundry and people count in. An off-by-one
// here leaves the wrong page out of somebody's book, an hour after they pressed
// the button, and nothing in the finished EPUB says which page is missing.

check('nothing deleted means no flag at all, not an empty one', () => {
  assert.deepStrictEqual(vlmSkipPagesArgs([]), []);
});

check('page indexes become page numbers', () => {
  assert.deepStrictEqual(vlmSkipPagesArgs([0, 1, 2]), ['--skip-pages', '1,2,3']);
});

check('the list is sorted and de-duplicated', () => {
  assert.deepStrictEqual(vlmSkipPagesArgs([11, 3, 11, 0, 3]), ['--skip-pages', '1,4,12']);
});

check('a page index that is not a page index stops the conversion', () => {
  for (const bad of [-1, 1.5, NaN, '3', null, undefined]) {
    assert.throws(
      () => vlmSkipPagesArgs([0, bad]),
      /is not a page index/,
      `${JSON.stringify(bad)} was accepted as a page`);
  }
});

check('a server serving something else names both', () => {
  const said = describeVlmEndpointCheck('http://h:8000/v1', {
    reachable: true, models: ['Qwen/Qwen2-VL-7B'], modelMissing: 'dots.ocr',
  });
  assert.match(said, /does not serve "dots\.ocr"/);
  assert.match(said, /Qwen\/Qwen2-VL-7B/);
});

check('a server with nothing loaded says so', () => {
  assert.match(
    describeVlmEndpointCheck('http://h:8000/v1', { reachable: true, models: [] }),
    /lists no models/);
});

check('a healthy server names what it serves', () => {
  assert.match(
    describeVlmEndpointCheck('http://h:8000/v1', { reachable: true, models: ['dots.ocr'] }),
    /is serving dots\.ocr/);
});

// ── report ─────────────────────────────────────────────────────────────────
for (const [status, name, message] of results) {
  console.log(`${status === 'ok' ? '  ok  ' : ' FAIL '} ${name}${message ? `\n        ${message}` : ''}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures === 0 ? 0 : 1);
