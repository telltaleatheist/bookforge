// cutWindowsStreamed (2026-09-26) must give the aligner exactly the audio the old one-ffmpeg-per-window cutWindow
// gave it: every window sample-equal to an ffmpeg -ss/-t cut of the same span, overlapping and out-of-order windows
// included, plus a window that runs past the end of the audio (zero tail) and one wholly past it (all zeros).
const fs = require('fs'); const os = require('os'); const path = require('path'); const { execFileSync } = require('child_process');
const { cutWindowsStreamed } = require('../dist/electron/crucible/sentence-align.js');
const FF = process.env.FFMPEG || 'C:/Users/tellt/AppData/Roaming/BookForge/runtime/tools-env/Library/bin/ffmpeg.exe';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cutwin-'));
const src = path.join(dir, 'src.flac');
// 40 s of a chirp at 48 kHz stereo (the decode must also resample and downmix, as on a real master)
execFileSync(FF, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.4*sin(2*PI*(200+20*t)*t)|0.3*sin(2*PI*330*t):s=48000:d=40', '-c:a', 'flac', src]);
const ref = (a, b) => {
  const buf = execFileSync(FF, ['-v', 'error', '-i', src, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
  return buf.subarray(Math.round(a * 16000) * 2, Math.round(b * 16000) * 2);
};
const windows = [ { index: 3, start: 12.5, end: 20.25 }, { index: 1, start: 0.0, end: 4.0 }, { index: 2, start: 3.0, end: 9.75 },
  { index: 4, start: 12.5, end: 13.0 }, { index: 5, start: 38.0, end: 42.0 }, { index: 6, start: 45.0, end: 46.0 } ];
(async () => {
  const wdir = path.join(dir, 'windows'); fs.mkdirSync(wdir);
  const inputs = await cutWindowsStreamed(FF, src, windows, wdir);
  let fail = 0;
  for (const w of windows) {
    const f = inputs[`${w.index}.wav`];
    if (!f) { fail++; console.log(`FAIL window ${w.index}: not written`); continue; }
    const got = fs.readFileSync(f).subarray(44);
    const want = Buffer.alloc(Math.round(w.end * 16000) * 2 - Math.round(w.start * 16000) * 2);
    ref(w.start, w.end).copy(want);                    // past the end of the audio stays zero
    if (!got.equals(want)) { fail++; console.log(`FAIL window ${w.index}: ${got.length} bytes vs ${want.length}, not sample-equal`); }
  }
  console.log(`cut-windows: ${windows.length - fail}/${windows.length} passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
