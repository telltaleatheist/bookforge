/**
 * clean-lines.js — the narration text cleanup over a file of lines, headless.
 *
 * One training transcript per line in, the same lines cleaned out, by position.
 * A killed run keeps its answers and the next run asks only about the rest. See
 * clean-lines-step.js.
 *
 * THE ENGINE NEVER LOADS AND NEVER UNLOADS a model, since Foundry `646e8a1`
 * (v1.3.0). The weights are made resident by the operator before a pass is
 * spawned and a server holding the wrong one refuses by name; this door starts
 * and stops BookForge's own text SERVER (`--keep-server`), which is a different
 * act from loading a model into it.
 *
 * Run via the electron shim preload:
 *   node --require ./cli/electron-stub.js cli/clean-lines.js --input lines.txt --language en
 *   node --require ./cli/electron-stub.js cli/clean-lines.js --input lines.txt --output cleaned.txt --language en
 *
 * The model and the endpoint are the app's own (`app-settings.json`), the same
 * ones the hosted Clean text press uses, so a corpus and a book are cleaned by
 * one setting.
 */
'use strict';
const path = require('path');
const { runCleanLines } = require('./clean-lines-step.js');
const { refuseRetiredEngineFlags } = require('./retired-engine-flags.js');

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
  // BEFORE the usage check, so `--keep-model` on an otherwise complete line is
  // told what happened to it rather than passing silently.
  refuseRetiredEngineFlags(args, 'clean-lines');
  if (!args.input || args.input === true) {
    throw new Error(
      'usage: clean-lines.js --input <lines.txt> [--output <cleaned.txt>] --language <en> '
      + '[--keep-server]');
  }
  if (!args.language || args.language === true) {
    throw new Error('--language is required (the plain primary subtag the lines are in, e.g. en)');
  }
  if (args.model) {
    console.log(
      '[clean-lines] note: --model is ignored. The cleanup runs `foundry clean-text`, which takes its '
      + 'model and its endpoint from the same settings the hosted Clean text press uses.');
  }
  const inputPath = path.resolve(args.input);
  const outputPath = args.output && args.output !== true
    ? path.resolve(args.output)
    : path.join(path.dirname(inputPath), `${path.basename(inputPath).replace(/\.[^.]+$/, '')}.cleaned.txt`);
  const result = await runCleanLines({
    inputPath,
    outputPath,
    language: String(args.language),
    /*
     * `--keep-server` IS NOT `--keep-model`, and it is the one of the pair that
     * survived. `--keep-model` was an Ollama word — leave the weights resident
     * for its keep_alive window — and it went with the dialect in Foundry
     * `646e8a1`; it is refused by name above. THIS one is BookForge's own and
     * says: leave BookForge's OWN text server up when the run ends, for somebody
     * about to make several runs back to back, because starting it again costs
     * ~110 s (measured 2026-09-08). Unsaid, the server is stopped and the card
     * goes back to whatever is queued for it.
     */
    keepServer: args['keep-server'] === true,
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
