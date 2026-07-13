/**
 * generate-sentences.js — audio → sentence-level VTT through BookForge's REAL
 * machinery, two modes:
 *
 *   WHISPER (default): faster-whisper transcription — the app's "Generate sentences"
 *     path (transcribe-bridge → transcribe_audiobook.py, bundled e2a env, never WSL).
 *     Words come from the audio, so ASR spelling errors are possible.
 *
 *   EPUB-ALIGN (--epub given): the ebook text is GROUND TRUTH; WhisperX forced
 *     alignment supplies only the timings (whisperx-align-bridge →
 *     runEpubAlignOnFiles → align_audiobook.py, CPU-only whisperx-env). Produces a
 *     VTT whose text is the book's own words — the "link epub source to audio" mode.
 *
 * Reuses, unchanged: component install (whisper pip overlay / whisperx-env),
 * whisper-model download cache, both python pipelines, the app's m4b subtitle
 * embed (+read-back verify) with all its ffmpeg gotchas. This file adds only
 * argument plumbing and console progress.
 *
 *   node --require ./cli/electron-stub.js cli/generate-sentences.js \
 *        --audio book.m4b --out book.vtt [--epub book.epub] [--whisper-model small]
 *        [--language en] [--device auto|cpu|cuda] [--embed] [--report coverage.json]
 *        [--hole-min 30]
 *
 * --report (epub-align only): also write a coverage JSON — epub sentence runs the
 * narrator never read (with text anchors + neighboring narrated timestamps) and
 * audio ranges with no epub match (ads/intros, with timestamps + the whisper
 * transcript of what's actually spoken there).
 *
 * No fallbacks: missing files/env/model errors name exactly what's wrong.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

/** Stub BrowserWindow: the bridges use win ONLY as an event sink (sendProgress guards
 *  isDestroyed then webContents.send). We print the events instead. */
function makeProgressWindow() {
  let lastLine = '';
  return {
    isDestroyed: () => false,
    webContents: {
      send: (_channel, payload) => {
        if (!payload) return;
        const pct = payload.percentage != null ? `${payload.percentage}%` : '';
        const msg = payload.message || '';
        const line = `[sentences] ${pct} ${msg}`.trim();
        if (line !== lastLine) { console.log(line); lastLine = line; }
      },
    },
  };
}

/** Console digest of the coverage report — enough to act on without opening the
 *  JSON, capped so a noisy book (hundreds of dropped headings) stays readable. */
function printCoverageSummary(reportPath) {
  const rep = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const s = rep.summary;
  const short = (t, n) => (t && t.length > n ? t.slice(0, n - 1) + '…' : t || '');
  console.log(`[sentences] coverage report -> ${reportPath}`);
  console.log(`[sentences]   epub: ${s.narratedSentences}/${s.epubSentences} sentences narrated; ` +
    `${s.excludedSentences} excluded in ${s.excludedRuns} run(s) (head ${s.trimmedHead}, interior ${s.interiorDropped}, tail ${s.trimmedTail})`);
  console.log(`[sentences]   audio: ${s.unmatchedAudioRanges} range(s) with no epub match, ` +
    `${Math.round(s.unmatchedAudioSeconds)}s of ${s.audioDurationTimestamp} total`);
  const MAX_LIST = 12;
  const bigRuns = rep.epubNotInAudio.filter((r) => r.count >= 3);
  for (const r of bigRuns.slice(0, MAX_LIST)) {
    const at = r.narratedBefore ? `after ${r.narratedBefore.timestamp}` : (r.narratedAfter ? `before ${r.narratedAfter.timestamp}` : '');
    console.log(`[sentences]   [epub ${r.reason}] ${r.count} sentences ${at}: "${short(r.firstSentence, 70)}" … "${short(r.lastSentence, 70)}"`);
  }
  if (bigRuns.length > MAX_LIST) console.log(`[sentences]   …and ${bigRuns.length - MAX_LIST} more epub run(s) ≥3 sentences (see report)`);
  const smallRuns = rep.epubNotInAudio.length - bigRuns.length;
  if (smallRuns > 0) console.log(`[sentences]   (+${smallRuns} run(s) of 1-2 sentences — headings etc., see report)`);
  for (const h of rep.audioNotInEpub.slice(0, MAX_LIST)) {
    console.log(`[sentences]   [audio] ${h.startTimestamp} -> ${h.endTimestamp} (${Math.round(h.durationSeconds)}s): ` +
      (h.transcript ? `"${short(h.transcript, 110)}"` : '(no transcript segments)'));
  }
  if (rep.audioNotInEpub.length > MAX_LIST) console.log(`[sentences]   …and ${rep.audioNotInEpub.length - MAX_LIST} more audio range(s) (see report)`);
  const d = rep.driftSelfCheck;
  if (d && d.checkedCues > 0) {
    console.log(`[sentences]   drift: ${d.checkedCues} cue(s) self-checked against the audio; ` +
      `|offset| median ${d.medianAbsSeconds}s, p95 ${d.p95AbsSeconds}s, max ${d.maxAbsSeconds}s; ` +
      `${d.correctedCues} corrected (>${d.correctionThresholdSeconds}s)`);
    for (const c of (d.corrected || []).slice(0, 5)) {
      console.log(`[sentences]     moved ${c.cueWas} -> ${c.movedTo} (${c.offsetSeconds > 0 ? '+' : ''}${c.offsetSeconds}s): "${short(c.text, 70)}"`);
    }
  }
}

