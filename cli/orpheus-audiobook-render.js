/**
 * orpheus-audiobook-render.js — headless, APP-FAITHFUL audiobook build. Chains the
 * EXACT two high-level calls the app's queue makes for a standard audiobook:
 *
 *   1. renderRangeHeadless()  (parallel-tts-bridge) — the tts-conversion core: real
 *      e2a prep + batch worker.py, producing a complete e2a session (sentence FLACs
 *      + session state with chapter mapping). Identical to a UI TTS job.
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
 * Output lands in its canonical project location (<project>/output/audiobook.m4b),
 * exactly like the app — there is no --out.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { USER_DATA } = require('./electron-stub.js');

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

/** Best-available input EPUB — mirrors the app's TTS "Latest" resolution
 *  (translated > simplified/cleaned > exported > original). First existing wins. */
function resolveInputEpub(projectDir) {
  const candidates = [
    'stages/02-translate/translated.epub',
    'stages/01-cleanup/simplified.epub',
    'stages/01-cleanup/cleaned.epub',
    'source/exported.epub',
    'source/original.epub',
  ];
  for (const rel of candidates) {
    const p = path.join(projectDir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
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
  if (!voice) throw new Error('--voice <id> is required (a voice in BookForge models.json)');
  if (!args.project) throw new Error('--project <projectDir> is required');

  const projectDir = path.resolve(args.project);
  if (!fs.existsSync(path.join(projectDir, 'manifest.json'))) {
    throw new Error(`not a BookForge project (no manifest.json): ${projectDir}`);
  }

  // Library root = {library}/projects/{slug} -> two levels up. Reassembly resolves the
  // cover + metadata from the manifest relative to this, exactly like the app does.
  const libraryRoot = path.dirname(path.dirname(projectDir));
  const manifestSvc = require('../dist/electron/manifest-service.js');
  manifestSvc.setLibraryBasePath(libraryRoot);

  // Input EPUB: explicit --input override, else best-available (app "Latest").
  const inputPath = args.input ? path.resolve(args.input) : resolveInputEpub(projectDir);
  if (!inputPath) {
    throw new Error(`no input EPUB in ${projectDir} (looked for translated/cleaned/exported/original)`);
  }
  if (!fs.existsSync(inputPath)) throw new Error(`input EPUB not found: ${inputPath}`);

  // Project metadata for the reassembly config (title/author/cover/etc.). Reassembly
  // also resolves the cover from the manifest itself; passing it here matches the app
  // (config.metadata.coverPath is primary, manifest is the fallback).
  const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'manifest.json'), 'utf8'));
  const md = manifest.metadata || {};
  const absCover = md.coverPath ? path.join(libraryRoot, md.coverPath) : undefined;

  const bridge = require('../dist/electron/parallel-tts-bridge.js');
  const reassembly = require('../dist/electron/reassembly-bridge.js');
  for (const [obj, fn] of [[bridge, 'renderRangeHeadless'], [bridge, 'scanProjectSessions'],
                           [bridge, 'cacheSessionToProject'], [reassembly, 'startReassembly']]) {
    if (typeof obj[fn] !== 'function') {
      throw new Error(`compiled bridge missing ${fn} — rebuild (npx tsc -p tsconfig.electron.json)`);
    }
  }

  const language = args.language || 'en';

  // Final-assembly denoise (e2a FINAL_DENOISE, injected by reassembly-bridge from
  // config.finalDenoise). Default ON: this adapter is Orpheus-only, and Orpheus voices
  // are trained on a deliberate faint hiss bed the render reproduces — the denoise pass
  // strips it once, at assembly. --no-final-denoise restores the legacy byte-identical
  // export (--final-denoise is an explicit ON, same as the default here).
  if (args['final-denoise'] && args['no-final-denoise']) {
    throw new Error('--final-denoise and --no-final-denoise are mutually exclusive');
  }
  const finalDenoise = !args['no-final-denoise'];

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
        process.exit(130);
      })
      .catch((e) => { console.error('[audiobook] teardown error:', e && e.message); process.exit(130); });
  };
  process.on('SIGINT', () => stopAndExit('SIGINT'));
  process.on('SIGTERM', () => stopAndExit('SIGTERM'));

  // ParallelTtsSettings. For Orpheus, temperature/topP/topK/repetitionPenalty/speed and
  // enableTextSplitting are INERT (Orpheus sampling is fixed in orpheus.py; they're here
  // to satisfy the shape). Env seams (ORPHEUS_MEMORY_TIER, etc.) are read by the pipeline.
  const settings = {
    device: 'auto',
    language: args.language || 'en',
    ttsEngine: 'orpheus',
    fineTuned: voice,
    temperature: 0.6, topP: 0.8, topK: 0, repetitionPenalty: 1.1, speed: 1.0,
    enableTextSplitting: false,
  };
  if (args['model-dir']) settings.orpheusModelDir = args['model-dir'];

  const t0 = Date.now();

  // ── STEP 1/2: TTS — the tts-conversion core (real prep + batch worker) ──
  console.log(`[audiobook] STEP 1/2 renderRangeHeadless — e2a prep + batch worker on ${path.basename(inputPath)}`);
  const { totalSentences, scratchSessionDir, normalizedSessionDir } =
    await bridge.renderRangeHeadless(inputPath, settings, {
      jobId,
      resumeFromSentencesDir,
      onSessionReady: (info) => { liveSessionDir = info.sessionDir; },
    });
  const sessionDirPath = normalizedSessionDir || scratchSessionDir;
  console.log(`[audiobook] generation complete: ${totalSentences} sentences (session ${path.basename(sessionDirPath)})`);

  // Persist the rendered sentences to the project cache (stages/03-tts/sessions/) so a
  // re-run resumes here; prune older cached sessions for this language to avoid buildup.
  try {
    await bridge.cacheSessionToProject(scratchSessionDir, projectDir, language);
    pruneOldSessions(projectDir, language, path.basename(scratchSessionDir));
    console.log('[audiobook] cached TTS session to project (resume-ready)');
  } catch (e) { console.warn(`[audiobook] session cache failed: ${e && e.message}`); }

  // ── STEP 2/2: Assembly — the reassembly job (e2a --assemble_only) ──
  const sessionId = path.basename(sessionDirPath).replace(/^ebook-/, '');
  const e2aTmpPath = path.dirname(sessionDirPath);
  const session = await reassembly.getSession(sessionId, e2aTmpPath);
  if (!session) throw new Error(`could not load e2a session '${sessionId}' from ${e2aTmpPath}`);

  const outputDir = path.join(projectDir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });

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
    finalDenoise,
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

  // Seal the transcript INTO the m4b (embed-only model), mirroring the app's
  // finalizeOutputPath. e2a moves its VTT to the output dir and startReassembly
  // promotes it as a sidecar next to the m4b — but the reassembly seal looks in
  // processDir (already emptied by e2a's move), so nothing gets embedded on this
  // direct path. Embed the promoted sidecar here, then strip it so none lingers in
  // output/. The e2a VTT is author-suffixed (name ≠ m4b stem), so fall back to any
  // mono .vtt next to the sole m4b. On embed failure the book simply has no
  // transcript (loud warn) — no sidecar fallback (sidecars can't be trusted).
  try {
    const metaTools = require('../dist/electron/metadata-tools.js');
    const outDir = path.dirname(outPath);
    const stem = path.parse(outPath).name;
    const vtts = fs.readdirSync(outDir).filter(
      (n) => n.toLowerCase().endsWith('.vtt') && !n.startsWith('._') && !n.startsWith('bilingual-'));
    const sidecar = vtts.find((n) => path.parse(n).name === stem) || vtts[0];
    if (sidecar) {
      const embedded = await metaTools.embedAndVerifyVtt(outPath, path.join(outDir, sidecar), { language });
      console.log(embedded
        ? `[audiobook] embedded transcript into m4b (${sidecar})`
        : `[audiobook] WARN: embed verify failed — m4b has NO transcript`);
      metaTools.deleteSidecarsForM4b(outPath);
    } else {
      console.warn('[audiobook] WARN: no sidecar VTT next to m4b — transcript not embedded');
    }
  } catch (e) { console.error('[audiobook] transcript embed failed:', e && e.message); }

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
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[audiobook] ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});
