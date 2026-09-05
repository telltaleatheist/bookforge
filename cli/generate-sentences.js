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
 *        [--hole-min 30] [--rough-cache rough.json] [--align-workers N]
 *        [--snap-silence 0.6 | --no-snap-silence] [--no-paragraph-split]
 *        [--report-hole-min 3]
 *
 * Boundary accuracy (epub-align only, 2026-09-03):
 *   --snap-silence <s>     pull each cue seam onto the middle of the nearest
 *                          detected silence within <s> seconds (default 0.6).
 *   --no-snap-silence      keep the raw forced-alignment times.
 *   --no-paragraph-split   segment the ebook on punctuation only (pre-2026-09-03);
 *                          the default also splits on block boundaries, so an
 *                          unpunctuated heading gets its own cue instead of being
 *                          glued onto the prose that follows it.
 *   --report-hole-min <s>  unmatched-audio ranges this long are LISTED in the
 *                          coverage report (default 3). Report-only: --hole-min
 *                          still governs whisper-fallback cues in the VTT.
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

/**
 * A pure on/off switch: present means true, and a VALUE is an error.
 *
 * `parseArgs` stores `--flag` as boolean true but `--flag=false` as the STRING
 * "false", which is truthy — so a plain `args['no-paragraph-split'] ? ... ` turned
 * an explicit "off" into "on". argparse rejects `--store-true-flag=false` for the
 * same reason, and bookforge-tts.py inherits that, so rejecting here also keeps the
 * two entry points saying the same thing.
 */
