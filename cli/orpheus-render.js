/**
 * orpheus-render.js — headless render of text -> WAV through BookForge's REAL
 * Orpheus worker pool. Requires BookForge to be built (dist/electron present) but
 * NOT running. Inherits, unchanged, everything the pool composes: memory-tier +
 * computeSafeGpuUtil sizing, the WSL-safe spawn, custom-model resolution, and the
 * guarded kill-ladder on teardown. This file adds only argument plumbing, sentence
 * splitting, and WAV framing — no TTS logic, no guards of its own.
 *
 * Run via the electron shim preload:
 *   node --require ./cli/electron-stub.js cli/orpheus-render.js \
 *        --voice rohan --input passage.txt --out sample.wav
 *
 * Contract (from the compiled pool): generateSentence ignores per-call settings;
 * sampling is the worker's e2a production default. audio.data is base64 PCM16 mono
 * 24 kHz; we frame the WAV ourselves.
 */
'use strict';
const fs = require('fs');
const path = require('path');

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

function splitSentences(text) {
  return text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter((s) => s.trim().length);
}

function writeWav(pcm, sampleRate, outPath) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([h, pcm]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const voice = args.voice || args['voice-token'];
  if (!voice) throw new Error('--voice <id> is required (a voice in BookForge models.json)');
  if (!args.out) throw new Error('--out <file.wav> is required');
  let text = args.text;
  if (args.input) text = fs.readFileSync(args.input, 'utf8');
  if (!text) throw new Error('--text <string> or --input <file> is required');

  const wp = require('../dist/electron/orpheus-worker-pool.js');
  const api = (wp.orpheusWorkerPool && wp.orpheusWorkerPool.startSession) ? wp.orpheusWorkerPool : wp;

  const t0 = Date.now();
  console.log('[render] startSession — sizing memory tier + spawning WSL-safe worker...');
  const s = await api.startSession();
  console.log('[render] startSession =>', JSON.stringify(s).slice(0, 300));
  if (!s || !s.success) throw new Error('startSession failed: ' + (s && s.error));

  console.log(`[render] loadVoice ${voice} — resolving custom model...`);
  const lv = await api.loadVoice(voice);
  console.log('[render] loadVoice =>', JSON.stringify(lv));
  if (!lv || !lv.success) throw new Error('loadVoice failed: ' + (lv && lv.error));

  const sentences = splitSentences(text);
  let results;
  if (args.sequential) {
    // batch-of-1: await each before the next, so the pool never coalesces a
    // multi-sentence batch. Isolates model behavior from the batched path.
    console.log(`[render] ${sentences.length} sentences -> SEQUENTIAL (batch of 1)...`);
    results = [];
    for (let i = 0; i < sentences.length; i++) {
      const r = await api.generateSentence(sentences[i], i, {}, false);
      results.push({ i, r });
      process.stdout.write(`\r[render] ${i + 1}/${sentences.length}   `);
    }
    console.log('');
  } else {
    console.log(`[render] ${sentences.length} sentences -> vLLM batches (concurrent)...`);
    results = await Promise.all(
      sentences.map((sent, i) => api.generateSentence(sent, i, {}, false).then((r) => ({ i, r })))
    );
  }
  results.sort((a, b) => a.i - b.i);
  const chunks = [];
  for (const { i, r } of results) {
    if (!r || !r.success) throw new Error(`generateSentence[${i}] failed: ` + (r && r.error));
    chunks.push(Buffer.from(r.audio.data, 'base64'));
  }
  const pcm = Buffer.concat(chunks);
  writeWav(pcm, 24000, args.out);
  console.log(`[render] wrote ${(pcm.length / 2 / 24000).toFixed(1)}s -> ${args.out}`);

  console.log('[render] endSession — guarded kill-ladder teardown...');
  await api.endSession();
  console.log(`[render] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[render] ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});
