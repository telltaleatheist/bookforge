# The browser extension goes to Crucible directly — the plan (Phase 16)

**Owen, 2026-09-14 (evening):** *"write up a plan to bring the browser extension into compliance
with crucible. including removing orpheus from the options list, deleting the orpheus voice
models once they're verified safe and redownloadable on huggingface, and making sure the
browser extension logic is going through the streaming pipeline it currently goes through for
higgs. switching to live streaming from rendering dropped the time to first sentence from 45
seconds to 6 seconds. we also need to make sure the higgs model is unloaded afterward … we
should make the streaming server load and unload in memory from the browser extension …
bookforge's streaming tab in the nav bar can use the same logic as the browser extension."*
And: *"the extension will have to have a way to connect to crucible servers as well. probably
the same way bookforge and foundry connect to them. and it needs a way to pick which crucible
server to use."*

Sequenced AFTER Phase 15's button run (`crucible/docs/PHASE15-HOST.md` §8). Until this lands,
the extension keeps talking to BookForge's WebSocket on 8766, which relays to Crucible's
streaming door (PHASE3-TTS.md §7's ruling), and Sunday keeps working.

## 0. What is decided

- **The extension is a Crucible client.** It talks to `POST /v1/tts/stream`, the SSE event
  stream and the op post directly, from its offscreen document (which already owns audio and
  outlives the service worker's 30-second idle kill, which an SSE connection in the worker
  would not). BookForge does not have to be running to read a page.
- **It connects the way the apps connect:** a pasted connect code (`crucible://…`), parsed by
  the SDK's `parsePairing`, into a registry of servers in `chrome.storage.local`, with ONE
  selected server. A browser extension cannot read the pairing file, so the operator page's
  Connect panel and BookForge's Settings → engine both offer the same "Copy connect code"
  the extension takes. The Options page lists the registry, a Select radio, Add (paste),
  Remove, and a Test that is `/v1/ping` + `/v1/info` (name, backend, resident voice).
- **Load and unload go through the engine, from the extension:** the popup's one button
  becomes **Load voice / Unload** = `POST /v1/jobs {type: "load-voice", voice}` and
  `{type: "unload-model"}` on the selected server, with the job's events driving the button's
  state. "Engine up" is `/v1/info`'s resident voice, not a process the extension owns.
- **The text side stays ONE source, bundled twice.** Sentence segmentation and the Listen
  normalizer (`electron/tts-punctuation.ts`'s deterministic Listen path — punctuation, number
  rules; BookForge OWNS it, ruling `narration-text-pass-ledger-step`) move to
  `shared/listen-text/` and are bundled by esbuild into the extension and by tsc into the
  app. A keeper pins the two bundles' function bodies byte-equal. Nothing is copied.
- **BookForge's Streaming tab uses the same client.** `electron/tts-api-server.ts` +
  `stream-scheduler.ts`'s session policy (read-ahead window, background prefetch, preempt,
  playhead) become a renderer-side module `src/app/core/listen/` that is the same code the
  extension's offscreen page runs (built from `shared/listen-client/`). The tab's process
  buttons are the extension's popup buttons.
- **Orpheus leaves the extension.** The options' engine list, `engine.restart {engine}`,
  `cpuWorkers`, the Orpheus voices, and the `fastStart` switch's Orpheus arm go. The switch
  itself stays as a CLIENT gate ("Buffer before playing": wait for the whole sentence vs. play
  from the first frame), because Crucible's stream always emits sub-sentence frames — fast
  start is the door's native shape, and buffering is a client choice.
