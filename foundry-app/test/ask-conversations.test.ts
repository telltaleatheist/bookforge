import { afterAll, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/*
 * ASK'S CONVERSATIONS (Owen, 2026-11-02): several per book, each kept. "+"
 * starts one; an old one is gone back to and continued — from its note, or,
 * with none, from its last question and answer; the old single thread migrates
 * once; and delete removes the note and the row, never the book's edits.
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-ask-conv-'));
mock.module('electron', () => ({app:{getPath:()=>userData,getName:()=> 'Foundry',getVersion:()=> 'test',getAppPath:()=>path.dirname(import.meta.dir),isPackaged:false,on:()=>{},whenReady:async()=>{}},BrowserWindow:class{},dialog:{},ipcMain:{handle:()=>{},on:()=>{}},nativeImage:{},net:{},protocol:{},session:{},shell:{}}));
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

const ask = await import('../electron/ask-document');
const conv = await import('../shared/ask-conversations');
import type { AskSession, AskThread } from '../shared/ask';

function run(id: string, at: string, request: string, summary: string, conversation?: string): AskSession {
  return {
    id, at, request, server: 's', model: 'm', summary, items: [], skipped: 0, rounds: 1, seconds: 1,
    ...(conversation === undefined ? {} : { conversation }),
  };
}

function opsWith(sessions: readonly AskSession[], thread: AskThread | null): string {
  const ops = fs.mkdtempSync(path.join(userData, 'ops-'));
  fs.writeFileSync(path.join(ops, 'ask-sessions.jsonl'), sessions.map((one) => JSON.stringify(one)).join('\n') + '\n');
  if (thread !== null) fs.writeFileSync(path.join(ops, 'ask-thread.json'), JSON.stringify(thread));
  return ops;
}

test('the old thread migrates once: its runs become one conversation with its note, older runs one each', async () => {
  const sessions = [
    run('r1', '2026-11-01T10:00:00Z', 'what should be cut for TTS', 'Cut the index.'),
    run('r2', '2026-11-01T11:00:00Z', 'fix the chapters', 'Fixed 12.'),
    run('r3', '2026-11-01T12:00:00Z', 'and the footnotes?', 'Linked 4.'),
  ];
  const thread: AskThread = { format: 'ask-thread/v1', first: 'fix the chapters', turns: 2, at: '2026-11-01T12:00:05Z', note: 'Chapters fixed; footnotes linked.' };
  const ops = opsWith(sessions, thread);
  const all = await ask.readConversationsIn(ops);
  expect(all.map((c) => [c.title, c.turns, c.note])).toEqual([
    ['fix the chapters', 2, 'Chapters fixed; footnotes linked.'],
    ['what should be cut for TTS', 1, null],
  ]);
  expect(conv.runsOf(all[0]!, sessions).map((s) => s.id)).toEqual(['r2', 'r3']);
  expect(conv.runsOf(all[1]!, sessions).map((s) => s.id)).toEqual(['r1']);
  // Written once, and the old thread file gone after it.
  expect(fs.existsSync(path.join(ops, 'ask-conversations.json'))).toBe(true);
  expect(fs.existsSync(path.join(ops, 'ask-thread.json'))).toBe(false);
  expect(await ask.readConversationsIn(ops)).toEqual(all);
});

test('a new conversation is created by its first run, titled by the question, and a second run continues it', async () => {
  const ops = opsWith([], null);
  const first = await ask.keepConversation(ops, null, 'remove the pictures and their captions from this whole book please', { note: 'Struck 40 captions.' });
  expect(first.noteProblem).toBeNull();
  expect(first.conversation.title).toBe('remove the pictures and their captions from this whole book…');
  expect(first.conversation.turns).toBe(1);
  const second = await ask.keepConversation(ops, first.conversation, 'and the URLs?', { note: 'Also 3 URLs.' });
  expect(second.conversation.id).toBe(first.conversation.id);
  expect(second.conversation.turns).toBe(2);
  expect(second.conversation.note).toBe('Also 3 URLs.');
  const other = await ask.keepConversation(ops, null, 'a separate question', { problem: 'The note could not be had.' });
  expect(other.noteProblem).toBe('The note could not be had.');
  expect(other.conversation.note).toBeNull();
  const all = await ask.readConversationsIn(ops);
  expect(all.map((c) => c.id)).toEqual([other.conversation.id, first.conversation.id]);
  // Switching is by id; a conversation deleted meanwhile is refused by name.
  expect((await ask.conversationNamedIn(ops, first.conversation.id)).turns).toBe(2);
});

test('continuing opens with the note; with none, with the last question and answer; with neither, nothing', () => {
  const withNote: Parameters<typeof conv.continuationOf>[0] = {
    id: 'a', title: 't', createdAt: 'x', updatedAt: 'x', turns: 2, note: 'e-579 is a URL.',
  };
  const opened = conv.continuationOf(withNote, [], 'yes, mark it');
  expect(opened).toContain('<note>\ne-579 is a URL.\n</note>');
  expect(opened).toContain('after 2 questions');
  expect(opened!.endsWith('The person now says:\nyes, mark it')).toBe(true);

  const noNote = { ...withNote, note: null };
  const runs = [run('r1', 'x', 'first question', 'first answer', 'a'), run('r2', 'y', 'what is on p. 4?', 'A list of names.', 'a')];
  const fromRuns = conv.continuationOf(noNote, runs, 'and p. 5?');
  expect(fromRuns).toContain('No working note was kept');
  expect(fromRuns).toContain('<question>\nwhat is on p. 4?\n</question>');
  expect(fromRuns).toContain('<answer>\nA list of names.\n</answer>');
  expect(fromRuns!.endsWith('The person now says:\nand p. 5?')).toBe(true);
  expect(conv.continuationOf(noNote, [], 'x')).toBeNull();
});

test('delete removes the conversation and its note, and the runs stay kept; rename retitles', async () => {
  const ops = opsWith([run('r1', '2026-11-01T10:00:00Z', 'q1', 'a1')], null);
  const [only] = await ask.readConversationsIn(ops);
  const kept = await ask.keepConversation(ops, null, 'q2', { note: 'n' });
  const renamed = await ask.updateConversationsIn(ops, (all) => all.map((c) => (c.id === kept.conversation.id ? { ...c, title: 'Pictures' } : c)));
  expect(renamed.find((c) => c.id === kept.conversation.id)!.title).toBe('Pictures');
  const left = await ask.updateConversationsIn(ops, (all) => all.filter((c) => c.id !== only!.id));
  expect(left.map((c) => c.id)).toEqual([kept.conversation.id]);
  await expect(ask.conversationNamedIn(ops, only!.id)).rejects.toThrow('no longer kept with this book');
  // The runs file is untouched: the book's edits and their review stay.
  expect((await ask.readSessionsAt(path.join(ops, 'ask-sessions.jsonl'))).map((s) => s.id)).toEqual(['r1']);
});

test('a run kept with its conversation id reads back, and one with a bad id is refused', () => {
  expect(conv.isConversation({ id: 'a', title: 't', createdAt: 'x', updatedAt: 'x', turns: 1, note: null })).toBe(true);
  expect(conv.isConversation({ id: '', title: 't', createdAt: 'x', updatedAt: 'x', turns: 1, note: null })).toBe(false);
  expect(conv.migrateConversations(null, [run('r1', 'x', 'q', 'a', 'already')])).toEqual([]);
});
