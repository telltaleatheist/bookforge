#!/usr/bin/env node
/**
 * Tests for the picker's undo/redo history — the ONE block table it names its
 * blocks in, and what a project written before that table existed reads as.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-editor-history.js
 *
 * ── The failure this guards ────────────────────────────────────────────────
 *
 * A `mergeBlocks` history action used to carry a full `TextBlock` for every
 * source it consumed AND for the merged block those sources were joined into —
 * the same characters written down twice, inside a record whose only job is to
 * say which ids became which. Measured on the live library, 2026-08-10: ONE
 * project held a single `mergeBlocks` entry of 15.57 MB (2,923 merge
 * definitions with full block copies), and `MAX_EDITOR_HISTORY` caps the number
 * of ACTIONS at 200, not the number of bytes, so one "merge everything" click
 * was 15 MB of history by itself — rewritten by every autosave and re-synced by
 * Syncthing after each one.
 *
 * What is asserted here is everything that is PURE: the four transitions a
 * merge and a split make to the document's block list, the resolution of ids
 * against the table, what the cap releases, what a project written in the old
 * shape reads as, what an unreadable one does instead of quietly reading as
 * empty, and the SIZE of the record that goes to disk. The Angular service
 * calls these same functions — it holds the table and the signals, and nothing
 * else.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'document', 'editor-history.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const {
  MAX_EDITOR_HISTORY,
  blockIdsReferencedByHistory,
  blockTableFromRecord,
  blocksAfterMerge,
  blocksAfterMergeUndone,
  blocksAfterSplit,
  blocksAfterSplitUndone,
  editorHistoryShape,
  normalizeEditorHistory,
  persistedBlockTable,
  pruneBlockTable,
  requireBlocks,
  reproducibleBlockIds,
  trimUndoStack,
} = require(MODULE);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Fixtures ───────────────────────────────────────────────────────────────

/**
 * A block of roughly the weight the real ones carry — text, geometry, the
 * per-line boxes an OCR block keeps, and the provenance stamps a converted book
 * writes. The size assertion at the bottom is only honest if the thing being
 * counted is the size of a real block.
 */
function block(id, text) {
  return {
    id,
    page: 4,
    x: 72.3, y: 118.45, width: 431.2, height: 52.8,
    text,
    font_size: 10.5,
    font_name: 'AGaramondPro-Regular',
    char_count: text.length,
    region: 'body',
    category_id: 'body',
    seq: Number(id.replace(/\D/g, '')) || 0,
    is_bold: false,
    is_italic: false,
    is_superscript: false,
    is_image: false,
    line_boxes: [
      [72.3, 118.45, 431.2, 13.2], [72.3, 131.65, 431.2, 13.2],
      [72.3, 144.85, 431.2, 13.2], [72.3, 158.05, 428.9, 13.2],
    ],
    ocr_confidence: 0.987,
    bf_group: 'g-000412',
    bf_blocks: ['w-0041', 'w-0042'],
    bf_element: 'OEBPS/ch07.xhtml#118',
    bf_source_page: 132,
  };
}

const SENTENCE =
  'The tribunal had been in session for eleven weeks, and the interpreters had begun to '
  + 'render the word "Endlösung" without pausing over it.';

/** ids → blocks, as the service's table holds them. */
function tableOf(blocks) {
  return new Map(blocks.map(b => [b.id, b]));
}

/** The joined block a merge produces — text is the sources' text, joined. */
function mergedOf(id, sources) {
  return { ...block(id, sources.map(s => s.text).join(' ')), id };
}

// ── The four transitions, driven as a real merge round-trip ────────────────

