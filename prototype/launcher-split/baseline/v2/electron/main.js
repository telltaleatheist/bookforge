// "BookForge proper" — the code bundle that lives in userData/app/<version>/.
// This file is IDENTICAL across v1 and v2; only version.json differs. That's the point:
// a code update ships new JS, the launcher swaps the folder, behavior changes with zero
// changes to the launcher.
//
// It validates three things the real app needs:
//   1. It is loaded from userData (not the .app) — proven by __dirname / bundleDir below.
//   2. It self-locates its renderer via __dirname (NOT app.getAppPath()).
//   3. A native module (better-sqlite3) resolves across the launcher->bundle boundary
//      and actually runs.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const BUNDLE_ROOT = path.resolve(__dirname, '..'); // userData/app/<version>/
const meta = JSON.parse(fs.readFileSync(path.join(BUNDLE_ROOT, 'version.json'), 'utf8'));

function probeNativeModule() {
  // The ABI test. better-sqlite3 is the app's only native dep. If this loads and runs
  // under the launcher's Electron runtime, cross-boundary native resolution works.
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    const row = db.prepare('select sqlite_version() as v').get();
    db.close();
    return { ok: true, sqlite: row.v };
  } catch (err) {
    return { ok: false, error: String(err && err.stack ? err.stack : err) };
  }
}

app.whenReady().then(() => {
  const native = probeNativeModule();
  const info = {
    bundleVersion: meta.version,
    channel: meta.channel,
    accent: meta.accent,
    bundleDir: BUNDLE_ROOT,
    rendererSelfLocated: path.join(BUNDLE_ROOT, 'renderer', 'index.html'),
    electron: process.versions.electron,
    node: process.versions.node,
    abiModules: process.versions.modules, // Node ABI version; N-API modules don't care about it
    native,
  };

  console.log('[code-bundle] booted', JSON.stringify(info, null, 2));

  const win = new BrowserWindow({
    width: 760,
    height: 560,
    title: `BookForge proto — code bundle ${meta.version}`,
  });

  // Self-located renderer, loaded straight from the userData bundle.
  const indexPath = path.join(BUNDLE_ROOT, 'renderer', 'index.html');
  win.loadFile(indexPath, { search: encodeURIComponent(JSON.stringify(info)) });

  // Headless test hook: render, report, exit (so the prototype can run in CI/console).
  if (process.env.PROTO_AUTOQUIT) {
    win.webContents.once('did-finish-load', () => {
      console.log('[code-bundle] render complete; native.ok =', native.ok);
      setTimeout(() => app.quit(), 300);
    });
  }
});

app.on('window-all-closed', () => app.quit());
