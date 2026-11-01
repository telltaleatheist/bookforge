#!/usr/bin/env node
/**
 * ONE-TIME: bring every pronunciation guide on disk under the letters rule (prompt g7,
 * 2026-10-31) without asking any model.
 *
 * Owen, 2026-10-31: *"i dont want it to spell out acronyms. id rather it read the
 * acronym out ... maybe U S M C would be better"*, and 2026-11-01, of the guides
 * built before that: "yes, do both". A guide decided under g6 keeps initials as
 * printed ("US", "BEF", "U.S.") and leaves every expansion it refused ("United
 * States") to the sentence pass. The rule that replaced that (`acronymRead`,
 * electron/narration-glossary.ts) needs a model only to tell a long run said as a
 * word (NASA) from one said letter by letter (USMC); for everything else it is code:
 *
 *   - initials printed with periods, two or three capitals, or a run with no vowel
 *     are said letter by letter — spelled "U S", "B E F";
 *   - one letter twice ("SS") is said as printed.
 *
 * So this runs every caps / dotted-initials meaning of every MODEL-decided form
 * through that rule, with g6's "acronym" (which meant initials, said either way)
 * handed over undecided, and keeps a change only where the rule decided it:
 *
 *   - an as-printed meaning that becomes letters;
 *   - a refused expansion that becomes letters (or, for "SS", as printed), its
 *     refusal cleared, so its places are the guide's again rather than the cleanup's.
 *
 * Everything else is left as it is — a longer run with a vowel (USMC, SOMUA, AIDS)
 * needs the model, so that guide's Rebuild decides it. A person's form is never
 * touched. No other field is written.
 *
 * Dry run by default: `node tools/migrate-guides-letters.js [--root <projects dir>]`
 * prints what would change. `--write` changes the files, each backed up first beside
 * itself as `<name>.pre-letters.json`.
 *
 * Runs against the compiled dist/electron (npm run build:electron).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
require(path.join(REPO, 'cli', 'electron-stub.js'));
const glossary = require(path.join(REPO, 'dist', 'electron', 'narration-glossary.js'));

const args = process.argv.slice(2);
const write = args.includes('--write');
const rootAt = args.indexOf('--root');
const ROOT = rootAt >= 0 ? args[rootAt + 1] : 'Z:/bookforge/foundry/projects';
if (!fs.existsSync(ROOT)) {
  console.error(`No projects folder at ${ROOT}. Pass --root <the library's foundry/projects>.`);
  process.exit(1);
}

const isDotted = (key) => /^(\p{L}\.)+\p{L}$/u.test(key) && key !== 'e.g' && key !== 'i.e';

/** One sense under the letters rule, or null when the rule leaves it as it is. */
function migrated(entry, sense) {
  if (sense.kind === 'word' || sense.kind === 'numeral') return null;
  const form = { key: entry.key, kind: entry.kind, count: entry.count, printed: entry.printed, samples: [], occurrences: [] };
  const { problem: _was, ...bare } = sense;
  // g6's "acronym" meant initials, said either way: the rule decides, not the old word.
  const asked = { ...bare, kind: sense.kind === 'acronym' ? 'abbreviation' : sense.kind };
  const read = glossary.acronymRead(form, asked);
  if (read.kind !== 'initials') return null;
  if (glossary.senseProblem(form, read) !== null) return null;
  if (sense.problem === undefined && read.reading === sense.reading) return null;
  return { ...read, meaning: sense.meaning };
}

const counts = { files: 0, changedFiles: 0, asPrintedToLetters: 0, refusedToLetters: 0, refusedToPrinted: 0, entries: 0 };
const examples = [];
for (const project of fs.readdirSync(ROOT)) {
  const readings = path.join(ROOT, project, 'readings');
  if (!fs.existsSync(readings)) continue;
  for (const name of fs.readdirSync(readings)) {
    if (!name.endsWith('.narration-glossary.json')) continue;
    counts.files += 1;
    const file = path.join(readings, name);
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (body.format !== glossary.GLOSSARY_FORMAT) {
      console.log(`  skip ${name}: format ${body.format}, not ${glossary.GLOSSARY_FORMAT}`);
      continue;
    }
    let changed = false;
    body.entries = body.entries.map((entry) => {
      if (entry.by === 'person') return entry;
      if (entry.kind !== 'caps' && !isDotted(entry.key)) return entry;
      let touched = false;
      const senses = entry.senses.map((sense) => {
        const next = migrated(entry, sense);
        if (next === null) return sense;
        touched = true;
        if (sense.problem !== undefined) {
          if (next.reading === '') counts.refusedToPrinted += 1; else counts.refusedToLetters += 1;
        } else {
          counts.asPrintedToLetters += 1;
        }
        if (examples.length < 12) {
          examples.push(`${entry.key}: ${sense.problem !== undefined ? `refused "${sense.reading}"` : 'as printed'} -> ${next.reading === '' ? 'as printed' : `"${next.reading}"`}`);
        }
        return next;
      });
      if (!touched) return entry;
      changed = true;
      counts.entries += 1;
      const reads = senses.some((s) => s.reading.length > 0 && s.problem === undefined);
      return { ...entry, senses, ...(reads ? { decision: 'reading' } : {}) };
    });
    if (!changed) continue;
    counts.changedFiles += 1;
    if (!write) continue;
    const backup = file.replace(/\.json$/, '.pre-letters.json');
    fs.copyFileSync(file, backup);
    const partial = `${file}.partial`;
    fs.writeFileSync(partial, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    fs.renameSync(partial, file);
    console.log(`  wrote ${project}/${name} (backup ${path.basename(backup)})`);
  }
}
console.log(examples.map((e) => `  e.g. ${e}`).join('\n'));
console.log(`${write ? 'WROTE' : 'DRY RUN'}: ${JSON.stringify(counts)}`);
