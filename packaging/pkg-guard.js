#!/usr/bin/env node
/**
 * Guard package.json against electron-builder's in-place rewrite.
 *
 * electron-builder applies `-c.extraMetadata.*` by rewriting the SOURCE
 * package.json in place, and doesn't reliably restore it — a package:mac run
 * once left a gutted, scripts-less file (name/version/main/deps only). Every
 * script that invokes electron-builder with extraMetadata (build-dmg.js on
 * macOS; run-builder.js and package-win.js on Windows) must call
 * guardPackageJson() BEFORE spawning the builder: it snapshots package.json
 * and restores it on ANY exit (success, failure, or Ctrl-C).
 */
const fs = require('node:fs');
const path = require('node:path');

const PKG = path.resolve(__dirname, '..', 'package.json');

function guardPackageJson(label) {
  const backup = fs.readFileSync(PKG);
  process.on('exit', () => {
    try {
      if (!fs.readFileSync(PKG).equals(backup)) {
        fs.writeFileSync(PKG, backup);
        console.log(`[${label}] restored package.json (electron-builder had rewritten it in place)`);
      }
    } catch { /* best-effort: never mask the build's own exit status */ }
  });
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
}

module.exports = { guardPackageJson };
