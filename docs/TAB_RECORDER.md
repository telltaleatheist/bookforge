# Tab Recorder — lossless capture of one browser tab's audio

Contract for the BookForge Reader extension's **Record this tab** feature and the
TTS API server's `record.*` actions. Written 2026-09-03. Read `docs/TTS_API.md`
first for the transport, auth, and the existing action/event vocabulary; this
document only adds to it.

## Why it exists

The user buys audiobooks whose only playable form is a DRM'd web player (Audible's
Cloud Player at `audible.com/webplayer?asin=…`). They want the audio as training
data, at the quality the player decodes it to, without any other application's
sound bleeding in. Two facts decide the design:

1. **The player uses Encrypted Media Extensions.** The `<audio>` element carries
   `mediaKeys` and the page calls `audible-api/1.0/content/<asin>/drmlicense`.
   Decrypted audio never exists in page JavaScript, so intercepting `MediaSource`
   buffers or fetches CANNOT yield a file. "Pull the whole file" is not a feature
   we can build; it is not planned.
2. **`chrome.tabCapture` hands us the tab's own audio graph**, decoded, isolated
   from every other tab and application. That is the ONE way to get this audio
   from inside the browser. Capture is real-time (a 6-hour book takes 6 hours).

An OS loopback device (BlackHole) remains the user's fallback if Chrome ever
silences protected audio in tab capture. **Measured 2026-09-03 against the real
Audible Cloud Player: it does not.** 45.1 s captured clean — 48 kHz stereo, peak
-2.9 dBFS, RMS -19 dBFS, spectrogram showing speech with Audible's AAC lowpass at
~16 kHz. The feature works as designed; BlackHole is a contingency, not a
likelihood.

**Quality**: the tab stream is the player's decoded PCM. We never encode lossily:
float32 PCM leaves the browser, FLAC lands on disk. The only generation loss is
Audible's own AAC, which every route shares.

## Architecture

```
popup (user gesture)                offscreen document                     BookForge main
────────────────────                ───────────────────                    ──────────────
[Record this tab]                                                          tts-api-server.ts
  │ chrome.tabCapture.getMediaStreamId({targetTabId})
  │ → streamId
  ├─ runtime msg {cmd:'record', op:'start', streamId, tabId, title, speed}
  │      │
  │      ├─► background: chrome.scripting → page: preservesPitch=false, playbackRate=S
  │      │               (re-asserted every 2 s; restored to 1x when recording ends)
  │      │
  │      └─► offscreen:  getUserMedia(chromeMediaSource:'tab')
  │                      AudioContext(@stream rate)   → speed guard: rate/S ≥ 24 kHz
  │                      ├─ source → destination   (user keeps hearing it)
  │                      └─ source → AudioWorklet → float32 chunks
  │                           │ ws JSON  {action:'record.start', …, speed, outputDir}
  │                           │ ws BINARY frames (raw f32le interleaved)
  │                           ▼
  │                      ffmpeg -f f32le -ar R/S -ac C -i pipe:0 -c:a flac -sample_fmt s32
  │                             -bits_per_raw_sample 24     (R/S = the RELABELLED rate)
  │                           │ <dir>/.<stem>.partial.flac → atomic rename
  ◄─ snapshot.recording {state, seconds, bytes, level, path, waiting} ◄─┘ {record.progress|record.done}
```

- **Popup** owns the gesture. `chrome.tabCapture.getMediaStreamId` needs a user
  gesture and the `tabCapture` permission; the popup click is that gesture. The
  popup passes the stream id to the offscreen document via the background relay
  (same `target:'offscreen'` path every other command uses). The target tab is
  the popup's active tab — which may be a popup WINDOW (Audible opens the
  player in one); that is still a tab and captures the same way.
- **Offscreen** owns capture, the AudioContext, and the socket. Add
  `chrome.offscreen.Reason.USER_MEDIA` to the `createDocument` reasons
  (`getUserMedia` is refused without it). Capturing MUTES the tab's speakers
  unless the stream is wired back to `ctx.destination` — do that, always.
- **Server** owns the file. The client streams raw PCM; main spawns ffmpeg
  (`getFfmpegPath()` from `tool-paths.ts`) and pipes into it. No encoding in the
  browser, no WAV assembly in the browser, no 16 MB blobs.
- **Background** owns the page's playback rate, and owns it because the popup
  cannot: a recording can end with no popup open (the silence auto-stop, the tab
  closing, a dropped socket), and whatever set the page to 2× must be able to put
  it back. The popup's Record click is still what grants `activeTab`; that grant
  belongs to the extension and outlives the popup.

## Wire protocol additions (`docs/TTS_API.md` must gain this section verbatim)

Client → server (JSON):

