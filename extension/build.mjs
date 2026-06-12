import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });

// Bake the local TTS API token (and host/port) into the build so the extension
// connects without the user pasting it each time. Read from the app's userData
// tts-api.json — same file the options page tells you to copy from. dist/ is
// gitignored, so the token never lands in source control. Defaults to empty when
// the app hasn't been run yet (extension then behaves as before: enter it once).
function appConfigDir() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'bookforge-app');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'bookforge-app');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bookforge-app');
}

const baked = { token: '', host: '127.0.0.1', port: 8766 };
try {
  const cfg = JSON.parse(readFileSync(join(appConfigDir(), 'tts-api.json'), 'utf8'));
  if (cfg.token) baked.token = String(cfg.token);
  if (cfg.host) baked.host = String(cfg.host);
  if (cfg.port) baked.port = Number(cfg.port);
  console.log(`[build] baked TTS token from tts-api.json (${baked.host}:${baked.port})`);
} catch {
  console.log('[build] no tts-api.json found — shipping without a default token (enter it in Options)');
}

const options = {
  entryPoints: [
    'src/background.ts',
    'src/content.ts',
    'src/offscreen.ts',
    'src/options.ts',
    'src/popup.ts'
  ],
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  outdir: 'dist',
  logLevel: 'info',
  define: {
    __BFR_TOKEN__: JSON.stringify(baked.token),
    __BFR_HOST__: JSON.stringify(baked.host),
    __BFR_PORT__: JSON.stringify(baked.port)
  }
};

if (watch) {
  // Note: static/ files are only copied at startup; restart watch after editing them.
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
