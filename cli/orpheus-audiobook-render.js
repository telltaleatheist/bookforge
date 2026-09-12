/**
 * orpheus-audiobook-render.js — headless, APP-FAITHFUL audiobook build. Chains the
 * EXACT high-level calls the app's queue makes for a standard audiobook:
 *
 *   0. prepareNarrationInput() (parallel-tts-bridge) — the narration door: the
 *      caption/footnote cut and the number pass, content-addressed, exactly as
 *      startParallelConversion runs them. What it returns is what generation reads.
 *   1. renderRangeHeadless()  (parallel-tts-bridge) — the tts-conversion core: real
 *      e2a prep + batch worker.py, producing a complete e2a session (sentence FLACs
 *      + session state with chapter mapping). Identical to a UI TTS job.
 *   1b. runFinalDenoise()     (denoise-job)         — the final-denoise job, when the
 *      denoise is on: gap-normalize then roformer, into the session's durable
 *      chapters/sentences-denoised/. Its own step in the app since 2026-08-29, so it
 *      is its own call here: assembly refuses the old `finalDenoise` flag by name.
 *   2. startReassembly()      (reassembly-bridge)   — the reassembly job: e2a
 *      --assemble_only over that session -> <project>/output/audiobook.m4b (+ .vtt)
 *      with chapters, cover, and metadata.
 *
 * Unlike orpheus-batch-render.js — which stops after generation and flat-concats the
 * FLACs into a bare WAV (handy for a quick voice test, but NOT what the app ships) —
 * this reproduces the full pipeline end to end, so it is a faithful headless test of
 * the real audiobook path. No pipeline logic is reimplemented here: this file only
 * resolves the project's input EPUB + metadata, initializes the library context, and
 * wires the two real calls together.
 *
 * Run via the electron shim preload:
 *   node --require ./cli/electron-stub.js cli/orpheus-audiobook-render.js \
 *        --project "/path/to/projects/<slug>" --voice deathstalker
 *
 * Optional assembly passes (all default OFF except denoise, mirroring the app toggles):
 *   --no-final-denoise   skip the roformer denoise pass (default ON for this adapter)
 *   --de-ring            apply the voice's post-render notch/comb (SNAC ringing); opt-in
 *   --sentence-gap <s>   normalize the inter-sentence gap to <s> seconds at assembly
 *                        (strips e2a's artificial trailing exact-zero pad, then re-adds
 *                        <s>s of silence). Omit to use the voice's models.json default.
 *   --chapter-gap <s>    seconds of silence to leave BETWEEN chapters (never after the
 *                        last one). Omit for BookForge's default of 3s; pass 0 for the
 *                        butt-joined book this pipeline made until 2026-09-09.
 *
 * Assembling a DERIVED set as a SECOND audiobook (--assemble-only only):
 *   --sentences-dir <d>  assemble THIS set instead of the session's own cache — the
 *                        durable output of an enhancement pass, e.g.
 *                        `<session>/chapters/sentences-rvc-<voice>/`. Nothing is
 *                        derived here: the set already exists and is assembled as it
 *                        is, so --final-denoise is refused alongside it.
 *   --as-new-version     file the result BESIDE the project's audiobook instead of
 *                        replacing it — a manifest variant, under a filename carrying
 *                        the voice. This is what the app does for a run that converted
 *                        sentences it did not itself render.
 *   --version-voice <id> the RVC voice that second version is NAMED after. Derived from
 *                        a `sentences-rvc-<voice>` directory name; required when the
 *                        set is named anything else.
 *   --skip-text-cleanup  do NOT run the narration text cleanup, and tell the render
 *                        door so: the book is read exactly as printed, digits and all.
 *                        The app's own "No, narrate as printed" button, headless.
 *
 * Output lands in its canonical project location (<project>/output/audiobook.m4b),
 * exactly like the app — there is no --out.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { USER_DATA } = require('./electron-stub.js');
const { resolveInputEpub } = require('./resolve-project-epub.js');
const { runNarrationPrep } = require('./narration-prep-step.js');
const { runNarrationTextStep } = require('./narration-text-step.js');
const { applyNarratorSessionsRoot } = require('./narrator-sessions-root.js');
const { higgsOverrideFromArgs } = require('./higgs-override.js');

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

/** Keep only `keepName` under stages/03-tts/sessions/<language>/ so cached sessions
 *  don't accumulate across resume runs (each run caches a fresh ebook-<uuid>). */
