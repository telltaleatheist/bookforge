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
/*
 * WHERE userData IS, AND THERE IS ONE ANSWER TO IT.
 *
 * `$BOOKFORGE_USER_DATA` overrides the platform location, which is how a keeper
 * drives a door against records of its own without touching the ones holding
 * Owen's library root, his settings and his Crucible tokens.
 *
 * IT IS HONOURED HERE, at the shim, because this is what `app.getPath` answers
 * and therefore what every compiled module reads. `cli/clean-step.js` already
 * consulted the variable for its OWN two lookups while the modules it calls
 * went on reading the platform path — one fact with two answers, and a run
 * pointed elsewhere that half-obeyed (crucible `docs/ARCHITECTURE.md` R1).
 */
const USER_DATA = (process.env.BOOKFORGE_USER_DATA || '').trim().length > 0
  ? path.resolve(process.env.BOOKFORGE_USER_DATA.trim())
  : path.join(
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
        : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')),
    'BookForge'
  );

const electronStub = {
  app: {
    getPath(name) {
      if (name === 'userData') return USER_DATA;
      if (name === 'temp') return os.tmpdir();
      if (name === 'home') return os.homedir();
      // Per this file's contract: unknown surface throws loudly (silently returning
      // tmpdir would redirect e.g. 'documents' output into %TEMP% — a hidden fallback).
      throw new Error(`electron-stub: app.getPath('${name}') is not stubbed — add it deliberately`);
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
