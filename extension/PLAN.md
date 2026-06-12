# BookForge Reader — Implementation Plan

Chrome MV3 extension that reads web pages aloud through BookForge's local streaming
TTS server. **Read `docs/TTS_API.md` first** — it is the authoritative wire-protocol
spec; this plan covers everything on top of it: product decisions, architecture,
module-by-module design, and the edge cases already thought through.

Personal-use extension (sideloaded, not store-published). LAN-ready via host/port
settings, matching the server's design.

## Product decisions (locked with the user)

1. **Activation**: clicking the toolbar icon injects/toggles the UI on that tab
   (`activeTab` + `scripting`). Pages are untouched until the user opts in.
2. **Per-block play buttons**: small floating button next to each detected text
   block (paragraphs, list items, headings, blockquotes…).
3. **Transport bar**: fixed bottom-center pill with rewind 5 s / play-pause /
   forward 5 s, time + sentence position, **speed selector** (0.75–2×,
   pitch-preserved, independent of seek), status text, close.
4. **Seek is ±5 seconds.** Fast-forward grays out when within 5 s of the live
   (still-generating) edge; after `complete` it grays only at the very end.
5. **Audio is cached** (cap **256 MB**, LRU) so finished blocks replay instantly
   and the user can jump around without re-contacting the server.
6. **Auto-advance**: when a block finishes, scroll to and play the next block
   (toggleable in options, default on).
