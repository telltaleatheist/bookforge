#!/usr/bin/env node
/**
 * The MAIN PROCESS may only import what the PACKAGED app ships.
 *
 *   node tools/test-no-undeclared-runtime-deps.js
 *
 * ── The defect this exists for ──────────────────────────────────────────────
 *
 * Owen, 2026-09-18, from the installed app:
 *
 *     The narration copy could not be cut: Cannot find module '@xmldom/xmldom'
 *     Require stack:
 *     - …\app.asar\dist\electron\epub-processor.js
 *
 * `@xmldom/xmldom` was in `node_modules`, `npm run build` was clean, every
 * keeper passed, and the checkout ran it fine. It was not in `package.json` at
 * all. It reached the top of `node_modules` by HOISTING, through
 *
 *     electron-builder → app-builder-lib → @electron/osx-sign → plist → @xmldom/xmldom
 *
 * — every one of which is a devDependency. electron-builder prunes
 * devDependencies out of the asar, so the copy that satisfied the import in the
 * checkout is precisely the copy the installed app does not have. The app had
 * been resolving a runtime dependency out of its BUILD TOOL's dependency tree.
 *
 * `entities` was the same shape and would have been the next crash. It happens
 * to arrive through `cheerio`, which IS a dependency, so it survives packaging
 * today — by luck, and only until cheerio's tree changes.
 *
 * ── Why no other check catches it ───────────────────────────────────────────
 *
 * `tsc` resolves against `node_modules`, which has the hoisted copy. `ng build`
 * does not compile the main process at all. Every keeper runs in the checkout.
 * The one environment where it fails is the one nobody runs until the app is
 * installed — which is why it reached Owen rather than CI.
 *
 * ── Scope: electron/ and shared/, not src/ ──────────────────────────────────
 *
 * The renderer is BUNDLED — Angular compiles its imports into the bundle, so a
 * package that resolves at build time is in the output whatever `package.json`
 * says. The main process is `require`d from the asar at run time, one file at a
 * time, against whatever `node_modules` the installer shipped. Only the second
 * can fail this way, so only the second is checked.
 *
 * `shared/` is included because `tsconfig.electron.json` compiles it into
 * `dist/shared` and the main process requires it from there.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'));
const deps = new Set(Object.keys(pkg.dependencies || {}));
const dev = new Set(Object.keys(pkg.devDependencies || {}));

/**
 * Node's own modules, plus `electron` itself, which the runtime supplies.
 * A name missing from this list shows up as a false positive rather than as a
 * silent pass, which is the safe direction for a list maintained by hand.
 */
const BUILTIN = new Set([
  'assert', 'buffer', 'child_process', 'constants', 'crypto', 'dns', 'electron',
  'events', 'fs', 'http', 'https', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'querystring', 'readline', 'stream', 'string_decoder', 'timers',
  'tls', 'tty', 'url', 'util', 'vm', 'worker_threads', 'zlib',
]);

/*
 * ANCHORED TO REAL IMPORT SYNTAX. The first draft of this matched
 * `from\s+['"]…['"]` anywhere and found forty English sentences inside template
 * literals — `… from 'the call failed'` — every one reported as a missing
 * package. A check that cries wolf forty times is a check that gets deleted.
 */
const REQUIRE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
const FROM = /^\s*(?:import|export)\b[^;'"]*?\bfrom\s+['"]([^'"]+)['"]/gm;
const BARE = /^\s*import\s+['"]([^'"]+)['"]/gm;

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { sources(full, out); continue; }
    if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = [
  ...sources(path.join(REPO, 'electron')),
  ...sources(path.join(REPO, 'shared')),
];

const offenders = new Map();
for (const file of files) {
  const text = fs.readFileSync(file, 'utf-8');
  const names = new Set();
  for (const re of [REQUIRE, FROM, BARE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) names.add(match[1]);
  }
  for (const name of names) {
    // Relative imports, the renderer's own alias, and explicit node: builtins.
    if (name.startsWith('.') || name.startsWith('@shared/') || name.startsWith('node:')) continue;
    const parts = name.split('/');
    const root = name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (BUILTIN.has(root) || deps.has(root)) continue;
    if (!offenders.has(root)) offenders.set(root, new Set());
    offenders.get(root).add(path.relative(REPO, file).replace(/\\/g, '/'));
  }
}

console.log(`${files.length} main-process sources scanned`);

if (offenders.size > 0) {
  for (const [name, where] of [...offenders].sort()) {
    const why = dev.has(name)
      ? 'is a devDependency — electron-builder prunes it out of the asar'
      : 'is not in package.json at all — it is reaching the checkout by hoisting';
    console.error(`  FAIL ${name} ${why}`);
    for (const file of [...where].sort().slice(0, 5)) console.error(`         ${file}`);
  }
  console.error('\nAdd each to "dependencies". It works here and throws in the installed app.');
  process.exit(1);
}

/*
 * THE NO-OP GUARD. A walk that stopped matching would pass forever by scanning
 * nothing, which is how a keeper dies quietly. The floor is far below the real
 * count (250-odd when this was written) so ordinary deletions never trip it.
 */
assert.ok(files.length > 100,
  `only ${files.length} sources were found, so the walk is broken rather than the codebase small`);

console.log('no undeclared runtime deps: all clear');
