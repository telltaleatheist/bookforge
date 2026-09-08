#!/usr/bin/env node
/**
 * Keeper for cli/clean-lines-step.js — a file of lines through the narration
 * text cleanup, one process, written back by position.
 *
 *   node tools/test-clean-lines.js
 *
 * Loads no compiled module and spawns no foundry: the run is driven with an
 * injected engine that answers the way `foundry clean-text --book` does (one
 * records row per block, keyed by the block id), so this checks the book file
 * this side WRITES and the zip this side READS, which are the two halves that
 * are ours.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const step = require(path.join(__dirname, '..', 'cli', 'clean-lines-step.js'));

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bf-clean-lines-'));

(async () => {
  console.log('the input: one item per line, numbered by EVERY line');
  await check('blank lines are skipped as items but keep their line numbers; a trailing newline is not an item', () => {
    const parsed = step.parseLines('one\n\nthree\r\nfour\n');
    assert.strictEqual(parsed.total, 4);
    assert.deepStrictEqual(parsed.items, [
      { line: 1, text: 'one' }, { line: 3, text: 'three' }, { line: 4, text: 'four' },
    ]);
  });

  console.log('the book file: version 3, one Text block per line, parts covering the whole line');
  await check('every header field the parser requires is present, and every row carries its parts', () => {
    const text = step.bookFileFor([{ line: 2, text: 'In 1994 we met.' }], { engine: '1.4.0', language: 'en' });
    const [head, ...rows] = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(head.book, step.BOOK_FILE_VERSION);
    assert.strictEqual(head.engine, '1.4.0');
    assert.strictEqual(head.language, 'en');
    assert.deepStrictEqual(Object.keys(head.source).sort(), ['bankSha', 'pages', 'unreadable']);
    assert.deepStrictEqual(head.chapters, []);
    assert.strictEqual(head.typography, null, 'null where nothing was measured, never absent');
    assert.deepStrictEqual(head.seams, []);
    assert.deepStrictEqual(head.loose, { markers: [], notes: [] });
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.id, 'e-2', 'the id is the line number, in a shape Foundry mints');
    assert.strictEqual(row.category, 'Text');
    assert.strictEqual(row.text, 'In 1994 we met.');
    assert.deepStrictEqual(row.parts, [{ src: 'lines', page: 1, chars: [0, 'In 1994 we met.'.length] }]);
    assert.ok(row.box && typeof row.page === 'number' && Array.isArray(row.pages));
  });
  await check('two different inputs never share a bankSha', () => {
    const a = JSON.parse(step.bookFileFor([{ line: 1, text: 'a' }], { engine: '1', language: 'en' }).split('\n')[0]);
    const b = JSON.parse(step.bookFileFor([{ line: 1, text: 'b' }], { engine: '1', language: 'en' }).split('\n')[0]);
    assert.notStrictEqual(a.source.bankSha, b.source.bankSha);
  });
  await check('a missing engine or language is refused by name', () => {
    assert.throws(() => step.bookFileFor([], { language: 'en' }), /engine/);
    assert.throws(() => step.bookFileFor([], { engine: '1' }), /language/);
  });

  console.log('the zip: the newest record per line wins, positions are kept, a missing line is refused');
  await check('output has as many lines as the input; blank lines stay blank; newest row wins', () => {
    const parsed = step.parseLines('one\n\nthree\n');
    const records = [
      { key: 'k1', parts: 'e-1', text: 'stale' },
      { key: 'k2', parts: 'e-1', text: 'One.' },
      { key: 'k3', parts: 'e-3', text: 'three' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n';
    const zipped = step.zipRecords(parsed, records);
    assert.deepStrictEqual(zipped.lines, ['One.', '', 'three']);
    assert.strictEqual(zipped.changed, 1);
  });
  await check('a line the pass wrote no answer for is refused by line number, not copied through', () => {
    const parsed = step.parseLines('one\ntwo\n');
    const records = JSON.stringify({ key: 'k', parts: 'e-1', text: 'one' }) + '\n';
    assert.throws(() => step.zipRecords(parsed, records), /line\(s\) 2/);
  });
  await check('an answer holding a line break cannot be written by position and is refused', () => {
    const parsed = step.parseLines('one\n');
    assert.throws(
      () => step.zipRecords(parsed, JSON.stringify({ key: 'k', parts: 'e-1', text: 'o\nne' }) + '\n'),
      /line break/);
  });

  console.log('the run: one spawn, the app\'s settings, the output written by position');
  await check('runCleanLines writes the book file, spawns clean-text --book once, and zips the records back', async () => {
    const dir = fresh();
    const input = path.join(dir, 'lines.txt');
    fs.writeFileSync(input, 'Chapter 1 begins.\n\nHe paid $5.\n', 'utf8');
    const output = path.join(dir, 'lines.cleaned.txt');
    const spawns = [];
    const deps = {
      foundryVersion: async () => ({ version: '1.4.0', path: 'C:\\fake\\foundry.exe' }),
      foundryVersionAtLeast: (v, min) => v >= min,
      FOUNDRY_VERSION_FOR_CLEAN_TEXT: '1.1.0',
      cleanTextEngineSettings: async () => ({ model: 'm', endpoint: 'http://x:1', source: 'the test' }),
      parseCleanTextProgress: (line) => {
        const m = /^clean-text:\s+(\d+)\/(\d+)$/.exec(line.trim());
        return m ? { done: Number(m[1]), total: Number(m[2]) } : null;
      },
      runFoundry: async (args, opts) => {
        spawns.push(args);
        const at = (flag) => args[args.indexOf(flag) + 1];
        assert.strictEqual(args[0], 'clean-text');
        const book = fs.readFileSync(at('--book'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert.strictEqual(book.length, 3, 'a header and two blocks — the blank line is not a block');
        assert.strictEqual(at('--model'), 'm');
        assert.strictEqual(at('--endpoint'), 'http://x:1');
        assert.ok(!args.includes('--keep-model'));
        opts.onProgress('clean-text: 1/2\n');
        const rows = book.slice(1).map((row) => JSON.stringify({
          key: 'k', parts: row.id, text: row.text.replace('$5', 'five dollars').replace('Chapter 1', 'Chapter one'),
        }));
        fs.writeFileSync(at('--records'), rows.join('\n') + '\n', 'utf8');
        fs.writeFileSync(`${at('--records')}.receipt.json`, JSON.stringify({
          model: 'm', normalizerVersion: 'n6', punctuationSpec: 's1', unitsAsked: 2, unitsParseFailed: 0,
          dispositions: { APPLIED_RULE: 2 },
        }), 'utf8');
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const logged = [];
    const result = await step.runCleanLines(
      { inputPath: input, outputPath: output, language: 'en', log: (l) => logged.push(l) }, deps);
    assert.strictEqual(spawns.length, 1, 'one process for the whole file');
    assert.strictEqual(fs.readFileSync(output, 'utf8'), 'Chapter one begins.\n\nHe paid five dollars.\n');
    assert.strictEqual(result.lines, 2);
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.changed, 2);
    assert.strictEqual(result.resumed, false);
    assert.ok(logged.some((l) => l.includes('[clean-lines] 1/2')), 'the engine\'s count is relayed');
    assert.ok(fs.existsSync(path.join(step.workDirFor(output), 'lines.book.jsonl')));
    // A second run finds the records and says so.
    const again = await step.runCleanLines(
      { inputPath: input, outputPath: output, language: 'en', log: () => {} }, deps);
    assert.strictEqual(again.resumed, true);
  });
  await check('a foundry older than clean-text --book is refused before anything is spawned', async () => {
    const dir = fresh();
    const input = path.join(dir, 'lines.txt');
    fs.writeFileSync(input, 'x\n', 'utf8');
    let spawned = false;
    await assert.rejects(step.runCleanLines(
      { inputPath: input, outputPath: path.join(dir, 'o.txt'), language: 'en', log: () => {} },
      {
        foundryVersion: async () => ({ version: '1.0.0', path: 'f' }),
        foundryVersionAtLeast: (v, min) => v >= min,
        FOUNDRY_VERSION_FOR_CLEAN_TEXT: '1.1.0',
        cleanTextEngineSettings: async () => ({ model: 'm', endpoint: 'e', source: 's' }),
        parseCleanTextProgress: () => null,
        runFoundry: async () => { spawned = true; return { code: 0, stdout: '', stderr: '' }; },
      }), /predates clean-text --book/);
    assert.strictEqual(spawned, false);
  });
  await check('an engine exit that is not 0 is the run\'s failure, with what it said', async () => {
    const dir = fresh();
    const input = path.join(dir, 'lines.txt');
    fs.writeFileSync(input, 'x\n', 'utf8');
    await assert.rejects(step.runCleanLines(
      { inputPath: input, outputPath: path.join(dir, 'o.txt'), language: 'en', log: () => {} },
      {
        foundryVersion: async () => ({ version: '1.4.0', path: 'f' }),
        foundryVersionAtLeast: () => true,
        FOUNDRY_VERSION_FOR_CLEAN_TEXT: '1.1.0',
        cleanTextEngineSettings: async () => ({ model: 'm', endpoint: 'e', source: 's' }),
        parseCleanTextProgress: () => null,
        runFoundry: async () => ({ code: 3, stdout: '', stderr: 'the model is not pulled' }),
      }), /exited 3[\s\S]*the model is not pulled/);
  });
  await check('an empty input and an output equal to the input are refused', async () => {
    const dir = fresh();
    const input = path.join(dir, 'lines.txt');
    fs.writeFileSync(input, '\n\n', 'utf8');
    const deps = {
      foundryVersion: async () => ({ version: '1.4.0', path: 'f' }), foundryVersionAtLeast: () => true,
      FOUNDRY_VERSION_FOR_CLEAN_TEXT: '1.1.0', cleanTextEngineSettings: async () => ({}),
      parseCleanTextProgress: () => null, runFoundry: async () => ({ code: 0, stdout: '', stderr: '' }),
    };
    await assert.rejects(step.runCleanLines({ inputPath: input, outputPath: path.join(dir, 'o.txt'), language: 'en', log: () => {} }, deps), /no non-blank lines/);
    await assert.rejects(step.runCleanLines({ inputPath: input, outputPath: input, language: 'en', log: () => {} }, deps), /must not be the input/);
  });

  if (failed) { console.log(`\n${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\nAll clean-lines checks passed.');
})();