function pruneOldSessions(projectDir, language, keepName) {
  const dir = path.join(projectDir, 'stages', '03-tts', 'sessions', language);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name.startsWith('ebook-') && name !== keepName) {
      try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const voice = args.voice;
  // THE VOICE IS A RENDER CHOICE. --assemble-only reads the cached sentences the
  // render already made and resolves the engine from the session itself
  // (reassembly-bridge.narratorEngineForSession); the wrapper refuses --voice on
  // that door by name. Demanding it here anyway (as this adapter did until
  // 2026-09-05) made the two doors contradict each other and left every
  // headless assembly of a Higgs book unrunnable: "--voice is required" without
  // it, "drop --voice" with it.
  if (!args['assemble-only'] && !voice) {
    throw new Error('--voice <id> is required (a voice in BookForge models.json)');
  }
  if (args['assemble-only'] && voice) {
    throw new Error('--assemble-only reads the cached sentences; the voice was decided when they were rendered. Drop --voice.');
  }
  // THE ENGINE IS A RENDER CHOICE, and this adapter used to hard-code
  // `ttsEngine: 'orpheus'` — a Higgs project had no headless render door.
  // Required on the render branch (no default: a missing flag rendering as
  // Orpheus would be a silent substitution), refused on --assemble-only, where
  // reassembly-bridge resolves the engine from the session it assembles.
  const engine = args.engine;
  if (!args['assemble-only']) {
    if (engine !== 'orpheus' && engine !== 'higgs') {
      throw new Error(`--engine <orpheus|higgs> is required for a render (got ${engine === undefined ? 'nothing' : JSON.stringify(engine)})`);
    }
  } else if (engine !== undefined) {
    throw new Error('--assemble-only reads the cached sentences; the engine was decided when they were rendered. Drop --engine.');
  }
  if (!args.project) throw new Error('--project <projectDir> is required');

  const projectDir = path.resolve(args.project);
  if (!fs.existsSync(path.join(projectDir, 'manifest.json'))) {
    throw new Error(`not a BookForge project (no manifest.json): ${projectDir}`);
  }

  // ── ASSEMBLING A DERIVED SET, AND FILING IT AS A SECOND AUDIOBOOK ────────
  //
  // An enhancement pass writes a DURABLE set inside the session
  // (`chapters/sentences-rvc-<voice>`, `chapters/sentences-denoised`) and the
  // app assembles it through `startReassembly`'s `sentencesDir` — the same field
  // this passes. Until 2026-09-10 the CLI could RUN the conversion
  // (`--rvc-enhance`) and then had no way to assemble what it produced, so a
  // headless enhancement ended at a directory of FLACs.
  //
  // `--as-new-version` is the other half: the app files a conversion of
  // sentences it did not render as a manifest VARIANT rather than over the
  // project's one audiobook, because overwriting it would destroy the original
  // to produce its alternative. Same flags, same helper
  // (`audiobook-variant-filing.resolveRvcVariantFiling`), same result.
  const suppliedSentencesDir = args['sentences-dir'] && args['sentences-dir'] !== true
    ? path.resolve(args['sentences-dir'])
    : null;
  if (suppliedSentencesDir) {
    if (!args['assemble-only']) {
      throw new Error('--sentences-dir names a set that already exists; a render makes its own. Use --assemble-only.');
    }
    if (!fs.existsSync(suppliedSentencesDir)) {
      throw new Error(`--sentences-dir not found: ${suppliedSentencesDir}`);
    }
    if (args['final-denoise']) {
      throw new Error(
        '--final-denoise derives a new set from the session\'s raw cache; --sentences-dir '
        + 'names the set to assemble. Denoise it first (--denoise --sentences-dir ...) and '
        + 'assemble THAT directory.');
    }
  }
  const asNewVersion = !!args['as-new-version'];
  if (asNewVersion && !args['assemble-only']) {
    throw new Error('--as-new-version files a SECOND audiobook beside the project\'s; a render makes the project\'s own. Use --assemble-only.');
  }
  if (args['version-voice'] && !asNewVersion) {
    throw new Error('--version-voice names the voice a second version is called after; it means nothing without --as-new-version.');
  }
  // WHICH VOICE NAMES IT. A `sentences-rvc-<voiceId>` directory was named by the
  // conversion that wrote it, so the id is already on disk and asking for it
  // again is asking the operator to repeat what the path says. Anything else -
  // a denoised set, a hand-assembled directory - has no voice in its name and
  // must say.
  let versionVoiceId = args['version-voice'] && args['version-voice'] !== true
    ? String(args['version-voice'])
    : undefined;
  if (asNewVersion && !versionVoiceId) {
    const fromName = suppliedSentencesDir
      ? /^sentences-rvc-(.+?)(?:-denoised)?$/.exec(path.basename(suppliedSentencesDir))
      : null;
    if (!fromName) {
      throw new Error(
        '--as-new-version needs --version-voice <id>: the voice is what tells two versions of '
        + 'a book apart, and it could not be read off the set\'s directory name (only a '
        + '`sentences-rvc-<voice>` directory carries it).');
    }
    versionVoiceId = fromName[1];
    console.log(`[audiobook] --as-new-version: voice "${versionVoiceId}", read off the set's directory name`);
  }

  // Library root = {library}/projects/{slug} -> two levels up. Reassembly resolves the
  // cover + metadata from the manifest relative to this, exactly like the app does.
  const libraryRoot = path.dirname(path.dirname(projectDir));
  const manifestSvc = require('../dist/electron/manifest-service.js');
  manifestSvc.setLibraryBasePath(libraryRoot);
  // The same scratch the app would use for this library, so the narration copy
  // a `--prep` wrote (or the app's own run wrote) is found and reused here.
  console.log(`[audiobook] scratch: ${applyNarratorSessionsRoot(libraryRoot)}`);

  // Input EPUB: explicit --input override, else the project's RECORDED book
  // through the app's own door (manifest-service.bookForAct — see
  // resolve-project-epub.js). Only needed for TTS (STEP 1); --assemble-only
  // runs the existing cache and needs none.
  const inputPath = args.input
    ? path.resolve(args.input)
    : (args['assemble-only'] ? null : await resolveInputEpub(projectDir));
  if (!args['assemble-only']) {
    if (!fs.existsSync(inputPath)) throw new Error(`input EPUB not found: ${inputPath}`);
  }

  // Project metadata for the reassembly config (title/author/cover/etc.). Reassembly
  // also resolves the cover from the manifest itself; passing it here matches the app
  // (config.metadata.coverPath is primary, manifest is the fallback).
  const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'manifest.json'), 'utf8'));
  const md = manifest.metadata || {};
  const absCover = md.coverPath ? path.join(libraryRoot, md.coverPath) : undefined;

  const bridge = require('../dist/electron/parallel-tts-bridge.js');
  const reassembly = require('../dist/electron/reassembly-bridge.js');
  const denoiseJob = require('../dist/electron/denoise-job.js');
  for (const [obj, fn] of [[bridge, 'renderRangeHeadless'], [bridge, 'scanProjectSessions'],
                           [bridge, 'cacheSessionToProject'], [reassembly, 'startReassembly'],
                           [denoiseJob, 'runFinalDenoise']]) {
    if (typeof obj[fn] !== 'function') {
      throw new Error(`compiled bridge missing ${fn} — rebuild (npx tsc -p tsconfig.electron.json)`);
    }
  }

  const language = args.language || 'en';

  // Final-audio denoise — its OWN step now (denoise-job), run between generation
  // and assembly exactly as the app's chain runs it: gap-normalize the raw cached
  // sentences, then the block-based roformer, into the session's durable
  // chapters/sentences-denoised/, which assembly then reads via --sentences_dir.
  // Default ON: this adapter is Orpheus-only, and Orpheus voices are trained on a
  // deliberate faint hiss bed the render reproduces — the denoise pass strips it
  // once, over the sentence set. --no-final-denoise disables it entirely
  // (--final-denoise is an explicit ON, same as the default here).
  if (args['final-denoise'] && args['no-final-denoise']) {
    throw new Error('--final-denoise and --no-final-denoise are mutually exclusive');
  }
  // A SUPPLIED SET IS ALREADY FINAL. `--sentences-dir` names the audio to
  // assemble; deriving a denoise off the session's raw cache and then assembling
  // a different directory would spend the roformer on audio nobody hears. The
  // combination with an explicit --final-denoise was refused by name above.
  const finalDenoise = !args['no-final-denoise'] && !suppliedSentencesDir;

  // De-ring (OPT-IN, default OFF — same as the app's assemble step): apply the voice's
  // per-voice post-render filter chain (the notch/comb that strips SNAC tonal ringing)
  // at e2a's final encode. startReassembly resolves the chain from session provenance
  // ONLY when config.applyDeRing is set; --de-ring turns it on. Shares the SAME handler
  // the app uses, so behaviour is identical.
  const applyDeRing = !!args['de-ring'];

  // Sentence-gap normalization: when --sentence-gap <seconds> is given, the gap pass
  // strips e2a's artificial trailing exact-zero pad from each raw cached sentence and
  // re-applies exactly this much silence. It runs wherever the pass in front of assembly
  // runs — inside the denoise step when denoising, inside startReassembly when not —
  // and it must precede the roformer, which turns those exact zeros into near-zeros that
  // no longer trim. Absent → left undefined so the voice's models.json default
  // (resolveOrpheusSentenceGap) applies; if the voice declares none either, the gap step
  // is skipped (NO invented default).
  let sentenceGap;
  if (args['sentence-gap'] !== undefined && args['sentence-gap'] !== true) {
    sentenceGap = parseFloat(args['sentence-gap']);
    if (!Number.isFinite(sentenceGap) || sentenceGap < 0) {
      throw new Error(`--sentence-gap must be a non-negative number, got: ${args['sentence-gap']}`);
    }
  }

  // The silence between chapters. Absent is NOT zero: it is left undefined so the
  // reassembly bridge applies BookForge's default, which is the same answer the app's
  // own dialog opens at — this door and that one must make the same book.
  let chapterGap;
  if (args['chapter-gap'] !== undefined && args['chapter-gap'] !== true) {
    chapterGap = parseFloat(args['chapter-gap']);
    if (!Number.isFinite(chapterGap) || chapterGap < 0) {
      throw new Error(`--chapter-gap must be a non-negative number, got: ${args['chapter-gap']}`);
    }
  }

  // Resume: find a cached session for this project/language (unless --fresh). The render
  // seeds those already-done FLACs and generates only what's missing.
  let resumeFromSentencesDir;
  if (!args.fresh) {
    try {
      const sessions = await bridge.scanProjectSessions(projectDir);
      const cand = sessions
        .filter((s) => s.language === language && s.sentenceCount > 0)
        .sort((a, b) => b.sentenceCount - a.sentenceCount)[0];
      if (cand) {
        resumeFromSentencesDir = cand.sentencesDir;
        console.log(`[audiobook] resume: ${cand.sentenceCount} cached sentence(s) found — will skip those`);
      }
    } catch (e) { console.warn(`[audiobook] resume scan failed (continuing fresh): ${e && e.message}`); }
  } else {
    console.log('[audiobook] --fresh: ignoring any cached session');
  }

  // Real log sink (else logger calls spam ENOENT). CLI-specific dir so the app's own
  // worker-output.log is never clobbered.
  await bridge.initializeLogger(path.join(USER_DATA, 'cli'));

  // Mint the jobId HERE so Ctrl+C drives the bridge's REAL wedge-safe teardown
  // (stopParallelConversion -> TERM -> verify -> kill ladder) instead of orphaning a
  // worker that keeps burning GPU.
  const jobId = `cli-${crypto.randomUUID()}`;
  let liveSessionDir = null;   // set once the session is on disk (for interrupt-time caching)
  let stopping = false;
  const stopAndExit = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[audiobook] ${sig} — stopping job ${jobId} (wedge-safe worker teardown)...`);
    bridge.stopParallelConversion(jobId)
      .then(async (stopped) => {
        console.log(stopped ? '[audiobook] worker stopped cleanly' : '[audiobook] no active session');
        // Persist whatever rendered so a re-run resumes from it (the scratch session has
        // the partial FLACs; cache them into the project before we exit).
        if (liveSessionDir) {
          try {
            await bridge.cacheSessionToProject(liveSessionDir, projectDir, language);
            console.log('[audiobook] cached partial progress — a re-run will resume from here');
          } catch (e) { console.warn('[audiobook] partial cache failed:', e && e.message); }
        }
        process.exit(130);  // abort-path: SIGINT/SIGTERM teardown
      })
      .catch((e) => { console.error('[audiobook] teardown error:', e && e.message); process.exit(130); });  // abort-path: SIGINT/SIGTERM teardown
  };
  process.on('SIGINT', () => stopAndExit('SIGINT'));
  process.on('SIGTERM', () => stopAndExit('SIGTERM'));

  // ParallelTtsSettings. speed and enableTextSplitting are INERT for Orpheus (its sampling
  // is fixed in orpheus.py; they are here to satisfy the shape). The four sampling fields
  // that used to sit beside them left the interface with XTTS on 2026-09-05. Env seams
  // (ORPHEUS_MEMORY_TIER, etc.) are read by the pipeline.
  const settings = {
    device: 'auto',
    language: args.language || 'en',
    ttsEngine: engine,
    // Orpheus: the prompt token. Higgs: the catalog voice id — the same field
    // the app's queue fills from the modal (narration-run.ts `fineTuned`).
    fineTuned: voice,
    speed: 1.0,
    enableTextSplitting: false,
  };
  if (args['model-dir']) {
    // TWO ENGINES, TWO SPELLINGS, AND NEITHER STANDS IN FOR THE OTHER. The old
    // message here ("a Higgs voice is a catalog checkpoint") said what --model-dir
    // is NOT and left the operator with nowhere to go; since 2026-09-12 there IS
    // somewhere — a Higgs checkpoint under test rides --checkpoint-dir and borrows
    // the named voice's certificate (caps, pace, band).
    if (engine !== 'orpheus') {
      throw new Error('--model-dir names an Orpheus model directory; a Higgs checkpoint under '
        + 'test is named by --checkpoint-dir (it borrows --voice\'s certificate).');
    }
    settings.orpheusModelDir = args['model-dir'];
  }
  // ── THE CHECKPOINT / SAMPLING / BAND OVERRIDE (2026-09-12) ───────────────
  //
  // The SAME shared parser the batch adapter uses (cli/higgs-override.js), so a
  // `--tts` audition and an `--audiobook` build of one checkpoint are the same
  // render. The bridge resolves the base `fineTuned` voice from the catalog and
  // renders the override against its certificate.
  const higgsOverride = higgsOverrideFromArgs(args, engine);
  if (higgsOverride) {
    settings.higgsOverride = higgsOverride;
    console.log(`[audiobook] higgs override: ${JSON.stringify(higgsOverride)}`);
  }

  const t0 = Date.now();

  let sessionDirPath, scratchSessionDir, normalizedSessionDir;
  if (args['assemble-only']) {
    // ── ASSEMBLE-ONLY: run the EXISTING sentence cache through denoise + reassembly,
    //    no TTS. This mirrors the app's "Assemble from cache" (Studio → Versions →
    //    Assemble), which also skips generation and calls startReassembly on the cached
    //    session — the SAME startReassembly + config path. Purpose: a faithful headless
    //    repro of the denoise/reassembly step so a bug there surfaces from the CLI. ──
    const sessions = await bridge.scanProjectSessions(projectDir);
    const cand = sessions
      .filter((s) => s.language === language && s.sentenceCount > 0)
      .sort((a, b) => b.sentenceCount - a.sentenceCount)[0];
    if (!cand) {
      throw new Error(`--assemble-only: no cached session with sentences (language '${language}') in ${projectDir}`);
    }
    sessionDirPath = cand.sessionDir;
    console.log(`[audiobook] --assemble-only: ${cand.sentenceCount} cached sentences in ${path.basename(sessionDirPath)} — SKIPPING TTS, running denoise + reassembly on the cache`);
  } else {
    // ── STEP 0/2: the narration door — captions and notes out, numbers as words ──
    // The SAME `prepareNarrationInput` the app's queue calls, so this chain preps
    // the book exactly as a queued job does and a defect in the door shows up
    // here. Its output is what generation reads; the project's own EPUB is never
    // rewritten.
    // ── STEP 0a: the NARRATION TEXT CLEANUP, run automatically ──────────────
    //
    // The persisted text pass — punctuation, then the number rules, then the
    // model on the residue — writes a cleaned, STAMPED book beside the input. An
    // unattended chain has nobody to ask, so it runs the pass itself rather than
    // narrating raw digits; a book already carrying a current stamp costs one
    // hash and no model call.
    //
    // `--skip-text-cleanup` is the operator saying what the app's "No, narrate
    // as printed" button says: don't run the pass, and tell the door, so the
    // render's log names the skip instead of guessing at an absent stamp.
    const textCleanup = args['skip-text-cleanup'] ? 'skipped' : 'required';
    const toRender = textCleanup === 'skipped'
      ? inputPath
      : (await runNarrationTextStep(inputPath, {})).inputPath;
    if (textCleanup === 'skipped') {
      console.log('[audiobook] --skip-text-cleanup: the book is read exactly as printed');
    }

    const prepared = await runNarrationPrep(
      bridge, toRender, jobId, { skipAssembly: false, textCleanup });

    // ── STEP 1/2: TTS — the tts-conversion core (real prep + batch worker) ──
    console.log(`[audiobook] STEP 1/2 renderRangeHeadless — e2a prep + batch worker on ${path.basename(prepared.inputPath)}`);
    let totalSentences;
    ({ totalSentences, scratchSessionDir, normalizedSessionDir } =
      await bridge.renderRangeHeadless(prepared.inputPath, settings, {
        jobId,
        resumeFromSentencesDir,
        onSessionReady: (info) => { liveSessionDir = info.sessionDir; },
      }));
    sessionDirPath = normalizedSessionDir || scratchSessionDir;
    console.log(`[audiobook] generation complete: ${totalSentences} sentences (session ${path.basename(sessionDirPath)})`);

    // Persist the rendered sentences to the project cache (stages/03-tts/sessions/) so a
    // re-run resumes here; prune older cached sessions for this language to avoid buildup.
    try {
      await bridge.cacheSessionToProject(scratchSessionDir, projectDir, language);
      pruneOldSessions(projectDir, language, path.basename(scratchSessionDir));
      console.log('[audiobook] cached TTS session to project (resume-ready)');
    } catch (e) { console.warn(`[audiobook] session cache failed: ${e && e.message}`); }
  }

  // ── STEP 2/2: Assembly — the reassembly job (e2a --assemble_only) ──
  const sessionId = path.basename(sessionDirPath).replace(/^ebook-/, '');
  const e2aTmpPath = path.dirname(sessionDirPath);
  const session = await reassembly.getSession(sessionId, e2aTmpPath);
  if (!session) throw new Error(`could not load e2a session '${sessionId}' from ${e2aTmpPath}`);

  const outputDir = path.join(projectDir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  // ── STEP 1b: the denoise, as its own call (mirrors the app's own step) ──
  // The set it writes is DURABLE — it lives in the session as
  // chapters/sentences-denoised/ with a manifest, so a second --assemble-only run
  // over the same cache reuses it and costs minutes instead of an hour. Assembly
  // reads it and LEAVES it (no disposeSentencesDir), which is what makes that true.
  //
  // It is derived against THE SESSION BEING ASSEMBLED, which on --assemble-only is
  // the project cache (durable, reused by every later run) and on a fresh render is
  // the scratch session this run then deletes. That is correct rather than
  // convenient: deriving against a different copy of the sentences than the one
  // being assembled is exactly the class of mismatch the manifest exists to catch.
  // The app's chain lands in the cache for the same reason — its TTS step publishes
  // no processDir, so the denoise step resolves the project's cached session itself.
  let denoisedSentencesDir;
  if (finalDenoise) {
    console.log('[audiobook] STEP 1b/2 runFinalDenoise — gap-normalize + roformer over the cached sentences');
    const dn = await denoiseJob.runFinalDenoise(`${jobId}-denoise`, {
      processDir: session.processDir,
      ...(sentenceGap !== undefined ? { sentenceGap } : {}),
    }, null);
    if (!dn || !dn.success || !dn.outputDir) {
      throw new Error(`final denoise failed: ${dn && dn.error ? dn.error : 'unknown'}`);
    }
    denoisedSentencesDir = dn.outputDir;
    console.log(dn.reused
      ? `[audiobook] denoised sentences REUSED (already derived for this session): ${denoisedSentencesDir}`
      : `[audiobook] denoised sentences written: ${denoisedSentencesDir}`);
  }

  const config = {
    sessionId,
    sessionDir: session.sessionDir,
    processDir: session.processDir,
    outputDir,
    e2aTmpPath,
    totalChapters: (session.chapters || []).filter((c) => !c.excluded).length || undefined,
    metadata: {
      title: md.title || session.metadata?.title || path.basename(projectDir),
      author: md.author || session.metadata?.author || '',
      year: md.year,
      narrator: md.narrator,
      series: md.series,
      seriesNumber: md.seriesNumber,
      genre: md.genre,
      description: md.description,
      coverPath: absCover,
      outputFilename: md.outputFilename,
    },
    excludedChapters: [],
    applyDeRing,
    // The denoised set, when one was derived above — assembled via --sentences_dir
    // and KEPT (it is the session's, not this run's). Assembly runs no gap pass on a
    // supplied set, because the gap is already baked into it; so the gap only travels
    // to assembly on the no-denoise path, where assembly is the pass that applies it.
    // undefined → the voice's models.json sentenceGap default applies (or no gap step)
    // A SET SUPPLIED BY THE CALLER WINS. `--sentences-dir` names the audio to
    // assemble outright; the denoise below it cannot have run (it is gated on the
    // same flag), so these two are alternatives and never both.
    ...(suppliedSentencesDir
      ? { sentencesDir: suppliedSentencesDir }
      : denoisedSentencesDir
        ? { sentencesDir: denoisedSentencesDir }
        : (sentenceGap !== undefined ? { sentenceGap } : {})),
    // Unlike the sentence gap, this never rides on an upstream pass — no
    // enhancement touches a chapter boundary — so it goes straight to assembly,
    // and absence hands the question to the bridge's default rather than to zero.
    ...(chapterGap !== undefined ? { chapterGap } : {}),
    // BESIDE the project's audiobook rather than over it. The bridge names the
    // file after the voice, spares the audiobooks already in output/, and records
    // a manifest variant instead of overwriting `outputs.audiobook`.
    ...(asNewVersion
      ? { registerAsNewVariant: true, rvcVoiceId: versionVoiceId }
      : {}),
  };

  console.log(`[audiobook] STEP 2/2 startReassembly — e2a --assemble_only -> ${path.join(outputDir, 'audiobook.m4b')}`);
  const result = await reassembly.startReassembly(jobId, config, null);
  if (!result || !result.success) {
    throw new Error(`reassembly failed: ${result && result.error ? result.error : 'unknown'}`);
  }
  // The app promotes the M4B to its canonical composed name ({Title}. {Author}.m4b),
  // not a literal audiobook.m4b — result.outputPath is the real file.
  const outPath = result.outputPath || path.join(outputDir, 'audiobook.m4b');
  console.log(`[audiobook] M4B: ${outPath}`);

  // THE TRANSCRIPT IS THE BRIDGE'S JOB, and this file no longer does it.
  //
  // There used to be an embed here, on the premise that "the reassembly seal
  // looks in processDir (already emptied by e2a's move), so nothing gets
  // embedded on this direct path". That premise is FALSE and had been for a
  // while: the seal does not look for e2a's moved VTT at all, it looks for
  // `<processDir>/<stem>.sentences.vtt` — which narrator writes there itself
  // (assemble/run.write_estimated_sentence_vtt, or `narrator align` when the
  // book was measured) — and startReassembly then embeds it, promotes it and
  // BINDS it (reassembly-bridge: 'embed transcript' -> 'promote' -> 'bind
  // sidecars'). Doing it again here was not a fallback, it was damage:
  //
  //   1. It re-embedded a transcript the m4b already carried, rewriting 1.1 GB
  //      and spending another ~19 s on a 16 h book.
  //   2. That rewrite changed the m4b AFTER 'bind sidecars' had recorded its
  //      sha256, so every CLI-assembled book shipped with a binding that did
  //      not match its own audio — `resolveSidecars` fails closed on that, so
  //      the VTT and the cover read as unbound and no player would serve them.
  //      (Measured 2026-09-10 on Shift: bound 4082552…/1112966987 against an
  //      actual 22f19546…/1112966847, 140 bytes apart.)
  //   3. It then called `deleteSidecarsForM4b`, aiming at the very sidecar the
  //      bridge had just deliberately kept — the bridge's comment says the
  //      staging copy "is NOT redundant now, and it is not deleted here",
  //      because re-extracting mov_text is lossy (empty cues vanish and every
  //      later cue shifts). It survived only because `isBound` tests that a
  //      `.sidecars.json` EXISTS, not that it matches; a fractionally different
  //      layout would have deleted the book's transcript.
  //
  // The rule this file is built on is that it chains the calls the app's queue
  // makes and reimplements none of them. An embed here is a parallel
  // implementation of a step the app owns, so it is gone rather than guarded.

  // Clean the e2a scratch session (default ON; --keep-session disables). The M4B is now
  // in output/, so the tmp session is disposable. 'ebook-' name guard so a surprising
  // path can never make this destructive.
  if (!args['keep-session']) {
    for (const d of new Set([scratchSessionDir, normalizedSessionDir].filter(Boolean))) {
      if (!/ebook-[0-9a-f-]+\/?$/i.test(d.replace(/\\/g, '/'))) {
        console.warn(`[audiobook] NOT deleting unexpected session path: ${d}`);
        continue;
      }
      try { fs.rmSync(d, { recursive: true, force: true }); console.log(`[audiobook] cleaned scratch session ${d}`); }
      catch (e) { console.warn(`[audiobook] scratch cleanup failed for ${d}: ${e && e.message}`); }
    }
  }

  console.log(`[audiobook] done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${outPath}`);
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[audiobook] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
