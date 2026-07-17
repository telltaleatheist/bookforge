// Minimal `electron` stub so main-process modules (tool-paths, manifest-service,
// metadata-tools, …) can be esbuild-bundled and run HEADLESS in a CLI script.
// Only the surface those modules touch at import/use time is implemented; app
// paths point at the real per-user locations so tool-paths.json etc. resolve.
const os = require('os');
const path = require('path');
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

function userData() {
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'BookForge');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'BookForge');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'BookForge');
}

const app = {
  getPath: (n) => ({
    userData: userData(),
    appData: path.dirname(userData()),
    documents: path.join(HOME, 'Documents'),
    home: HOME,
    temp: os.tmpdir(),
    logs: os.tmpdir(),
  })[n] || os.tmpdir(),
  getAppPath: () => process.cwd(),
  getName: () => 'BookForge',
  getVersion: () => '0.0.0',
  isPackaged: false,
  on: () => {}, once: () => {}, whenReady: () => Promise.resolve(),
};

module.exports = {
  app,
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class {},
  shell: {}, dialog: {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
};
