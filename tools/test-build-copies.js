#!/usr/bin/env node
/**
 * test-build-copies.js — every file `build:electron` copies must be there.
 *
 * `npm run build:electron` names eleven source paths in one long shell line and
 * copies each beside the compiled main process. Nothing checked that any of them
 * exists, so a directory deleted in a refactor stays in that line until somebody
 * runs a full build — and the failure surfaces as a bare `cp: no such file or
 * directory` in the middle of a five-minute build, on whatever machine happened
 * to package first.
 *
 * MEASURED 2026-09-15: that is exactly how `electron/scripts/higgs` went. It was
 * deleted with the local spawn layer (the launch scripts are Crucible's now) and
 * the copy step was left behind. `tsc` was clean, the keepers were green, and the
 * break only appeared when Owen ran the real build.
 *
 * ── The second half, which is the one that was silently broken ─────────────
 *
 * The reverse failure is worse because dev hides it. `electron/text-server.ts`
 * resolves `serve_text_vllm.sh` through three candidates, one of which walks UP
 * out of `dist/` into the checkout — so a dev run finds the script whether or not
 * the build copied it. A PACKAGED app has no checkout: `package.json`'s `files`
 * is `dist/**` (plus python and the icon), so anything not copied into `dist/`
 * ships nowhere and `resolveVllmScript` throws. Its own refusal says so — *"is
 * electron/scripts/vllm/ in the checkout, and build:electron must copy that
 * folder beside the compiled main process"* — and until 2026-09-15 the build did
 * not.
 *
 * So this suite asserts BOTH directions:
 *   1. every path the build copies exists in the checkout (the loud failure);
 *   2. every script a runtime resolver requires is among them (the quiet one).
 *
 * Source assertions, deliberately: they read `package.json` and the checkout, so
 * they run in a second and fail the moment a refactor removes a directory rather
 * than the next time somebody packages.
 *
 * Run: node tools/test-build-copies.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err}`);
    process.exitCode = 1;
  }
}

const buildLine = pkg.scripts && pkg.scripts['build:electron'];

/** Every `shx cp [-r] <source> <dest>` source in the build line. */
function copiedSources(line) {
  const out = [];
  const re = /shx\s+cp\s+(?:-r\s+)?([^\s]+)\s+([^\s]+)/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push({ source: m[1], dest: m[2] });
  return out;
}

check('build:electron exists and copies things', () => {
  assert.ok(typeof buildLine === 'string' && buildLine.length > 0,
    'package.json has no build:electron script');
  assert.ok(copiedSources(buildLine).length >= 5,
    'the copy steps have moved out of this script — this suite reads the wrong thing now');
});

check('every path build:electron copies EXISTS in the checkout', () => {
  const missing = [];
  for (const { source } of copiedSources(buildLine)) {
    if (!fs.existsSync(path.join(REPO, source))) missing.push(source);
  }
  assert.deepStrictEqual(missing, [],
    'build:electron copies paths that are not here, so a full build dies with a bare '
    + '"cp: no such file or directory". Delete the step if the thing is gone (that is what '
    + 'happened to electron/scripts/higgs when the local spawn layer went), or restore the path.');
});

/*
 * THE QUIET DIRECTION. A resolver that walks up out of `dist/` finds its script
 * in a dev run whether or not the build copied it, and finds nothing at all in a
 * packaged app, where `files` is `dist/**`. So the requirement is asserted from
 * the RUNTIME side: the script the text server spawns must be among the copied
 * sources, not merely present in the checkout.
 */
check('the text server\'s launcher is COPIED, not just present in the checkout', () => {
  const dir = 'electron/scripts/vllm';
  assert.ok(fs.existsSync(path.join(REPO, dir, 'serve_text_vllm.sh')),
    `${dir}/serve_text_vllm.sh is not in the checkout at all`);
  const sources = copiedSources(buildLine).map((c) => c.source);
  const copied = sources.some((s) => s === dir || s.startsWith(`${dir}/`));
  assert.ok(copied,
    `build:electron does not copy ${dir}. electron/text-server.ts resolves `
    + 'serve_text_vllm.sh through candidates that walk UP out of dist/ into the checkout, so a '
    + 'DEV run finds it either way — but package.json\'s `files` is dist/**, so a packaged app '
    + 'has no checkout to walk up into and resolveVllmScript throws. Its own refusal already '
    + 'says this folder must be copied beside the compiled main process.');
});

check('the packaged file list still makes dist/ the only thing that ships', () => {
  // The premise the check above rests on. If `files` ever grows an
  // `electron/**` entry, the walk-up candidate becomes real in a packaged app
  // and that check is asserting something that no longer bites — which is worth
  // noticing deliberately rather than leaving as a test that cannot fail.
  const files = (pkg.build && pkg.build.files) || [];
  assert.ok(files.length > 0, 'package.json build.files is empty');
  const shipsCheckout = files.some((f) => typeof f === 'string' && /^electron\//.test(f));
  assert.ok(!shipsCheckout,
    'build.files now ships electron/ itself. That is a real change: the dist-relative walk-up '
    + 'in resolveVllmScript would start resolving in a packaged app, and the copy requirement '
    + 'above is no longer what protects it. Re-read this suite before adjusting it.');
});

console.log(`\nbuild copies: ${ran} check(s), exit ${process.exitCode || 0}`);
