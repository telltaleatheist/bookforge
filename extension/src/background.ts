/**
 * Service worker — relay between content scripts, the popup, and the offscreen
 * document (which can't message content/popup directly), plus offscreen-document
 * lifecycle. Builds QueueItems from page commands and tailors the queue snapshot
 * down to a per-tab UiState.
 *
 * Routing keys: a content script knows its block ids but not its own tab id, so
 * background composes `id = "${tabId}:${blockId}"` and decomposes it when
 * projecting the snapshot back to that tab.
 */

import {
  RuntimeMessage,
  BlockCmd,
  PlayFromCmd,
  ExcludeBlockCmd,
  TransportCmd,
  RecordCmd,
  EngineCmd,
  QueueOpCmd,
  SetVoiceCmd,
  SetIdleCmd,
  PutSettingsCmd,
  RestartEngineCmd,
  QueueItem,
  QueueSnapshot,
  UiState,
  loadSettings
} from './messages';

let activeTabId: number | null = null;
let latestSnapshot: QueueSnapshot | null = null;

/** Push the snapshot straight to the popup (if one is open). */
function pushToPopup(snapshot: QueueSnapshot): void {
  chrome.runtime.sendMessage({ target: 'popup', cmd: 'snapshot', snapshot }).catch(() => { /* no popup open */ });
}

// ─── Offscreen document lifecycle ─────────────────────────────────────────────

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (creating) return creating;
  creating = chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      // AUDIO_PLAYBACK alone lets Chrome close the doc after ~30 s of silence,
      // which would kill the socket during the ~60 s cold engine start. BLOBS
      // (we hold WAV blob URLs) keeps it alive through buffering. USER_MEDIA is
      // required for the tab recorder: getUserMedia is REFUSED in an offscreen
      // document that did not declare it, and the reasons are fixed at creation
      // — so it is declared up front rather than after the first Record click.
      reasons: [
        chrome.offscreen.Reason.AUDIO_PLAYBACK,
        chrome.offscreen.Reason.BLOBS,
        chrome.offscreen.Reason.USER_MEDIA
      ],
      justification: 'Stream and play TTS audio, and record the audio of a tab the user chooses.'
    })
    .finally(() => { creating = null; });
  return creating;
}

