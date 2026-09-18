#!/usr/bin/env node
/**
 * WHAT THE WEB FETCHER DECIDES ABOUT A PAGE IT HAS ALREADY LOADED.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-web-fetch-article.js
 *
 * Three decisions, each of which was a heuristic standing in for a measurement
 * and each of which threw an article away without saying so (B4, 2026-09-18):
 *
 *   §1  IS THIS A CAPTCHA? It was `bodyText.includes('challenge') ||
 *       bodyText.length < 500`, so any piece opening on "the challenge of…"
 *       popped a window titled "Please solve the captcha, then close this
 *       window" — the user closed it as told and the article that was loading
 *       perfectly was reported as `Window closed by user`. A short page could
 *       never satisfy the loop's exit either, so it burned the full 60 s and
 *       filed a `partial` warning about a challenge that was never there.
 *   §2  WHERE IS THE TEXT? A block with block children recursed into
 *       `element.children` and emitted none of its own text nodes, so
 *       `<li>Introduction<ul>…</ul></li>` lost "Introduction"; and `FIGURE` in
 *       SKIP_TAGS made the `FIGCAPTION` entry in BLOCK_TAGS unreachable.
 *   §3  IS THIS BOILERPLATE? An unanchored `\b(…|copyright|©)\b` deleted every
 *       short paragraph of an article ABOUT copyright, and `length < 5` deleted
 *       a standalone `1914` heading.
 *
 * And §4, the one shape a caller cannot see: `extractTextFromHtml` read its
 * file OUTSIDE the try, so an unreadable article threw instead of returning the
 * `{ success: false, error }` every caller reads.
 *
 * NO NETWORK AND NO BROWSER. The page probe and the paragraph walk are exported
 * as source — the same source the page is given — and are run here against
 * hand-built documents. The one real call, §4, fails before a BrowserWindow is
 * ever asked for.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'web-fetch-bridge.js'))) {
  console.log('SKIP: dist/electron is not built — run `npm run build:electron`');
  return;
}

// web-fetch-bridge statically requires 'electron'; the CLI's own shim answers
// it so this runs under plain node. Nothing here constructs a window.
process.env.BOOKFORGE_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-web-fetch-'));
require('../cli/electron-stub.js');

const bridge = require(path.join(DIST, 'web-fetch-bridge.js'));
const { CAPTCHA_PROBE_JS, LEAF_PARAGRAPHS_JS, isBoilerplate, extractTextFromHtml } = bridge;

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (err) { failures++; console.log(`  FAIL  ${name}\n        ${String(err && err.message).split('\n').join('\n        ')}`); }
}

/* ── Hand-built documents ──────────────────────────────────────────────────
 *
 * Just enough of the DOM for the two probes: `nodeType`, `tagName`,
 * `childNodes`, `children`, `textContent`, `nodeValue`, `querySelector`. The
 * CSS engine is Chromium's and is not re-implemented — a document simply
 * answers for the exact selector strings it was told it has.
 */
function textNode(value) {
  return { nodeType: 3, nodeValue: value, textContent: value };
}
function el(tagName, ...kids) {
  const childNodes = kids.map((k) => (typeof k === 'string' ? textNode(k) : k));
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    childNodes,
    get children() { return childNodes.filter((n) => n.nodeType === 1); },
    get textContent() { return childNodes.map((n) => n.textContent).join(''); },
  };
}
/** A page that matches `selectors` and whose prose is `bodyText`. */
function doc(selectors, bodyText) {
  const present = new Set(selectors);
  return {
    title: 'An article',
    body: { textContent: bodyText },
    querySelector: (sel) => (present.has(sel) ? { tagName: 'DIV' } : null),
  };
}