async function ensureWhisperReady(modelId) {
  const { isWhisperEnvInstalled } = require('../dist/electron/components/whisper-env.js');
  const { componentManager } = require('../dist/electron/components/component-manager.js');
  const { WHISPER_ENV_ID } = require('../dist/electron/components/whisper-env.js');
  const wm = require('../dist/electron/whisper-models.js');

  if (!isWhisperEnvInstalled()) {
    console.log('[sentences] whisper engine overlay not installed — installing (pip, one-time)...');
    const inst = await componentManager.install(WHISPER_ENV_ID, (p) => {
      if (p.message) console.log(`[sentences] ${p.message}`);
    });
    if (!inst.ok) throw new Error(inst.error || 'whisper engine install failed');
  }
  if (!wm.getWhisperModelDef(modelId)) {
    const ids = wm.WHISPER_MODELS.map((m) => m.id).join(', ');
    throw new Error(`unknown --whisper-model '${modelId}' (available: ${ids})`);
  }
  if (!wm.isWhisperModelPresent(modelId)) {
    console.log(`[sentences] whisper model '${modelId}' not on disk — downloading...`);
    const dl = await wm.downloadWhisperModel(modelId, (p) => {
      if (p && p.message) console.log(`[sentences] ${p.message}`);
    });
    if (!dl || dl.ok !== true) throw new Error((dl && dl.error) || `download failed for whisper model ${modelId}`);
  }
  return wm.whisperModelDir(modelId);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.audio) throw new Error('--audio <file> is required');
  if (!fs.existsSync(args.audio)) throw new Error(`audio file not found: ${args.audio}`);
  if (!args.out) throw new Error('--out <file.vtt> is required');
  if (args.epub && !fs.existsSync(args.epub)) throw new Error(`epub file not found: ${args.epub}`);
  if (args.report && !args.epub) {
    throw new Error('--report requires --epub (coverage is epub-vs-audio; whisper mode has no epub to compare against)');
  }
  if (args.report === true) throw new Error('--report needs a path (the dispatcher derives a default; pass --report <file.json> when calling this adapter directly)');
  let holeMinS;
  if (args['hole-min'] !== undefined) {
    if (!args.epub) throw new Error('--hole-min requires --epub (it tunes epub-vs-audio hole detection)');
    holeMinS = Number(args['hole-min']);
    if (!Number.isFinite(holeMinS) || holeMinS < 0) {
      throw new Error(`--hole-min must be a number >= 0, got '${args['hole-min']}' (0 = report every gap)`);
    }
  }

  const jobId = `cli-sent-${crypto.randomUUID()}`;
  const language = args.language || 'auto';
  const t0 = Date.now();
  let vttSource;   // where the produced VTT currently lives
  let cues = 0;
  let warning;

  if (args.epub) {
    // EPUB-ALIGN: ebook text as truth, WhisperX timing. CPU-only env; no GPU coupling.
    const wab = require('../dist/electron/whisperx-align-bridge.js');
    if (typeof wab.runEpubAlignOnFiles !== 'function') {
      throw new Error('runEpubAlignOnFiles missing — rebuild BookForge (npx tsc -p tsconfig.electron.json)');
    }
    console.log(`[sentences] EPUB-ALIGN: "${path.basename(args.epub)}" -> "${path.basename(args.audio)}" (whisperx-env, CPU)`);
    const reportPath = args.report ? path.resolve(args.report) : undefined;
    if (reportPath) fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const r = await wab.runEpubAlignOnFiles(jobId, makeProgressWindow(), args.epub, args.audio, language,
      { reportPath, holeMinS });
    vttSource = r.vttPath;
    cues = r.cues;
    warning = r.warning;
    if (reportPath) printCoverageSummary(reportPath);
  } else {
    // WHISPER: pure transcription through the app's transcribe pipeline.
    const modelId = args['whisper-model'] || 'small';
    const modelDir = await ensureWhisperReady(modelId);
    const tb = require('../dist/electron/transcribe-bridge.js');

    const controller = new AbortController();
    let stopping = false;
    const stopAndExit = (sig) => {
      if (stopping) return;
      stopping = true;
      console.log(`\n[sentences] ${sig} — aborting transcription...`);
      controller.abort();
      setTimeout(() => process.exit(130), 1500);
    };
    process.on('SIGINT', () => stopAndExit('SIGINT'));
    process.on('SIGTERM', () => stopAndExit('SIGTERM'));

    console.log(`[sentences] WHISPER: "${path.basename(args.audio)}" model=${modelId} lang=${language} device=${args.device || 'auto'}`);
    const outTmp = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outTmp), { recursive: true });
    let lastPct = -1;
    const r = await tb.transcribeAudiobook({
      audioPath: args.audio,
      modelDir,
      outPath: outTmp,
      language,
      device: args.device || 'auto',
      signal: controller.signal,
      onStage: (s) => console.log(`[sentences] stage: ${s}`),
      onDevice: (d) => console.log(`[sentences] device: ${d}`),
      onProgress: (frac, det) => {
        const pct = Math.floor(frac * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          const extra = det && det.cues != null ? ` (${det.cues} cues)` : '';
          process.stdout.write(`\r[sentences] transcribing ${pct}%${extra}   `);
        }
      },
    });
    console.log('');
    if (!r.ok) throw new Error(`transcription failed: ${r.error}`);
    vttSource = outTmp;
    cues = r.cues || 0;
  }

  // Land the VTT at --out (align mode produced a temp file; whisper wrote in place).
  const outPath = path.resolve(args.out);
  if (path.resolve(vttSource) !== outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(vttSource, outPath);
    try { fs.unlinkSync(vttSource); } catch { /* temp — best-effort */ }
  }
  console.log(`[sentences] VTT: ${cues} cues -> ${outPath}`);
  if (warning) console.warn(`[sentences] WARNING: ${warning}`);

  // --embed: seal the VTT into the m4b exactly like the app (mov_text track, ms
  // timescale, brand restore, atomic rename, read-back verify).
  if (args.embed) {
    if (!/\.m4b$/i.test(args.audio)) throw new Error('--embed requires the audio to be an .m4b');
    const mt = require('../dist/electron/metadata-tools.js');
    console.log('[sentences] embedding VTT into the m4b (+ read-back verify)...');
    const verified = await mt.embedAndVerifyVtt(args.audio, outPath,
      { language: language === 'auto' ? 'en' : language });
    if (!verified) throw new Error('embed verification failed — the subtitle track did not read back from the m4b');
    console.log('[sentences] embedded + verified');
  }

  console.log(`[sentences] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[sentences] ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});
