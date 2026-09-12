/**
 * orpheus-batch-render.js — headless render of text -> WAV through BookForge's REAL
 * AUDIOBOOK (batch) path: the one Owen actually ships with. Unlike the streaming
 * adapter (orpheus-render.js, one sentence per vLLM sequence), this drives
 * `renderRangeHeadless` in the compiled parallel-tts-bridge, which runs the genuine
 * pipeline — e2a prep packs the text into ~300-char generation chunks, a single
 * worker.py renders every chunk (WSL-safe for Orpheus, VRAM-tier sized), and the
 * shared machinery moves the WSL output onto a Windows-native path. It inherits every
 * guard unchanged (kill-ladder, memory tiers, safe GPU sizing, custom-model
 * resolution); this file adds only argument plumbing and the final FLAC concatenation.
 *
 * Before generation it calls the app's own narration door
 * (`prepareNarrationInput`) so the numbers in the input are read as words, exactly
 * as they are for a queued audiobook, and the caption/footnote cut runs. The
 * record beside the copy names every proposed edit and its disposition.
 *
 * THE INPUT IS A BOOK, A TEXT FILE, A JSONL OR A LITERAL (2026-09-12). It was
 * EPUB-only — Owen, 2026-09-05: "we will never use anything but epub for
 * renders" — and he OVERRODE that on 2026-09-12: *"it should also let me run
 * renders on anything, up to and including test chunks. it should allow me to
 * fully control what goes in and comes out."* So `.txt`/`.md` (paragraphs
 * separated by blank lines), `.jsonl` (one row per chunk) and `--text` are
 * accepted here.
 *
 * They are accepted by being PACKED INTO A REAL EPUB, with the app's own writer
 * (`dist/electron/epub-writer.js buildEpubBuffer`) — not by teaching the render
 * path a second input format. narrator's prep reads an EPUB and nothing else, and
 * that stays true: what changes is that this door will now build the one-chapter
 * book the text describes, content-addressed under
 * <tmpdir>/bookforge-cli-inputs/, and print its path so the run is reproducible.
 * Raw text STREAMED is still the streaming adapter's (orpheus-stream.js /
 * `--mode streaming`) — that is the Listen path, which takes blocks, not books.
 *
 * `--as-chunks` makes each paragraph/row exactly ONE generation chunk
 * (`settings.sentencePerParagraph`, narrator's `--sentence_per_paragraph`), which
 * is what makes this door a test-chunk harness: what you typed is what the worker
 * is asked for, one chunk per line.
 *
 * The inter-clip gap (default 0.6s) is already baked into each {i}.flac by orpheus.py
 * _save_audio, so concatenating them in numeric order is byte-faithful to what e2a's
 * assembly would join — no gap logic here.
 *
 * Run via the electron shim preload:
 *   node --require ./cli/electron-stub.js cli/orpheus-batch-render.js \
 *        --voice rohan --input book.epub --out sample.wav
 *
 * `--library <root>` names the library whose `tmp/` holds the sessions and the
 * narration cuts; omitted, it is the root this machine chose in BookForge
 * (`<userData>/library-root.json`, the file main persists for exactly this
 * "before the renderer exists" question). There is no default: see the block in
 * main() that refuses.
 *
 * No fallbacks: a missing arg, an unbuilt bridge, an incomplete sentence set, or a
 * failed concat all throw with a naming message.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { USER_DATA } = require('./electron-stub.js');
const { runNarrationPrep } = require('./narration-prep-step.js');
const { runNarrationTextStep } = require('./narration-text-step.js');
const { higgsOverrideFromArgs } = require('./higgs-override.js');
const { applyNarratorSessionsRoot, readPersistedLibraryRoot } = require('./narrator-sessions-root.js');

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

/** Formats this door will pack into a book. `.epub` is passed through untouched. */
const TEXT_INPUT_EXTS = new Set(['.txt', '.md', '.jsonl']);

