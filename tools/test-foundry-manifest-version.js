#!/usr/bin/env node
/**
 * FOUNDRY OWNS THE CATALOGUE VERSION. This is what keeps BookForge's reader in step.
 *
 *   node tools/test-foundry-manifest-version.js
 *
 * ── Why this is a keeper and not a comment ──────────────────────────────────
 *
 * Foundry writes a project catalogue stamped `MANIFEST_VERSION` and reads back
 * `{1, MANIFEST_VERSION}` — DERIVED, so one edit moves its reader and both its
 * writers together. BookForge's adopt door has to accept the same set, and until
 * 2026-09-13 it did so as two bare literals (`row['version'] !== 1 && !== 2`).
 *
 * A bump to 3 would therefore have moved Foundry in a single line and left
 * BookForge silently at {1, 2} — refusing every newly written catalogue at adopt
 * time, by name, with a clear message, which is the one mercy in it. Adoption of
 * new projects stops dead until someone finds the site.
 *
 * And nobody would find it. A developer making that bump greps `MANIFEST_VERSION`
 * across BookForge and gets four hits — clipforge-bridge, enhance-bridge,
 * manifest-service, orpheus-models — every one an unrelated subsystem with its own
 * unrelated number, and none of them the adopt door. The literal was invisible to
 * the search the change calls for. That is the whole reason this file exists.
 *
 * ── Why it reads SOURCE and not dist ────────────────────────────────────────
 *
 * Both numbers are read out of TypeScript source text. `foundry-app/` is a sealed
 * vendored subtree — edited in the foundry repo and re-copied, never in place — so
 * importing from it is not an option, and requiring BookForge's compiled module
 * would drag in the manifest service and the EPUB importer to compare one integer.
 * Reading the literal is the same mechanism `tools/test-sentence-abbreviations.js`
 * uses against narrator's `lang.py`.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const foundrySrc = path.join(repo, 'foundry-app', 'electron', 'projects.ts');
const adoptSrc = path.join(repo, 'electron', 'foundry-adopt.ts');

function read(file, what) {
  assert.ok(fs.existsSync(file), `${what} is missing: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function soleMatch(text, re, what, file) {
  const found = [...text.matchAll(re)];
  assert.strictEqual(found.length, 1,
    `expected exactly one ${what} in ${path.relative(repo, file)}, found ${found.length}. `
    + 'If it moved or gained a second declaration, this keeper must be taught the new shape '
    + 'rather than deleted.');
  return Number(found[0][1]);
}

const foundryText = read(foundrySrc, "Foundry's vendored projects.ts");
const adoptText = read(adoptSrc, "BookForge's foundry-adopt.ts");

const foundryVersion = soleMatch(
  foundryText, /^const MANIFEST_VERSION = (\d+);/gm, 'MANIFEST_VERSION declaration', foundrySrc);
const bookforgeVersion = soleMatch(
  adoptText, /^export const FOUNDRY_MANIFEST_VERSION = (\d+);/gm,
  'FOUNDRY_MANIFEST_VERSION declaration', adoptSrc);

assert.strictEqual(bookforgeVersion, foundryVersion,
  `BookForge's FOUNDRY_MANIFEST_VERSION is ${bookforgeVersion} and Foundry's MANIFEST_VERSION is `
  + `${foundryVersion}. Foundry OWNS this number: it stamps every catalogue it writes with it. `
  + `Update electron/foundry-adopt.ts to ${foundryVersion} — otherwise every catalogue Foundry `
  + 'writes from now on is refused at adopt time and new projects cannot be adopted at all.');

// Foundry's reader must still be the derived pair this side mirrors. If Foundry
// ever widens or narrows its accepted set, mirroring only its newest version is
// no longer enough, and that is a decision rather than a rename.
assert.ok(
  /row\['version'\] !== MANIFEST_VERSION && row\['version'\] !== 1/.test(foundryText),
  "Foundry's catalogue reader is no longer the pair {1, MANIFEST_VERSION}. BookForge's adopt "
  + 'door mirrors that exact set; re-read foundry-app/electron/projects.ts and decide what this '
  + 'side should now accept.');

// And this side must stay DERIVED. A reintroduced bare literal is the original
// defect, and it would pass every other assertion in this file.
assert.ok(!/row\['version'\] !== \d/.test(adoptText),
  "electron/foundry-adopt.ts compares row['version'] against a bare numeric literal again. That "
  + 'is the defect this keeper exists to prevent: the accepted set must be derived from '
  + 'FOUNDRY_MANIFEST_VERSION so a bump on Foundry\'s side fails here instead of in production.');

console.log(
  `ok — Foundry stamps catalogue version ${foundryVersion}; BookForge's adopt door accepts `
  + `{1, ${bookforgeVersion}}, derived.`);