/** Send to offscreen, retrying: its listener can lag createDocument. */
async function sendToOffscreen(msg: RuntimeMessage): Promise<void> {
  try {
    await ensureOffscreen();
  } catch (err) {
    console.error('[BFR] failed to create offscreen document:', err);
    return;
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await chrome.runtime.sendMessage(msg);
      return;
    } catch (err) {
      const m = String((err as Error).message || err);
      if (!m.includes('Receiving end does not exist')) { console.error('[BFR] sendToOffscreen:', m); return; }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  console.error('[BFR] offscreen document never became reachable');
}

// ─── Message relay ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((raw: RuntimeMessage, sender, sendResponse) => {
  if (!raw || (raw as { target?: string }).target !== 'background') return;

  // Offscreen can't reach chrome.storage; it asks us to read and write for it.
  if ((raw as { cmd?: string }).cmd === 'get-settings') {
    loadSettings().then(sendResponse);
    return true; // keep the channel open for the async response
  }
  if (raw.cmd === 'put-settings') {
    void chrome.storage.local.set((raw as PutSettingsCmd).patch);
    return;
  }

  switch (raw.cmd) {
    // content → offscreen: build a QueueItem with this tab's id baked in
    case 'play':
    case 'enqueue': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return;
      activeTabId = tabId;
      const c = raw as BlockCmd;
      const item: QueueItem = {
        id: `${tabId}:${c.blockId}`,
        label: c.label,
        text: c.text,
        source: c.source,
        tabId,
        blockId: c.blockId
      };
      console.log('[BFR] relay', c.cmd, 'from tab', tabId, 'block', c.blockId);
      void sendToOffscreen({ target: 'offscreen', cmd: c.cmd, item });
      return;
    }

    // content → offscreen: play a whole run of blocks (this block → end of page)
    case 'play-from': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return;
      activeTabId = tabId;
      const c = raw as PlayFromCmd;
      const items: QueueItem[] = c.items.map((it) => ({
        id: `${tabId}:${it.blockId}`,
        label: it.label,
        text: it.text,
        source: c.source,
        tabId,
        blockId: it.blockId,
        ...(it.startChar ? { startChar: it.startChar } : {})
      }));
      console.log('[BFR] play-from', items.length, 'blocks from tab', tabId);
      void sendToOffscreen({ target: 'offscreen', cmd: 'play-sequence', items });
      return;
    }

    // content → offscreen: drop an excluded block from the running queue
    case 'exclude-block': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return;
      const c = raw as ExcludeBlockCmd;
      void sendToOffscreen({ target: 'offscreen', cmd: 'queue', op: 'remove', id: `${tabId}:${c.blockId}` });
      return;
    }

    // popup/content → offscreen: control verbs forwarded as-is
    case 'transport':
      if (sender.tab?.id !== undefined) activeTabId = sender.tab.id;
      void sendToOffscreen({ ...(raw as TransportCmd), target: 'offscreen' });
      return;
    // Tab recording. The popup did the part that needs a user gesture (minting
    // the stream id); the offscreen document does the part that needs a
    // MediaStream. Background owns exactly one thing of its own: driving the
    // PAGE's player at the capture speed, because it is the only context that
    // still exists when a recording ends by a route the popup isn't open for.
    case 'record': {
      const c = raw as RecordCmd;
      if (c.op === 'start' && c.tabId !== undefined) {
        recordingTabId = c.tabId;
        recordingSpeed = c.speed && c.speed > 1 ? c.speed : 1;
        if (recordingSpeed > 1) void setPageSpeed(c.tabId, recordingSpeed);
      }
      void sendToOffscreen({ ...c, target: 'offscreen' });
      return;
    }
    case 'engine':
      void sendToOffscreen({ target: 'offscreen', cmd: 'engine', op: (raw as EngineCmd).op });
      return;
    case 'set-voice':
      void sendToOffscreen({ target: 'offscreen', cmd: 'set-voice', voice: (raw as SetVoiceCmd).voice });
      return;
    case 'set-idle':
      void sendToOffscreen({ target: 'offscreen', cmd: 'set-idle', minutes: (raw as SetIdleCmd).minutes });
      return;
    case 'restart-engine': {
      const c = raw as RestartEngineCmd;
      void sendToOffscreen({ target: 'offscreen', cmd: 'restart-engine', cpuWorkers: c.cpuWorkers, voice: c.voice });
      return;
    }
    case 'queue': {
      const q = raw as QueueOpCmd;
      void sendToOffscreen({ target: 'offscreen', cmd: 'queue', op: q.op, id: q.id });
      return;
    }
    case 'sync':
      if (sender.tab?.id !== undefined) activeTabId = sender.tab.id;
      // Give the popup whatever we last knew, instantly, then refresh.
      if (latestSnapshot) pushToPopup(latestSnapshot);
      void sendToOffscreen({ target: 'offscreen', cmd: 'sync' });
      return;

    // offscreen → content (per-tab) + popup (full)
    case 'snapshot': {
      const snapshot = (raw as { snapshot: QueueSnapshot }).snapshot;
      latestSnapshot = snapshot;
      noteRecordingLiveness(snapshot);
      relaySnapshot(snapshot);
      pushToPopup(snapshot);
      return;
    }
  }
});

// ─── Speed capture: driving the page's player ─────────────────────────────────
//
// The recorder can capture faster than realtime by running the tab's own player
// at S× with `preservesPitch = false` and relabelling the file's sample rate —
// nothing resamples, and a six-hour book takes three hours at 2×.
//
// This lives in BACKGROUND, not the popup, for one reason: the recording can end
// without the popup being open (the trailing-silence auto-stop, the tab closing,
// the socket dropping), and whatever set the page to 2× MUST be able to put it
// back. The popup's Record click is still what grants `activeTab` — that grant
// belongs to the extension, not to the popup, and outlives it.
//
// The injected functions run in the ISOLATED world, which shares the page's DOM:
// setting `playbackRate` there drives the real element, with no exposure to the
// page's own scripts or CSP.

let recordingTabId: number | null = null;
let recordingSpeed = 1;
/** Was a recording live at the previous snapshot? The 1× restore hangs off the
 *  live→not-live edge, so EVERY way a recording can end restores the page. */
let recordingWasLive = false;