test('a merge, undone and redone, is the same document both times — by ids alone', () => {
  const [a, b, c, other] = [
    block('src-a', 'The tribunal had been in session'),
    block('src-b', 'for eleven weeks, and the interpreters'),
    block('src-c', 'had begun to render the word without pausing.'),
    block('untouched', 'A block no merge names.'),
  ];
  const merged = mergedOf('merge_1x9', [a, b, c]);
  const table = tableOf([a, b, c, merged]);
  const definition = { mergedBlockId: 'merge_1x9', sourceBlockIds: ['src-a', 'src-b', 'src-c'] };

  // The record that goes on the undo stack holds NOTHING but ids.
  const action = {
    type: 'mergeBlocks',
    blockIds: ['merge_1x9'],
    selectionBefore: ['src-a'],
    selectionAfter: ['merge_1x9'],
    mergeDefinitions: [definition],
  };
  assert.ok(!/"text"|"line_boxes"/.test(JSON.stringify(action)),
    'a merge action must carry no block payload at all');

  const before = [a, b, c, other];
  const afterMerge = blocksAfterMerge(before, [definition], [merged]);
  assert.deepStrictEqual(afterMerge.map(x => x.id).sort(), ['merge_1x9', 'untouched']);

  const undone = blocksAfterMergeUndone(
    afterMerge, [definition], requireBlocks(table, definition.sourceBlockIds, 'undo'));
  assert.deepStrictEqual(undone.map(x => x.id).sort(), ['src-a', 'src-b', 'src-c', 'untouched']);
  // The blocks that came back are the SAME objects, not rebuilt approximations.
  assert.strictEqual(undone.find(x => x.id === 'src-b'), b);

  const redone = blocksAfterMerge(
    undone, [definition], requireBlocks(table, ['merge_1x9'], 'redo'));
  assert.deepStrictEqual(redone.map(x => x.id).sort(), afterMerge.map(x => x.id).sort());
  assert.strictEqual(redone.find(x => x.id === 'merge_1x9'), merged);
});

test('a merge whose source is not in the table REFUSES, naming the block', () => {
  const table = tableOf([block('src-a', 'one')]);
  assert.throws(
    () => requireBlocks(table, ['src-a', 'src-b'], 'undo the merge into merge_1x9'),
    err => /src-b/.test(err.message) && /undo the merge into merge_1x9/.test(err.message),
    'a dangling id must say which id and what was being attempted');
});

test('a split, undone, leaves the document exactly as it was', () => {
  const original = block('orig', SENTENCE);
  const kids = [block('orig-0', 'The tribunal had been in session'), block('orig-1', 'for eleven weeks.')];
  const table = tableOf([original, ...kids]);
  const definition = {
    originalBlockId: 'orig', splitPoints: [1], childBlockIds: ['orig-0', 'orig-1'],
  };

  const action = {
    type: 'splitBlock', blockIds: ['orig'], selectionBefore: ['orig'],
    selectionAfter: ['orig-0', 'orig-1'], splitDefinition: definition,
  };
  assert.ok(!/"text"|"line_boxes"/.test(JSON.stringify(action)),
    'a split action must carry no block payload at all');

  const before = [original];
  const applied = blocksAfterSplit(before, requireBlocks(table, definition.childBlockIds, 'split'));
  assert.deepStrictEqual(applied.map(x => x.id), ['orig', 'orig-0', 'orig-1']);

  const undone = blocksAfterSplitUndone(applied, definition);
  assert.deepStrictEqual(undone.map(x => x.id), ['orig']);

  const redone = blocksAfterSplit(undone, requireBlocks(table, definition.childBlockIds, 'redo'));
  assert.deepStrictEqual(redone.map(x => x.id), ['orig', 'orig-0', 'orig-1']);
});

// ── The cap, and what it releases ──────────────────────────────────────────

test('the cap counts actions, drops the OLDEST, and keeps the newest 200', () => {
  const stack = Array.from({ length: MAX_EDITOR_HISTORY + 3 }, (_, i) => ({
    type: 'delete', blockIds: [`b${i}`], selectionBefore: [], selectionAfter: [],
  }));
  const dropped = trimUndoStack(stack, MAX_EDITOR_HISTORY);
  assert.strictEqual(stack.length, MAX_EDITOR_HISTORY);
  assert.deepStrictEqual(dropped.map(a => a.blockIds[0]), ['b0', 'b1', 'b2']);
  assert.strictEqual(stack[0].blockIds[0], 'b3');
  assert.deepStrictEqual(trimUndoStack(stack, MAX_EDITOR_HISTORY), [],
    'a stack at the cap must not be trimmed again');
});

