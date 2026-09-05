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
 * as they are for a queued audiobook. A `.txt` is prepped block by block; an
 * `.epub` gets the caption/footnote cut too. The record beside the copy names every
 * proposed edit and its disposition.
 *
 * The inter-clip gap (default 0.6s) is already baked into each {i}.flac by orpheus.py
 * _save_audio, so concatenating them in numeric order is byte-faithful to what e2a's
 * assembly would join — no gap logic here.
 *
 * Run via the electron shim preload:
 *   node --require ./cli/electron-stub.js cli/orpheus-batch-render.js \
 *        --voice rohan --input passage.txt --out sample.wav
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

  // Resolve the input to a file path — prep reads it via `--ebook`. A literal --text is
  // written to a temp .txt (e2a's convert2epub accepts a plain text file).
  let inputPath = args.input;
  let tempInput = null;
  if (!inputPath) {
    if (!args.text) throw new Error('--input <file> or --text <string> is required');
    tempInput = path.join(os.tmpdir(), `bf-tts-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(tempInput, String(args.text), 'utf8');
    inputPath = tempInput;
  }
  if (!fs.existsSync(inputPath)) throw new Error(`input file not found: ${inputPath}`);

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
  if (args['model-dir']) settings.orpheusModelDir = args['model-dir'];

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
  const cleaned = await runNarrationTextStep(inputPath, {});

  const prepared = await runNarrationPrep(
    bridge, cleaned.inputPath, jobId, { skipAssembly: true, textCleanup: 'required' });

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

  if (tempInput) { try { fs.unlinkSync(tempInput); } catch { /* temp text — best-effort */ } }
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[batch] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
