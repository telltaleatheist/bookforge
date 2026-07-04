#!/usr/bin/env node
/**
 * Ensure our app-embedded native plugins stay registered after `cap sync`.
 *
 * Capacitor derives `packageClassList` in capacitor.config.json purely from
 * installed npm plugins (see @capacitor/cli util/iosplugin.js), so it rewrites
 * the list to `[]` on every sync — wiping any plugin compiled directly into the
 * app. Our plugins live in CapApp-SPM/Sources (an SPM target that's part of the
 * app, not npm packages), so we re-add their @objc class names here.
 *
 * Idempotent; run automatically by `npm run sync`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(here, '../ios/App/App/capacitor.config.json');
const CLASSES = ['NativeAudioPlugin', 'NativeFilePlugin'];

const json = JSON.parse(readFileSync(configPath, 'utf8'));
json.packageClassList = Array.isArray(json.packageClassList) ? json.packageClassList : [];

let changed = false;
for (const cls of CLASSES) {
  if (json.packageClassList.includes(cls)) {
    console.log(`[register-native-plugin] ${cls} already registered`);
  } else {
    json.packageClassList.push(cls);
    changed = true;
    console.log(`[register-native-plugin] registered ${cls} in packageClassList`);
  }
}
if (changed) writeFileSync(configPath, JSON.stringify(json, null, '\t') + '\n');