async function main() {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§1 a captcha is a thing in the DOM, not a word in the prose');

  await check('the probe is exported as the source the page is given', () => {
    assert.strictEqual(typeof CAPTCHA_PROBE_JS, 'string',
      'web-fetch-bridge exports no CAPTCHA_PROBE_JS — the captcha decision is an inline '
      + 'substring test against the article\'s own prose and cannot be measured');
  });

  const probe = typeof CAPTCHA_PROBE_JS === 'string'
    // eslint-disable-next-line no-eval
    ? eval(CAPTCHA_PROBE_JS)
    : () => { throw new Error('no CAPTCHA_PROBE_JS to run'); };

  await check('an article about a challenge is not a captcha', () => {
    const article = doc([], 'The challenge of decarbonising cement is the subject of this piece. '
      + 'Engineers have tried to verify you are human levels of ingenuity on it for decades, and '
      + 'the captcha-delivery of a solution is still years away.');
    assert.deepStrictEqual(probe(article), [],
      'the word "challenge" in the prose was read as a challenge PAGE — the hidden window is shown '
      + 'and titled "close this window", and closing it reports the article as a user cancellation');
  });

  await check('a short page is a short page', () => {
    assert.deepStrictEqual(probe(doc([], 'A poem.\n\nTwelve words long.\n\nThat is all of it.')), [],
      'a page under 500 characters was declared a captcha: the 60 s wait can never end and the '
      + 'result carries a partial warning about a challenge that was never there');
    assert.deepStrictEqual(probe(doc([], '')), [], 'an empty body was declared a captcha');
  });

  await check('a vendor\'s own element IS a captcha, and the probe names it', () => {
    assert.deepStrictEqual(probe(doc(['#challenge-form'], 'Just a moment...')), ['#challenge-form']);
    assert.deepStrictEqual(probe(doc(['.h-captcha'], 'Verify')), ['.h-captcha']);
    assert.deepStrictEqual(
      probe(doc(['iframe[src*="captcha-delivery.com"]', '#px-captcha'], 'blocked')),
      ['iframe[src*="captcha-delivery.com"]', '#px-captcha']);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§2 a block\'s own text is text');

  await check('the paragraph walk is exported as the source the page is given', () => {
    assert.strictEqual(typeof LEAF_PARAGRAPHS_JS, 'string',
      'web-fetch-bridge exports no LEAF_PARAGRAPHS_JS — the traversal exists only inside an '
      + 'injected string and cannot be measured');
  });

  const paragraphs = typeof LEAF_PARAGRAPHS_JS === 'string'
    // eslint-disable-next-line no-eval
    ? eval(LEAF_PARAGRAPHS_JS)
    : () => { throw new Error('no LEAF_PARAGRAPHS_JS to run'); };

  await check('a nested list keeps the parent item\'s own text', () => {
    const body = el('body', el('ul',
      el('li', 'Introduction', el('ul', el('li', 'Sub A'), el('li', 'Sub B'))),
      el('li', 'Conclusion')));
    assert.deepStrictEqual(paragraphs(body), ['Introduction', 'Sub A', 'Sub B', 'Conclusion'],
      'the parent item\'s own words were dropped — the commonest shape in a wiki- or '
      + 'documentation-style article');
  });

  await check('a div\'s direct text survives a paragraph beside it', () => {
    const body = el('body', el('div', 'Direct text', el('p', 'A real paragraph.')));
    assert.deepStrictEqual(paragraphs(body), ['Direct text', 'A real paragraph.']);
  });

  await check('a figcaption is reachable', () => {
    const body = el('body', el('figure', el('img'), el('figcaption', 'Fig 1. The bridge in 1890.')));
    assert.deepStrictEqual(paragraphs(body), ['Fig 1. The bridge in 1890.'],
      'FIGURE in SKIP_TAGS returned before FIGCAPTION in BLOCK_TAGS could ever be reached');
  });

  await check('a leaf paragraph is still exactly its own text, inline children included', () => {
    const body = el('body', el('p', 'Hello ', el('em', 'world'), el('a', ' and everyone'), '!'));
    assert.deepStrictEqual(paragraphs(body), ['Hello world and everyone!']);
  });

  await check('a wrapper emits its children once, never itself as well', () => {
    const body = el('body', el('article', el('div', el('p', 'A'), el('p', 'B'))));
    assert.deepStrictEqual(paragraphs(body), ['A', 'B'],
      'a container duplicated its descendants\' text');
  });

  await check('skipped tags stay skipped, and whitespace is not a paragraph', () => {
    const body = el('body',
      el('nav', el('a', 'Home'), el('a', 'About')),
      '\n  \n',
      el('p', 'The article.'),
      el('aside', el('p', 'Sponsored')));
    assert.deepStrictEqual(paragraphs(body), ['The article.']);
  });

  await check('a table cell is a paragraph and its row is not', () => {
    const body = el('body', el('table', el('tbody',
      el('tr', el('td', 'Left'), el('td', 'Right')))));
    assert.deepStrictEqual(paragraphs(body), ['Left', 'Right']);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§3 boilerplate is a shape, not a word');

  await check('isBoilerplate is exported so the decision can be measured', () => {
    assert.strictEqual(typeof isBoilerplate, 'function',
      'web-fetch-bridge does not export isBoilerplate');
  });

  await check('an article about copyright keeps its short paragraphs', () => {
    assert.strictEqual(isBoilerplate('The court found that the copyright had expired.'), false,
      'a paragraph naming the article\'s own subject was deleted, with no log line');
    assert.strictEqual(isBoilerplate('He asked who owned the copyright.'), false);
    assert.strictEqual(isBoilerplate('All rights were reserved to the estate until 1996.'), false);
  });

  await check('a short line is not boilerplate', () => {
    assert.strictEqual(isBoilerplate('1914'), false,
      'a standalone date heading was deleted for being four characters long');
    assert.strictEqual(isBoilerplate('Why?'), false);
  });

  await check('a real footer notice still goes', () => {
    assert.strictEqual(isBoilerplate('© 2024 The Guardian. All rights reserved.'), true);
    assert.strictEqual(isBoilerplate('Copyright 2019 Reuters'), true);
    assert.strictEqual(isBoilerplate('All rights reserved.'), true);
    assert.strictEqual(isBoilerplate('Sign up for our newsletter today'), true);
    assert.strictEqual(isBoilerplate('Follow us on Twitter'), true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('§4 an unreadable article reports itself');

  await check('extractTextFromHtml returns the shape its callers read', async () => {
    const missing = path.join(os.tmpdir(), 'bookforge-web-fetch-no-such-article.html');
    let result;
    try {
      result = await extractTextFromHtml(missing, []);
    } catch (err) {
      assert.fail('the read threw out of a function whose contract is { success, error }: '
        + String(err && err.message));
    }
    assert.strictEqual(result.success, false);
    assert.ok(result.error && result.error.includes(missing),
      `the failure does not name the file it could not read: ${String(result.error)}`);
  });

  fs.rmSync(process.env.BOOKFORGE_USER_DATA, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exitCode = 1; }
  else console.log('\nThe fetcher decides about a page from the page, not from its prose.');
}

void main();
