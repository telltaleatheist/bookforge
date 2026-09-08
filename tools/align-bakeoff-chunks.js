#!/usr/bin/env node
// tools/align-bakeoff-chunks.js — the chunk truth table for tools/align-bakeoff.py,
// from an assembled m4b's SENTENCE VTT (the .m4b.vtt sidecar narrator writes).
// Every "NOTE estimated chunk N" block's first cue START is the chunk's exact
// start in the m4b (manifest sample sums); the cues' text joined is its text.
//   node tools/align-bakeoff-chunks.js "<book>.m4b.vtt" chunks.json
'use strict';
const fs = require('fs');
const [vttPath, outPath] = process.argv.slice(2);
if (!vttPath || !outPath) { console.error('usage: align-bakeoff-chunks.js <m4b.vtt> <chunks.json>'); process.exitCode = 64; return; }
const lines = fs.readFileSync(vttPath, 'utf8').split(/\r?\n/);
const ts = (s) => { const m = /(\d+):(\d+):(\d+\.\d+)/.exec(s); return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]); };
const chunks = []; let cur = null;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  let m = /^NOTE .*chunk (\d+)/.exec(l);
  if (m) { cur = { index: +m[1], start: null, end: null, text: [] }; chunks.push(cur); continue; }
  m = /^(\S+) --> (\S+)/.exec(l);
  if (m && cur) {
    const a = ts(m[1]), b = ts(m[2]);
    if (cur.start === null) cur.start = a;
    cur.end = b;
    let t = lines[++i] || '';
    while (lines[i + 1] && lines[i + 1].trim() !== '') t += ' ' + lines[++i];
    cur.text.push(t.replace(/<[^>]+>/g, '').trim());
  }
}
for (const c of chunks) c.text = c.text.join(' ');
fs.writeFileSync(outPath, JSON.stringify(chunks));
console.log(`${chunks.length} chunk(s) -> ${outPath}`);