7. Voice selection lives in options; default is to **omit** `settings.voice` so
   the engine keeps whatever voice is loaded (per the API doc's recommendation).

## Repo layout

```
extension/
├── package.json          # esbuild + typescript + @types/chrome (ALREADY WRITTEN)
├── tsconfig.json         # strict, noEmit, chrome types (ALREADY WRITTEN)
├── build.mjs             # esbuild bundle of 4 entries + copy static/ → dist/ (ALREADY WRITTEN)
├── .gitignore            # node_modules/, dist/ (ALREADY WRITTEN)
├── README.md             # build/install/setup instructions
├── static/               # copied verbatim into dist/
│   ├── manifest.json
│   ├── offscreen.html    # <script src="offscreen.js">
│   ├── options.html      # form + inline <style>
│   └── content.css
└── src/
    ├── protocol.ts       # wire types for TTS_API.md (ClientAction / ServerEvent)
    ├── messages.ts       # internal message + PlaybackStatus types
    ├── background.ts     # service worker: inject/toggle, offscreen lifecycle, relay
    ├── content.ts        # block detection, buttons, transport bar, auto-advance
    ├── offscreen.ts      # WebSocket client, PCM assembly, player, cache
    └── options.ts        # host/port/token/voice/auto-advance + Test connection
```

Build: `npm install && npm run build`, load unpacked from `extension/dist`.
`npm run typecheck` runs `tsc --noEmit` (esbuild doesn't typecheck).

## manifest.json

```json
{
  "manifest_version": 3,
  "name": "BookForge Reader",
  "version": "0.1.0",
  "description": "Read web pages aloud through BookForge's local streaming TTS engine.",
  "minimum_chrome_version": "116",
  "action": { "default_title": "BookForge Reader: toggle on this page" },
  "background": { "service_worker": "background.js" },
  "options_page": "options.html",
  "permissions": ["activeTab", "scripting", "offscreen", "storage"]
}
```

- No `host_permissions`: WebSockets from extension contexts don't need them, and we
  skip the HTTP probe — a WS connection failure means "not running", close code
  4401 means "bad token". That's enough to produce both error messages.
- `minimum_chrome_version: 116` for `chrome.offscreen.hasDocument()`.
- No icons in v1 (Chrome shows the default puzzle piece); add later if desired.

## Architecture & message flow

Per the API doc: MV3 service workers can't own an `AudioContext`/`<audio>` and get
killed when idle, so the **offscreen document owns the WebSocket + player + cache**.
Content scripts can't be messaged directly from offscreen, so the **service worker
relays**. All `chrome.runtime` messages carry a `target` field
(`'background' | 'offscreen' | 'content'`) because background and offscreen both
hear `runtime.onMessage`; each listener returns early on a foreign target.

```
content ──{target:'background', cmd:'play'|'transport'}──▶ background
background ──{target:'offscreen', cmd:'play'|'transport'}──▶ offscreen
offscreen ──{target:'background', cmd:'status'|'finished', blockKey}──▶ background
background ──chrome.tabs.sendMessage(tabId, {target:'content', cmd, blockId, status})──▶ content
```

- `blockKey = "${tabId}:${blockId}"` — background composes it on `play` (it knows
  `sender.tab.id`; content doesn't know its own tabId) and decomposes it when
  routing `status`/`finished` back to the right tab.
- Offscreen document is created lazily on first `play` with
  `reasons: [AUDIO_PLAYBACK, BLOBS]` — both genuine (it plays audio and holds blob
  URLs for cached audio), and AUDIO_PLAYBACK alone gets the document closed after
  ~30 s without audio, which would kill the WS during the ~60 s cold engine start.
- After `createDocument`, the first `sendMessage` can race the offscreen script's
  listener registration — background retries `sendMessage` up to ~8× / 120 ms on
  "Receiving end does not exist".
- background tracks `activeTab` (the tab that last sent `play`). On
  `tabs.onRemoved` or `tabs.onUpdated` with `status === 'loading'` (navigation)
  for that tab → send `{cmd:'transport', op:'stop'}` to offscreen.

## The playback engine (the key design decision)

**Don't schedule AudioBufferSourceNodes.** Raw Web Audio playback-rate changes
shift pitch (no `preservesPitch` on buffer sources), and the user explicitly wants
a 1.25×/1.5× speed slider. Instead:

- Assemble received PCM16 into a growing in-memory byte sequence (array of
  `Uint8Array` segments, in playback order).
- Play it via **one `<audio>` element** whose `src` is a WAV blob URL
  (44-byte WAV header for PCM16 mono 24 kHz + the segments). Set
  `audio.preservesPitch = true` (cast to `any` if lib.dom lacks it) and
  `audio.playbackRate = rate` after every load.
- The blob is **rebuilt lazily**, never while audibly playing:
  - on first start,
  - on `ended` when more PCM has arrived than the current blob covers
    (`session.seconds > blobSeconds`) — reload at `currentTime = blobSeconds`
    and resume,
  - on a seek past the current blob's end.
- `bytes / 48000 = seconds` (24 kHz × 2 bytes); all position math is byte-derived
  and exact.

**Why the swap gaps don't matter**: a src swap costs ~10–40 ms. By construction
(below), swap points land on *sentence boundaries* — natural pauses — so they're
inaudible. To guarantee that, **don't start playback at the first chunk**; start
when the first sentence is fully appended (`appendCursor >= 1`), OR generation is
finished, OR ≥ 8 s is buffered (safety valve for a very long first sentence).
Warm-engine start latency becomes ~2–6 s instead of ~2–3 s — an acceptable trade
for pitch-preserved speed + dead-simple pause/seek/cache.

This gives for free: pause (`audio.pause()`), seek (`audio.currentTime`), speed
(`playbackRate` + `preservesPitch`), replay, and caching (keep the PCM segments).

### PCM assembly (`Session` class in offscreen.ts)

Per the API doc: sentence 0 streams in ordered `seq` chunks; other sentences
arrive as single chunks **out of order** across 4 workers.

```
Session {
  requestId = crypto.randomUUID()
  sentences: string[]              // from 'speaking'
  slots: { chunks: Uint8Array[](by seq), done, failed }[]
  segments: Uint8Array[]; bytes    // contiguous appended PCM
  boundaries: number[] = [0]       // boundaries[i] = byte offset where sentence i starts
  appendCursor = 0; cursorSeq = 0  // next sentence / next seq to append
  complete = false                 // 'complete' arrived (all audio generated)
  generationDone = false           // no more audio WILL arrive (complete | cancelled | error | disconnect)
  note: string | null              // e.g. "Preempted by another BookForge client"
}
```

`drain()` (called after every chunk/done/failed): while a slot exists at
`appendCursor`, append its chunks in `cursorSeq` order as they're present; when
the slot is `done` and fully consumed, advance `appendCursor`, reset `cursorSeq`,
record `boundaries[appendCursor] = bytes`. This streams the cursor sentence's
chunks immediately and appends later sentences atomically when contiguous.
`failed` ⇒ mark done with zero chunks (zero-length sentence, playback skips it
naturally). `sentenceAt(seconds)` scans `boundaries` (valid up to `appendCursor`)
for playhead reporting and the `3/41` display.

### Offscreen orchestration

State: `session`, `currentBlockKey`, `cacheKey`, `started`, `userPaused`,
`blobSeconds`, `blobUrl`, `rate`, `errorMsg`,
`preState: 'connecting'|'starting-engine'|'buffering'` (UI state before playback
starts), `finishedSent`, `lastReportedSentence`, `playSeq` (a generation counter:
`handlePlay` is async — storage read, SHA-256, connect — so it checks
`seq === playSeq` after every await and aborts if a newer play superseded it).

**handlePlay(blockKey, text, rate)**:
1. `stopCurrent()` — send `cancel` for the old request if generation is live;
   cache the old session if `complete`; pause audio.
2. `cacheKey = sha256(voice + '\0' + text)` (via `crypto.subtle`; voice from
   storage — voice is part of the key so changing voice busts the cache).
3. Cache hit → build a complete Session from the entry, `loadBlob(0)`, play. Done —
   no server contact.
4. Miss → `ensureConnected()` (lazy WS + `hello` auth), then send `speak`
   (`settings.voice` only if configured). Status pushes drive the UI through
   connecting / starting-engine / buffering.

**Server events** (all matched against `session.requestId`; stale events ignored):
`speaking` → init slots. `chunk`/`done`/`failed` → drain, then `afterData()`.
`complete` → `finishGeneration(true)`. `cancelled` (not self-initiated) →
`finishGeneration(false, 'Playback was taken over by another BookForge client')` —
**normal flow, not an error**: already-received audio stays playable, but on
ended do NOT emit `finished` (so auto-advance doesn't skip unheard text).
`error` with matching/absent requestId → `errorMsg`, finish generation.
Engine `state` pushes pre-start → `preState = 'starting-engine'` / back to
`'buffering'`.

**afterData()**: if not started and (appendCursor ≥ 1 || generationDone ||
seconds ≥ 8) → start. If started and `audio.ended` and new PCM exists → extend
(reload at `blobSeconds`). If started and `audio.ended` and generation finished →
finalize. Push status.

**ended handler**: more PCM → extend; else if `complete && !finishedSent` →
`finishedSent = true`, cache the session, send `{cmd:'finished', blockKey}`.

**Socket close mid-speak**: `ws = null`; if session incomplete →
`finishGeneration(false, 'Connection to BookForge lost')`. Buffered audio plays
out; no `finished` ⇒ no auto-advance; user presses play again → fresh `speak` of
the whole block (incomplete sessions are never cached — keep resume simple).

**Transport ops**: `toggle-pause` (pre-start: just flip `userPaused`, which
gates autoplay; at end-of-complete-audio: restart from 0), `seek ±5`
(clamp to `[0, session.seconds]`; reload blob if target beyond it), `rate`
(set `playbackRate` live), `stop` (cancel + clear + push an `idle` status).

**Status pushes**: 300 ms interval while a session exists + immediately on every
transition. `PlaybackStatus`:

```ts
{ state: 'connecting'|'starting-engine'|'buffering'|'playing'|'paused'|'ended'|'error'|'idle',
  position, buffered, totalKnown /* complete arrived */,
  sentenceIndex, sentenceCount, error?, note? }
```

**Playhead reporting** (lookahead contract): in the status tick, when playing
(not paused — the doc says don't advance the window while paused) and generation
is live, if `sentenceAt(currentTime)` changed → send
`{action:'playhead', requestId, sentenceIndex}`. Once per boundary, exactly as
the doc prescribes.

**Cache**: `Map<cacheKey, {segments, bytes, boundaries, sentences, lastUsed}>`,
`lastUsed` = monotonic counter (not Date). Evict oldest while total > 256 MB,
never the just-inserted key. Only `complete` sessions are cached.

## Content script

- **Idempotence**: guard with `window.__bfrInjected`; background tries
  `tabs.sendMessage({cmd:'toggle-ui'})` first and only injects
  (`insertCSS` + `executeScript`) when that throws.
- **Block detection**: `querySelectorAll('p, li, blockquote, h1..h6, dd, figcaption')`
  filtered by: not inside
  `nav, header, footer, aside, form, [role="navigation"], [aria-hidden="true"], [contenteditable], #bfr-root, #bfr-bar`;
  normalized `innerText` ≥ 60 chars (≥ 12 for headings — chapter titles matter
  for auto-advance continuity); nonzero bounding rect. **Leaf-dedupe** so an
  `<li>` wrapping a `<p>` doesn't double-read: drop any candidate containing
  another candidate (cheap pre-check: `el.querySelector(SELECTOR)` before the
  O(n²) `contains` pass). Cap ~500 blocks. No `pre` (reading code aloud is noise).
- **Buttons**: one absolutely-positioned 22 px round button per block in a
  `#bfr-root` container appended to `document.documentElement` (NOT body — the
  MutationObserver watches `body`, so our own DOM writes can't retrigger scans).
  Position = `rect + scroll` (document coords; no scroll listener needed).
  Reposition on resize; full rescan via MutationObserver debounced 1.5 s.
  Stable block ids from a `WeakMap<HTMLElement, string>` + counter so rescans
  don't reassign ids. Button states via `data-state`:
  idle / loading (pulse animation) / playing / paused / error / done.
- **Click**: active block → `toggle-pause`; any other → `play` (server-side
  preemption makes switch-while-loading just work).
- **Transport bar** `#bfr-bar`: fixed bottom-center dark pill, built with DOM APIs.
  `«5  ▶/⏸  5»  ·  0:23/1:45+  ·  3/41  [1×▾]  status  ✕`
  - Time shows `position / buffered` with a trailing `+` until `totalKnown`.
  - FF disabled when `buffered - position <= (totalKnown ? 0.6 : 5.2)` — that's
    the "grayed at the live edge" rule. Rewind disabled at position ~0.
  - Speed select `[0.75, 1, 1.25, 1.5, 1.75, 2]`; on change: persist to
    `chrome.storage.local.rate` and send `{op:'rate'}`. Rate is also sent inside
    every `play` so the offscreen doc starts new sessions at the right rate.
  - Status text: Connecting… / Starting TTS engine… (about a minute) /
    Buffering… / Paused / Done / error message; append `note` when present.
  - ✕ → `stop`, hide bar, reset button.
- **Auto-advance**: on `finished` for the active block: mark button done; find
  next block in document order, `scrollIntoView({block:'center', behavior:'smooth'})`,
  play it. Read `autoAdvance` from storage at init.
- **Status routing**: ignore status/finished whose `blockId !== activeBlockId`
  (stale events from a just-replaced session).
- **Toolbar toggle**: hide `#bfr-root` + bar, stop active playback; re-toggle
  rescans.
- Declare all module-level `let`s before the bottom-of-file init call (esbuild
  IIFE + TDZ).

## Options page

Fields: host (default `127.0.0.1`), port (`8766`), token (password input),
voice (`<select>` with "Engine default" = `''`), auto-advance checkbox.
**Test connection** opens a WS itself (extension pages can), sends `hello`,
reports: connected + engine state + populates the voice dropdown from
`msg.voices` (note when engine is cold: "voices appear once it starts");
4401 → "token rejected, re-copy from tts-api.json"; else/6 s timeout → "is
BookForge running?". Save → `chrome.storage.local`. Hint text shows both token
paths from the API doc (macOS + Windows).

## Error handling map (from the doc's checklist)

| Condition | Behavior |
|---|---|
| WS connect fails | error status: "Can't reach BookForge at host:port — is the app running?" |
| Close 4401 | "BookForge rejected the token — check it in the extension options." |
| No token configured | "No token configured — open BookForge Reader options…" |
| `error` event for our request | show message, reset block button |
| `failed` sentence | zero-length slot; playback skips it; counts stay aligned |
| `cancelled` (preempted) | finalize partial audio, playable, note shown, **no auto-advance** |
| Socket drop mid-speak | partial audio plays out, "connection lost" note, play again = fresh speak |

## Verification (needs the user)

`tts-api.json` does NOT exist yet — the user must launch BookForge once with the
current build (branch `ui-restructure-phase-1`) to generate the token. Then:
1. `npm install && npm run build` in `extension/`; `npm run typecheck` clean.
2. Load unpacked `extension/dist`, paste token in options, Test connection.
3. On a long article: toolbar click → buttons appear; play → engine cold-start
   spinner → audio; pause/seek/speed; let a block finish → auto-advance; replay a
   finished block (instant, from cache); click a different block mid-play
   (preemption); quit BookForge mid-play (disconnect handling).

## Post-build housekeeping

- Add an `extension/` line to CLAUDE.md's Key Directories tree (pointer to
  `extension/README.md` + `docs/TTS_API.md`).
- Update the `tts-server-service` memory file: extension now exists at
  `extension/` (it currently says "planned, not yet built").
