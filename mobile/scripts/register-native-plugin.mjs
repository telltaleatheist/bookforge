#!/usr/bin/env node
/**
 * Ensure our app-embedded native plugin stays registered after `cap sync`.
 *
 * Capacitor derives `packageClassList` in capacitor.config.json purely from
 * installed npm plugins (see @capacitor/cli util/iosplugin.js), so it rewrites
 * the list to `[]` on every sync — wiping any plugin compiled directly into the
 * app. NativeAudioPlugin lives in CapApp-SPM/Sources (an SPM target that's part
 * of the app, not an npm package), so we re-add its @objc class name here.
 *
 * Idempotent; run automatically by `npm run sync`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(here, '../ios/App/App/capacitor.config.json');
const CLASS = 'NativeAudioPlugin';

const json = JSON.parse(readFileSync(configPath, 'utf8'));
json.packageClassList = Array.isArray(json.packageClassList) ? json.packageClassList : [];

if (json.packageClassList.includes(CLASS)) {
  console.log(`[register-native-plugin] ${CLASS} already registered`);
} else {
  json.packageClassList.push(CLASS);
  writeFileSync(configPath, JSON.stringify(json, null, '\t') + '\n');
  console.log(`[register-native-plugin] registered ${CLASS} in packageClassList`);
}
