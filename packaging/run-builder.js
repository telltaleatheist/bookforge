#!/usr/bin/env node
/**
 * electron-builder wrapper that injects the auto-derived version (git commit
 * count) via extraMetadata, so the packaged app's version needs no manual bump —
 * on every platform. Used by the `electron:build` script (Windows/Linux); macOS
 * goes through build-dmg.js, which injects the same version (+ its hdiutil retry).
 *
 * Any extra CLI args (e.g. `--win`, `--linux`) pass straight through to
 * electron-builder. Run as: node packaging/run-builder.js [electron-builder args]
 */
const { spawnSync } = require('node:child_process');
const { computeVersion } = require('./app-version');

const version = computeVersion();
const passthrough = process.argv.slice(2);
const args = [...passthrough, `-c.extraMetadata.version=${version}`];

console.log(`[run-builder] electron-builder at auto-version ${version} (no manual bump needed)`);
const res = spawnSync('electron-builder', args, { stdio: 'inherit', shell: true });
process.exit(res.status == null ? 1 : res.status);
