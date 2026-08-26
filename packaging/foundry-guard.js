#!/usr/bin/env node
/**
 * Refuse to package when the vendored Foundry subtree is not built.
 *
 * `foundry-app/` is a VENDORED copy of the Foundry desktop app (see its
 * VENDORED.md) with its OWN toolchain. Nothing in package:mac / package:win
 * builds it, and electron-builder copies only what `build.files` names — so it
 * is possible to produce a perfectly clean, signed, notarized app that dies on
 * the first line of main.js because `foundry-app/dist/electron/mount.js` is not
 * inside the asar. That is exactly what shipped until Aug 26 2026: `build.files`
 * had never once mentioned foundry-app, so EVERY packaged build since the
 * vendoring failed at launch with "Foundry is not built".
 *
 * Same contract as pkg-guard.js: every script that invokes electron-builder
 * must call this BEFORE spawning the builder. Failing here costs one command;
 * failing in the packaged app costs a user a broken install.
 */
const fs = require('node:fs');
const path = require('node:path');

const MOUNT = path.resolve(__dirname, '..', 'foundry-app', 'dist', 'electron', 'mount.js');

function guardVendoredFoundry(label) {
  if (fs.existsSync(MOUNT)) return;
  console.error([
    `[${label}] REFUSING TO PACKAGE: the vendored Foundry subtree is not built.`,
    `  missing: ${MOUNT}`,
    '  fix:     cd foundry-app && npm install && npm run build',
  ].join('\n'));
  process.exit(1);
}

module.exports = { guardVendoredFoundry, FOUNDRY_MOUNT: MOUNT };
