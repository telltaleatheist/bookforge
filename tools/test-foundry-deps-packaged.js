/**
 * Keeper: every package the book window's main-process code requires is a dependency of BookForge,
 * and exactly one copy of the library and its Crucible SDK resolves.
 *
 *   node tools/test-foundry-deps-packaged.js
 *
 * The window's main half compiles to dist/foundry-app/electron and its requires
 * resolve from BookForge's own node_modules, the ones electron-builder packs from
 * THIS package.json. (2026-11-03: the installed app would not start, "Cannot find
 * module '@owen/tool-loop'".)
 *
 * ONE COPY is the check that matters most. The library holds process singletons:
 * the queue, the host record, the registry cache. A second copy resolved from
 * anywhere in the main process is a second queue, and nothing errors.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'foundry-app');
// Provided by the runtime, never by node_modules.
const RUNTIME = new Set(['electron']);

const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const have = new Set(Object.keys(root.dependencies || {}));
const builtin = new Set(builtinModules);

const needs = new Map();
for (const sub of ['electron']) {
  const dir = path.join(DIST, sub);
  if (!fs.existsSync(dir)) {
    console.error(`FAIL: ${dir} is not built — run npm run build:electron first.`);
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

// The same package, asked for from the window's code, BookForge's code and from inside the library.
const { createRequire } = require('module');
const askers = [
  path.join(REPO, 'dist', 'foundry-app', 'electron', 'mount.js'),
  path.join(REPO, 'dist', 'electron', 'main.js'),
  path.join(REPO, 'node_modules', '@owen', 'foundry-core', 'dist', 'node', 'host.js'),
];
for (const name of ['@owen/foundry-core', '@crucible/client', '@crucible/bootstrap', '@owen/tool-loop']) {
  const seen = new Set(askers.map((asker) => createRequire(asker).resolve(`${name}/package.json`)));
  if (seen.size !== 1) {
    console.error(`FAIL: ${name} resolves to ${seen.size} copies: ${[...seen].join(', ')}. Two copies of `
      + 'the library are two queues and two host records, with no error anywhere.');
    process.exit(1);
  }
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
