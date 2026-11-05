#!/usr/bin/env node
/**
 * THE PROCESS THAT DIES. `test-m4b-tags.js` runs one tag write here and kills it with no
 * chance to clean up at a named point inside the write, as a power cut or a crash would.
 *
 *   node tools/m4b-kill-child.js <m4b> <checkpoint|none> <title> [cover]
 *
 * Not a keeper itself: `run-keepers.js` runs only the `test-*` names it lists.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = process.env.BF_M4B_REPO || path.resolve(__dirname, '..');
const tags = require(path.join(REPO, 'dist', 'electron', 'narrator', 'assemble', 'm4b-tags.js'));

const [file, killAt, title, coverPath] = process.argv.slice(2);
const cover = coverPath ? { data: fs.readFileSync(coverPath), path: coverPath } : null;
tags.setM4bItems(file, tags.audiobookItems({ title }, cover), {
  probe: tags.ffmpegM4bProbe(process.env.BF_FFMPEG || 'ffmpeg', process.env.BF_FFPROBE || 'ffprobe'),
  checkpoint: (name) => {
    if (name === killAt) process.kill(process.pid, 'SIGKILL');
  },
}).then(() => { process.exitCode = 0; }, (err) => {
  console.error(`${err.code || 'error'}: ${err.message}`);
  process.exitCode = 3;
});
