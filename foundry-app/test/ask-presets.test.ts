import { afterAll, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/*
 * ASK'S PRESETS (Owen, 2026-11-02): kept in app settings, checked in a modal,
 * and Send runs the checked ones one after another in list order — each later
 * step reading the book with the earlier steps' changes pending on it.
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-ask-presets-'));
mock.module('electron', () => ({app:{getPath:()=>userData,getName:()=> 'Foundry',getVersion:()=> 'test',getAppPath:()=>path.dirname(import.meta.dir),isPackaged:false,on:()=>{},whenReady:async()=>{}},BrowserWindow:class{},dialog:{},ipcMain:{handle:()=>{},on:()=>{}},nativeImage:{},net:{},protocol:{},session:{},shell:{}}));
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

const settings = await import('../electron/app-settings');
const presets = await import('../shared/ask-presets');
const { askToolbox } = await import('../electron/ask-tools');
const { askViewOf, askRowStates, planLanding, reviewOf } = await import('../shared/ask');
const { replayOps } = await import('../shared/ops');
import type { AskSession } from '../shared/ask';
import type { BookOp } from '../shared/ops';
import type { BookRow } from '../shared/book';

test('the defaults are the four jobs, in run order, each a full instruction naming its tools', () => {
  expect(presets.DEFAULT_ASK_PRESETS.map((p) => p.label))
    .toEqual(['Correct chapters', 'Front & back matter', 'Pictures, captions & web addresses', 'Footnotes']);
  const [chapters, matter, pictures, notes] = presets.DEFAULT_ASK_PRESETS;
  expect(chapters!.question).toContain('rename_chapter');
  expect(chapters!.question).toContain('Do NOT mark the table of contents');
  expect(matter!.question).toContain('highlight');
  expect(pictures!.question).toContain('join');
  expect(notes!.question).toContain('link_footnote');
  for (const p of presets.DEFAULT_ASK_PRESETS) expect(p.description.length).toBeGreaterThan(0);
});

test('presets and the checked set persist in app settings; null restores the defaults', () => {
  expect(settings.readAppSettings().askPresets).toBeNull();
  expect(settings.readAppSettings().askPresetsChecked).toBeNull();
  const mine = [
    { ...presets.DEFAULT_ASK_PRESETS[1]!, label: 'Matter, my way' },
    { id: 'mine:1', label: 'Numbers', description: '', question: 'Spell out the numbers.' },
  ];
  settings.writeAppSettings({ askPresets: mine, askPresetsChecked: ['mine:1'] });
  const file = path.join(userData, 'app-settings.json');
  // Written whole, through the temp file, which is gone afterwards.
  expect(fs.existsSync(`${file}.writing`)).toBe(false);
  const back = settings.readAppSettings();
  expect(back.askPresets).toEqual(mine);
  expect(back.askPresetsChecked).toEqual(['mine:1']);
  // Another setting written later leaves the presets alone.
  settings.writeAppSettings({ setupCompleted: true });
  expect(settings.readAppSettings().askPresets).toEqual(mine);
  settings.writeAppSettings({ askPresets: null });
  expect(settings.readAppSettings().askPresets).toBeNull();
  expect(presets.askPresetsOrDefaults(settings.readAppSettings().askPresets)).toBe(presets.DEFAULT_ASK_PRESETS);
  expect(settings.readAppSettings().askPresetsChecked).toEqual(['mine:1']);
});

test('a stored list is made legal: no label or question, a repeated id, old entries without a description', () => {
  expect(presets.clampAskPresets([
    { id: 'a', label: '  Two   words ', question: 'Q' },
    { id: 'a', label: 'again', description: 'x', question: 'Q2' },
    { id: 'b', label: '', question: 'Q' },
    { id: 'c', label: 'C', question: '   ' },
    'junk',
  ])).toEqual([{ id: 'a', label: 'Two words', description: '', question: 'Q' }]);
  expect(presets.clampAskPresets('nope')).toBeNull();
  expect(presets.clampCheckedPresets(['a', 'a', 3, 'b'])).toEqual(['a', 'b']);
});

test('the checked presets run in the list\'s order, which the person can change', () => {
  const list = [...presets.DEFAULT_ASK_PRESETS].reverse();
  expect(presets.checkedSteps(list, new Set(['builtin:chapters', 'builtin:footnotes'])).map((p) => p.id))
    .toEqual(['builtin:footnotes', 'builtin:chapters']);
});

test('a chain runs every step in order, says where it is, and ends with a sentence', () => {
  const chain = new presets.AskChain('c1', presets.DEFAULT_ASK_PRESETS.slice(0, 3));
  expect(chain.said()).toBe('Presets: step 1 of 3 — Correct chapters');
  expect(chain.current()!.step).toEqual({ chain: 'c1', step: 'Correct chapters', index: 1, of: 3 });
  const two = chain.ended({ state: 'done' });
  expect('next' in two && two.next.preset.label).toBe('Front & back matter');
  expect(chain.said()).toBe('Presets: step 2 of 3 — Front & back matter');
  chain.ended({ state: 'done' });
  expect(chain.ended({ state: 'done' })).toEqual({ over: 'All 3 presets ran.' });
  expect(chain.said()).toBeNull();
});

test('a failed step stops the chain and names it; the steps before stay', () => {
  const chain = new presets.AskChain('c2', presets.DEFAULT_ASK_PRESETS);
  chain.ended({ state: 'done' });
  const over = chain.ended({ state: 'failed', message: 'the server went away.' });
  expect(over).toEqual({ over: 'The presets stopped at step 2 of 4 (Front & back matter), which failed: the server went away. The steps before it stay on the book.' });
  expect(chain.current()).toBeNull();
});

test('one Stop ends the chain: the running step\'s end starts nothing more, even if it finished', () => {
  const chain = new presets.AskChain('c3', presets.DEFAULT_ASK_PRESETS);
  chain.cancel();
  expect(chain.said()).toBeNull();
  const over = chain.ended({ state: 'done' });
  expect('over' in over && over.over).toBe('The presets were stopped at step 1 of 4 (Correct chapters); 3 later steps were not run. The steps that finished stay on the book.');
});

/*
 * THE LATER STEP SEES THE EARLIER ONE. AskService lands a step's marks on the
 * pane's pending stack and only then starts the next step from the pane's
 * replay; this is that sequence over the pure parts: step 1's plan, replayed
 * with the person's own pending ops, read back as the view step 2 is given.
 */
test('a later step reads the book with the earlier step\'s changes pending, and does not redo them', () => {
  const BOX = { x1: 0, y1: 0, x2: 0, y2: 0 };
  const row = (id: string, category: string, text: string): BookRow => ({
    id, category, text, page: 0, pages: [0], box: BOX, pageWidth: 0, pageHeight: 0,
    parts: [{ src: id, page: 0, chars: [0, text.length] }],
  }) as BookRow;
  const rows = [
    row('b-1', 'Section-header', 'Contents'),
    row('b-2', 'Text', 'The river rose and the town'),
    row('b-3', 'Picture', '[Picture]'),
    row('b-4', 'Text', 'watched from the bridge.'),
  ];
  const chapters = [{ id: 'b-1', title: 'Contents' }];
  const pending: BookOp[] = [{ op: 'text', id: 'b-4', text: 'watched it from the bridge.' }]; // the person's own edit

  const book1 = replayOps(rows, pending, { markers: [], notes: [] }, chapters);
  const step1 = askToolbox(askViewOf(book1, 'Book'));
  step1.call('mark', JSON.stringify({ ids: ['b-3'], reason: 'picture' }));
  step1.call('join', JSON.stringify({ id: 'b-4', reason: 'broken by a picture' }));
  const landed = planLanding(step1.items(), askRowStates(book1.rows, book1.chapters), false);
  expect(landed.skipped).toEqual([]);
  pending.push(...landed.ops);

  const book2 = replayOps(rows, pending, { markers: [], notes: [] }, chapters);
  const view2 = askViewOf(book2, 'Book');
  expect(view2.struckBlocks.map((b) => b.id)).toEqual(['b-3']);
  expect(view2.blocks.map((b) => b.text)).toEqual(['Contents', 'The river rose and the town watched it from the bridge.']);
  const step2 = askToolbox(view2);
  expect(step2.call('mark', JSON.stringify({ ids: ['b-3'], reason: 'again' })).content).toContain('not live blocks: b-3');
  expect(step2.call('join', JSON.stringify({ id: 'b-4', reason: 'again' })).content).toContain('there is no live block b-4');
});

test('review shows every step of a chain together, each group labelled with its step, each row its own', () => {
  const base = { at: '2026-11-02T00:00:00Z', server: 's', model: 'm', summary: '', skipped: 0, rounds: 1, seconds: 1 };
  const one: AskSession = {
    ...base, id: 'r1', request: 'q1', items: [{ id: 'e-1', kind: 'strike', reason: 'contents', before: 'x' }],
    chain: { chain: 'c', step: 'Correct chapters', index: 1, of: 2 },
  };
  const two: AskSession = {
    ...base, id: 'r2', request: 'q2', items: [{ id: 'e-1', kind: 'strike', reason: 'contents', before: 'x' }], skipped: 2,
    chain: { chain: 'c', step: 'Front & back matter', index: 2, of: 2 },
  };
  const earlier: AskSession = { ...base, id: 'r0', request: 'plain', items: [] };
  const review = reviewOf([earlier, one, two], two);
  expect(review.request).toBe('Presets: Correct chapters, Front & back matter');
  expect(review.groups.map((g) => g.reason)).toEqual(['Correct chapters — contents', 'Front & back matter — contents']);
  expect(review.items.length).toBe(2);
  expect(review.skipped).toBe(2);
  expect(review.keyOf(one.items[0]!)).not.toBe(review.keyOf(two.items[0]!));
  expect(reviewOf([earlier], earlier).request).toBe('plain');
});
