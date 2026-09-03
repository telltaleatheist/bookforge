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
npm run build       # bundles src/ → dist/ and copies static/ → dist/ (dev: bakes local token)
npm run build:dist  # same, but WITHOUT baking a token (for distribution)
npm run typecheck   # tsc --noEmit (esbuild doesn't type-check)
npm run watch       # rebuild on change (restart it if you edit static/)
npm run package     # build:dist + zip → bookforge-reader-<version>.zip
```

## Auth (no token for local use)

The extension has a pinned identity (a `key` in `manifest.json` → a stable
extension id). BookForge's TTS API trusts a WebSocket whose **Origin** is exactly
this extension — a value the browser sets and webpages cannot forge — so a
**local** connection needs no token. A token is only required for a **LAN**
server (host other than `127.0.0.1`), entered in Options. The private key for the
id lives in `.crx-key.pem` (git-ignored) and is only needed to pack a `.crx`
later.

## Install (unpacked)

1. Launch BookForge at least once (so the TTS API server is running).
2. In Chrome: `chrome://extensions` → enable **Developer mode** → **Load
   unpacked** → select `extension/dist`.
3. Click the toolbar icon → **Start TTS server**. No token to paste — it just
   connects. (Only enter a token in Options when pointing at a LAN server.)

## Distribute

`npm run package` produces `bookforge-reader-<version>.zip`, whose contents sit
inside a `bookforge-reader/` folder. Hand that zip out; recipients:

1. Unzip it.
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the
   unzipped `bookforge-reader/` folder.

Chrome cannot install a `.zip` (or a self-hosted `.crx`) by drag-drop — "Load
unpacked" is the sideload path. The only one-click install is publishing to the
Chrome Web Store (for that, re-zip the **dist/ contents at the archive root**,
not under a wrapper folder).

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

## Record a tab

The popup's **Recorder** section captures the decoded audio of the tab you are
looking at — including a DRM'd web player, whose audio exists nowhere else — and
writes it losslessly as 24-bit FLAC with a `.json` sidecar beside it. Float32 PCM
leaves the browser and BookForge's ffmpeg makes the file; nothing is encoded
lossily on the way.

Open the tab, press play in its player, then open the popup and press **● Record
this tab**. The tab stays audible while recording. You get elapsed time, file
size, a level meter, the destination path, and **■ Stop** / **✕ Discard**. Stop
finalizes the file; Discard deletes it. Pressing Record *before* Play is fine —
the popup shows **"Waiting for audio — press play in the tab"** with a countdown,
and keeps recording.

**Where it saves**: Options → **Save recordings to**, default `~/Downloads`. That
is a folder on the machine running **BookForge**, not on this one; `~` means that
machine's home folder (Windows included). It is created if missing, and a
relative path is refused by name. While a recording is in progress it is a hidden
`.<name>.partial.flac` in the same folder, so a `.flac` there is always a
finished recording.

**Speed capture** — the selector beside the Record button (1x / 1.5x / 2x / 3x /
4x). The extension drives the page's own player that fast with pitch preservation
off, and the file is written at `capture rate ÷ speed`: nothing is resampled, and
played back at 1x it is the book at normal pitch and full length. A 6-hour book at
2x costs 3 hours. The catch is bandwidth — a 48 kHz capture at 2x is a 24 kHz
file, and 3x would be 16 kHz, which is refused by name. For 3x or 4x, set the
Mac's output device to 96 kHz in Audio MIDI Setup first. Chrome mutes media above
4x.

**Stopping itself**: 30 seconds of continuous silence ends the recording and
saves it — the book finished, or it never started. Chapter gaps (2-4 s) are
nowhere near it. Closing or navigating the tab, and losing the connection to
BookForge, also stop the recording and KEEP what was captured.

Chrome does **not** silence protected audio in tab capture (measured against the
real Audible player on 2026-09-03). If a future Chrome ever does, the fallback is
an OS loopback device ([BlackHole](https://existential.audio/blackhole/) on
macOS): route the browser's output through it and record that device. The
contract and the reasoning are in
[`../docs/TAB_RECORDER.md`](../docs/TAB_RECORDER.md).

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