```
{action:'record.start', recordId, title, sampleRate, channels, speed?, outputDir?, sourceUrl?}
   → server replies {type:'record.started', recordId, path}   (path = resolved final destination)
   → or {type:'error', recordId, message}                      (ffmpeg missing, dir unwritable, another recording live)
{action:'record.stop',   recordId}   → flush, finalize, {type:'record.done', recordId, path, seconds, bytes}
{action:'record.cancel', recordId}   → kill ffmpeg, delete the partial, {type:'record.cancelled', recordId}
{action:'record.mark',   recordId, label, seconds}   → append to the sidecar (see Output); no reply
```

Client → server (BINARY frames): raw `f32le` interleaved PCM at the declared
`sampleRate`/`channels`, any frame size (~100 ms chunks recommended). Binary
frames are ONLY legal between `record.started` and `record.stop`/`cancel`; a
binary frame outside a recording is answered with `{type:'error'}` and dropped.
**One recording per client connection**, and one per server — a second
`record.start` while one is live is refused by name.

Server → client:

```
{type:'record.progress', recordId, seconds, bytes}     every ~1 s
{type:'record.done'|'record.cancelled'|'record.started'} as above
```

`ws.on('message', (raw, isBinary))` — the server currently JSON-parses every
frame; the binary branch is new and must come BEFORE the parse.

## Output

- **Directory: the user's choice**, default `~/Downloads`, set in the extension's
  Options ("Save recordings to") and carried on every `record.start` as
  `outputDir`. A recording is a file someone made and wants to find, not app
  state, so it does not live in a folder of ours. The extension has no
  filesystem: the SERVER expands a leading `~` (correct on Windows too), refuses
  by name anything not absolute afterwards, creates the folder if missing, and
  refuses by name if it is not writable.
- File: `<safe title>-<YYYYMMDD-HHMMSS>.flac`, **24-bit**
  (`-c:a flac -sample_fmt s32 -bits_per_raw_sample 24`; ffmpeg's default 32-bit
  FLAC is legal but some libsndfile/librosa builds refuse it, and a recording
  nothing can open is not a recording).
- While it is being written it is `<outputDir>/.<stem>.partial.flac` — a dotfile
  with a suffix nothing can mistake for a finished recording, and in the SAME
  directory as the final file, because a staging folder elsewhere makes the
  finishing rename cross-volume and rename(2) answers EXDEV the first time
  someone picks an external disk. Renamed into place on `record.done`.
- The sample rate and channel count of the CAPTURE are whatever the tab delivered
  — **never resample**; ffmpeg gets `-ar`/`-ac` only as INPUT description. At
  `speed` > 1 the input `-ar` is the RELABELLED rate (`capture / speed`); the
  samples are still untouched. See §Speed capture.
- Sidecar `<same stem>.json`: `{ title, sourceUrl, sampleRate, captureSampleRate,
  speed, channels, startedAt, seconds, marks:[{label, seconds}] }`. `sampleRate`
  is the FILE's rate; `seconds` is BOOK seconds. Marks come from `record.mark`;
  v1 sends none (the popup has no mark button yet), the field exists so a later
  chapter-title observer in the content script has somewhere to write.

## Speed capture

The feature the user actually wants: capture faster than realtime. The Audible
player accepts `audio.preservesPitch = false; audio.playbackRate = S` and holds it
across chapter skips (verified live), so the tab emits the whole book in 1/S of
the time, pitch-shifted up.

**Nothing resamples.** The samples that arrive are written verbatim and the FILE
is labelled with a sample rate of `captureRate / S`. Played back at 1×, it is the
book at its original pitch and its original duration. A 6-hour book at 2× costs 3
hours of wall clock.

The cost is bandwidth, and it is exact — the file's Nyquist is
`(captureRate/S)/2`:

| capture | 1x | 1.5x | 2x | 3x | 4x |
|---|---|---|---|---|---|
| 44.1 kHz | 44.1 kHz | 29.4 kHz | 22.05 ✗ | 14.7 ✗ | 11.0 ✗ |
| 48 kHz | 48 kHz | 32 kHz | 24 kHz | 16 ✗ | 12 ✗ |
| 96 kHz | 96 kHz | 64 kHz | 48 kHz | 32 kHz | 24 kHz |

- **The guard** (`TRAINING_FLOOR_HZ` = 24000): a recording whose
  `captureRate / S` would fall below 24 kHz is refused BY NAME before a frame is
  sent — "At 3x a 48000 Hz capture keeps only 16000 Hz of audio — below the
  24 kHz training floor. Set the Mac's output device to 96 kHz in Audio MIDI
  Setup, or pick a lower speed." The capture rate is only knowable after
  `getUserMedia`, so the guard runs in the offscreen document the moment the
  AudioContext exists; on refusal the stream is stopped and the page's rate
  restored.