function switchFlag(args, name) {
  const v = args[name];
  if (v === undefined) return false;
  if (v === true) return true;
  throw new Error(`--${name} is a switch and takes no value (got '${v}') — omit it to leave the behaviour on`);
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
  console.log(`[sentences]   audio: ${s.unmatchedAudioRanges} range(s) with no epub match ` +
    `(≥${s.holeThresholdSeconds}s), ${Math.round(s.unmatchedAudioSeconds)}s of ${s.audioDurationTimestamp} total`);
  if (s.reportedRanges != null && s.reportHoleThresholdSeconds !== s.holeThresholdSeconds) {
    console.log(`[sentences]   report lists ${s.reportedRanges} range(s) at the lower ≥${s.reportHoleThresholdSeconds}s ` +
      `threshold (a reading-speed estimate, not measured silence — see lowSpeechCues)`);
  }
  // null (not 0) means the silence map was absent, so nothing was measured — say so
  // rather than printing a reassuring zero.
  if (s.lowSpeechCues == null && rep.lowSpeechCues && rep.lowSpeechCues.measured === false) {
    console.log('[sentences]   dead air: not measured (no silence map this run)');
  } else if (s.lowSpeechCues) {
    console.log(`[sentences]   dead air: ${s.lowSpeechCues} cue(s) ≥3s are ≤30% speech (measured against the silence map)`);
  }
  if (s.headingCues != null) console.log(`[sentences]   headings: ${s.headingCues} cue(s) tagged NOTE heading`);
  const bs = rep.boundarySnap;
  if (bs && bs.windowSeconds > 0) {
    console.log(`[sentences]   boundary snap: ${bs.seamsSnapped}/${bs.seamsConsidered} seam(s) moved onto a silence ` +
      `(window ${bs.windowSeconds}s, ${bs.silenceIntervals} silence intervals; ` +
      `|move| median ${bs.medianAbsMoveSeconds}s max ${bs.maxAbsMoveSeconds}s)`);
  }
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
  // ARGUMENTS FIRST, FILESYSTEM SECOND. The existence checks used to sit up here,
  // above every flag check, so a bad flag combination was reported as "audio file
  // not found" whenever the path happened to be wrong — and, worse, a flag-parity
  // test could not tell a rejected flag from a missing file, because both exited 1
  // with the same message. bookforge-tts.py already validates flags first (argparse
  // does it before any of its _require file checks); this makes the adapter agree.
  if (!args.audio) throw new Error('--audio <file> is required');
  if (!args.out) throw new Error('--out <file.vtt> is required');
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
  let roughCachePath;
  if (args['rough-cache'] !== undefined) {
    if (!args.epub) throw new Error('--rough-cache requires --epub (only epub-align has a rough transcribe pass to cache)');
    if (args['rough-cache'] === true) throw new Error('--rough-cache needs a path (the dispatcher derives a default; pass --rough-cache <file.json> when calling this adapter directly)');
    roughCachePath = path.resolve(args['rough-cache']);
  }
  // --snap-silence <s> / --no-snap-silence: bounded window for pulling each cue
  // seam onto the middle of a detected silence. Flag absent = the bridge default
  // (0.6 s). --no-snap-silence restores the pre-2026-09-03 raw aligner times.
  // Every rejection here mirrors bookforge-tts.py's _require checks exactly. They
  // used to disagree: a valueless `--snap-silence` was silently DROPPED (the run
  // used 0.6 while the operator believed they had set something), and
  // `--no-snap-silence --snap-silence 1.0` silently took 1.0 here while the python
  // wrapper refused the pair. A flag that means different things depending on which
  // entry point you call is worse than no flag.
  let snapSilenceS;
  const snapGiven = args['snap-silence'] !== undefined;
  const noSnap = switchFlag(args, 'no-snap-silence');
  if (snapGiven && noSnap) {
    throw new Error('--snap-silence and --no-snap-silence are mutually exclusive');
  }
  if (snapGiven) {
    if (args['snap-silence'] === true) {
      throw new Error('--snap-silence needs a value in seconds (e.g. --snap-silence 0.6); use --no-snap-silence, or --snap-silence 0, to turn it off');
    }
    snapSilenceS = Number(args['snap-silence']);
    if (!Number.isFinite(snapSilenceS) || snapSilenceS < 0) {
      throw new Error(`--snap-silence must be a number >= 0 seconds, got '${args['snap-silence']}' (0 = off)`);
    }
  } else if (noSnap) {
    snapSilenceS = 0;
  }
  if (snapSilenceS !== undefined && !args.epub) {
    throw new Error('--snap-silence/--no-snap-silence require --epub (whisper mode has no cue seams to snap)');
  }
  // --no-paragraph-split: pre-2026-09-03 punctuation-only ebook segmentation
  // (headings glued onto the following prose).
  const paragraphAware = switchFlag(args, 'no-paragraph-split') ? false : undefined;
  if (paragraphAware === false && !args.epub) {
    throw new Error('--no-paragraph-split requires --epub (it changes ebook segmentation)');
  }
  // --report-hole-min <s>: threshold for unmatched-audio ranges LISTED IN THE
  // REPORT. Separate from --hole-min, which also fills holes with ASR cues and so
  // changes the VTT; this one is report-only and safe to lower.
  let reportHoleMinS;
  if (args['report-hole-min'] !== undefined) {
    if (!args.epub) throw new Error('--report-hole-min requires --epub');
    // `=== true` is the valueless form. Without this guard Number(true) is 1, which
    // is finite and >= 0, so a bare --report-hole-min would quietly mean 1 second.
    if (args['report-hole-min'] === true) throw new Error('--report-hole-min needs a value in seconds');
    reportHoleMinS = Number(args['report-hole-min']);
    if (!Number.isFinite(reportHoleMinS) || reportHoleMinS < 0) {
      throw new Error(`--report-hole-min must be a number >= 0, got '${args['report-hole-min']}'`);
    }
  }
  let alignWorkers;
  if (args['align-workers'] !== undefined) {
    if (!args.epub) throw new Error('--align-workers requires --epub (it sizes the epub-align worker pool)');
    alignWorkers = Number(args['align-workers']);
    if (!Number.isInteger(alignWorkers) || alignWorkers < 1) {
      throw new Error(`--align-workers must be a positive integer, got '${args['align-workers']}'`);
    }
  }

  // Now that every flag is known good, touch the filesystem.
  if (!fs.existsSync(args.audio)) throw new Error(`audio file not found: ${args.audio}`);
  if (args.epub && !fs.existsSync(args.epub)) throw new Error(`epub file not found: ${args.epub}`);

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
    console.log(`[sentences] EPUB-ALIGN: "${path.basename(args.epub)}" -> "${path.basename(args.audio)}" (whisperx-env, device=${args.device || 'auto'})`);
    const reportPath = args.report ? path.resolve(args.report) : undefined;
    if (reportPath) fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const r = await wab.runEpubAlignOnFiles(jobId, makeProgressWindow(), args.epub, args.audio, language,
      { reportPath, holeMinS, roughCachePath, alignWorkers, device: args.device,
        snapSilenceS, paragraphAware, reportHoleMinS });
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
      setTimeout(() => process.exit(130), 1500);  // abort-path: SIGINT/SIGTERM teardown
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
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[sentences] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
