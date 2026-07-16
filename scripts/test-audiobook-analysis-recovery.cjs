const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const outfile = path.join(os.tmpdir(), `bookforge-analysis-recovery-${process.pid}.cjs`);

function cue(index, text = `Cue ${index} authoritative wording.`) {
  return { index, text, startTime: index, endTime: index + 1 };
}

function makeChunk(cues) {
  return { cues, promptText: cues.map(item => `[${item.index}] ${item.text}`).join('\n') };
}

function defaultClass(error) {
  if (String(error.message).includes('refusal')) {
    return { reason: 'ai-refusal', recoverable: true, splitAllowed: true, retrySameChunk: false };
  }
  return { reason: 'request-error', recoverable: true, splitAllowed: false, retrySameChunk: true };
}

function options(recovery, cues, overrides = {}) {
  return {
    chunk: makeChunk(cues),
    topLevelChunkNumber: 1,
    totalTopLevelChunks: 1,
    existingSkippedCount: 0,
    maxSkippedChunks: 10,
    makeChunk,
    classifyError: defaultClass,
    delay: async () => {},
    analyze: async () => '[]',
    parse: response => recovery.parseAnalysisJsonArray(response),
    ...overrides,
  };
}

(async () => {
  try {
    esbuild.buildSync({
      entryPoints: [path.join(__dirname, '..', 'electron', 'audiobook-analysis-recovery.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
    const recovery = require(outfile);

    assert.deepEqual(
      recovery.parseAnalysisJsonArray('<think>private notes</think>```json\n[{"quote":"bracket ] inside string",}]\n```'),
      [{ quote: 'bracket ] inside string' }],
    );
    assert.throws(() => recovery.parseAnalysisJsonArray('no structured output'), /no complete JSON array/);
    assert.equal(
      recovery.fuzzyQuoteMatchesTranscript(
        'The committee conclusively established three separate violations',
        'The committee established three separate violations during its inquiry.',
      ),
      true,
    );
    assert.equal(
      recovery.fuzzyQuoteMatchesTranscript('A completely unrelated medical assertion', 'The committee discussed municipal budgets.'),
      false,
    );
    const relocated = recovery.locateAudiobookQuoteCueRange(
      'The quoted claim is here',
      [cue(0, 'Unrelated opening.'), cue(1, 'The quoted claim is here.'), cue(2, 'Unrelated close.')],
    );
    assert.deepEqual([relocated.startPosition, relocated.endPosition], [1, 1]);
    assert.equal(
      recovery.locateAudiobookQuoteCueRange(
        'Repeated exact claim',
        [cue(0, 'Repeated exact claim.'), cue(1, 'Middle.'), cue(2, 'Repeated exact claim.')],
      ),
      null,
    );

    const uneven = [cue(0, 'short'), cue(1, 'This is the longest cue by a substantial margin.'), cue(2, 'tail')];
    const split = recovery.splitAudiobookCueChunk(makeChunk(uneven), makeChunk);
    assert.ok(split);
    assert.deepEqual([...split[0].cues, ...split[1].cues], uneven);
    assert.ok(split[0].cues.length > 0 && split[1].cues.length > 0);

    let invalidLeafCalls = 0;
    const invalidLeaf = await recovery.recoverAudiobookAnalysisChunk(options(recovery, [cue(0)], {
      analyze: async () => { invalidLeafCalls++; return '[{"bad":true}]'; },
      parse: () => { throw new Error('quote does not match cue 0'); },
    }));
    assert.equal(invalidLeafCalls, 1);
    assert.equal(invalidLeaf.flags.length, 0);
    assert.equal(invalidLeaf.skippedChunks.length, 1);
    assert.equal(invalidLeaf.skippedChunks[0].reason, 'invalid-response');

    const invalidEvents = [];
    const invalid = await recovery.recoverAudiobookAnalysisChunk(options(recovery, [cue(0), cue(1), cue(2), cue(3)], {
      analyze: async () => '[{"bad":true}]',
      parse: () => { throw new Error('strict cue validation failed'); },
      onEvent: event => invalidEvents.push(event),
    }));
    assert.deepEqual(invalid.skippedChunks.map(item => [item.cueStartIndex, item.cueEndIndex]), [[0, 0], [1, 1], [2, 2], [3, 3]]);
    assert.equal(invalid.requestAttempts, 7);
    assert.ok(invalidEvents.some(event => event.action === 'splitting'));

    let refusalCalls = 0;
    const refused = await recovery.recoverAudiobookAnalysisChunk(options(recovery, [cue(0), cue(1), cue(2), cue(3)], {
      analyze: async () => { refusalCalls++; throw new Error('copyright refusal'); },
    }));
    assert.equal(refusalCalls, 7);
    assert.equal(refused.skippedChunks.length, 4);
    assert.ok(refused.skippedChunks.every(item => item.reason === 'ai-refusal'));

    let textualRefusalCalls = 0;
    const textualRefusal = await recovery.recoverAudiobookAnalysisChunk(options(recovery, [cue(0), cue(1)], {
      analyze: async () => { textualRefusalCalls++; return 'Copyright refusal: I cannot analyze this text.'; },
      classifyInvalidResponse: response => defaultClass(new Error(response)),
    }));
    assert.equal(textualRefusalCalls, 3);
    assert.equal(textualRefusal.skippedChunks.length, 2);
    assert.ok(textualRefusal.skippedChunks.every(item => item.reason === 'ai-refusal'));

    let transientCalls = 0;
    const transient = await recovery.recoverAudiobookAnalysisChunk(options(recovery, [cue(0), cue(1)], {
      analyze: async () => {
        transientCalls++;
        if (transientCalls < 3) throw new Error('temporary connection reset');
        return '[]';
      },
    }));
    assert.equal(transient.requestAttempts, 3);
    assert.equal(transient.skippedChunks.length, 0);

    await assert.rejects(
      recovery.recoverAudiobookAnalysisChunk(options(recovery, [cue(0)], {
        existingSkippedCount: 9,
        analyze: async () => '[{"bad":true}]',
        parse: () => { throw new Error('still invalid'); },
      })),
      error => error instanceof recovery.TooManyAudiobookAnalysisSkipsError
        && error.skippedChunks.length === 1,
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      recovery.recoverAudiobookAnalysisChunk(options(recovery, [cue(0)], { signal: controller.signal })),
      /Job cancelled/,
    );

    console.log('Audiobook analysis recovery tests passed.');
  } finally {
    try { fs.unlinkSync(outfile); } catch { /* already absent */ }
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
