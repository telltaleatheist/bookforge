# Bookshelf Reader — "Listen to anything" (Implementation Plan)

Point a URL or a PDF/epub/txt at the **bookshelf web app** and have it stream through
BookForge's TTS engine, live, in a player that lets you click any sentence to start
there. This is the ReadBit flow — but running on the **iPhone** (bookshelf over the
tailnet), which a Chrome extension can't do.

**This is a port, not a green-field build.** The Chrome extension at `extension/`
(`extension/PLAN.md`) already solves the hard parts: streaming PCM to a browser,
pitch-preserved speed, pause/seek, sentence highlight, click-to-start, a read-ahead
queue, and a 256 MB cache. And every ingestion path (URL/PDF/epub/formats) already
exists in `electron/`. The work is (1) glue those into bookshelf-server, and (2) move
the extension's playback brain from a Chrome offscreen document into an Angular service
— where it gets *simpler*.

---

## Decisions (baked-in defaults — flip any before build)

1. **Separate Reader surface**, not a fork of the existing player. The library player
   is file+VTT+known-timestamps (`/api/audio` + `/api/vtt`); the Reader is live-PCM with
   no timestamps up front. Different enough that merging hurts both. They share the app
   shell + MediaSession.
2. **Ephemeral reads (v1).** A read is throwaway: extracted text + cache-backed audio,
   no library project, no manifest. "Save this as an audiobook" (hand the sentence list
   to the batch pipeline) is a later fast-follow.
3. **Auth rides the existing reader token.** New endpoints + the WS authenticate with
   `readerIdFromRequest` (`Authorization: Bearer` / `x-reader-token` / `?token=`). No new
   identity system; the phone is already logged in as a reader.

---

## Architecture

```
iPhone — bookshelf web app (Angular, projects/bookshelf, over tailnet)
  │ paste URL / upload file
  ├─ POST /api/reader/ingest ──► bookshelf-server (main process)
  │     routes by type to EXISTING bridges → { docId, title, blocks: string[] }
  │
  │ WebSocket  ws://<host>:8765/api/reader/ws?token=<readerToken>   (NEW on bookshelf-server)
  ├─ {action:'speak', requestId, text, settings?, preempt?, background?}
  │     └─► streamScheduler.start(splitForTts(text), 0, settings, requestId, sink, opts)
  │  ◄── {type:'speaking'|'chunk'|'done'|'failed'|'complete'|'cancelled'|'error'}
  │        (per-connection StreamSink forwards scheduler events to this socket)
  │
  ├─ ReaderPlaybackService  (ported extension/src/offscreen.ts)
  │     PCM assembly → growing WAV blob → one <audio>; LRU cache; concurrent prefetch;
  │     transport (pause/seek/rate/volume); MediaSession
  └─ ReaderComponent
        renders blocks (each sentence its own <span>); transport bar;
        highlight current sentence BY INDEX; click a span → start there
```

Key fact that makes (2) trivial: `bookshelf-server.ts` runs **in the Electron main
process**, same as `streamScheduler` (`electron/stream-scheduler.ts`) and every
ingestion bridge. So it calls them **directly** — no :8766 `tts-api-server`, no
Origin/token dance, no cross-process IPC.

---

## What already exists (reuse — do NOT rebuild)

| Need | Existing code | Notes |
|---|---|---|
| URL → clean article text | `electron/web-fetch-bridge.ts` — hidden BrowserWindow + Mozilla Readability (`fetchUrlToPdf` :191, `extractTextFromHtml` :922) | Deps `@mozilla/readability`, `cheerio`, `jsdom` already in package.json. Currently only wired to Language Learning. |
| PDF → text + header/footer strip | `electron/pdf-analyzer.ts` (mupdf WASM, `analyzeText` :741) + region classification (:1122–1778) | Auto-strip headers/footers server-side. No manual crop UI on mobile v1. |
| EPUB → text/chapters | `electron/epub-processor.ts` (`parseEpub`, `extractTextFromXhtml` :604) | Direct. |
| mobi/docx/rtf/… → epub | `electron/ebook-convert-bridge.ts` → Calibre (`convertToEpub` :210) | Calibre is an optional add-on; surface an honest "install Calibre" message if absent. |
| sentence split | `electron/bilingual-processor.js` `splitForTts(text, lang)` | Same splitter `tts-api-server` already feeds the engine — reuse for parity. |
| raw string → TTS | `streamScheduler.start(sentences[], startIndex, settings, requestId, sink, opts)` | `StreamSink = (data: Record<string, unknown>) => void`. No file needed at synthesis. |
| the entire playback brain | `extension/src/offscreen.ts` + `extension/src/protocol.ts` | Port; see below. |

The engine's event shapes (`speaking`/`chunk`/`done`/`failed`/`complete`/`cancelled`/
`error`, PCM16 mono 24 kHz base64) are already what `protocol.ts` decodes.

---

## Server work (`electron/bookshelf-server.ts`)

### 1. `POST /api/reader/ingest`
- Auth: `readerIdFromRequest(req)`; 401 if none.
- Body: JSON `{ url }` **or** multipart file upload (pdf/epub/txt/…).
- Dispatch by type:
  - **url** → web-fetch-bridge Readability extraction → paragraph blocks.
  - **pdf** → `pdf-analyzer.analyzeText`, drop `header`/`footer` regions → blocks.
  - **epub** → `epub-processor` chapters → blocks.
  - **other** → `ebook-convert-bridge` → epub → epub path (or 422 if Calibre missing).
  - **txt/pasted** → split on blank lines → blocks.
- Return `{ docId, title, blocks: string[] }`. `docId` is a random id for logging only
  (ephemeral; nothing persisted in v1).
