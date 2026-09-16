#!/usr/bin/env node
// Public builds must be signed and notarized; never silently ship an unsigned DMG.
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
if (process.platform !== 'darwin') throw new Error('Build the signed Mac release on macOS.');
const env = { ...process.env };
const team = env.APPLE_TEAM_ID || 'N7V7AT6CZ9';
if (!env.APPLE_ID || !env.APPLE_APP_SPECIFIC_PASSWORD) {
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const service = 'BOOKFORGE_NOTARIZE_ASP';
  const metadata = execFileSync('security', ['find-generic-password', '-s', service], options);
  const account = metadata.match(/"acct"<blob>="([^"]*)"/);
  env.APPLE_ID ||= account?.[1];
  env.APPLE_APP_SPECIFIC_PASSWORD ||= execFileSync('security', ['find-generic-password', '-s', service, '-w'], options).trim();
}
if (!env.APPLE_ID || !env.APPLE_APP_SPECIFIC_PASSWORD) throw new Error('Apple notarization credentials are required.');
env.APPLE_TEAM_ID = team;
const cli = require.resolve('electron-builder/cli.js');
const result = spawnSync(process.execPath, [cli, '--mac', '--arm64', '--publish', 'never',
  '-c.forceCodeSigning=true', `-c.mac.notarize.teamId=${team}`], {
  cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
