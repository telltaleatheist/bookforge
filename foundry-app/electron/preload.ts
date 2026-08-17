/**
 * preload — the whole surface the renderer is allowed to touch.
 *
 * `window.foundry`, and nothing else. The renderer has no Node, no `require`,
 * no filesystem: it names a path and main decides whether that path is a thing
 * this app will open. The interface itself lives in shared/api.ts so the
 * renderer is typed against the same declaration this implements.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { FoundryApi, MenuAction } from '../shared/api';
import type {
  AppQuestion,
  Asked,
  CloseAnswer,
  EnvInstallProgress,
  Job,
  QuestionAnswer,
  ReReadAnswer,
  ServerStatus,
  SetupLogEvent,
} from '../shared/types';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: unknown, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => { ipcRenderer.removeListener(channel, wrapped); };
}

/**
 * The card that draws this app's questions, once the renderer has one.
 *
 * NULL UNTIL THE APP STARTS, and null forever in a renderer that has no card to
 * register (`ng serve` in a plain browser reaches none of this, but a window
 * whose bootstrap threw is a real state). Every `ask` below carries its own safe
 * answer for that case: a question that was never drawn was never answered, and
 * a caller must not be told somebody agreed to something.
 */
let card: ((question: AppQuestion) => Promise<QuestionAnswer>) | null = null;

/**
 * ASK MAIN, DRAW THE CARD, ANSWER WITH THE CHOSEN WORD — the shape all five of
 * this app's questions share.
 *
 * Main composes (it owns the sentences) and may answer outright (a standing
 * "don't ask again", read before anything is composed, so no card is drawn and
 * nothing flickers). What comes back from the card is the pressed choice's own
 * key, which IS the caller's answer union — no index, no label lookup, and a
 * mismatch between main's composition and the caller's `switch` is a type error
 * rather than a silently wrong answer (see `AppQuestion`).
 *
 * The cast on the way out is the one unchecked step in the chain and it is
 * checked at the other end: main built these choices out of `Answer`'s own
 * members, and the card returns a key it was given.
 */
async function ask<Answer extends string>(
  channel: string,
  payload: unknown,
  /** What the answer is when there is nothing on screen to answer it. */
  unasked: Answer,
  /** Where a ticked "do this every time" goes, for the questions that offer it. */
  remember?: (answer: Answer) => Promise<unknown>,
): Promise<Answer> {
  const asked: Asked<Answer> = await ipcRenderer.invoke(channel, payload);
  if (asked.kind === 'answered') return asked.answer;
  if (card === null) return unasked;
  /*
   * A CARD THAT THREW IS A QUESTION NOBODY ANSWERED, and it resolves like one.
   * The alternative is a rejection travelling back into `questionBefore` or the
   * OCR dialog's Add — call sites written against a promise that always settles
   * — where it would come out as a close that did not happen, with nothing on
   * screen saying why.
   */
  const { key, standing } = await card(asked.question).catch(() => ({ key: asked.question.dismissed, standing: false }));
  const answer = key as Answer;
  /*
   * THE BOX IS ONLY STORED FOR AN ANSWER MAIN SAID IT MAY BE STORED FOR.
   * `remembers` is main's rule — "always put the number back" would make deleting
   * a reference number impossible, with no dialog left to explain why every
   * attempt undoes itself — and this is the one place that could break it.
   */
  if (standing && remember && (asked.question.checkbox?.remembers.includes(answer) ?? false)) {
    await remember(answer);
  }
  return answer;
}