test('trimming past the cap releases the blocks the dropped action was the last to name', () => {
  const doomed = [block('gone-a', 'one'), block('gone-b', 'two')];
  const kept = [block('kept-a', 'three'), block('kept-b', 'four')];
  const doomedMerge = mergedOf('merge_gone', doomed);
  const keptMerge = mergedOf('merge_kept', kept);
  const table = tableOf([...doomed, ...kept, doomedMerge, keptMerge]);

  const mergeAction = (mergedBlockId, sourceBlockIds) => ({
    type: 'mergeBlocks', blockIds: [mergedBlockId], selectionBefore: [], selectionAfter: [],
    mergeDefinitions: [{ mergedBlockId, sourceBlockIds }],
  });

  // The doomed merge is the OLDEST action, and it was undone (so no live merge
  // record names it any more). Everything after it is filler.
  const stack = [
    mergeAction('merge_gone', ['gone-a', 'gone-b']),
    ...Array.from({ length: MAX_EDITOR_HISTORY }, (_, i) => ({
      type: 'delete', blockIds: [`f${i}`], selectionBefore: [], selectionAfter: [],
    })),
    mergeAction('merge_kept', ['kept-a', 'kept-b']),
  ];
  // The kept merge is still standing, so it is also a LIVE merge record.
  const liveMerges = [{ mergedBlockId: 'merge_kept', sourceBlockIds: ['kept-a', 'kept-b'] }];

  assert.strictEqual(table.size, 6);
  trimUndoStack(stack, MAX_EDITOR_HISTORY);
  const removed = pruneBlockTable(table, stack, [], [], liveMerges).sort();
  assert.deepStrictEqual(removed, ['gone-a', 'gone-b', 'merge_gone'],
    'the blocks only the dropped action named must be collected');
  assert.deepStrictEqual([...table.keys()].sort(), ['kept-a', 'kept-b', 'merge_kept']);
});

test('a block a SURVIVING record still names is never collected', () => {
  const kids = [block('k0', 'a'), block('k1', 'b')];
  const table = tableOf(kids);
  const liveSplit = { originalBlockId: 'orig', splitPoints: [1], childBlockIds: ['k0', 'k1'] };
  // No history at all — the live split record alone must hold them.
  assert.deepStrictEqual(pruneBlockTable(table, [], [], [liveSplit], []), []);
  assert.strictEqual(table.size, 2);

  // And the redo stack counts as much as the undo stack.
  const redoOnly = [{
    type: 'splitBlock', blockIds: ['orig'], selectionBefore: [], selectionAfter: [],
    splitDefinition: liveSplit,
  }];
  assert.deepStrictEqual(pruneBlockTable(tableOf(kids), [], redoOnly, [], []), []);
});

test('the reference set is every id every record names, and nothing else', () => {
  const refs = blockIdsReferencedByHistory(
    [{
      type: 'splitBlock', blockIds: [], selectionBefore: [], selectionAfter: [],
      splitDefinition: { originalBlockId: 'o1', splitPoints: [1], childBlockIds: ['c1', 'c2'] },
    }],
    [{
      type: 'mergeBlocks', blockIds: [], selectionBefore: [], selectionAfter: [],
      mergeDefinitions: [{ mergedBlockId: 'm1', sourceBlockIds: ['s1', 's2'] }],
    }],
    [{ originalBlockId: 'o2', splitPoints: [2], childBlockIds: ['c3'] }],
    [{ mergedBlockId: 'm2', sourceBlockIds: ['s3'] }],
  );
  assert.deepStrictEqual([...refs].sort(),
    ['c1', 'c2', 'c3', 'm1', 'm2', 'o1', 'o2', 's1', 's2', 's3']);
});

// ── Reading a project written before the table existed ─────────────────────

/** The undo entry the old picker wrote for a bulk merge: blocks inside it. */
function embeddedMergeAction(defs) {
  return {
    type: 'mergeBlocks',
    blockIds: defs.map(d => d.merged.id),
    selectionBefore: [],
    selectionAfter: defs.map(d => d.merged.id),
    mergeDefinitions: defs.map(d => ({
      mergedBlockId: d.merged.id,
      sourceBlockIds: d.sources.map(s => s.id),
      sourceBlocks: d.sources,
      mergedBlock: d.merged,
    })),
  };
}

