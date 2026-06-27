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
  EngineCmd,
  QueueOpCmd,
  SetVoiceCmd,
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
      // (we hold WAV blob URLs) keeps it alive through buffering.
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.BLOBS],
      justification: 'Stream and play TTS audio from the BookForge engine.'
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

  // Offscreen can't read chrome.storage; it asks us for settings.
  if ((raw as { cmd?: string }).cmd === 'get-settings') {
    loadSettings().then(sendResponse);
    return true; // keep the channel open for the async response
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
    case 'engine':
      void sendToOffscreen({ target: 'offscreen', cmd: 'engine', op: (raw as EngineCmd).op });
      return;
    case 'set-voice':
      void sendToOffscreen({ target: 'offscreen', cmd: 'set-voice', voice: (raw as SetVoiceCmd).voice });
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
      relaySnapshot(snapshot);
      pushToPopup(snapshot);
      return;
    }
  }
});

// ─── Snapshot → per-tab UiState ───────────────────────────────────────────────

function relaySnapshot(snapshot: QueueSnapshot): void {
  if (activeTabId === null) return;
  const tabId = activeTabId;
  const mine = (item: QueueItem | null) => !!item && item.tabId === tabId;

  const ui: UiState = {
    connected: snapshot.connected,
    engineState: snapshot.engineState,
    currentBlockId: mine(snapshot.current) ? snapshot.current!.blockId ?? null : null,
    currentLabel: snapshot.current?.label ?? null,
    upcomingBlockIds: snapshot.upcoming.filter((i) => i.tabId === tabId).map((i) => i.blockId!).filter(Boolean),
    playback: snapshot.playback,
    voices: snapshot.voices,
    currentVoice: snapshot.currentVoice
  };
  chrome.tabs.sendMessage(tabId, { target: 'content', cmd: 'ui', ui }).catch(() => { /* tab gone */ });
}

// ─── Stop playback when the active tab navigates or closes ────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) { void sendToOffscreen({ target: 'offscreen', cmd: 'transport', op: 'stop' }); activeTabId = null; }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.status === 'loading') {
    void sendToOffscreen({ target: 'offscreen', cmd: 'transport', op: 'stop' });
    activeTabId = null;
  }
});
