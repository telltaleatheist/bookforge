/**
 * orpheus-stream.js — headless drive of BookForge's REAL streaming path.
 *
 * This is the Listen/extension path, end to end, with NO logic of its own: it starts
 * the app's actual `ttsApiServer` and then talks the documented WebSocket protocol to
 * it (docs/TTS_API.md), exactly as the BookForge Reader extension does. So a CLI run
 * exercises handleSpeak's voice binding, splitForTts + the voice's packing cap,
 * stream-scheduler's sessions/priority/read-ahead, the pool's batch-width ladder, and
 * orpheus_stream.py — the same code, in the same order, as pressing play in a browser.
 *
 * That fidelity is the whole point. The older `orpheus-render.js` calls the pool's
 * per-sentence API directly, which skips the scheduler and the batch ladder entirely —
 * it cannot reproduce (or catch) anything that lives there. Every streaming defect
 * found on 2026-08-31 lived there.
 *
 * If BookForge is already running, its server is used as-is rather than starting a
 * second one; the port is busy either way, and driving the live app is MORE faithful,
 * not less.
 *
 * Run via the electron shim preload:
 *   node --require ./cli/electron-stub.js cli/orpheus-stream.js \
 *        --voice deathstalker --input article.txt
 *
 * Input is BLOCKS: paragraphs separated by blank lines, the same unit the extension
 * detects on a page. Block 1 is the one "play" was pressed on (a priority speak); the
 * rest are read-ahead (background speaks), which is what makes the batch shapes real.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

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

const USAGE = `orpheus-stream.js — drive BookForge's real streaming path headlessly

  --text <string>       one block of text, or
  --input <file>        blocks separated by blank lines (block 1 = the one played)
  --voice <id>          voice to bind (required; sent as a BINDING speak setting)
  --read-ahead <n>      how many following blocks to prefetch (default: all)
  --out <file.wav>      write block 1's audio
  --json                emit the timing table as JSON
`;

/** Is a BookForge TTS API server already listening? */
function probe(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).service === 'bookforge-tts'); }
        catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function writeWav(pcm, rate, out) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(out, Buffer.concat([h, pcm]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { console.log(USAGE); process.exitCode = 0; return; }
  if (!args.voice) throw new Error('--voice <id> is required (speak settings bind the voice)');

  let raw = args.text;
  if (args.input) raw = fs.readFileSync(args.input, 'utf8');
  if (!raw) throw new Error('--text <string> or --input <file> is required');
  const blocks = String(raw).split(/\n\s*\n/).map((b) => b.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!blocks.length) throw new Error('no non-empty blocks in the input');
  const fan = args['read-ahead'] === undefined ? blocks.length - 1 : Number(args['read-ahead']);
  const use = blocks.slice(0, 1 + Math.max(0, fan));

  const { ttsApiServer } = require('../dist/electron/tts-api-server.js');
  const { app } = require('electron');             // the shim
  const userData = app.getPath('userData');
  // tts-api.json is the PUBLISHED interface (docs/TTS_API.md) — the same file the
  // extension's options page reads for host/port/token. Reading it is how a client
  // attaches to a running app; ttsApiServer.getStatus() answers with an empty token
  // until the server itself has loaded its config, which in this process it has not.
  const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'tts-api.json'), 'utf8'));
  const live = await probe(onDisk.host, onDisk.port);
  let started = false;
  let status = onDisk;
  if (live) {
    console.log(`[stream] BookForge is running on ${onDisk.host}:${onDisk.port} — driving it`);
  } else {
    status = await ttsApiServer.start(userData);
    started = true;
    console.log(`[stream] started the app's TTS API server headlessly on ${status.host}:${status.port}`);
  }

  // Teardown must run on signals too: a bare process death orphans the Orpheus worker
  // (it holds the GPU/unified memory for hours). `finally` does not run on SIGINT.
  let stopping = false;
  const teardown = async () => {
    if (started) { try { await ttsApiServer.stop(); } catch { /* reported below */ } }
    // Only OUR server owns the engine. When we attached to a running app, its engine is
    // the app's to manage — killing it would stop playback in a window we do not own.
    if (started) {
      const { getActiveEngine } = require('../dist/electron/streaming-engine.js');
      try { await getActiveEngine().endSession(); } catch { /* worker may need manual cleanup */ }
    }
  };
  const stopAndExit = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[stream] ${sig} — tearing down...`);
    teardown().then(() => process.exit(130)).catch(() => process.exit(130));  // abort-path: SIGINT/SIGTERM teardown
  };
  process.on('SIGINT', () => stopAndExit('SIGINT'));
  process.on('SIGTERM', () => stopAndExit('SIGTERM'));

  const WebSocket = require('ws');
  const T0 = Date.now();
  const at = () => (Date.now() - T0) / 1000;
  const st = use.map(() => ({ first: null, done: null, secs: 0, rows: 0, pcm: [] }));

  const result = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${status.host}:${status.port}`);
    let settled = false;
    ws.on('open', () => ws.send(JSON.stringify({ action: 'hello', token: status.token })));
    ws.on('error', (err) => { settled = true; reject(err); });
    // 4401 is the server's "bad/absent token, or an action before hello". Without this
    // the promise simply never settles and the run hangs with no explanation.
    ws.on('close', (code, why) => {
      if (settled) return;
      settled = true;
      reject(new Error(code === 4401
        ? `authentication rejected (code 4401) — token from ${path.join(userData, 'tts-api.json')} was not accepted`
        : `socket closed before the run finished (code ${code}${why ? ': ' + why : ''})`));
    });
    ws.on('message', (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === 'hello') {
        // EXACTLY the extension's shape: one foreground (preempting) speak for the
        // clicked block, then a background read-ahead speak per following block.
        use.forEach((text, i) => ws.send(JSON.stringify({
          action: 'speak', requestId: `b${i}`, text,
          settings: { voice: args.voice, speed: 1.0 },
          preempt: i === 0, background: i > 0, startSentence: 0,
        })));
        console.log(`[stream] 1 foreground + ${use.length - 1} read-ahead speaks | voice ${args.voice}`);
        return;
      }
      if (m.type === 'error') { reject(new Error(`${m.requestId ?? ''} ${m.message}`.trim())); return; }
      const i = typeof m.requestId === 'string' && /^b\d+$/.test(m.requestId) ? Number(m.requestId.slice(1)) : -1;
      if (i < 0) return;
      if (m.type === 'speaking') { st[i].rows = m.sentences.length; return; }
      if (m.type === 'chunk') {
        if (st[i].first === null) st[i].first = at();
        const pcm = Buffer.from(m.data, 'base64');
        st[i].secs += pcm.length / 48000;
        if (i === 0 && args.out) st[i].pcm.push(pcm);
        return;
      }
      if (m.type === 'complete') {
        st[i].done = at();
        if (st.every((x) => x.done !== null)) { settled = true; ws.close(); resolve(true); }
      }
    });
  });
  void result;

  // Reading-order report: what the listener would actually experience. A block cannot
  // play before it is generated, so a later block being ready early costs nothing — a
  // STALL is only when the next block in READING order is not there yet.
  let clock = null;
  const rows = st.map((x, i) => {
    const start = clock === null ? x.done : Math.max(clock, x.done);
    const stall = clock === null ? 0 : Math.max(0, x.done - clock);
    clock = start + x.secs;
    return { block: i + 1, rows: x.rows, completeAt: +x.done.toFixed(1),
             audio: +x.secs.toFixed(1), playsAt: +start.toFixed(1), stall: +stall.toFixed(1) };
  });
  if (args.json) {
    console.log(JSON.stringify({ firstWordAt: rows[0].playsAt, rows }, null, 2));
  } else {
    console.log('\nblock rows  complete   audio     plays      stall');
    for (const r of rows) {
      console.log(`  ${String(r.block).padStart(2)}   ${String(r.rows).padStart(2)}   ${String(r.completeAt).padStart(6)}s  ${String(r.audio).padStart(5)}s  ${String(r.playsAt).padStart(6)}s  ${r.stall > 0.5 ? String(r.stall).padStart(6) + 's' : '      -'}`);
    }
    const stalls = rows.filter((r) => r.stall > 0.5);
    console.log(`\nfirst word at ${rows[0].playsAt}s`);
    console.log(stalls.length
      ? `stalls: ${stalls.map((r) => `before block ${r.block}: ${r.stall}s`).join(', ')}`
      : 'no stalls — continuous flow');
  }

  if (args.out) { writeWav(Buffer.concat(st[0].pcm), 24000, args.out); console.log(`[stream] wrote block 1 -> ${args.out}`); }

  console.log('[stream] tearing down...');
  await teardown();
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[stream] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
