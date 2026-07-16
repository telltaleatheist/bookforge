const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const outfile = path.join(os.tmpdir(), `bookforge-analysis-canonical-${process.pid}.cjs`);
try {
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'electron', 'audiobook-analysis-canonical.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const protocol = require(outfile);
  const first = [
    'WEBVTT', '',
    '00:00:01.250 --> 00:00:02.500',
    'First   spoken line.', '',
    '7',
    '00:00:02.500 --> 00:00:04.000',
    'Second spoken line.', '',
  ].join('\n');
  const whitespaceEquivalent = first
    .replace(/\n/g, '\r\n')
    .replace('First   spoken line.', ' First spoken line. ');

  const cues = protocol.parseAudiobookVttStrict(first);
  const equivalentCues = protocol.parseAudiobookVttStrict(whitespaceEquivalent);
  assert.equal(cues.length, 2);
  assert.deepEqual(
    cues.map(cue => [cue.index, cue.startMs, cue.endMs]),
    [[0, 1250, 2500], [1, 2500, 4000]],
  );
  assert.equal(protocol.digestAudiobookCues(cues), protocol.digestAudiobookCues(equivalentCues));

  const changedTiming = protocol.parseAudiobookVttStrict(first.replace('00:00:04.000', '00:00:04.001'));
  assert.notEqual(protocol.digestAudiobookCues(cues), protocol.digestAudiobookCues(changedTiming));
  const changedText = protocol.parseAudiobookVttStrict(first.replace('Second spoken line.', 'Second altered line.'));
  assert.notEqual(protocol.digestAudiobookCues(cues), protocol.digestAudiobookCues(changedText));
  assert.throws(
    () => protocol.parseAudiobookVttStrict('WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nBad'),
    /end must be after start/,
  );
  const reservedPrefixIds = [
    'WEBVTT', '',
    'NOTE123',
    '00:00:00.000 --> 00:00:01.000',
    'Cue whose identifier starts with NOTE.', '',
    'WEBVTT-cue',
    '00:00:01.000 --> 00:00:02.000',
    'Cue whose identifier starts with WEBVTT.', '',
    'WEBVTT',
    '00:00:02.000 --> 00:00:03.000',
    'Cue whose identifier is exactly WEBVTT.', '',
  ].join('\n');
  assert.equal(protocol.parseAudiobookVttStrict(reservedPrefixIds).length, 3);
  const reservedBlocks = [
    'WEBVTT',
    'Kind: captions', '',
    'NOTE',
    'multiline comment', '',
    'STYLE',
    '::cue { color: lime; }', '',
    'REGION',
    'id:fred', '',
    '00:00:00.000 --> 00:00:01.000',
    'Only real cue.', '',
  ].join('\n');
  assert.equal(protocol.parseAudiobookVttStrict(reservedBlocks).length, 1);
  console.log('Audiobook analysis protocol tests passed.');
} finally {
  try { fs.unlinkSync(outfile); } catch { /* already absent */ }
}
