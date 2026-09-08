/**
 * clean-lines.js — the narration text cleanup over a file of lines, headless.
 *
 * One training transcript per line in, the same lines cleaned out, by position.
 * The model loads once at the start and unloads at the end; a killed run keeps
 * its answers and the next run asks only about the rest. See clean-lines-step.js.
 *
 * Run via the electron shim preload:
 *   node --require ./cli/electron-stub.js cli/clean-lines.js --input lines.txt --language en
 *   node --require ./cli/electron-stub.js cli/clean-lines.js --input lines.txt --output cleaned.txt --language en
 *
 * The model and the Ollama endpoint are the app's own (`app-settings.json`),
 * the same ones the hosted Clean text press uses, so a corpus and a book are
 * cleaned by one setting.
 */
'use strict';
const path = require('path');
const { runCleanLines } = require('./clean-lines-step.js');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const body = t.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { a[body.slice(0, eq)] = body.slice(eq + 1); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { a[body] = argv[++i]; }
    else { a[body] = true; }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || args.input === true) {
    throw new Error('usage: clean-lines.js --input <lines.txt> [--output <cleaned.txt>] --language <en> [--keep-model]');
  }
  if (!args.language || args.language === true) {
    throw new Error('--language is required (the plain primary subtag the lines are in, e.g. en)');
  }
  if (args.model) {
    console.log(
      '[clean-lines] note: --model is ignored. The cleanup runs `foundry clean-text`, which takes its '
      + 'model and its Ollama endpoint from the same settings the hosted Clean text press uses.');
  }
  const inputPath = path.resolve(args.input);
  const outputPath = args.output && args.output !== true
    ? path.resolve(args.output)
    : path.join(path.dirname(inputPath), `${path.basename(inputPath).replace(/\.[^.]+$/, '')}.cleaned.txt`);
  const result = await runCleanLines({
    inputPath,
    outputPath,
    language: String(args.language),
    keepModel: args['keep-model'] === true,
  });
  console.log(JSON.stringify({
    output: result.outputPath,
    lines: result.lines,
    changed: result.changed,
    resumed: result.resumed,
    records: result.recordsPath,
    receipt: result.receiptPath,
  }));
}

main().catch((err) => {
  console.error(`[clean-lines] ${err.message}`);
  process.exitCode = 1;
});