/** Paragraphs out of a blank-line-separated text body (`.txt`, `.md`, `--text`). */
function paragraphsFromText(body) {
  return String(body)
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Paragraphs out of a `.jsonl` — ONE ROW PER CHUNK, which is the format a test
 * set already comes in (a rejects report, a retake list, a band sweep).
 *
 * A row is either a JSON string or an object carrying `text`. Anything else is
 * refused BY LINE NUMBER: guessing at which field held the words is how a sweep
 * ends up rendering the wrong column and nobody notices until the audio is heard.
 */
function paragraphsFromJsonl(body, label) {
  const out = [];
  const lines = String(body).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (e) {
      throw new Error(`${label}:${i + 1} is not JSON: ${e && e.message}`);
    }
    let text;
    if (typeof row === 'string') text = row;
    else if (row && typeof row === 'object' && !Array.isArray(row) && typeof row.text === 'string') text = row.text;
    else {
      throw new Error(
        `${label}:${i + 1}: a .jsonl row is a JSON string or an object with a 'text' string. `
        + `Got ${Array.isArray(row) ? 'an array' : JSON.stringify(row).slice(0, 80)} — naming the `
        + 'field is the caller\'s job, because guessing renders the wrong column silently.');
    }
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned) out.push(cleaned);
  }
  return out;
}

/**
 * Pack paragraphs into a one-chapter EPUB with the APP'S OWN WRITER and return
 * its path. Content-addressed under <tmpdir>/bookforge-cli-inputs/: the same text
 * is the same file, which is what lets the narration prep's own
 * content-addressed copy be reused across runs instead of re-minted every time.
 *
 * `modifiedAt` is therefore the UNIX EPOCH, not the clock: the path is a function
 * of the content, so the bytes have to be too, or every run would rewrite a
 * different book at the same path and nothing downstream could cache on it.
 */
