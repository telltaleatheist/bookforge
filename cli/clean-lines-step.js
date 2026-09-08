/**
 * clean-lines-step.js — the narration text cleanup over a FILE OF LINES.
 *
 * Owen, 2026-09-07: *"put the text we want to process into a single file
 * separated by newlines and have the bookforge-cli split it into chunks and
 * process it that way ... model is loaded on start and unloaded on completion."*
 * The corpus behind it: thousands of training clips, some a single sentence,
 * whose transcripts should read the way a narration would — the same three
 * stages (punctuation spec, the number rules, the model on every block) the
 * app's Clean text step runs on a book.
 *
 * ── ONE PASS, ONE PROCESS, ONE FILE ─────────────────────────────────────────
 *
 * There is one implementation of the pass and it is Foundry's `clean-text`
 * (docs/CLEAN-TEXT.md there; BookForge's own copy was retired on 2026-09-05).
 * Its `--book` door reads a book file of blocks, loads the model ONCE, pins the
 * context window ONCE from the longest block, asks about every block at
 * temperature 0, writes one records row per block and unloads the model at the
 * end. So this module does not clean anything: it turns a text file into a book
 * file with one paragraph block per line, spawns that door exactly as the app
 * does (same binary, same settings file, same progress line), and zips the
 * records back into a text file whose line N is the cleaned line N.
 *
 * Five thousand `bookforge-cli` calls would have loaded the prompt, pinned the
 * context and paid the process start five thousand times, and would have left
 * no single receipt. One file in, one file out is the shape the engine already
 * has.
 *
 * ── What survives a kill ────────────────────────────────────────────────────
 *
 * The records file lives beside the output under `<stem>.clean-lines/` and is
 * append-only, keyed by block text and model, so a run killed at 4,000 of 5,000
 * keeps 4,000 answers and the next run asks only about the rest — that is the
 * engine's own resume, not one built here.
 *
 * ── The line is the unit, and the line is kept ──────────────────────────────
 *
 * Blank lines are kept blank and their positions kept, so the output has
 * exactly as many lines as the input and a caller can zip it against an audio
 * list by position. A non-blank line the engine wrote no record for is a
 * refusal by line number, never a silent copy of the input: a transcript that
 * did not go through the pass must not come back looking as if it had.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** The category every line is filed as: the engine asks about `Text` rows one at a time. */
const LINE_CATEGORY = 'Text';

/** Foundry's book-file format this module writes (`BOOK_FILE_VERSION`, src/vlm/book-file.ts). */
const BOOK_FILE_VERSION = 3;

/**
 * The input, one item per line. Line numbers are 1-based and count EVERY line
 * of the file, blank ones included, because the output is written back by
 * position and a caller's audio list is numbered the same way.
 */
function parseLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  // A trailing newline is the file's terminator, not an empty last item.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    items.push({ line: i + 1, text: line });
  }
  return { total: lines.length, items };
}

/** The block id a line is filed under — `e-<line>` is one of the id shapes Foundry mints. */
function idForLine(line) {
  return `e-${line}`;
}

/**
 * A version-3 book file with one `Text` block per non-blank line.
 *
 * Every header field Foundry's parser requires is written, in the shape it
 * requires, and nothing it does not: no chapters (so no chapter title is asked
 * about), no figures, no seams, an empty shelf. `engine` is the installed
 * foundry's own version string, because the parser reads it as "which foundry
 * wrote this". `bankSha` is a digest of the input so two runs over different
 * files never share a source identity.
 */