- **After the extension is direct, BookForge's "TTS server" button and its options go
  (Owen, 2026-09-14: "we should remove the tts server button and its options from bookforge.
  we need to make sure those options are added to the extension though" — then: "every IMPORTANT
  option. some of these options are unimportant and dont need to carry over").** The keeper that
  pins the deletion lists both columns by name:

  | carried into the extension | dropped, and why |
  |---|---|
  | **voice** ("voice is important and must be available on the extension") — from `GET /v1/voices` of the selected server | **voice engine** — always Higgs today; the multi-engine door for "when we add a new voice engine, after higgs is superseded" is Crucible's: each `/v1/voices` row already names its `engine`, and the extension shows an engine column only when that list carries more than one — no selector of its own |
  | **speed** | **generation device** — "always chosen by the crucible server": MLX/mlx-audio on the Mac, SGLang/vLLM on CUDA; never a client field |
  | **Buffer before playing** (the client gate) | **enable multiple TTS workers** (`cpuWorkers`) — XTTS-only, XTTS is removed; gone |
  | **idle-unload window** (`idleMinutes` → a client timer that posts `unload-model`) | the engine start/stop/restart rows — they ARE the popup's load/unload |
  | **the server picker** (registry + connect code; replaces the LAN host/port/token rows) | |

  The extension's own tab-recording rows are already the extension's and stay as they are.
  Nothing is removed from BookForge until the extension has every row in the left column.
- **After the extension is direct, BookForge's 8766 relay is deleted.** The iPhone Bookshelf
  reader keeps its own bridge on the bookshelf server (the phone needs the ingest endpoint and
  a LAN-addressable server, which is BookForge's), pointed at the same shared client.

## 1. The wire, mapped

| extension today (8766 WebSocket) | Crucible |
|---|---|
| `hello {token}` | bearer on every request; `X-Crucible-Api: 1` |
| `status` / `state` pushes | `GET /v1/info` (resident voice), `GET /v1/activity` |
| `engine.start {voice}` | job `load-voice {voice}` + its events |
| `engine.stop` | job `unload-model` |
| `engine.restart {engine, voice, cpuWorkers}` | GONE (one engine; workers are server tuning) |
| `config.get/set` | `GET /v1/voices` for the list; the rest is server config, never the client's |
| `speak {requestId, text, settings, preempt, background, startSentence, fastStart}` | session `POST /v1/tts/stream {voice}` once; then one `say {id, text, take: 0}` per sentence; `startSentence` = the client sends only the rows it lacks; `background`/`preempt` are CLIENT scheduling (which rows it says, in what order); `fastStart` is the client gate |
| `speaking {requestId, sentences}` | the client segmented the text itself (shared source), so it already knows |
| `chunk`, `done`, `error` | `audio {id, seq, pcm_base64}`, `done {id, seconds, chars, capped}`, `error {id, code}`, plus `restart {id, from_seq}` the client must honour (a retake of a row mid-stream) |
| `playhead {requestId, sentenceIndex}` | client-side only: it decides which rows to `say` next |
| `cancel {requestId}` | `cancel {id}` per row, `cancel_all`, `close` |
| reconnect | `Last-Event-ID` inside the 15 s grace window — the extension's tunnel reconnect gets this for free |

One session per selected server per tab-reading; the session is closed on stop and on tab
close. Two clients (the extension and BookForge's tab) contend for one card the way any two
Crucible clients do: the second `POST /v1/tts/stream` while a session is live is refused by
name (`engine_in_use` per PHASE3 §7), and the popup says which client holds it, from
`/v1/activity`. Preempt-across-clients (today's `preempt: true`) is therefore an explicit
"take over" that closes the other session through the engine, not a silent kill.

## 2. Correct Sentences — where it stands, and the ruling it needs

Already through Crucible: `electron/crucible/reroll.ts` sends the flagged indices as N `tts`
render jobs at `take: 0`, one `<index>.flac` artifact each; takes differ because narrator's
sampling is unseeded. **What does NOT travel: the temperature spread** (`computeTakeTemperatures`,
0.4/0.8/1.0 around Orpheus's 0.6 — an Orpheus-era practice). The module refuses temperatures
by name rather than dropping them.

**Ruling proposed (Owen decides):** the spread IS the take ladder, and a temperature is never on
the wire. PHASE3 §3 already defines it — `[[voice.takes]]` per voice, take 0 = the boson
default, take 1 = the one measured alternative (0.7, with its written reason) — and the
division-of-knowledge ruling says tuning is engine config, never a wire field. Correct
Sentences then asks for `take: 0..k` across its N candidates (k ≤ the ladder's length,
`unknown_take` past it), and the audition list says which rung each take came from. **The one
thing owed before that works: narrator's sampling channel on `generate`/`generate_batch`**
(PHASE3 §4: "a take above 0 on a voice that declares a ladder is refused `sampling_not_wired`"
until narrator carries it) — that is BookForge's `python/narrator`, not Crucible. Then
`computeTakeTemperatures` and the legacy arm are deleted with the legacy layer.

## 3. Every render/stream route BookForge manages, and where each stands

| surface | door | state |
|---|---|---|
| narration render (the book) | `tts` render job, `electron/crucible/render.ts` | through Crucible |
| Streaming tab | `stream-scheduler` → 8766 relay → stream door | relayed; becomes the shared client (§0) |
| browser extension | 8766 relay | relayed; becomes direct (§0) |
| iPhone Bookshelf reader | `reader-stream-bridge` on 8765 → scheduler | relayed; keeps its bridge, same shared client |
| Listen (narration modal / voice preview) | stream door, `electron/crucible/stream.ts` | through Crucible |
| Correct Sentences re-roll | `tts` jobs at take 0, `reroll.ts` | through Crucible; spread = ruling (§2) |
| Whisper "Generate sentences" | `asr` job | through Crucible |
| alignment | `align` job | through Crucible |
| RVC voice conversion | `rvc` job | through Crucible |
| denoise (hiss separator) | `denoise` job | through Crucible |
| page reading (PDF) | `pages` via Foundry | through Crucible |
| cleanup / narration text pass / number normalization / simplify / translate / analysis | `llm` (routes) | through Crucible |
| zero-shot Higgs clips | `load-voice` with a reference clip | door exists; MLX arm never exercised |
| **Enhance tab (Resemble-Enhance CFM on MPS/CUDA)** | `electron/enhance-bridge.ts`, local spawn | **DROPPED (Owen, 2026-09-14: "drop and remove the enhance page and the corresponding crucible route. it's unnecessary").** The page, its route, `enhance-bridge.ts`, `components/resemble-env.ts`, the five `enhance:*` IPC handlers, the settings rows and the analytics fields go; NO `enhance` job type is ever built. `denoise` (the hiss separator) is NOT the Enhance tab's alone — `chapter-closer.ts`, `clipforge-chain.ts`, `coverage-align-job.ts` and the queue's `denoise-job.ts` use it — so the `denoise` job type and subject STAY. |
| RVC *training* (urvc), ClipForge studio | local | training is outside Crucible by design; ClipForge is CPU |

## 4. The Orpheus cleanup (C: space)

Verified-then-deleted by an agent, never deleted first: every local Orpheus artifact — fused
models under WSL (`~/higgs_v3_merged` is Higgs, NOT Orpheus; Orpheus fused/adapter copies are
in `E:\training` and the WSL/Windows caches), the `orpheus_tts` conda env (WSL), Orpheus
voices in BookForge's runtime dir, the extension's baked Orpheus voice list — each fused copy
checked against its HuggingFace mirror by sha256 (memory `orpheus-fused-copies-staged`: "HF
has them", `orpheus-finetune-public-repo`, `owen-morgan-voices-hf`) and deleted only when the
mirror's file matches byte for byte; adapters on E: stay (they are the source of every merge).
Anything unverified is listed, not deleted.

## 4a. The multi-engine door — what a second voice engine costs, and where

**Owen, 2026-09-14:** *"voice engine will be removed because it's always higgs. right now. i want a
multi engine option in case (or when) we add a new voice engine, after higgs is superseded."*

The door already exists in Crucible and nothing in a client has to be built ahead of it:

- A voice engine is a `tts` engine entry in Crucible (`crucible/engines/`), its env recipe
  (`envs/tts/<engine>-<backend>.txt`), and its voices' manifests carrying `engine = "<name>"`.
  `GET /v1/voices` rows already name their engine; `crucible install tts --narrator-engine
  <name>` installs it; a module asks for it with a second `[[job_types]] type = "tts"` entry
  (`modules/bookforge.toml` says so in its comment: a new engine is another multi-gigabyte
  install and therefore a person's decision, never a generator's).
- The extension and BookForge's narration modal show the engine as a COLUMN of the voice
  list, only when that list carries more than one engine. A voice implies its engine; no
  client ever selects an engine apart from a voice, so a second engine changes no wire and
  no option — a user picks a voice, and the engine comes with it.
- Nothing about the streaming door changes: the session is opened with a voice, and the
  server loads the engine that voice names.

So the "multi engine option" is: keep `engine` on every voice row (it is), never add an engine
selector to a client (there is none to remove later), and when the next engine lands it is
one Crucible entry plus one module line.

## 5. Order of work

1. Owen's ruling on §2 (takes are the spread). 2. `shared/listen-text/` + `shared/listen-client/`
extracted from the app with keepers (no behaviour change; the 8766 relay still runs on them).
3. The extension: registry + picker + connect code; load/unload jobs; the stream client;
Orpheus removed; "Buffer before playing" as a client gate. 4. BookForge's Streaming tab on the
shared client. 5. Owen's Sunday check on both machines. 6. Delete the 8766 relay and
`tts-api-server.ts`. 7. Delete the Enhance page and its bridge (ruled: drop). 8. Delete the TTS server button and its options from BookForge once the extension carries every one of them.
