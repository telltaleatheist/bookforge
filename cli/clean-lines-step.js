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

  // Asked for the book file's `engine` field and the log line, not as a gate:
  // the engine is vendored with foundry-app, so it always has `clean-text --book`.
  const installed = await d.foundryVersion();
  const settings = await d.cleanTextEngineSettings();

  const workDir = workDirFor(outputPath);
  fs.mkdirSync(workDir, { recursive: true });
  const bookPath = path.join(workDir, 'lines.book.jsonl');
  const recordsPath = path.join(workDir, 'lines.records.jsonl');
  const stampPath = path.join(workDir, 'lines.stamp.json');
  const receiptPath = `${recordsPath}.receipt.json`;
  const verdictsPath = path.join(workDir, 'lines.triage.json');
  fs.writeFileSync(bookPath, bookFileFor(parsed.items, { engine: installed.version, language }), 'utf8');

  /*
   * ONE DOOR, THREE FLAGS. Foundry `646e8a1` (v1.3.0, tag `engine-one-door`)
   * deleted the Ollama dialect and every flag that only existed to choose it:
   * `--server`, `--ollama` and `--keep-model` are all `unknown option` now.
   * What is left is the pair this door has always written, under the rules that
   * did not change:
   *
   *   · `--endpoint <url>` is THE server. Absent, the engine would read
   *     `backend.endpointUrl` from its own settings — which is the READING
   *     door's setting, the same server — but it is written on every line this
   *     app composes, because a job must not depend on the engine's fallback to
   *     say which machine it runs on.
   *   · `--model` is OMITTED when the model is empty — never `--model ""` —
   *     because empty is the meaningful default ("whatever it is serving"),
   *     which the engine resolves from /v1/models and RECORDS. Since `646e8a1`
   *     there are no act-level model defaults at all, so an absent `--model` is
   *     the served model on every run rather than only under vLLM.
   *
   * `opts.keepModel` IS NO LONGER A THING THIS FUNCTION CAN HONOUR, and it is
   * refused at the door rather than dropped here (`cli/clean-lines.js`,
   * `refuseRetiredEngineFlags`). The engine never loads and never unloads: a
   * server holding the wrong model refuses by name, and residency is the
   * operator's act before the spawn.
   */
  /*
   * ── WHERE THIS RUN'S MODEL LIVES — the app's own venue decision ───────────
   *
   * `decideWhereTextActRuns` is what `electron/queue-steps/foundry-job.ts` and
   * the bare-EPUB failsafe both call, over the same routing record.
   * `opts.crucibleServer` is `--crucible-server`, and it fills exactly the
   * field the app fills from a queue row. A Crucible run replaces the endpoint
   * and NAMES the model (there is no "whatever it is serving" on a Crucible:
   * the id must equal the resident one or the server answers 409
   * model_not_resident), and the credential goes in the spawn's environment.
   */
  const venueHost = d.processTextVenueHost();
  const venue = await d.decideWhereTextActRuns(opts.crucibleServer, venueHost);
  const crucible = venue.where === 'crucible'
    // `spawn`: this door calls `runFoundry` with an explicit `env` below.
    ? await d.resolveCrucibleTextEngine('clean', venue.server, venueHost, { headerReach: 'spawn' })
    : null;

  const args = crucible === null
    ? [
      'clean-text',
      '--book', bookPath,
      '--records', recordsPath,
      '--stamp', stampPath,
      '--endpoint', settings.endpoint,
      ...(settings.model.length > 0 ? ['--model', settings.model] : []),
    ]
    : [
      'clean-text',
      '--book', bookPath,
      '--records', recordsPath,
      '--stamp', stampPath,
      '--endpoint', crucible.endpoint,
      '--model', crucible.model,
      ...(opts.triage === true ? ['--triage', verdictsPath] : []),
    ];
  if (opts.triage === true && crucible === null) {
    throw new Error(
      '--triage runs the Foundry clean-triage, which only the decide door of a Crucible answers; this run resolved to '
      + `${settings.endpoint} (${venue.because}). Name a Crucible with --crucible-server, or drop --triage.`);
  }
  log(
    `[clean-lines] ${parsed.items.length} line(s) of ${parsed.total} in ${path.basename(inputPath)} → `
    + `${installed.path} ${args.join(' ')}`);
  log(crucible === null
    ? `[clean-lines] model and endpoint from ${settings.source}`
    : `[clean-lines] crucible "${crucible.server}" (${venue.because}), act ${crucible.act}, `
      + `headers ${crucible.maskedHeaders} (in the spawn's environment, never on the line)`);
  const resumed = fs.existsSync(recordsPath);
  if (resumed) log(`[clean-lines] ${recordsPath} exists; the engine asks only about lines it has no answer for.`);

  /*
   * ── THE ARBITER'S BRACKET ───────────────────────────────────────────────────
   *
   * Owen, 2026-09-08: *"build that piece. the arbiter that starts/stops it."*
   * Foundry starts no server; BookForge does, and a dev run through this door is
   * no different from a queued one — "the CLI mirrors the app's code path".
   *
   * ONLY WHEN THE ENDPOINT IS THE SERVER THIS MACHINE MANAGES: any other URL is
   * somebody else's and is used exactly as given. That one question used to be
   * asked behind a second one (`settings.server === 'vllm'`), and Foundry
   * `646e8a1` deleted the server kind, so the endpoint is the whole gate now —
   * which is also the better question, because a machine set to `ollama` whose
   * URL is BookForge's own text server used to be skipped in silence.
   *
   * The stop is unconditional on the way out unless `--keep-server` was asked
   * for, which is the flag for somebody about to make several runs back to back.
   */
  let started = null;
  if (crucible !== null) {
    // A Crucible is a service somebody else already started. Nothing here
    // brings a server up beside it — that would put two models on one card.
    log(`[clean-lines] ${crucible.endpoint} is a Crucible; BookForge starts and stops nothing.`);
  } else if (d.textServerRoute(settings.endpoint).manage) {
    d.noteTextQueueBusy();
    const profile = d.profileForKind('clean');
    const startedAt = Date.now();
    const up = await d.ensureTextServer(profile.id, (line) => log(`[clean-lines] ${line}`));
    started = profile;
    log(
      `[clean-lines] the text server is serving ${up.servedName} at ${up.url} `
      + `(${((Date.now() - startedAt) / 1000).toFixed(1)}s to be ready)`);
  } else {
    log(`[clean-lines] ${d.textServerRoute(settings.endpoint).note}`);
  }

  const t0 = Date.now();
  let result;
  try {
    /*
     * ONE LEASE FOR THE WHOLE ACT, and only on a Crucible (Owen, 2026-09-14:
     * *"Models should always be unloaded when we're done with them. Every
     * time."*). The engine's blocks arrive there as ordinary chat completions,
     * which hold nothing, so between any two of them the server would see an idle
     * card and unload the model this run is using. The lease is what says
     * otherwise; it is released on success and failure alike.
     */
    /*
     * ── TRIAGE FIRST, THE APP'S WAY (2026-09-25) ─────────────────────────────
     *
     * Owen: "ai cleanup triage, then clean the sentences triage decides should be
     * cleaned". The app's triaged press is two engine runs: `foundry clean-triage`
     * asks one yes/no per sentence, then `clean-text --triage <verdicts>` sends the
     * cleaner only the flagged ones and records the rest as examined and clean.
     * Every doubt resolves toward cleaning (the engine's rule, not this file's).
     *
     * THE MODEL IS THE CLEANER'S, THE ACT IS `decide` - exactly as the vendored
     * dispatcher places it (foundry 5989dc0, BookForge f70005df): the triage is
     * answered by the model the server serves `clean` with (qwen3.5-9b, AUC 0.89 /
     * 0.976 where the 2B managed 0.55-0.82), and leased and asked as `decide`, the
     * door it is sent through. So the resolved clean engine is reused with only its
     * act changed - on the lease and in X-Crucible-Act.
     *
     * A verdicts file already in the work dir is reused: its verdicts carry the
     * digest of the text they judged, and the engine cleans any line whose text has
     * changed since, so a stale verdict can only cause MORE cleaning, never less.
     */
    if (opts.triage === true) {
      if (fs.existsSync(verdictsPath)) {
        log(`[clean-lines] triage: reusing ${verdictsPath} (verdicts carry the digest of the text they judged)`);
      } else {
        const headers = JSON.parse(crucible.env.FOUNDRY_ENDPOINT_HEADERS);
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'x-crucible-act') headers[k] = 'decide';
        // clean-triage asks the Crucible's DECIDE door, which it addresses itself from the server's BASE
        // url (`--endpoint http://host:port`, foundry-engine CTR_ENDPOINT) - not the chat endpoint, whose
        // /openai suffix sent the first run to .../openai/v1/decide and a 404 (2026-09-25).
        const base = crucible.endpoint.replace(/\/openai\/?$/, '');
        const triageEngine = { ...crucible, endpoint: base, act: 'decide', env: { FOUNDRY_ENDPOINT_HEADERS: JSON.stringify(headers) } };
        const triageArgs = [
          'clean-triage', '--book', bookPath, '--out', verdictsPath,
          '--endpoint', triageEngine.endpoint, '--model', triageEngine.model,
        ];
        log(`[clean-lines] triage: ${installed.path} ${triageArgs.join(' ')} (act decide, model ${triageEngine.model})`);
        const tri = await d.withCrucibleTextActLease(triageEngine, () => d.runFoundry(triageArgs, {
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          env: triageEngine.env,
          onProgress: (line) => {
            const trimmed = line.trim();
            if (trimmed.length > 0) log(`[foundry] ${trimmed}`);
          },
        }));
        if (tri.code !== 0) {
          throw new Error(`foundry clean-triage exited ${tri.code}. What it said:\n${(tri.stderr || '').slice(-4000)}`);
        }
        if (!fs.existsSync(verdictsPath)) throw new Error(`foundry clean-triage exited 0 and wrote no verdicts at ${verdictsPath}.`);
      }
    }
    const spawnEngine = () => d.runFoundry(args, {
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      // The credential, on THIS child and no other: `runFoundry` merges an
      // overlay for one spawn (crucible docs/PHASE7-LANES.md section 7.1(B)).
      ...(crucible === null ? {} : { env: crucible.env }),
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
    result = crucible === null
      ? await spawnEngine()
      : await d.withCrucibleTextActLease(crucible, spawnEngine);
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
    triaged: opts.triage === true, verdictsPath: opts.triage === true ? verdictsPath : null,
  };
}

/** The app's own doors, out of the compiled dist — loaded only when a run asks for them. */
function defaultDeps() {
  const door = require('../dist/electron/narration-clean-text.js');
  const bridge = require('../dist/electron/foundry-bridge.js');
  // The arbiter. Its five doors are named individually rather than the module
  // being handed over, so a keeper replacing one of them replaces a function and
  // not a namespace.
  const textServer = require('../dist/electron/text-server.js');
  const textVenue = require('../dist/electron/crucible/text-venue.js');
  return {
    foundryVersion: bridge.foundryVersion,
    runFoundry: bridge.runFoundry,
    cleanTextEngineSettings: door.cleanTextEngineSettings,
    parseCleanTextProgress: door.parseCleanTextProgress,
    textServerRoute: textServer.textServerRoute,
    // The venue, from the ONE module that decides it for every text act.
    processTextVenueHost: textVenue.processTextVenueHost,
    decideWhereTextActRuns: textVenue.decideWhereTextActRuns,
    resolveCrucibleTextEngine: textVenue.resolveCrucibleTextEngine,
    // One lease for the whole act. Only reached when the venue IS a Crucible —
    // a local run has no server to tell it intends more requests.
    withCrucibleTextActLease: textVenue.withCrucibleTextActLease,
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
