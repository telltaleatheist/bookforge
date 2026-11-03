/**
 * Keeper: every package the hosted Foundry's main-process code requires is a
 * dependency of BookForge itself.
 *
 *   node tools/test-foundry-deps-packaged.js
 *
 * The packaged app carries `foundry-app/dist/**` but NOT `foundry-app/node_modules`
 * (package.json `build.files`), so a `require()` in Foundry's compiled electron
 * code resolves from BookForge's own node_modules — the ones electron-builder
 * packs from THIS package.json. On 2026-11-03 the installed app would not start
 * ("Cannot find module '@owen/tool-loop'"): Foundry ad493fb moved Ask onto the
 * module, the dev checkout resolved it from foundry-app/node_modules, and nothing
 * noticed the package had no copy. `libheif-js` had been missing the same way,
 * quietly, behind its lazy require (photographs refused in packaged builds only).
 *
 * Reads the compiled output (foundry-app/dist/electron + dist/shared), so run it
 * after the subtree build in docs/RE-VENDOR-FOUNDRY.md.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'foundry-app', 'dist');
// Provided by the runtime, never by node_modules.
const RUNTIME = new Set(['electron']);

const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const have = new Set(Object.keys(root.dependencies || {}));
const builtin = new Set(builtinModules);

const needs = new Map();
for (const sub of ['electron', 'shared']) {
  const dir = path.join(DIST, sub);
  if (!fs.existsSync(dir)) {
    console.error(`FAIL: ${dir} is not built — run the subtree build (docs/RE-VENDOR-FOUNDRY.md §4) first.`);
    process.exit(1);
  }
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      for (const m of fs.readFileSync(full, 'utf8').matchAll(/require\(["']([^."'][^"']*)["']\)/g)) {
        const spec = m[1];
        if (spec.startsWith('node:')) continue;
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!needs.has(name)) needs.set(name, path.relative(REPO, full));
      }
    }
  })(dir);
}

const missing = [...needs].filter(([name]) => !have.has(name) && !builtin.has(name) && !RUNTIME.has(name));
if (missing.length > 0) {
  for (const [name, file] of missing) {
    console.error(`FAIL: ${file} requires '${name}', which BookForge's package.json does not list — `
      + 'a packaged build will not carry it. Add it to dependencies (a file: tarball goes in vendor/).');
  }
  process.exit(1);
}
console.log(`ok: all ${needs.size} packages Foundry's main process requires are BookForge dependencies or built in.`);