- A "block" = a paragraph/heading/list-item, exactly like the extension's unit. The
  client sends whole blocks as `text`; the **server** splits each into sentences via
  `splitForTts` at speak time (matches extension behavior — client never pre-splits).

### 2. WebSocket `GET /api/reader/ws`  (NEW — bookshelf-server has no WS today)
- Add a `ws.Server` on the existing HTTP server via the `upgrade` event; `ws` is already
  a dependency (used by `tts-api-server`).
- Auth on upgrade: read `?token=` and resolve via the reader-token map; reject otherwise.
- Client→server actions (subset of the extension protocol — no engine.start/config here;
  engine lifecycle stays owned by the app/Settings):
  - `speak { requestId, text, settings?, preempt?, background? }`
  - `cancel { requestId }`
  - `playhead { requestId, sentenceIndex }`  (advances the generate-ahead window)
- Per-connection **sink**: `const sink: StreamSink = (data) => ws.send(JSON.stringify(data))`.
- `speak` handler mirrors `tts-api-server.handleSpeak` (:377) but in-process:
  ```
  const sentences = splitForTts(text, 'en');
  ws.send({ type:'speaking', requestId, sentences });        // segmentation echo
  streamScheduler.start(sentences, 0, settings, requestId, sink,
                        { preempt, priority: !background, lookaheadSeconds: 45 });
  ```
- Reuse the scheduler's existing engine selection (`getActiveEngine()`), warm-up state
  pushes, and preemption. Multiple BookForge clients still share ONE engine session —
  the extension already models "taken over by another client" (`cancelled`); the Reader
  inherits that.

---

## Client work (`projects/bookshelf/src/app/reader/`)

### `reader-protocol.ts`
Copy `extension/src/protocol.ts` verbatim (wire types, `decodeBase64`, `BYTES_PER_SECOND`).

### `reader-playback.service.ts`  (port of `offscreen.ts`)
Lift 1:1, then delete the Chrome-only scaffolding:
- **Keep:** `Session` (PCM assembly, `drain`, `boundaries`, `sentenceAt`), `buildWav`,
  `loadBlob` + boundary-reload logic (the pitch-preserved speed / pause / seek trick),
  the 256 MB LRU cache, concurrent read-ahead (`fillPrefetch`/`startPrefetch`/
  `adoptPrefetchFor`), the queue model (blocks → auto-advance), transport ops.
- **Drop:** `chrome.runtime` messaging, the background/offscreen/content 3-process split,
  `blockKey` routing, `sendMessage` retries, the offscreen document itself. An Angular
  service owns `<audio>` + `AudioContext` directly.
- **Replace:** the WebSocket target — connect to `/api/reader/ws?token=…` instead of the
  extension's `ws://host:port` + Origin auth.
- **Expose:** Angular signals for `state`, `position`, `buffered`, `sentenceIndex`,
  `currentBlockId`, `voices`, `rate`, `volume` — the component binds to these instead of
  the extension's 300 ms `broadcast()` snapshot.

### `reader.component.ts`
- Input: paste-a-URL field + file upload (`<input type=file>` → multipart to `/ingest`).
- On ingest: render `blocks` as a clean reading view. **Because we render the text
  ourselves, each sentence is our own `<span data-block data-sentence>`** — highlight by
  index, click to start. This deletes the extension's whole DOM-range-matching layer
  (`indexElement`, alnum fingerprinting, `caretRangeFromPoint`, ~400 lines).
- Transport bar: reuse the extension's control set (rewind/play-pause/forward/skip,
  speed, volume, buffer-health ring, sentence counter).
- **MediaSession / iOS lock-screen:** reuse the existing bookshelf player's wiring so it
  plays screen-off.
- Entry point: a new tab or a "＋ Listen to something" affordance on the shelf.

---

## iOS specifics
- **Autoplay:** the first play tap is the required user gesture; fine.
- **AudioContext:** only engaged when volume ≠ 1 (the extension already defers/resumes it
  on gesture) — keep that.
- **PDF crop:** none on mobile v1; auto header/footer strip does the boring part. Manual
  touch-crop is a later desktop refinement.
- **Share-to-app:** iOS won't make a web app a real share target. v1 = paste a URL. A
  fast-follow iOS **Shortcut** can POST the shared URL to `/api/reader/ingest` and open
  the app.

---

## Phasing
1. **Server streaming bridge** — `/api/reader/ws` → `streamScheduler` with a forwarding
   sink. Prove: phone receives chunks for hardcoded text.
2. **Client playback engine** — port `Session`/WAV-player/cache/prefetch into
   `reader-playback.service.ts`, wired to the WS. Prove: phone plays that text with
   pause/seek/speed.
3. **Reader UI** — paste-URL + rendered blocks + transport + highlight-by-index +
   click-to-start + MediaSession.
4. **Ingestion** — URL (Readability) first, then PDF (+auto strip), then epub/txt, then
   Calibre formats.

## Edge cases (mostly already handled in offscreen.ts — preserve on port)
- Engine cold start (~1 min): surface `starting-engine` state; the extension already does.
- Preemption by another client (`cancelled`): partial audio stays playable, no
  auto-advance — keep.
- Socket drop mid-speak: buffered audio plays out; play again = fresh speak — keep.
- Failed sentence: zero-length slot, playback skips, counts stay aligned — keep.
- Calibre missing on an unsupported upload: honest 422 → "install Calibre in Add-ons".

## Post-build housekeeping
- Update the bookshelf memory note (new Reader surface + `/api/reader/*` endpoints).
- Note the new WS on bookshelf-server (first WS on that server).