test('the shape is decided by whether a record holds a BLOCK, not by a version number', () => {
  const sources = [block('s1', 'one'), block('s2', 'two')];
  const merged = mergedOf('m1', sources);
  assert.strictEqual(
    editorHistoryShape({ undoStack: [embeddedMergeAction([{ sources, merged }])] }), 'embedded');
  assert.strictEqual(editorHistoryShape({
    undoStack: [{
      type: 'mergeBlocks', blockIds: ['m1'], selectionBefore: [], selectionAfter: [],
      mergeDefinitions: [{ mergedBlockId: 'm1', sourceBlockIds: ['s1', 's2'] }],
    }],
    historyBlocks: {},
  }), 'normalized');
  assert.strictEqual(editorHistoryShape({}), 'empty');
  assert.strictEqual(editorHistoryShape({ undoStack: [], redoStack: [] }), 'empty');
  // A saved text-mode split carried its children inline and nothing else did.
  assert.strictEqual(editorHistoryShape({
    blockSplits: [{
      originalBlockId: 'o', splitPoints: [1], childBlockIds: ['c0', 'c1'],
      textMode: true, childBlocks: [block('c0', 'a'), block('c1', 'b')],
    }],
  }), 'embedded');
});

test('an old-shape project migrates: records become ids, blocks become one table', () => {
  const sources = [block('s1', 'The tribunal had been'), block('s2', 'in session eleven weeks.')];
  const merged = mergedOf('m1', sources);
  const children = [block('c0', 'The tribunal'), block('c1', 'had been in session.')];

  const normalized = normalizeEditorHistory({
    undoStack: [embeddedMergeAction([{ sources, merged }])],
    redoStack: [{
      type: 'splitBlock', blockIds: ['o1'], selectionBefore: [], selectionAfter: ['c0', 'c1'],
      splitDefinition: {
        originalBlockId: 'o1', splitPoints: [1], childBlockIds: ['c0', 'c1'],
        childBlocks: children, textMode: true,
      },
    }],
    blockMerges: [{ mergedBlockId: 'm1', sourceBlockIds: ['s1', 's2'] }],
    blockSplits: [{
      originalBlockId: 'o1', splitPoints: [1], childBlockIds: ['c0', 'c1'],
      textMode: true, childBlocks: children,
    }],
  }, 'projects/Nuremberg/editor-state.json');

  // Every block that was inside a record is now in the table, exactly once.
  assert.deepStrictEqual(Object.keys(normalized.blocks).sort(), ['c0', 'c1', 'm1', 's1', 's2']);
  assert.strictEqual(normalized.blocks.s1.text, 'The tribunal had been');

  // And no record holds one any more.
  const asJson = JSON.stringify({
    undoStack: normalized.undoStack, redoStack: normalized.redoStack,
    blockSplits: normalized.blockSplits, blockMerges: normalized.blockMerges,
  });
  assert.ok(!/"text"|"line_boxes"|sourceBlocks|mergedBlock"|childBlocks/.test(asJson),
    `a normalized record still carries block payload: ${asJson.slice(0, 400)}`);

  // The records themselves are unchanged in meaning.
  assert.deepStrictEqual(normalized.undoStack[0].mergeDefinitions,
    [{ mergedBlockId: 'm1', sourceBlockIds: ['s1', 's2'] }]);
  assert.deepStrictEqual(normalized.blockSplits,
    [{ originalBlockId: 'o1', splitPoints: [1], childBlockIds: ['c0', 'c1'], textMode: true }]);
  assert.strictEqual(normalized.undoStack[0].selectionAfter[0], 'm1');

  // Migrating the result again is a no-op: the shape is already the one it wants.
  const again = normalizeEditorHistory({
    historyBlocks: normalized.blocks,
    undoStack: normalized.undoStack,
    redoStack: normalized.redoStack,
    blockSplits: normalized.blockSplits,
    blockMerges: normalized.blockMerges,
  }, 'projects/Nuremberg/editor-state.json');
  assert.deepStrictEqual(again, normalized);
});

