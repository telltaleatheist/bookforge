# BookForge Reader

A Chrome (MV3) extension that reads web pages aloud through BookForge's local
streaming TTS engine. Click the toolbar icon to drop a small play button beside
each readable block on the page; click one to start listening, with local
pause / seek / speed and auto-advance through the article.

This is a personal-use, sideloaded extension. It talks to BookForge over the
WebSocket TTS API documented in [`../docs/TTS_API.md`](../docs/TTS_API.md) — read
that for the wire protocol. The design notes for this extension live in
[`PLAN.md`](PLAN.md).

## Build

```bash
cd extension
npm install
npm run build       # bundles src/ → dist/ and copies static/ → dist/
npm run typecheck   # tsc --noEmit (esbuild doesn't type-check)
npm run watch       # rebuild on change (restart it if you edit static/)
```

## Install (unpacked)

1. Launch BookForge at least once so it generates its token at
   `~/Library/Application Support/bookforge-app/tts-api.json` (macOS) or
   `%APPDATA%/bookforge-app/tts-api.json` (Windows).
2. In Chrome: `chrome://extensions` → enable **Developer mode** → **Load
   unpacked** → select `extension/dist`.
3. Open the extension's **Options**, paste the `token` value from that file, and
   click **Test connection** (with BookForge running) to confirm and to load the
   voice list.

## Use

- Click the **BookForge Reader** toolbar icon to open the popup. From there:
  - **Start / Stop TTS server** — brings the engine up (~1 minute cold start) or
    shuts it down to free its RAM. The dot shows connection + engine state.
  - **Show controls on page** — injects the reader controls into the current tab
    (re-click to hide).
  - The **queue** — the currently-playing item plus everything upcoming; remove a
    row with −, or **Clear queue** (keeps the playing item).
- On the page, each text block gets two buttons: **▶ play now** and **＋ add to
  queue**. ▶ jumps an item to the top and plays immediately; ＋ appends.
- **Select any text** and a floating **▶ Play / ＋ Queue** control appears — handy
  for reading a whole region while skipping ads/navigation.
- The transport bar (bottom center) gives rewind 5 s / play-pause / forward 5 s /
  skip, a speed selector, position, and sentence count. Seeking and speed never
  re-contact the server — received audio is buffered locally and cached (up to
  256 MB) so finished items replay instantly.
- When the current item finishes, playback advances to the next queued item; an
  empty queue stops.

## LAN use (optional)

The server defaults to `127.0.0.1`. To listen to a BookForge running on another
machine, set that machine's server host to `0.0.0.0` (in BookForge), then put its
IP and the same token in this extension's Options.

## Architecture

`popup` (server toggle + queue remote) and `content script` (block detection +
UI) → `service worker` (relay + offscreen lifecycle, builds queue items, projects
per-tab UI state) → `offscreen document` (WebSocket, PCM assembly,
`<audio>`/WAV-blob player, 256 MB LRU cache, **and the play queue**). The
offscreen doc is the single source of truth: it broadcasts a `QueueSnapshot` on
every change (mirrored to `chrome.storage.session` for the popup) and background
tailors a per-tab `UiState` down to the content script.

See `PLAN.md` for the full rationale, including why playback goes through a
WAV-backed `<audio>` element rather than scheduled Web Audio buffers
(pitch-preserved speed control).
