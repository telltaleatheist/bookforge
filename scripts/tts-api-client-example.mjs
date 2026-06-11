#!/usr/bin/env node
/**
 * Example client for the BookForge TTS API server (electron/tts-api-server.ts).
 * Connects, speaks a block of text, and writes the streamed audio to a WAV
 * file. Doubles as an end-to-end test and as reference code for the browser
 * extension (the protocol is identical; a browser uses `new WebSocket(url)`).
 *
 * Usage:
 *   node scripts/tts-api-client-example.mjs "Text to speak." [out.wav]
 *
 * The token is read from the app's config:
 *   ~/Library/Application Support/bookforge-app/tts-api.json
 * BookForge must be running. A cold engine auto-starts (~1 min model load);
 * watch the 'state' events.
 */

import WebSocket from 'ws';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const text = process.argv[2] || 'Hello from the BookForge TTS API. This is a streaming test.';
const outPath = process.argv[3] || 'tts-api-test.wav';

const configPath = join(homedir(), 'Library', 'Application Support', 'bookforge-app', 'tts-api.json');
const { port, token } = JSON.parse(readFileSync(configPath, 'utf-8'));

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const requestId = `example-${process.pid}`;

// sentenceIndex -> array of PCM16 buffers (chunks arrive out of order across sentences)
const audio = new Map();
let sentenceCount = 0;
let sampleRate = 24000;

ws.on('open', () => ws.send(JSON.stringify({ action: 'hello', token })));

ws.on('close', (code, reason) => {
  console.log(`connection closed: ${code} ${reason}`);
  process.exit(code === 1000 ? 0 : 1);
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  switch (msg.type) {
    case 'hello':
      console.log(`connected. engine: ${msg.state}, voices: ${msg.voices.join(', ') || '(engine cold)'}`);
      console.log('speaking…');
      ws.send(JSON.stringify({ action: 'speak', requestId, text, settings: { speed: 1.1 } }));
      break;
    case 'state':
      console.log(`engine: ${msg.state}`);
      break;
    case 'speaking':
      sentenceCount = msg.sentences.length;
      console.log(`segmented into ${sentenceCount} sentences`);
      break;
    case 'chunk': {
      if (!audio.has(msg.sentenceIndex)) audio.set(msg.sentenceIndex, []);
      audio.get(msg.sentenceIndex)[msg.seq] = Buffer.from(msg.data, 'base64');
      sampleRate = msg.sampleRate;
      break;
    }
    case 'done':
      console.log(`  sentence ${msg.sentenceIndex + 1}/${sentenceCount} generated (${msg.duration.toFixed(1)}s)`);
      break;
    case 'complete': {
      const pcm = Buffer.concat(
        [...audio.keys()].sort((a, b) => a - b).flatMap((i) => audio.get(i).filter(Boolean))
      );
      writeFileSync(outPath, wavFromPcm16(pcm, sampleRate));
      console.log(`wrote ${outPath} (${(pcm.length / 2 / sampleRate).toFixed(1)}s)`);
      ws.close(1000);
      break;
    }
    case 'cancelled':
      console.log('request was cancelled (preempted by another session)');
      ws.close(1000);
      break;
    case 'failed':
      console.warn(`sentence ${msg.sentenceIndex} failed: ${msg.error}`);
      break;
    case 'error':
      console.error(`error: ${msg.message}`);
      ws.close(1000);
      break;
  }
});

function wavFromPcm16(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);          // PCM
  header.writeUInt16LE(1, 22);          // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);   // byte rate
  header.writeUInt16LE(2, 32);          // block align
  header.writeUInt16LE(16, 34);         // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