test('a project with no history at all normalizes to empty records and an empty table', () => {
  assert.deepStrictEqual(normalizeEditorHistory({}, 'projects/Untouched/editor-state.json'), {
    blocks: {}, undoStack: [], redoStack: [], blockSplits: [], blockMerges: [],
  });
});

test('an action type this build no longer produces passes through untouched', () => {
  const alien = {
    type: 'someRetiredAction', blockIds: ['x'], selectionBefore: [], selectionAfter: [],
    whateverItCarried: 42,
  };
  const out = normalizeEditorHistory({ undoStack: [alien] }, 'projects/Old/editor-state.json');
  assert.deepStrictEqual(out.undoStack, [alien]);
});

test('a record that is neither shape FAILS LOUDLY, naming the file', () => {
  const FILE = 'projects/Nuremberg/editor-state.json';
  const cases = [
    ['a merge action with no merge records',
      { undoStack: [{ type: 'mergeBlocks', blockIds: [], selectionBefore: [], selectionAfter: [] }] }],
    ['a split action with no split record',
      { undoStack: [{ type: 'splitBlock', blockIds: [], selectionBefore: [], selectionAfter: [] }] }],
    ['an undo stack that is not a list', { undoStack: { 0: 'delete' } }],
    ['an action that is not an object', { undoStack: ['delete'] }],
    ['an action with no type', { undoStack: [{ blockIds: [] }] }],
    ['a merge naming no merged block',
      { blockMerges: [{ sourceBlockIds: ['s1'] }] }],
    ['source ids that are not ids',
      { blockMerges: [{ mergedBlockId: 'm', sourceBlockIds: [{ id: 's1' }] }] }],
    ['embedded sources that are not blocks',
      { blockMerges: [{ mergedBlockId: 'm', sourceBlockIds: ['s'], sourceBlocks: 'nope' }] }],
    ['an embedded block with no id',
      { blockMerges: [{ mergedBlockId: 'm', sourceBlockIds: ['s'], sourceBlocks: [{ text: 'x' }] }] }],
    ['a block table that is not an object', { historyBlocks: [block('a', 'x')] }],
    ['a block filed under someone else\'s id', { historyBlocks: { 'not-a': block('a', 'x') } }],
    ['a split with no line indices',
      { blockSplits: [{ originalBlockId: 'o', splitPoints: 'all', childBlockIds: ['c'] }] }],
  ];
  for (const [what, raw] of cases) {
    assert.throws(
      () => normalizeEditorHistory(raw, FILE),
      err => err.message.includes(FILE) && /has NOT been changed/.test(err.message),
      `${what} must throw, naming ${FILE}`);
  }
});

test('an unreadable history is never quietly read as no history', () => {
  let read = null;
  try {
    read = normalizeEditorHistory(
      { undoStack: [{ type: 'mergeBlocks', blockIds: [], selectionBefore: [], selectionAfter: [] }] },
      'projects/Nuremberg/editor-state.json');
  } catch { /* expected */ }
  assert.strictEqual(read, null, 'a corrupted history must not resolve to an empty one');
});

// ── What goes to disk, and what does not ───────────────────────────────────

test('the persisted table leaves out every block the next open produces again', () => {
  const sources = [block('s1', 'one'), block('s2', 'two')];
  const merged = mergedOf('m1', sources);
  const spanKids = [block('k0', 'a'), block('k1', 'b')];
  const textKids = [block('t0', 'c'), block('t1', 'd')];
  const table = tableOf([...sources, merged, ...spanKids, ...textKids]);

  const merges = [{ mergedBlockId: 'm1', sourceBlockIds: ['s1', 's2'] }];
  const splits = [
    { originalBlockId: 'o-span', splitPoints: [1], childBlockIds: ['k0', 'k1'] },
    { originalBlockId: 'o-text', splitPoints: [1], childBlockIds: ['t0', 't1'], textMode: true },
  ];
  // What is on screen after all that: the merged block, both sets of children,
  // and the two originals (struck out but still in the block list).
  const live = ['m1', 'k0', 'k1', 't0', 't1', 'o-span', 'o-text'];

  const persisted = persistedBlockTable(table, reproducibleBlockIds(live, merges, splits));
  assert.deepStrictEqual(Object.keys(persisted).sort(), [],
    'nothing here needs writing: the analysis and the two restores rebuild all of it');

  // Now undo the merge before saving. Its sources are live again, but nothing
  // rebuilds the merged block — so THAT one has to be written down.
  const afterUndo = ['s1', 's2', 'k0', 'k1', 't0', 't1', 'o-span', 'o-text'];
  const persistedAfterUndo =
    persistedBlockTable(table, reproducibleBlockIds(afterUndo, [], splits));
  assert.deepStrictEqual(Object.keys(persistedAfterUndo), ['m1']);

  // And with no split records live, a text split's children are written and a
  // span split's are not — the span ones come back off the block's spans.
  const bare = persistedBlockTable(table, reproducibleBlockIds(['o-span', 'o-text'], [], [
    { originalBlockId: 'o-span', splitPoints: [1], childBlockIds: ['k0', 'k1'] },
  ]));
  assert.ok(Object.keys(bare).includes('t0') && Object.keys(bare).includes('t1'),
    'a text-mode split has no spans to rebuild its children from');
  assert.ok(!Object.keys(bare).includes('k0'), 'a span split rebuilds its own children');
});

