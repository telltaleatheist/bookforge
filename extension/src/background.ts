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
  TransportCmd,
  EngineCmd,
  QueueOpCmd,
  QueueItem,
  QueueSnapshot,
  UiState
} from './messages';

let activeTabId: number | null = null;

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

chrome.runtime.onMessage.addListener((raw: RuntimeMessage, sender) => {
  if (!raw || (raw as { target?: string }).target !== 'background') return;

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

    // popup/content → offscreen: control verbs forwarded as-is
    case 'transport':
      if (sender.tab?.id !== undefined) activeTabId = sender.tab.id;
      void sendToOffscreen({ ...(raw as TransportCmd), target: 'offscreen' });
      return;
    case 'engine':
      void sendToOffscreen({ target: 'offscreen', cmd: 'engine', op: (raw as EngineCmd).op });
      return;
    case 'queue': {
      const q = raw as QueueOpCmd;
      void sendToOffscreen({ target: 'offscreen', cmd: 'queue', op: q.op, id: q.id });
      return;
    }
    case 'sync':
      if (sender.tab?.id !== undefined) activeTabId = sender.tab.id;
      void sendToOffscreen({ target: 'offscreen', cmd: 'sync' });
      return;

    // offscreen → content: project the snapshot for the active tab
    case 'snapshot':
      relaySnapshot((raw as { snapshot: QueueSnapshot }).snapshot);
      return;
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
    playback: snapshot.playback
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