function bookFileFor(items, opts) {
  if (typeof opts.engine !== 'string' || opts.engine.length === 0) {
    throw new Error('bookFileFor needs the installed foundry version as `engine`');
  }
  if (typeof opts.language !== 'string' || opts.language.length === 0) {
    throw new Error('bookFileFor needs a `language` (the plain primary subtag, e.g. en)');
  }
  const digest = crypto.createHash('sha256')
    .update(items.map((it) => `${it.line}\t${it.text}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
  const header = {
    book: BOOK_FILE_VERSION,
    engine: opts.engine,
    language: opts.language,
    source: { pages: 1, unreadable: [], bankSha: digest },
    chapters: [],
    typography: null,
    seams: [],
    loose: { markers: [], notes: [] },
  };
  const rows = items.map((it) => ({
    id: idForLine(it.line),
    category: LINE_CATEGORY,
    text: it.text,
    page: 1,
    pages: [1],
    box: { x1: 0, y1: 0, x2: 0, y2: 0 },
    pageWidth: 0,
    pageHeight: 0,
    // Version 3 says of every row which banked answer it came from and which
    // characters; a line is one answer covering all of itself.
    parts: [{ src: 'lines', page: 1, chars: [0, it.text.length] }],
  }));
  return [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join('\n') + '\n';
}

/**
 * The records file, read back: the NEWEST row per block wins (the file is
 * append-only and a resumed run appends), and a line with no row at all is
 * refused by number.
 */
function zipRecords(parsed, recordsText) {
  const newest = new Map();
  for (const raw of recordsText.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      throw new Error(`the records file has a row that is not JSON (${err.message}): ${line.slice(0, 120)}`);
    }
    if (typeof row.parts !== 'string' || typeof row.text !== 'string') {
      throw new Error(`the records file has a row with no parts or no text: ${line.slice(0, 120)}`);
    }
    newest.set(row.parts, row.text);
  }
  const out = new Array(parsed.total).fill('');
  const missing = [];
  let changed = 0;
  for (const it of parsed.items) {
    const text = newest.get(idForLine(it.line));
    if (text === undefined) {
      missing.push(it.line);
      continue;
    }
    if (text.includes('\n') || text.includes('\r')) {
      throw new Error(
        `line ${it.line} came back from the pass holding a line break, which cannot be written `
        + 'back by position. Nothing was written.');
    }
    if (text !== it.text) changed += 1;
    out[it.line - 1] = text;
  }
  if (missing.length > 0) {
    const shown = missing.length <= 12 ? missing.join(', ') : `${missing.slice(0, 12).join(', ')}, … (${missing.length} in all)`;
    throw new Error(
      `the pass wrote no answer for line(s) ${shown}. A line that did not go through the pass is `
      + 'not written back as if it had; run again and the engine asks only about what is missing.');
  }
  return { lines: out, changed };
}

/** Where a run keeps its book file, records, stamp and receipt: beside the output. */
function workDirFor(outputPath) {
  const stem = path.basename(outputPath).replace(/\.[^.]+$/, '');
  return path.join(path.dirname(outputPath), `${stem}.clean-lines`);
}

/**
 * The run. `deps` exists so a keeper can drive this without the compiled app
 * or a foundry on the machine; the CLI passes nothing and gets the app's doors.
 */
async function runCleanLines(opts, deps) {
  const inputPath = path.resolve(opts.inputPath);
  if (!fs.existsSync(inputPath)) throw new Error(`input file not found: ${inputPath}`);
  const outputPath = path.resolve(opts.outputPath);
  if (path.resolve(outputPath) === inputPath) {
    throw new Error('--output must not be the input file: the input is what a re-run resumes from.');
  }
  const language = opts.language;
  if (typeof language !== 'string' || language.trim().length === 0) {
    throw new Error('--language is required (the plain primary subtag the lines are in, e.g. en)');
  }
  const log = opts.log || ((line) => console.log(line));

  const d = deps || defaultDeps();
  const parsed = parseLines(fs.readFileSync(inputPath, 'utf8'));
  if (parsed.items.length === 0) {
    throw new Error(`${inputPath} holds no non-blank lines, so there is nothing to clean.`);
  }

  const installed = await d.foundryVersion();
  if (!d.foundryVersionAtLeast(installed.version, d.FOUNDRY_VERSION_FOR_CLEAN_TEXT)) {
    throw new Error(
      `foundry ${installed.version} at ${installed.path} predates clean-text --book `
      + `(${d.FOUNDRY_VERSION_FOR_CLEAN_TEXT}). Update Foundry; nothing was spawned.`);
  }
  const settings = await d.cleanTextEngineSettings();

  const workDir = workDirFor(outputPath);
  fs.mkdirSync(workDir, { recursive: true });
  const bookPath = path.join(workDir, 'lines.book.jsonl');
  const recordsPath = path.join(workDir, 'lines.records.jsonl');
  const stampPath = path.join(workDir, 'lines.stamp.json');
  const receiptPath = `${recordsPath}.receipt.json`;
  fs.writeFileSync(bookPath, bookFileFor(parsed.items, { engine: installed.version, language }), 'utf8');

  /*
   * WHICH SERVER, AND THEREFORE WHICH TWO FLAGS. Foundry 19f5e70 (Owen,
   * 2026-09-08: "lets build in vllm batching. ollama batching doesnt work") gave
   * `clean-text` a `--server ollama|vllm`, declared and never sniffed from a URL.
   * This door gets exactly what the bare-EPUB door gets, and by the same rules:
   *
   *   · `--server vllm` is WRITTEN and `--server ollama` is NOT, so the ollama
   *     line is byte-identical to what it was before vLLM existed;
   *   · `--model` is OMITTED when the model is empty — never `--model ""` —
   *     because empty is vLLM's meaningful default ("whatever it is serving"),
   *     which the engine resolves from /v1/models and RECORDS.
   *
   * `--keep-model` is untouched and stays what it was: an ollama word (keep the
   * weights resident), meaningless under vLLM and harmless there.
   */
  const args = [
    'clean-text',
    '--book', bookPath,
    '--records', recordsPath,
    '--stamp', stampPath,
    '--endpoint', settings.endpoint,
    ...(settings.server === 'vllm' ? ['--server', 'vllm'] : []),
    ...(settings.model.length > 0 ? ['--model', settings.model] : []),
    ...(opts.keepModel ? ['--keep-model'] : []),
  ];
  log(
    `[clean-lines] ${parsed.items.length} line(s) of ${parsed.total} in ${path.basename(inputPath)} → `
    + `${installed.path} ${args.join(' ')}`);
  log(`[clean-lines] model and endpoint from ${settings.source}`);
  const resumed = fs.existsSync(recordsPath);
  if (resumed) log(`[clean-lines] ${recordsPath} exists; the engine asks only about lines it has no answer for.`);

  /*
   * ── THE ARBITER'S BRACKET ───────────────────────────────────────────────────
   *
   * Owen, 2026-09-08: *"build that piece. the arbiter that starts/stops it."*
   * Foundry starts no server; BookForge does, and a dev run through this door is
   * no different from a queued one — "the CLI mirrors the app's code path".
   *
   * Only under vLLM, and only when the endpoint is the server this machine
   * manages: any other URL is somebody else's and is used exactly as given. The
   * stop is unconditional on the way out unless `--keep-server` was asked for,
   * which is the flag for somebody about to make several runs back to back.
   */
  let started = null;
  if (settings.server === 'vllm' && d.textServerRoute(settings.endpoint).manage) {
    d.noteTextQueueBusy();
    const profile = d.profileForKind('clean');
    const startedAt = Date.now();
    const up = await d.ensureTextServer(profile.id, (line) => log(`[clean-lines] ${line}`));
    started = profile;
    log(
      `[clean-lines] the text server is serving ${up.servedName} at ${up.url} `
      + `(${((Date.now() - startedAt) / 1000).toFixed(1)}s to be ready)`);
  } else if (settings.server === 'vllm') {
    log(`[clean-lines] ${d.textServerRoute(settings.endpoint).note}`);
  }

  const t0 = Date.now();
  let result;
  try {
    result = await d.runFoundry(args, {
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      onProgress: (line) => {
        const counted = d.parseCleanTextProgress(line);
        if (counted !== null) {
          log(`[clean-lines] ${counted.done}/${counted.total}`);
          return;
        }
        const trimmed = line.trim();
        if (trimmed.length > 0) log(`[foundry] ${trimmed}`);
      },
    });
  } finally {
    // Success or failure alike: a failed run must hand the card back exactly as a
    // finished one does.
    if (started !== null) {
      if (opts.keepServer === true) {
        log(`[clean-lines] --keep-server: ${started.servedName} is left running on the card.`);
      } else {
        await d.stopTextServer('the clean-lines run finished');
      }
    }
  }
  if (result.code !== 0) {
    throw new Error(
      `foundry clean-text exited ${result.code}. What it said:\n${(result.stderr || '').slice(-4000)}`);
  }
  if (!fs.existsSync(recordsPath)) {
    throw new Error(`foundry clean-text exited 0 and wrote no records file at ${recordsPath}.`);
  }

  const zipped = zipRecords(parsed, fs.readFileSync(recordsPath, 'utf8'));
  fs.writeFileSync(outputPath, zipped.lines.join('\n') + '\n', 'utf8');

  let receipt = null;
  if (fs.existsSync(receiptPath)) {
    try {
      receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    } catch (err) {
      log(`[clean-lines] the receipt at ${receiptPath} could not be read (${err.message}).`);
    }
  }
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  log(
    `[clean-lines] wrote ${outputPath}: ${parsed.items.length} line(s), ${zipped.changed} changed, `
    + `${seconds}s`);
  if (receipt !== null) {
    const disp = receipt.dispositions && typeof receipt.dispositions === 'object'
      ? Object.entries(receipt.dispositions).map(([k, v]) => `${k} ${v}`).join(', ')
      : 'none recorded';
    log(
      `[clean-lines] receipt: model ${receipt.model}, ${receipt.normalizerVersion}/${receipt.punctuationSpec}, `
      + `asked ${receipt.unitsAsked}, parse failed ${receipt.unitsParseFailed}; edits: ${disp}`);
    log(`[clean-lines] receipt at ${receiptPath}; records at ${recordsPath}`);
  }
  return {
    inputPath, outputPath, recordsPath, receiptPath, stampPath,
    lines: parsed.items.length, total: parsed.total, changed: zipped.changed, resumed, receipt,
  };
}

/** The app's own doors, out of the compiled dist — loaded only when a run asks for them. */
function defaultDeps() {
  const door = require('../dist/electron/narration-clean-text.js');
  const bridge = require('../dist/electron/foundry-bridge.js');
  const hostQueue = require('../dist/electron/foundry-host-queue.js');
  const bank = require('../dist/shared/vlm/readings-bank.js');
  // The arbiter. Its five doors are named individually rather than the module
  // being handed over, so a keeper replacing one of them replaces a function and
  // not a namespace.
  const textServer = require('../dist/electron/text-server.js');
  return {
    foundryVersion: bridge.foundryVersion,
    runFoundry: bridge.runFoundry,
    cleanTextEngineSettings: door.cleanTextEngineSettings,
    parseCleanTextProgress: door.parseCleanTextProgress,
    foundryVersionAtLeast: bank.foundryVersionAtLeast,
    FOUNDRY_VERSION_FOR_CLEAN_TEXT: hostQueue.FOUNDRY_VERSION_FOR_CLEAN_TEXT,
    textServerRoute: textServer.textServerRoute,
    profileForKind: textServer.profileForKind,
    ensureTextServer: textServer.ensureTextServer,
    noteTextQueueBusy: textServer.noteTextQueueBusy,
    stopTextServer: textServer.stopTextServer,
  };
}

module.exports = {
  LINE_CATEGORY, BOOK_FILE_VERSION,
  parseLines, idForLine, bookFileFor, zipRecords, workDirFor, runCleanLines,
};
