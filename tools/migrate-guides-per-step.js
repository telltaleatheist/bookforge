/**
 * One-time move: a book's pronunciation guide becomes ONE STEP's (Owen, 2026-10-10:
 * "maybe it should be a step specific thing. in fact, i think it should").
 *
 *   node tools/migrate-guides-per-step.js <library-root>           (says what it would do)
 *   node tools/migrate-guides-per-step.js <library-root> --apply   (does it)
 *
 * Before, a book had one guide, `readings/<key>.narration-glossary.json`, and every
 * cleanup read it. Every such guide was made for the book's clean as it stands, so
 * it becomes the guide of the step that clean was made from — the step a re-clean
 * starts from, and the one that keeps a person's decisions in reach:
 * `readings/<key>.<step>.narration-glossary.json`. A book whose position is not a
 * clean cannot say which step its guide was for, and is refused by name.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const [root, flag] = process.argv.slice(2);
if (!root) {
  console.error('usage: node tools/migrate-guides-per-step.js <library-root> [--apply]');
  process.exit(2);
}
const apply = flag === '--apply';
const projects = path.join(root, 'foundry', 'projects');

let moved = 0;
const refused = [];
for (const name of fs.readdirSync(projects)) {
  const dir = path.join(projects, name);
  const manifestPath = path.join(dir, 'project.json');
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
  const key = manifest.key;
  const legacy = {
    glossary: path.join(dir, 'readings', `${key}.narration-glossary.json`),
    readings: path.join(dir, 'readings', `${key}.narration-glossary.readings.json`),
  };
  if (!fs.existsSync(legacy.glossary)) continue;
  const steps = manifest.ledger?.steps ?? [];
  const position = steps.find((s) => s.id === manifest.ledger?.position);
  if (position === undefined || position.action !== 'clean' || typeof position.parent !== 'string') {
    refused.push(`${name}: its position is ${position === undefined ? 'no step' : `a ${position.action} step`}, `
      + 'not a clean, so there is no telling which step its guide was made for.');
    continue;
  }
  const step = position.parent;
  const target = {
    glossary: path.join(dir, 'readings', `${key}.${step}.narration-glossary.json`),
    readings: path.join(dir, 'readings', `${key}.${step}.narration-glossary.readings.json`),
  };
  if (fs.existsSync(target.glossary)) {
    refused.push(`${name}: step ${step} already has a guide (${target.glossary}); the old one is left where it is.`);
    continue;
  }
  const people = JSON.parse(fs.readFileSync(legacy.glossary, 'utf8')).entries.filter((e) => e.by === 'person').length;
  console.log(`${name}\n    → step ${step} ("${steps.find((s) => s.id === step)?.label ?? '?'}")`
    + `${people > 0 ? `, carrying ${people} decision(s) of yours` : ''}`);
  if (apply) {
    fs.renameSync(legacy.glossary, target.glossary);
    if (fs.existsSync(legacy.readings)) fs.renameSync(legacy.readings, target.readings);
  }
  moved += 1;
}
for (const line of refused) console.log(`REFUSED ${line}`);
console.log(`${apply ? 'moved' : 'would move'} ${moved} guide(s); ${refused.length} refused.`);
process.exit(refused.length === 0 ? 0 : 1);