- **The server** refuses a speed that does not divide the capture rate into a
  whole sample rate — rounding it would put the book fractionally off pitch
  forever.
- **Driving the page**: `chrome.scripting.executeScript` (the popup's Record click
  is what grants `activeTab`) sets `preservesPitch=false` and `playbackRate=S` on
  every `<audio>`/`<video>` in every frame, and installs a MutationObserver plus a
  2 s re-assert so a player that resets its own rate is put back. The injection is
  driven from BACKGROUND, not the popup, because the recording can end without a
  popup open (auto-stop, tab closed, socket dropped) and whatever set the page to
  2× must be able to put it back. It restores `preservesPitch=true`,
  `playbackRate=1` on the live→not-live edge of the recording state.
- **Chrome mutes media above 4×**, so 4 is the ceiling — not an arbitrary cap.
- Progress `seconds` and the sidecar report BOOK seconds (`frames /
  (captureRate/S)`); the popup shows both that and the wall clock.

## Extension UI (popup)

A **Recorder** section under the existing transport controls:

- Idle: `[● Record this tab]`, a **speed selector** (1x / 1.5x / 2x / 3x / 4x),
  and the tab's title + destination folder in small text.
- Recording: red dot, elapsed `h:mm:ss` (BOOK time — plus the wall clock when
  capturing at speed), size, a live level meter (RMS from the worklet, ~10 Hz),
  `[■ Stop]` `[✕ Discard]`, and the destination path.
- **Waiting**: nothing has been heard yet (Record pressed before Play). Amber dot,
  "Waiting for audio — press play in the tab (stops in Ns)" — the clock keeps
  counting and the recording keeps running; the countdown is the same 30 s silence
  rule that ends a finished book, made visible instead of sprung.
- Done: "Saved <path>".
- Errors surface by name: "BookForge not running", "ffmpeg not found", "Another
  recording is in progress", the speed guard's refusal, and the save-location
  refusals ("… is not an absolute folder", "… is not writable").

State lives in the offscreen document and rides the existing `QueueSnapshot`
broadcast as a new optional `recording` field, so the popup renders it exactly
the way it renders playback state — no second channel.

## Behaviours that are NOT optional

- **Silence stops the recording, uniformly.** SILENCE_STOP_SECONDS (30 s) of
  CONSECUTIVE silence ends the recording and FINALIZES it — the file is kept.
  There is one rule and it applies from the first frame: silence at the front
  (Record pressed, Play never pressed) and silence at the end (the book finished)
  mean the same thing and get the same answer. 30 s is measured against the thing
  it must not cut — a chapter gap in a real audiobook is 2-4 s.
- **Leading silence never cancels.** It is a *waiting state*, not a failure: the
  popup says "Waiting for audio — press play in the tab" with the countdown, and
  the recording runs. There is no protected-audio verdict, because there is no
  protected-audio problem (see §Why it exists — measured). Silent frames are
  recorded like any other; they are the book's real leading gap and the user can
  trim them.
- **The speed guard** refuses a capture that would fall below 24 kHz, by name,
  before a frame is sent. See §Speed capture.
- **Socket loss mid-recording** = the recording ends with what the server has.
  The server finalizes on client close exactly as on `record.stop` (the file is
  complete up to the last frame), and the popup shows it as done-with-warning.
  Never leave a `.partial.flac` behind; sweep them on server start, in every
  folder that has been recorded into.
- **Recording and TTS playback share the socket** and must not interfere: a
  `speak` while recording is fine; `record.*` never touches the stream scheduler.
- **The tab going away** (closed, navigated) ends the track; treat `track.ended`
  as `record.stop` — and restore the page's playback rate.

## Verification

1. `cd extension && npm run typecheck && npm run build`; electron side
   `npx tsc -p electron/tsconfig.json` (or whatever the repo's electron gate is —
   check `package.json`). The renderer is untouched, so `ng build` is not needed
   unless a Settings surface is added (it is not, in v1).
2. Pure tests for the two pieces that can be pure: the f32 chunk → worklet
   framing (chunk boundaries, RMS/peak), and the server's recording session
   state machine (start/stop/cancel/close ordering, partial → rename, refusal of
   a second start). Wire them as `npm run test:tab-recorder`.
3. **The empirical gate, done by the user, not the agent**: load `extension/dist`
   unpacked, open `audible.com/webplayer?asin=…`, press play, press Record, wait
   30 s, Stop. Then `ffprobe` the FLAC and look at a spectrogram.

   **Result, 2026-09-03: PASS.** 45.1 s, 48 kHz stereo, 24-bit, peak -2.9 dBFS,
   RMS -19 dBFS, clean speech with Audible's AAC lowpass at ~16 kHz. Chrome does
   NOT silence protected audio in tab capture on this build, so the BlackHole
   fallback stays a contingency rather than the route.
