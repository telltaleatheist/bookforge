import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });

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
  logLevel: 'info'
};

if (watch) {
  // Note: static/ files are only copied at startup; restart watch after editing them.
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