async function packInputEpub(paragraphs, { title, sourceLabel }) {
  if (!paragraphs.length) {
    throw new Error(`no non-empty paragraphs in ${sourceLabel} — nothing to render`);
  }
  const { buildEpubBuffer } = require('../dist/electron/epub-writer.js');
  if (typeof buildEpubBuffer !== 'function') {
    throw new Error('epub-writer.buildEpubBuffer missing — rebuild BookForge '
      + '(npx tsc -p tsconfig.electron.json)');
  }
  const doc = {
    title,
    author: 'bookforge-tts',
    language: 'en',
    modifiedAt: new Date(0).toISOString(),
    // THE CHAPTER CARRIES NO TITLE, DELIBERATELY. `epub-writer` renders a
    // non-empty chapter title as an <h2>, and under `--as-chunks` that <h2> is
    // its own block — so the run would open by narrating the input's filename as
    // chunk 1. The book's title lives in the OPF metadata, where it belongs.
    chapters: [{ title: '', paragraphs }],
  };
  const sha = crypto.createHash('sha256')
    .update(JSON.stringify({ t: doc.title, p: paragraphs }))
    .digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), 'bookforge-cli-inputs');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${sha}.epub`);
  if (fs.existsSync(target)) {
    console.log(`[batch] input book (reused): ${target} — ${paragraphs.length} paragraph(s) from ${sourceLabel}`);
    return target;
  }
  fs.writeFileSync(target, await buildEpubBuffer(doc));
  console.log(`[batch] input book: ${target} — ${paragraphs.length} paragraph(s) from ${sourceLabel}`);
  return target;
}

/** Concatenate the per-sentence FLACs in numeric order into a single WAV via ffmpeg's
 *  concat demuxer (all clips are flac / 24 kHz / mono, so a stream concat is exact).
 *  This mirrors what e2a assembly does; the gaps are already in the files. */
function concatFlacsToWav(sentencesDir, outPath) {
  const entries = fs.readdirSync(sentencesDir)
    .map((f) => { const m = /^(\d+)\.flac$/.exec(f); return m ? { i: parseInt(m[1], 10), f } : null; })
    .filter(Boolean)
    .sort((x, y) => x.i - y.i);
  if (entries.length === 0) {
    throw new Error(`no {i}.flac files to concatenate in ${sentencesDir}`);
  }

  // concat demuxer list — absolute, forward-slashed, single-quoted per ffmpeg's syntax.
  // Apostrophes in the path (session dirs derive from book titles — "Aesop's Fables")
  // would terminate the quote; escape them the ffmpeg way: ' -> '\''.
  const listPath = path.join(os.tmpdir(), `bf-concat-${crypto.randomUUID()}.txt`);
  const lines = entries.map((e) => {
    const p = path.join(sentencesDir, e.f).replace(/\\/g, '/').replace(/'/g, "'\\''");
    return `file '${p}'`;
  });
  fs.writeFileSync(listPath, lines.join('\n') + '\n', 'utf8');

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  try {
    const r = spawnSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le',
      outPath,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.error) {
      if (r.error.code === 'ENOENT') throw new Error('ffmpeg not found on PATH (needed to concatenate the sentence FLACs)');
      throw r.error;
    }
    if (r.status !== 0) throw new Error(`ffmpeg concat exited ${r.status}`);
  } finally {
    try { fs.unlinkSync(listPath); } catch { /* temp list — best-effort cleanup */ }
  }
  return entries.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const voice = args.voice;
  if (!voice) throw new Error('--voice <id> is required (a voice in BookForge models.json)');
  if (!args.out) throw new Error('--out <file.wav> is required');

  // ── WHAT GOES IN (2026-09-12) ────────────────────────────────────────────
  //
  // An EPUB is read as it is. A `.txt`/`.md`/`.jsonl` or a `--text` literal is
  // PACKED into a one-chapter EPUB by the app's own writer first, so the render
  // path still reads exactly one format while the operator can hand it anything
  // "up to and including test chunks" (Owen, 2026-09-12). The book it packed is
  // printed, because a run nobody can point at is not a measurement.
  if (args.text && args.input) {
    throw new Error('--text and --input both name what to render; pass one');
  }
  const asChunks = Boolean(args['as-chunks']);
  let inputPath;
  if (args.text) {
    if (args.text === true) throw new Error('--text needs the passage to render');
    inputPath = await packInputEpub(paragraphsFromText(args.text), {
      title: args.title && args.title !== true ? args.title : 'CLI passage',
      sourceLabel: '--text',
    });
  } else {
    if (!args.input) throw new Error('--input <book.epub|passage.txt|chunks.jsonl> or --text is required');
    if (!fs.existsSync(args.input)) throw new Error(`input file not found: ${args.input}`);
    const ext = path.extname(args.input).toLowerCase();
    if (ext === '.epub') {
      // A BOOK IS PACKED BY THE APP'S PACKER, and that is the whole point of an
      // EPUB render: e2a prep decides the chunk boundaries. `--as-chunks` asks
      // for the opposite, so it is refused here rather than quietly ignored.
      if (asChunks) {
        throw new Error(
          '--as-chunks makes each paragraph ONE generation chunk; an EPUB is chunked by the '
          + "app's own packer, which is what an EPUB render measures. Use a .txt/.md/.jsonl "
          + 'input (or --text), or drop --as-chunks.');
      }
      inputPath = args.input;
    } else if (TEXT_INPUT_EXTS.has(ext)) {
      const body = fs.readFileSync(args.input, 'utf8');
      const paragraphs = ext === '.jsonl'
        ? paragraphsFromJsonl(body, path.basename(args.input))
        : paragraphsFromText(body);
      inputPath = await packInputEpub(paragraphs, {
        title: args.title && args.title !== true
          ? args.title
          : path.basename(args.input, path.extname(args.input)),
        sourceLabel: path.basename(args.input),
      });
    } else {
      throw new Error(
        `--input ${args.input}: this door reads .epub (a book), .txt/.md (paragraphs separated `
        + `by blank lines) or .jsonl (one chunk per row). '${ext || path.basename(args.input)}' `
        + 'is none of them.');
    }
  }

  const bridge = require('../dist/electron/parallel-tts-bridge.js');
  if (typeof bridge.renderRangeHeadless !== 'function') {
    throw new Error('parallel-tts-bridge.renderRangeHeadless missing — rebuild BookForge (npx tsc -p tsconfig.electron.json)');
  }

  // Real log sink (audiobook-logger) — uninitialized it spams "Failed to write to log
  // file: ENOENT open ''" on every logger call. CLI-specific dir so the app's
  // worker-output.log (truncated on init) is never clobbered.
  await bridge.initializeLogger(path.join(USER_DATA, 'cli'));

  // Mint the jobId HERE so Ctrl+C can drive the bridge's REAL wedge-safe teardown
  // (stopParallelConversion → TERM → verify → `wsl -t` ladder). Without this, killing
  // the CLI orphans the guest vLLM worker, which keeps burning GPU for hours.
  const jobId = `cli-${crypto.randomUUID()}`;
  let stopping = false;
  const stopAndExit = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[batch] ${sig} — stopping job ${jobId} (wedge-safe worker teardown)...`);
    bridge.stopParallelConversion(jobId)
      .then((stopped) => {
        console.log(stopped ? '[batch] worker stopped cleanly' : '[batch] no active session (already done)');
        process.exit(130);  // abort-path: SIGINT/SIGTERM teardown
      })
      .catch((e) => { console.error('[batch] teardown error:', e && e.message); process.exit(130); });  // abort-path: SIGINT/SIGTERM teardown
  };
  process.on('SIGINT', () => stopAndExit('SIGINT'));
  process.on('SIGTERM', () => stopAndExit('SIGTERM'));

  // ParallelTtsSettings. speed and enableTextSplitting are INERT for Orpheus, whose
  // sampling is fixed inside orpheus.py; they are present to satisfy the shape. The four
  // sampling fields that used to sit beside them (temperature/topP/topK/repetitionPenalty)
  // left the interface with XTTS on 2026-09-05 — the only code that read them was the
  // prep spawn's XTTS-gated flag block.
  // THE ENGINE COMES FROM THE CALLER. It was hardcoded 'orpheus', which is what
  // made the CLI the one door in the app that could not render a Higgs book —
  // against the standing rule that the CLI mirrors the app's code path. Nothing
  // else here changes: `renderRangeHeadless` routes Higgs to narrator inside the
  // bridge, exactly as the app's narration modal does, so the CLI gets the
  // prep/worker/assembly split for free rather than reimplementing it.
  const engine = args.engine || 'orpheus';
  const settings = {
    device: 'auto',
    language: args.language || 'en',
    ttsEngine: engine,
    fineTuned: voice,
    speed: 1.0,
    enableTextSplitting: false,
  };
  // Explicit model directory (CLI --model-dir): bypasses models.json resolution. Must be
  // in the spawn target's namespace (a /home/... WSL path, or a \\wsl$ / C:\ path that
  // buildWslBashCommand will translate).
  if (args['model-dir']) {
    // TWO ENGINES, TWO SPELLINGS, AND NEITHER STANDS IN FOR THE OTHER. An
    // Orpheus model dir is the weights the worker loads; a Higgs checkpoint
    // under test borrows a CATALOG voice's certificate (caps, pace, band) and
    // rides `higgsOverride.checkpointDir`. Name the right flag.
    if (engine !== 'orpheus') {
      throw new Error('--model-dir names an Orpheus model directory; a Higgs checkpoint under '
        + 'test is named by --checkpoint-dir (it borrows --voice\'s certificate).');
    }
    settings.orpheusModelDir = args['model-dir'];
  }
  // ── THE CHECKPOINT / SAMPLING / BAND OVERRIDE ────────────────────────────
  //
  // One JSON object, composed by the python wrapper and parsed by the one shared
  // parser both render adapters use (cli/higgs-override.js). The bridge resolves
  // the base `fineTuned` voice from the catalog and renders the override against
  // it, so a merged checkpoint inherits the named voice's caps/pace/band — which
  // is exactly what makes a checkpoint comparable to the voice it came from.
  const higgsOverride = higgsOverrideFromArgs(args, engine);
  if (higgsOverride) {
    settings.higgsOverride = higgsOverride;
    console.log(`[batch] higgs override: ${JSON.stringify(higgsOverride)}`);
  }
  // ── ONE CHUNK PER PARAGRAPH ──────────────────────────────────────────────
  //
  // narrator's `--sentence_per_paragraph`: what you typed is what the worker is
  // asked for, one chunk per line. Without it the prep repacks the lines to the
  // voice's char cap and a test set of 40 chunks renders as 9.
  if (asChunks) settings.sentencePerParagraph = true;
  // ── A CAPPED RUN ─────────────────────────────────────────────────────────
  //
  // The same `testMode`/`testSentences` pair the app's own settings carry, so the
  // cap is applied by the bridge rather than by this adapter slicing the input.
  if (args['max-chunks'] !== undefined) {
    const n = Number(args['max-chunks']);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--max-chunks needs a positive integer (got ${JSON.stringify(args['max-chunks'])})`);
    }
    settings.testMode = true;
    settings.testSentences = n;
    console.log(`[batch] --max-chunks ${n}: the bridge caps generation at ${n} chunk(s)`);
  }

  // UNLESS THE OPERATOR SAID NOT TO. `--skip-text-cleanup` is the app's "No,
  // narrate as printed" button; `--as-chunks` implies it, because a test chunk
  // that came back rewritten is not the chunk that was under test. Both take the
  // SAME road the audiobook adapter takes: the pass is not run AND the door is
  // told (`textCleanup: 'skipped'`), so the log names the skip instead of
  // guessing at an absent stamp.
  const textCleanup = (asChunks || args['skip-text-cleanup']) ? 'skipped' : 'required';

  // ── WHERE THE SESSIONS GO, STATED THE WAY THE APP STATES IT ──────────────
  //
  // narrator has NO default sessions root: `setNarratorScratchRoot` decides
  // `NARRATOR_SESSIONS_ROOT`, every spawn carries a `--session_dir` derived from
  // it, and an unstated root fails the render before prep with "No narrator
  // scratch root has been stated." This adapter never stated one — it has no
  // project to derive a library from — so EVERY `--tts` run died there. The
  // audiobook adapter has stated it since the narrator cut-over (from
  // `path.dirname(path.dirname(projectDir))`); this is the same call with the
  // library resolved the way `electron/main.ts applyNarratorScratchRoot` resolves
  // it at startup: the Settings override wins inside
  // `applyNarratorSessionsRoot`, else `<library>/tmp`.
  //
  // THE LIBRARY IS THE ONE MAIN RECORDED, and if there isn't one this refuses.
  // `getLibraryRoot()` ends at `~/Documents/BookForge` and may: the app has a
  // Settings page where that is visible. A headless render taking that default
  // would put the session — and the content-addressed narration cut beside it —
  // somewhere the app never looks, and the only symptom would be work that
  // cannot be found later.
  const libraryRoot = args.library && args.library !== true
    ? path.resolve(args.library)
    : readPersistedLibraryRoot();
  if (!libraryRoot) {
    throw new Error(
      'no library root: this machine has never chosen a library in BookForge '
      + `(${path.join(USER_DATA, 'library-root.json')} is absent) — pass --library <root>`);
  }
  console.log(`[batch] scratch: ${applyNarratorSessionsRoot(libraryRoot)}`);

  // ── --dry-run: THE BOOK IS PACKED, AND NOTHING IS GENERATED ──────────────
  //
  // A dry run that only echoed the argv could not answer the question a text
  // input actually raises — what book did it build, and how many chunks is that?
  // So the packing above has already happened (it is CPU and a few kB) and its
  // path was printed; this stops before the narration door and the bridge, which
  // are the two steps that load a model or take the card.
  if (args['dry-run']) {
    console.log('[batch] DRY RUN — no model loaded, no GPU touched, nothing generated');
    console.log(`[batch]   would render: ${inputPath}`);
    console.log(`[batch]   text cleanup: ${textCleanup}`);
    console.log(`[batch]   settings: ${JSON.stringify(settings)}`);
    process.exitCode = 0;
    return;
  }

  const t0 = Date.now();

  // The narration door FIRST — the app's own `prepareNarrationInput`. A voice
  // audition that says "twenty three slash three slash nineteen thirty three"
  // where the shipped audiobook says "March twenty-third" is measuring a
  // different pipeline than it claims to: e2a reads text exactly as printed
  // (its own number transform was permanently disabled, 2026-09-02), so the
  // words the voice gets are decided here or nowhere.
  // ── The NARRATION TEXT CLEANUP first, and automatically ──────────────────
  //
  // This chain is unattended and nobody is here to be asked whether to clean,
  // so it runs the pass itself and renders the book it produced — which is what
  // makes an audition measure the shipped pipeline. A book that already carries
  // a current stamp costs one hash and no model call.
  //
  if (textCleanup === 'skipped') {
    console.log(`[batch] text cleanup SKIPPED (${asChunks ? '--as-chunks' : '--skip-text-cleanup'})`
      + ' — the words are narrated exactly as given');
  }
  const toRender = textCleanup === 'skipped'
    ? inputPath
    : (await runNarrationTextStep(inputPath, {})).inputPath;

  const prepared = await runNarrationPrep(
    bridge, toRender, jobId, { skipAssembly: true, textCleanup });

  console.log(`[batch] renderRangeHeadless — prep packs chunks, VRAM-tier sizing, WSL-safe worker...`);
  const { sentencesDir, totalSentences, scratchSessionDir, normalizedSessionDir } =
    await bridge.renderRangeHeadless(prepared.inputPath, settings, { jobId });
  console.log(`[batch] generation complete: ${totalSentences} chunks in ${sentencesDir}`);

  const n = concatFlacsToWav(sentencesDir, args.out);
  console.log(`[batch] concatenated ${n} FLAC(s) -> ${args.out}`);

  // --keep-sentences: copy the per-sentence FLACs beside the output for inspection.
  if (args['keep-sentences']) {
    const keepDir = path.resolve(args.out) + '.sentences';
    fs.mkdirSync(keepDir, { recursive: true });
    for (const f of fs.readdirSync(sentencesDir)) {
      if (/^\d+\.flac$/.test(f)) fs.copyFileSync(path.join(sentencesDir, f), path.join(keepDir, f));
    }
    console.log(`[batch] kept ${n} sentence FLAC(s) -> ${keepDir}`);
  }

  // Scratch cleanup (default ON; --keep-session disables). Every run otherwise leaves a
  // full session in TWO places — the WSL ext4 original (feeds the vhdx ballooning) and
  // the normalized Windows copy. Only after a successful concat; 'ebook-' name guard so
  // a surprising path can never make this destructive.
  if (!args['keep-session']) {
    const rmDirs = new Set([scratchSessionDir, normalizedSessionDir].filter(Boolean));
    for (const d of rmDirs) {
      if (!/ebook-[0-9a-f-]+\/?$/i.test(d.replace(/\\/g, '/'))) {
        console.warn(`[batch] NOT deleting unexpected session path (no ebook-<uuid> tail): ${d}`);
        continue;
      }
      try {
        if (d.startsWith('/')) {
          // WSL-native path — remove inside the guest.
          spawnSync('wsl.exe', ['-e', 'rm', '-rf', d], { stdio: 'ignore' });
        } else {
          fs.rmSync(d, { recursive: true, force: true });
        }
        console.log(`[batch] cleaned scratch session ${d}`);
      } catch (e) {
        console.warn(`[batch] scratch cleanup failed for ${d}: ${e && e.message}`);
      }
    }
  }
  console.log(`[batch] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[batch] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
