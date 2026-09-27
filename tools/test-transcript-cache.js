// The transcript cache follows the audio's CONTENT (2026-09-27): a COPY of the audio (new mtime) still hits the cache;
// a different recording of the same size never does. The 3000 Degrees copy re-ran a whole ASR pass before this.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { audioFingerprint } = require('../dist/electron/crucible/sentence-align.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-fp-'));
const a = path.join(dir, 'a.wav'); const b = path.join(dir, 'b.wav'); const c = path.join(dir, 'c.wav');
const data = Buffer.alloc(5 * (1 << 20)); for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 255;
fs.writeFileSync(a, data);
fs.copyFileSync(a, b); fs.utimesSync(b, new Date(2000, 1, 1), new Date(2000, 1, 1));   // a copy with another mtime
const other = Buffer.from(data); other[3 * (1 << 20) + 17] ^= 0xff; fs.writeFileSync(c, other);   // same size, one byte off in a sampled slice
let fail = 0;
if (audioFingerprint(a) !== audioFingerprint(b)) { fail++; console.log('FAIL a copy did not match'); }
if (audioFingerprint(a) === audioFingerprint(c)) { fail++; console.log('FAIL a different recording matched'); }
const small = path.join(dir, 's.wav'); fs.writeFileSync(small, Buffer.from('tiny')); audioFingerprint(small);   // < 1 MB works
console.log(`transcript-cache: ${3 - fail}/3 passed`);
fs.rmSync(dir, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
