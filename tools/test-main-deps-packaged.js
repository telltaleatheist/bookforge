/**
 * Keeper: everything the main process loads from node_modules is in the packaged app.
 *
 *   node tools/test-main-deps-packaged.js
 *
 * electron-builder packs the PRODUCTION dependencies of this package.json and
 * what they depend on. Nothing else in node_modules ships. On 2026-11-11 the
 * packages only the renderer uses (Angular, rxjs, epubjs, jsdom, the @types)
 * moved to devDependencies: ng build bundles them into dist/renderer, and
 * shipping them as loose files was about two thirds of the installer's 18,600 files and
 * most of a ten-minute Windows package.
 *
 * That move is safe only while no main-process code loads one of them. This
 * reads the compiled main process (dist/electron, dist/shared, dist/packages,
 * dist/foundry-app/electron) and fails by name on:
 *
 *   - a require() or import() of a package that is not a production dependency
 *     or reachable through one;
 *   - a file read by path out of node_modules (`'node_modules', '@mozilla', ...`)
 *     whose package is not one.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const REPO = path.resolve(__dirname, '..');
const NODE_MODULES = path.join(REPO, 'node_modules');
const MAIN_PROCESS = ['dist/electron', 'dist/shared', 'dist/packages', 'dist/foundry-app/electron'];
// Provided by the runtime, never by node_modules.
const RUNTIME = new Set(['electron']);
// The two Angular apps the main process serves are built bundles; their sources are not main-process code.
const NOT_MAIN = ['bookshelf-ui', 'clipforge-ui'];

const builtin = new Set(builtinModules);
const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

/** Every package electron-builder packs: the production dependencies and theirs, as npm placed them. */
const packaged = new Set();
const walkDeps = (name, from) => {
  let dir = null;
  for (let base = from; ; base = path.dirname(base)) {
    const candidate = path.join(base, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) { dir = candidate; break; }
    if (base === REPO) break;
  }
  if (dir === null || packaged.has(dir)) return;
  packaged.add(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) walkDeps(dep, dir);
};
for (const name of Object.keys(root.dependencies || {})) walkDeps(name, REPO);
/** Top-level packages that ship: what a bare specifier in our own code resolves to. */
const shipsAtTop = new Set([...packaged]
  .filter((dir) => !path.relative(NODE_MODULES, dir).replace(/\\/g, '/').includes('/node_modules/'))
  .map((dir) => path.relative(NODE_MODULES, dir).replace(/\\/g, '/')));

const packageOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

const failures = [];
let files = 0;
const needed = new Set();
for (const sub of MAIN_PROCESS) {
  const dir = path.join(REPO, sub);
  if (!fs.existsSync(dir)) {
    console.error(`FAIL: ${dir} is not built. Run npm run build:electron first.`);
    process.exit(1);
  }
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || NOT_MAIN.includes(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!/\.(js|cjs|mjs)$/.test(entry.name)) continue;
      files += 1;
      const text = fs.readFileSync(full, 'utf8');
      const where = path.relative(REPO, full).replace(/\\/g, '/');

      for (const m of text.matchAll(/(?:\brequire|\bimport)\(\s*["']([^."'][^"']*)["']\s*\)|\bfrom\s+["']([^."'][^"']*)["']/g)) {
        const spec = m[1] ?? m[2];
        if (spec.startsWith('node:')) continue;
        const name = packageOf(spec);
        if (builtin.has(name) || RUNTIME.has(name)) continue;
        // A word in a sentence is not a package: only names that exist in node_modules are judged.
        if (!fs.existsSync(path.join(NODE_MODULES, name, 'package.json'))) continue;
        needed.add(name);
        if (!shipsAtTop.has(name)) {
          failures.push(`${where} loads '${name}', which is not a production dependency (or reachable `
            + 'through one), so the packaged app will not carry it. Move it to dependencies in package.json.');
        }
      }

      // A file read by path: path.join(..., 'node_modules', '@scope', 'name', ...).
      for (const m of text.matchAll(/["']node_modules["']\s*,\s*["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/g)) {
        const name = m[1].startsWith('@') && m[2] !== undefined ? `${m[1]}/${m[2]}` : m[1];
        needed.add(name);
        if (!shipsAtTop.has(name)) {
          failures.push(`${where} reads a file out of node_modules/${name}, which is not a production `
            + 'dependency, so the packaged app will not carry it. Move it to dependencies in package.json.');
        }
      }
    }
  })(dir);
}

if (failures.length > 0) {
  for (const line of [...new Set(failures)]) console.error(`FAIL: ${line}`);
  process.exit(1);
}
if (needed.size === 0) {
  console.error('FAIL: no package load was found in the compiled main process, so this check is reading nothing.');
  process.exit(1);
}
console.log(`ok: ${files} main-process files load ${needed.size} packages, all among the ${packaged.size} the package carries.`);
