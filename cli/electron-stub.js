/**
 * Headless Electron shim for the BookForge CLI.
 *
 * BookForge's main-process modules (orpheus-worker-pool and its guard/tier/model
 * dependencies) statically `require('electron')`, but in this render path they only
 * ever touch a tiny surface: app.getPath / getAppPath / isPackaged and
 * BrowserWindow.getAllWindows (which no-ops on an empty window list). Preloading
 * this file with `node --require` intercepts `require('electron')` so those modules
 * load under plain node — driving BookForge's REAL guarded pipeline, no Electron
 * runtime. If a module reaches for an Electron API not stubbed here, it will throw
 * loudly naming the missing property — that's the signal to add exactly that, not a
 * blanket catch-all (no fallbacks).
 */
'use strict';
const Module = require('module');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const USER_DATA = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'BookForge'
);

const electronStub = {
  app: {
    getPath(name) {
      if (name === 'userData') return USER_DATA;
      if (name === 'temp') return os.tmpdir();
      if (name === 'home') return os.homedir();
      return os.tmpdir();
    },
    getAppPath: () => REPO_ROOT,
    getName: () => 'BookForge',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  // AI cleanup/simplify (ai-bridge.startAIPowerBlock) is the only path that touches
  // this; no-op it headlessly — there's no desktop session to keep awake.
  powerSaveBlocker: {
    start: () => 1,
    stop: () => {},
    isStarted: () => false,
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

module.exports = { electronStub, REPO_ROOT, USER_DATA };
