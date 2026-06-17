// BookForge launcher prototype — the thin "BookForge.app" that lives in /Applications.
//
// Its only jobs: (1) make sure a code bundle exists in userData, (2) optionally stage
// + flip to a newer one, (3) point module resolution at the launcher's own node_modules,
// (4) hand off to the code bundle's main.js via require().
//
// This file is what proves Approach A: the running Electron runtime is the launcher,
// but the *app code* it runs comes from userData and can be swapped without touching
// the launcher.
//
// Run:
//   PROTO_USERDATA=/tmp/bookforge-proto npx electron prototype/launcher-split/launcher
//   PROTO_USERDATA=/tmp/bookforge-proto PROTO_STAGE=v2 npx electron prototype/launcher-split/launcher
//
// Env:
//   PROTO_USERDATA  where the simulated userData lives (default: <tmp>/bookforge-launcher-proto)
//   PROTO_STAGE     name of a bundle under baseline/ to stage + flip to (e.g. "v2")

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const LAUNCHER_DIR = __dirname;
const BASELINE_DIR = path.resolve(LAUNCHER_DIR, '..', 'baseline'); // bundled-in code bundles
// Stand-in for the launcher's own bundled node_modules. In the real launcher this is
// inside the .app; here we borrow the repo's node_modules to test cross-boundary resolution.
const LAUNCHER_NODE_MODULES = path.resolve(LAUNCHER_DIR, '..', '..', '..', 'node_modules');

const USERDATA = process.env.PROTO_USERDATA || path.join(os.tmpdir(), 'bookforge-launcher-proto');
const APP_ROOT = path.join(USERDATA, 'app'); // holds version folders + current.json
const POINTER = path.join(APP_ROOT, 'current.json');

function log(...args) {
  console.log('[launcher]', ...args);
}

function readPointer() {
  try {
    return JSON.parse(fs.readFileSync(POINTER, 'utf8'));
  } catch {
    return null;
  }
}

function writePointer(version) {
  // Atomic-ish: write temp then rename (same discipline the real flip will use).
  const tmp = POINTER + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version, flippedAt: 'proto' }, null, 2));
  fs.renameSync(tmp, POINTER);
}

// Copy a code bundle from baseline/<name> into userData/app/<name>. Models "download +
// extract + verify" — here it's a local copy, but the destination layout is identical to
// what downloadAndExtract() would produce.
function stage(name) {
  const src = path.join(BASELINE_DIR, name);
  const dst = path.join(APP_ROOT, name);
  if (!fs.existsSync(src)) {
    throw new Error(`No such bundle to stage: ${src}`);
  }
  if (fs.existsSync(dst)) {
    log(`bundle ${name} already staged`);
    return dst;
  }
  log(`staging ${name} -> ${dst}`);
  fs.cpSync(src, dst, { recursive: true });
  return dst;
}

function ensureBootable() {
  fs.mkdirSync(APP_ROOT, { recursive: true });

  // First run: no pointer yet -> seed the bundled baseline (offline-safe path).
  let pointer = readPointer();
  if (!pointer) {
    log('first run: seeding baseline v1');
    stage('v1');
    writePointer('v1');
    pointer = readPointer();
  }

  // Stage-now / boot-next: if asked to stage a newer bundle, stage it and flip the pointer.
  // (In the real launcher we'd flip AFTER download+verify, and only boot it next launch.)
  const stageReq = process.env.PROTO_STAGE;
  if (stageReq && pointer.version !== stageReq) {
    stage(stageReq);
    writePointer(stageReq);
    pointer = readPointer();
    log(`flipped current -> ${stageReq}`);
  }

  return pointer.version;
}

function injectLauncherModules() {
  // Make bare requires from the code bundle (which lives in userData with no node_modules
  // nearby) fall back to the launcher's node_modules. This is what lets the code bundle
  // ship pure-JS-only and still resolve native deps like better-sqlite3.
  process.env.NODE_PATH = LAUNCHER_NODE_MODULES + path.delimiter + (process.env.NODE_PATH || '');
  Module._initPaths();
  log('module fallback path ->', LAUNCHER_NODE_MODULES);
}

function main() {
  log('userData =', USERDATA);
  const version = ensureBootable();
  const codeMain = path.join(APP_ROOT, version, 'electron', 'main.js');
  log(`booting code bundle "${version}" from`, codeMain);

  injectLauncherModules();

  if (!fs.existsSync(codeMain)) {
    throw new Error(`Code bundle main not found: ${codeMain}`);
  }
  // Hand off. From here on, the code bundle's main.js drives the app, exactly as the real
  // dist/electron/main.js would — but loaded from userData, not from the .app.
  require(codeMain);
}

main();