/** Runs in the page. Must be self-contained — executeScript serializes it. */
function drivePlaybackSpeed(speed: number): void {
  const KEY = '__bfrRecorderSpeed';
  const w = window as unknown as Record<string, unknown>;
  const apply = () => {
    const media = document.querySelectorAll('audio, video');
    for (let i = 0; i < media.length; i++) {
      const el = media[i] as HTMLMediaElement & { preservesPitch?: boolean };
      try {
        // Pitch preservation is exactly what we must NOT have: the whole trick is
        // that the audio comes out pitch-shifted and is un-shifted by writing the
        // file at a proportionally lower sample rate.
        el.preservesPitch = false;
        if (el.playbackRate !== speed) el.playbackRate = speed;
      } catch { /* a player that locks the property down */ }
    }
  };
  const previous = w[KEY] as { stop?: () => void } | undefined;
  if (previous && previous.stop) previous.stop();
  apply();
  // Players reset the rate on chapter changes, and swap in new <audio> elements
  // as they go — so re-assert on both counts for as long as we are recording.
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const timer = setInterval(apply, 2000);
  w[KEY] = { stop: () => { observer.disconnect(); clearInterval(timer); } };
}

/** Runs in the page: stop re-asserting and hand the player back to the user. */
function restorePlaybackSpeed(): void {
  const KEY = '__bfrRecorderSpeed';
  const w = window as unknown as Record<string, unknown>;
  const previous = w[KEY] as { stop?: () => void } | undefined;
  if (previous && previous.stop) previous.stop();
  delete w[KEY];
  const media = document.querySelectorAll('audio, video');
  for (let i = 0; i < media.length; i++) {
    const el = media[i] as HTMLMediaElement & { preservesPitch?: boolean };
    try { el.preservesPitch = true; el.playbackRate = 1; } catch { /* gone */ }
  }
}

async function setPageSpeed(tabId: number, speed: number): Promise<void> {
  try {
    // allFrames: a web player commonly lives in an iframe, and the element we
    // need is in whichever frame owns it.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: drivePlaybackSpeed,
      args: [speed]
    });
    console.log('[BFR] driving tab', tabId, 'at', speed + 'x');
  } catch (err) {
    // Named, not swallowed: the capture will still run, but at 1x, and the file's
    // relabelled rate would then be wrong — so the offscreen guard's refusal and
    // this line are the two places that say what happened.
    console.error('[BFR] could not set the page playback speed:', err);
  }
}

async function restorePageSpeed(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: restorePlaybackSpeed
    });
  } catch (err) {
    console.warn('[BFR] could not restore the page playback speed:', err);
  }
}

/** The page goes back to 1x the moment the recording stops being live, whatever
 *  ended it — Stop, Discard, the auto-stop, a dropped socket, the speed guard. */
function noteRecordingLiveness(snapshot: QueueSnapshot): void {
  const state = snapshot.recording?.state;
  const live = state === 'starting' || state === 'recording' || state === 'stopping';
  if (recordingWasLive && !live) {
    if (recordingTabId !== null && recordingSpeed > 1) void restorePageSpeed(recordingTabId);
    recordingTabId = null;
    recordingSpeed = 1;
  }
  recordingWasLive = live;
}

// ─── Snapshot → per-tab UiState ───────────────────────────────────────────────

function relaySnapshot(snapshot: QueueSnapshot): void {
  if (activeTabId === null) return;
  const tabId = activeTabId;
  const mine = (item: QueueItem | null) => !!item && item.tabId === tabId;
  // Queue ids are "tabId:blockId"; the page only knows the block half.
  const blocksOfThisTab = (ids: string[]) =>
    ids.filter((id) => id.startsWith(`${tabId}:`)).map((id) => id.slice(String(tabId).length + 1));

  const ui: UiState = {
    connected: snapshot.connected,
    engineState: snapshot.engineState,
    currentBlockId: mine(snapshot.current) ? snapshot.current!.blockId ?? null : null,
    upcomingBlockIds: snapshot.upcoming.filter((i) => i.tabId === tabId).map((i) => i.blockId!).filter(Boolean),
    renderedBlockIds: blocksOfThisTab(snapshot.renderedItemIds),
    playback: snapshot.playback,
    run: snapshot.run,
    voices: snapshot.voices,
    currentVoice: snapshot.currentVoice,
    switchingVoice: snapshot.switchingVoice
  };
  chrome.tabs.sendMessage(tabId, { target: 'content', cmd: 'ui', ui }).catch(() => { /* tab gone */ });
}

// ─── Tear down when the active tab navigates or closes ────────────────────────
//
// 'close' (not 'stop') because the page the audio belongs to is gone: this is the
// point where rendered audio is actually freed. A plain Stop keeps it, so that
// pressing play again on the same page never re-renders.

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) { void sendToOffscreen({ target: 'offscreen', cmd: 'transport', op: 'close' }); activeTabId = null; }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.status === 'loading') {
    void sendToOffscreen({ target: 'offscreen', cmd: 'transport', op: 'close' });
    activeTabId = null;
  }
});
