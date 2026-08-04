#!/usr/bin/env node
/**
 * The picker's deletion write path, run on Angular's own reactive primitives.
 *
 *   node tools/test-deletion-write-path.js
 *
 * Curation used to land deletions by watching `editorState.deletedBlockIds` from
 * an effect and writing the DIFFERENCE between it and the document's set. On the
 * Kershaw working file that produced 210 category annotations and zero deletion
 * flags, ever. The arithmetic in that effect was not wrong — the first test here
 * shows it landing a deletion perfectly when nothing else is happening. What is
 * wrong is inferring an edit from a comparison at all.
 *
 * The mirror that paints the document's answer back into the editor is
 * registered before the bridge, and Angular runs a view's effects in the order
 * they were created, repeatedly, while any of them is dirty
 * (`runEffectsInView`). So in any pass where the document side has ALSO changed
 * — a relabel, a merge, a re-read after a refused write — the mirror overwrites
 * the editor's set first and the bridge then compares two identical sets and
 * writes nothing. A diff has no record of intent, so it cannot tell a deletion
 * the user has just made from one the mirror has already painted over, and it
 * reads the difference either way in silence.
 *
 * These are Angular's real `runEffect`, `createSignal` and `untracked` out of
 * @angular/core, driven by Angular's own flush loop, so the ordering under test
 * is the framework's and not a description of it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const PRIMITIVES = path.join(
  REPO, 'node_modules', '@angular', 'core', 'fesm2022', 'primitives-signals.mjs');
if (!fs.existsSync(PRIMITIVES)) {
  console.error('Install first: @angular/core is not in node_modules');
  process.exit(1);
}

let passed = 0;
const failures = [];

(async () => {
  const ng = await import(pathToFileURL(PRIMITIVES).href);
  const { BASE_EFFECT_NODE, createSignal, runEffect, untracked } = ng;

  /**
   * One component view's effects, flushed the way Angular flushes them.
   *
   * `runEffectsInView`: iterate the view's effect set in CREATION order, run
   * every dirty one, and go round again while any of them dirtied another.
   */
  function makeView() {
    const effects = new Set();
    const view = { dirty: false };
    const NODE = {
      ...BASE_EFFECT_NODE,
      consumerMarkedDirty() { view.dirty = true; },
      cleanup() {},
    };
    return {
      effect(fn) {
        const node = Object.create(NODE);
        node.fn = fn;
        node.dirty = true;
        effects.add(node);
        view.dirty = true;
        return node;
      },
      flush() {
        let again = true;
        let guard = 0;
        while (again) {
          if (guard++ > 500) throw new Error('the effects never settled');
          let ranOne = false;
          view.dirty = false;
          for (const node of effects) {
            if (!node.dirty) continue;
            ranOne = true;
            runEffect(node);
          }
          again = ranOne && view.dirty;
        }
      },
    };
  }

  function sig(value) {
    const [get, set] = createSignal(value);
    get.set = set;
    return get;
  }

  /** The service: its own copy of the flags, and the edits it has queued. */
  function makeDocument() {
    const deletedBlockIds = sig(new Set());
    const blocks = sig([]);
    const queued = [];
    return {
      deletedBlockIds,
      blocks,
      queued,
      setDeleted(id, deleted) {
        const next = new Set(deletedBlockIds());
        if (deleted) next.add(id); else next.delete(id);
        deletedBlockIds.set(next);
        queued.push({ kind: deleted ? 'delete' : 'restore', blockId: id });
      },
      relabel(id, category) {
        blocks.set([...blocks(), { id, category }]);
        queued.push({ kind: 'relabel', blockId: id, category });
      },
    };
  }

  /** The picker, wired the way it was: mirror first, bridge second. */
  function pickerWithBridge() {
    const view = makeView();
    const doc = makeDocument();
    const editorDeleted = sig(new Set());
    const blockLayerRead = sig(false);

    view.effect(() => {
      if (!blockLayerRead()) return;
      doc.blocks();
      const deleted = doc.deletedBlockIds();
      untracked(() => { editorDeleted.set(new Set(deleted)); });
    });
    view.effect(() => {
      if (!blockLayerRead()) return;
      const wanted = editorDeleted();
      untracked(() => {
        const landed = doc.deletedBlockIds();
        for (const id of wanted) if (!landed.has(id)) doc.setDeleted(id, true);
        for (const id of landed) if (!wanted.has(id)) doc.setDeleted(id, false);
      });
    });

    view.flush();
    blockLayerRead.set(true);
    view.flush();
    return { view, doc, editorDeleted };
  }

  /** The picker, wired the way it is: the gesture writes, the mirror paints. */
  function pickerWithDirectWrites() {
    const view = makeView();
    const doc = makeDocument();
    const editorDeleted = sig(new Set());
    const blockLayerRead = sig(false);

    view.effect(() => {
      if (!blockLayerRead()) return;
      doc.blocks();
      const deleted = doc.deletedBlockIds();
      untracked(() => { editorDeleted.set(new Set(deleted)); });
    });

    view.flush();
    blockLayerRead.set(true);
    view.flush();

    return {
      view,
      doc,
      editorDeleted,
      // deleteBlock: the editor records it AND the document is told, here, now.
      deleteBlock(id) {
        editorDeleted.set(new Set([...editorDeleted(), id]));
        doc.setDeleted(id, true);
      },
    };
  }

  const test = (name, fn) => {
    try {
      fn();
      passed++;
    } catch (err) {
      failures.push(`${name}: ${err && err.message ? err.message : err}`);
    }
  };

  // ───────────────────────────────────────────────────────────────────────────

  test('the bridge lands a deletion when nothing else is happening', () => {
    const p = pickerWithBridge();
    p.editorDeleted.set(new Set(['b3']));
    p.view.flush();
    assert.deepStrictEqual(p.doc.queued, [{ kind: 'delete', blockId: 'b3' }],
      'the diff arithmetic is not what was wrong');
  });

  test('the bridge DROPS a deletion made in the same pass as a document change', () => {
    const p = pickerWithBridge();
    // A relabel and a deletion inside one change-detection pass. The mirror is
    // registered first, so it runs first, and what it writes into the editor is
    // the document's set — which does not have b3 in it yet.
    p.doc.relabel('b1', 'footnote');
    p.editorDeleted.set(new Set(['b3']));
    p.view.flush();

    const deletions = p.doc.queued.filter((e) => e.kind === 'delete');
    assert.strictEqual(deletions.length, 0,
      'this is the bug: the deletion was destroyed before the bridge could read it');
    assert.strictEqual(p.doc.queued.length, 1, 'and the relabel beside it landed fine');
    assert.strictEqual(p.editorDeleted().has('b3'), false,
      'nothing on screen says the deletion is gone either');
  });

  test('a direct write survives the same interleaving', () => {
    const p = pickerWithDirectWrites();
    p.doc.relabel('b1', 'footnote');
    p.deleteBlock('b3');
    p.view.flush();

    assert.deepStrictEqual(
      p.doc.queued,
      [{ kind: 'relabel', blockId: 'b1', category: 'footnote' },
        { kind: 'delete', blockId: 'b3' }],
      'the edit was made when the gesture was, so there was nothing to infer'
    );
    assert.strictEqual(p.doc.deletedBlockIds().has('b3'), true);
    assert.strictEqual(p.editorDeleted().has('b3'), true,
      'and the mirror paints the document back, which now agrees');
  });

  test('a direct write survives a bulk deletion beside a document change', () => {
    const p = pickerWithDirectWrites();
    p.doc.relabel('b1', 'footnote');
    for (const id of ['b2', 'b3', 'b4']) p.deleteBlock(id);
    p.view.flush();

    assert.deepStrictEqual(
      p.doc.queued.filter((e) => e.kind === 'delete').map((e) => e.blockId),
      ['b2', 'b3', 'b4'],
      'every id the gesture named, in the order it named them'
    );
    assert.deepStrictEqual([...p.editorDeleted()].sort(), ['b2', 'b3', 'b4']);
  });

  test('a direct restore is a restore, not a diff that could read as one', () => {
    const p = pickerWithDirectWrites();
    p.deleteBlock('b3');
    p.view.flush();
    p.doc.setDeleted('b3', false);
    p.editorDeleted.set(new Set());
    p.view.flush();

    assert.deepStrictEqual(
      p.doc.queued,
      [{ kind: 'delete', blockId: 'b3' }, { kind: 'restore', blockId: 'b3' }]
    );
    assert.strictEqual(p.doc.deletedBlockIds().size, 0);
  });

  if (failures.length) {
    console.error(`\n${failures.length} FAILURE(S):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`deletion write path: ${passed} test(s) passed`);
})();