const api: FoundryApi = {
  platform: process.platform,

  hosted: () => ipcRenderer.invoke('app:hosted'),

  openDocumentDialog: () => ipcRenderer.invoke('dialog:open-document'),
  openPath: (candidate) => ipcRenderer.invoke('document:open-path', candidate),
  pathForFile: (file) => webUtils.getPathForFile(file),
  documentBytes: (absolutePath) => ipcRenderer.invoke('document:read-bytes', absolutePath),
  documentSaveCopy: (absolutePath, suggestedName) =>
    ipcRenderer.invoke('document:save-copy', absolutePath, suggestedName),
  reveal: (target) => ipcRenderer.invoke('shell:reveal', target),
  saveExport: (target) => ipcRenderer.invoke('export:save-copy', target),
  /*
   * ── The two questions, and the safe answer each of them keeps ──────────────
   *
   * Keep the tab open; leave the reading alone. Both are the outcome that
   * destroys nothing and costs nothing, which is what an unanswered question has
   * to resolve to. There were FIVE while the block editor and the iframe reader
   * stood: the footnote-reference question and the two heading echoes went with
   * them (docs/RENDERER.md §7).
   */
  confirmClose: (warning) =>
    ask<CloseAnswer>('document:confirm-close', warning, 'keep'),
  confirmReRead: async (prompt) =>
    await ask<ReReadAnswer>('reading:confirm-re-read', prompt, 'leave') === 'again',
  /*
   * REGISTERED, NEVER CALLED FROM HERE. The renderer hands its card in as the app
   * starts and this holds the reference for the calls above; see
   * `FoundryApi.drawQuestions` for why the drawing has to arrive from that side.
   */
  drawQuestions: (draw) => { card = draw; },

  meta: {
    readPdf: (filePath) => ipcRenderer.invoke('meta:read-pdf', filePath),
    writePdf: (filePath, patch) => ipcRenderer.invoke('meta:write-pdf', filePath, patch),
  },

  workspace: {
    planReading: (inputPath, asked) =>
      ipcRenderer.invoke('workspace:plan-reading', inputPath, asked),
    planExport: (inputPath, kind) => ipcRenderer.invoke('workspace:plan-export', inputPath, kind),
    planTranslation: (inputPath, targetLanguage) =>
      ipcRenderer.invoke('workspace:plan-translation', inputPath, targetLanguage),
    planSimplification: (inputPath, mode) =>
      ipcRenderer.invoke('workspace:plan-simplify', inputPath, mode),
  },

  ledger: {
    read: (projectDir) => ipcRenderer.invoke('ledger:read', projectDir),
    go: (projectDir, stepId) => ipcRenderer.invoke('ledger:go', projectDir, stepId),
    standFor: (projectDir, filePath) =>
      ipcRenderer.invoke('ledger:stand-for', projectDir, filePath),
    documentAt: (projectDir) => ipcRenderer.invoke('ledger:document-at', projectDir),
    describeDelete: (projectDir, stepId) =>
      ipcRenderer.invoke('ledger:describe-delete', projectDir, stepId),
    delete: (projectDir, stepId) => ipcRenderer.invoke('ledger:delete', projectDir, stepId),
  },

  book: {
    load: (projectDir) => ipcRenderer.invoke('book:load', projectDir),
    apply: (projectDir, ops) => ipcRenderer.invoke('book:apply', projectDir, ops),
    amend: (projectDir, ops) => ipcRenderer.invoke('book:amend', projectDir, ops),
    view: (target) => ipcRenderer.invoke('book:view', target),
    correct: (projectDir, id, text) => ipcRenderer.invoke('book:correct', projectDir, id, text),
  },

  library: {
    dir: () => ipcRenderer.invoke('library:dir'),
    choose: (current) => ipcRenderer.invoke('library:choose', current),
    set: (dir) => ipcRenderer.invoke('library:set', dir),
  },

  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    onChanged: (listener) => subscribe<null>('projects:changed', listener),
    describe: (dir) => ipcRenderer.invoke('projects:describe', dir),
    delete: (dir) => ipcRenderer.invoke('projects:delete', dir),
  },

  documents: {
    describe: (filePath) => ipcRenderer.invoke('documents:describe', filePath),
    delete: (filePath) => ipcRenderer.invoke('documents:delete', filePath),
  },

  recents: {
    list: () => ipcRenderer.invoke('recents:list'),
    forget: (filePath) => ipcRenderer.invoke('recents:forget', filePath),
    clear: () => ipcRenderer.invoke('recents:clear'),
  },

  queue: {
    list: () => ipcRenderer.invoke('queue:list'),
    enqueue: (request) => ipcRenderer.invoke('queue:enqueue', request),
    enqueueTranslate: (request) => ipcRenderer.invoke('queue:enqueue-translate', request),
    start: () => ipcRenderer.invoke('queue:start'),
    remove: (id) => ipcRenderer.invoke('queue:remove', id),
    cancel: (id) => ipcRenderer.invoke('queue:cancel', id),
    clearFinished: () => ipcRenderer.invoke('queue:clear-finished'),
    onChanged: (listener) => subscribe<Job[]>('queue:changed', listener),
  },

  engineInfo: () => ipcRenderer.invoke('engine:info'),
  doctor: (endpointUrl) => ipcRenderer.invoke('doctor:run', endpointUrl),
  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    write: (patch) => ipcRenderer.invoke('settings:write', patch),
  },

  wsl: {
    facts: () => ipcRenderer.invoke('wsl:facts'),
    tooling: (distro) => ipcRenderer.invoke('wsl:tooling', distro),
  },

  env: {
    catalog: () => ipcRenderer.invoke('env:catalog'),
    install: (request) => ipcRenderer.invoke('env:install', request),
    cancel: () => ipcRenderer.invoke('env:cancel'),
    chooseDest: (defaultPath) => ipcRenderer.invoke('env:choose-dest', defaultPath),
    onInstallProgress: (listener) => subscribe<EnvInstallProgress>('env:install-progress', listener),
  },

  backendSetup: {
    run: (request) => ipcRenderer.invoke('backend:setup-run', request),
    cancel: () => ipcRenderer.invoke('backend:setup-cancel'),
    onLog: (listener) => subscribe<SetupLogEvent>('backend:setup-log', listener),
  },

  vllmServer: {
    status: () => ipcRenderer.invoke('vllm:status'),
    start: () => ipcRenderer.invoke('vllm:start'),
    stop: () => ipcRenderer.invoke('vllm:stop'),
    onStatus: (listener) => subscribe<ServerStatus>('vllm:status-changed', listener),
    keepWarm: () => ipcRenderer.invoke('vllm:keep-warm'),
    setKeepWarm: (minutes) => ipcRenderer.invoke('vllm:set-keep-warm', minutes),
  },

  onDocumentOpened: (listener) => subscribe<string>('document:opened', listener),
  onDocumentRelocated: (listener) =>
    subscribe<{ from: string; to: string }>('document:relocated', listener),
  onNavigate: (listener) => subscribe<string>('app:navigate', listener),
  onProjectOpen: (listener) =>
    subscribe<{ dir: string; originalPath: string; managed: boolean }>('project:open', listener),
  onMenuAction: (listener) => subscribe<MenuAction>('menu:action', listener),
  // The window is going and the documents in it have not been asked yet. The
  // payload is nothing — what is open is the renderer's own business, and this
  // says only that the question is now due.
  onWindowClosing: (listener) => subscribe<void>('window:closing', () => listener()),
  letWindowClose: (go) => ipcRenderer.invoke('window:let-go', go),
  closeWindow: () => ipcRenderer.invoke('window:close'),
};

contextBridge.exposeInMainWorld('foundry', api);