test('a persisted table round-trips back into the in-memory one', () => {
  const b = block('s1', 'one');
  const restored = blockTableFromRecord({ s1: b });
  assert.strictEqual(restored.get('s1'), b);
  assert.strictEqual(restored.size, 1);
});

// ── The size of the thing that used to be 15.57 MB ─────────────────────────

test('a 1,000-merge bulk action is at least 10x smaller than the shape it replaces', () => {
  const COUNT = 1000;
  const oldDefs = [];
  const newDefs = [];
  const table = new Map();
  const live = [];

  for (let i = 0; i < COUNT; i++) {
    const sources = [
      block(`s${i}a`, SENTENCE),
      block(`s${i}b`, SENTENCE),
      block(`s${i}c`, SENTENCE),
    ];
    const merged = mergedOf(`merge_${i}`, sources);
    oldDefs.push({ sources, merged });
    newDefs.push({ mergedBlockId: merged.id, sourceBlockIds: sources.map(s => s.id) });
    for (const s of sources) table.set(s.id, s);
    table.set(merged.id, merged);
    live.push(merged.id);
  }

  // THE OLD SHAPE: one undo entry with every block copied into it, plus the
  // id-only `block_merges` list that had to be written beside it anyway.
  const oldForm = JSON.stringify({
    undo_stack: [embeddedMergeAction(oldDefs)],
    block_merges: newDefs,
  });

  // THE NEW SHAPE: the same records by id, plus whatever of the block table the
  // next open cannot produce for itself — which, for a bulk merge, is nothing.
  const newForm = JSON.stringify({
    undo_stack: [{
      type: 'mergeBlocks',
      blockIds: newDefs.map(d => d.mergedBlockId),
      selectionBefore: [],
      selectionAfter: newDefs.map(d => d.mergedBlockId),
      mergeDefinitions: newDefs,
    }],
    block_merges: newDefs,
    history_blocks: persistedBlockTable(table, reproducibleBlockIds(live, newDefs, [])),
  });

  const ratio = oldForm.length / newForm.length;
  assert.ok(ratio >= 10,
    `expected the normalized record to be at least 10x smaller; it is ${ratio.toFixed(1)}x `
    + `(${(oldForm.length / 1e6).toFixed(2)} MB → ${(newForm.length / 1e3).toFixed(1)} kB)`);
  console.log(
    `      ${(oldForm.length / 1e6).toFixed(2)} MB embedded → `
    + `${(newForm.length / 1e3).toFixed(1)} kB normalized (${ratio.toFixed(0)}x smaller)`);

  // And it still says everything it has to: the same merges, resolvable.
  const onDisk = JSON.parse(newForm);
  const back = normalizeEditorHistory({
    undoStack: onDisk.undo_stack,
    blockMerges: onDisk.block_merges,
    historyBlocks: onDisk.history_blocks,
  }, 'projects/Bulk/editor-state.json');
  assert.strictEqual(back.undoStack[0].mergeDefinitions.length, COUNT);
  assert.deepStrictEqual(back.undoStack[0].mergeDefinitions[7], newDefs[7]);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
