import { afterAll, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/*
 * ASK'S THREAD (Owen, 2026-11-01): *"maybe when it finishes its first run, it
 * 'compacts' by summarizing what it found, and then i can ask more questions
 * about the same subject if i want?"* A run ends with one more request for the
 * model's own note; a follow-up starts from that note, framed as leads to check;
 * a note that cannot be had ends the thread by name and costs the run nothing.
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-ask-thread-'));
mock.module('electron', () => ({app:{getPath:()=>userData,getName:()=> 'Foundry',getVersion:()=> 'test',getAppPath:()=>path.dirname(import.meta.dir),isPackaged:false,on:()=>{},whenReady:async()=>{}},BrowserWindow:class{},dialog:{},ipcMain:{handle:()=>{},on:()=>{}},nativeImage:{},net:{},protocol:{},session:{},shell:{}}));
const ask = await import('../electron/ask-document');
const { askToolbox } = await import('../electron/ask-tools');
const sdk = await import('@crucible/client');
import type { AskThread, AskView } from '../shared/ask';
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

const VIEW: AskView = {
  title: 'A Test Book',
  struck: 0, struckBlocks: [], loose: { numbers: [], notes: [] },
  chapters: [{ id: 'e-1', title: 'One' }],
  blocks: [
    { id: 'e-1', text: 'Chapter One', category: 'Section-header', chapter: 0 },
    { id: 'e-2', text: 'www.example.com/a/b.html', category: 'Text', chapter: 0 },
  ],
};

type Chat = Parameters<import('@crucible/client').CrucibleClient['chat']>[0];

/** A target whose chat answers from a script, and remembers what it was sent. */
function target(answers: ((sent: Chat) => unknown)[]) {
  const sent: Chat[] = [];
  const to = {
    server: 'pc',
    model: 'm',
    local: true,
    window: null,
    session: null,
    client: {
      chat: async (options: Chat) => {
        sent.push(options);
        const next = answers.shift();
        if (next === undefined) throw new Error('the script ran out');
        return next(options);
      },
    },
  } as unknown as ask.Target;
  return { to, sent };
}
const reply = (content: string | null, calls: unknown[] = []) => () => ({
  content, toolCalls: calls, contentBlocks: [], finishReason: calls.length > 0 ? 'tool_calls' : 'stop', usage: null,
});
const quiet = (): void => {};

test('a follow-up opens with the note framed as leads to check, then the person\'s words', () => {
  const thread: AskThread = { format: 'ask-thread/v1', first: 'what should be cut', turns: 2, at: 'x', note: 'e-579 is a URL.' };
  const opening = ask.threadOpening(thread, 'yes, mark e-579');
  expect(opening).toContain('Treat it as leads to check, not facts');
  expect(opening).toContain('<note>\ne-579 is a URL.\n</note>');
  expect(opening).toContain('after 2 questions');
  expect(opening.endsWith('The person now says:\nyes, mark e-579')).toBe(true);
});

test('after the summary, one more request asks for the note, with the tools and the state', async () => {
  const box = askToolbox(VIEW);
  const { to, sent } = target([reply('Nothing to cut.'), reply('Asked what to cut; e-2 is a bare URL, not marked.')]);
  const finished = await ask.loop(to, 'what should be cut', box, new AbortController().signal, quiet);
  expect(finished.text).toBe('Nothing to cut.');
  const noted = await ask.takeNote(to, finished, box, new AbortController().signal, quiet);
  expect(noted).toEqual({ note: 'Asked what to cut; e-2 is a bare URL, not marked.' });
  expect(sent).toHaveLength(2);
  const last = sent[1]!;
  expect(last.tools?.length).toBe(box.tools.length);
  expect(last.maxTokens).toBe(ask.NOTE_MAX_TOKENS);
  const lastMessage = last.messages.at(-1)!;
  expect(lastMessage.role).toBe('user');
  expect(String(lastMessage.content).endsWith(ask.NOTE_ASK)).toBe(true);
  // The summary is in the conversation the note is asked on.
  expect(last.messages.some((m) => m.role === 'assistant' && m.content === 'Nothing to cut.')).toBe(true);
});

test('a note that cannot be had is a sentence, not a failed run; a cancel still cancels', async () => {
  const box = askToolbox(VIEW);
  const refused = target([reply('Done.'), () => { throw new sdk.CrucibleRefused(400, 'invalid_request', 'bad', null); }]);
  const finished = await ask.loop(refused.to, 'q', box, new AbortController().signal, quiet);
  const noted = await ask.takeNote(refused.to, finished, box, new AbortController().signal, quiet);
  expect('problem' in noted && noted.problem).toMatch(/could not be had .* so your next question starts fresh/);

  const empty = target([reply('Done.'), reply('   ')]);
  const again = await ask.loop(empty.to, 'q', box, new AbortController().signal, quiet);
  expect(await ask.takeNote(empty.to, again, box, new AbortController().signal, quiet))
    .toEqual({ problem: 'm wrote no note for a follow-up, so your next question starts fresh.' });

  const abort = new AbortController();
  const cancelled = target([reply('Done.'), () => { abort.abort(); throw new Error('aborted'); }]);
  const third = await ask.loop(cancelled.to, 'q', box, abort.signal, quiet);
  await expect(ask.takeNote(cancelled.to, third, box, abort.signal, quiet)).rejects.toThrow('aborted');
});

test('the thread file: absent is none, it round-trips, and a bad one is refused by name', async () => {
  const file = path.join(userData, 'ops', 'ask-thread.json');
  expect(await ask.readThreadAt(file)).toBeNull();
  const thread: AskThread = { format: 'ask-thread/v1', first: 'q', turns: 1, at: '2026-11-01T00:00:00.000Z', note: 'n' };
  await ask.writeThreadAt(file, thread);
  expect(await ask.readThreadAt(file)).toEqual(thread);
  await expect(ask.writeThreadAt(file, { ...thread, note: '' })).rejects.toThrow(/not one this build can keep/);
  fs.writeFileSync(file, '{"format":"ask-thread/v1"}');
  await expect(ask.readThreadAt(file)).rejects.toThrow(/not an Ask thread this build can read\. Press New question/);
  fs.writeFileSync(file, 'nope');
  await expect(ask.readThreadAt(file)).rejects.toThrow(/is not JSON/);
});

test('a kept run reads every kind of mark, a retyping included, and refuses a malformed one', () => {
  const before = { id: 'e-1', reason: 'r', before: 'B' };
  expect(ask.isAskMark({ ...before, kind: 'strike' })).toBe(true);
  expect(ask.isAskMark({ ...before, kind: 'text', after: 'A' })).toBe(true);
  const retype = { ...before, kind: 'category', from: 'Footnote', to: 'Section-header', chapter: { start: true, title: 'T' }, chapterBefore: null };
  expect(ask.isAskMark(retype)).toBe(true);
  expect(ask.isAskMark({ ...retype, chapter: null, chapterBefore: 'Old' })).toBe(true);
  expect(ask.isAskMark({ ...retype, chapter: { start: false } })).toBe(true);
  expect(ask.isAskMark({ ...retype, chapter: { start: true } })).toBe(false);
  expect(ask.isAskMark({ ...retype, to: undefined })).toBe(false);
  expect(ask.isAskMark({ ...retype, chapterBefore: undefined })).toBe(false);
});
