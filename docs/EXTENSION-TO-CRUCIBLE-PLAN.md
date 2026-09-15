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

**RULED (Owen, 2026-09-14, 20:xx):** *"we dont have to use temperature as the lever to get sentences
to sound different, but the goal is to re-render sentences that dont sound quite right. prosody is
bad, theres babbling or truncation, some other issue. thats why the feature exists. i was using
temperature as a lever because it gives a different output. if we can get the same result without
changing temperature then thats fine. i just know if a sentence/chunk was problematic before, itll
likely be problematic again with the same settings used to originally generate it."*

So the requirement is not "a temperature" — it is **a retake must not reuse the exact settings that
produced the problem**. Unseeded sampling alone gives a different output at the same settings, which
is the weak form; a different rung of the ladder is the strong form, and a problematic chunk needs
the strong form at least once. Therefore: the spread IS the take ladder, a temperature is never on
the wire, and Correct Sentences spreads its N candidates ACROSS the rungs, the first candidate on
rung 1 (the measured alternative) — never N re-rolls of take 0 — so every audition list contains at
least one candidate rendered under different settings than the original. With a two-rung ladder and
N = 3 that is takes 1, 0, 1; the audition list names the rung of each. The ladder itself stays the
engine's (per-voice config, PHASE3 §3), and a third rung, if one is ever measured, changes no client. PHASE3 §3 already defines it — `[[voice.takes]]` per voice, take 0 = the boson
default, take 1 = the one measured alternative (0.7, with its written reason) — and the
division-of-knowledge ruling says tuning is engine config, never a wire field. Correct
Sentences then asks for `take: 0..k` across its N candidates (k ≤ the ladder's length,
`unknown_take` past it), and the audition list says which rung each take came from. **The one
thing owed before that works (ASSIGNED 2026-09-14 evening, Opus agent): narrator's sampling channel on `generate`/`generate_batch`**
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
| **Enhance tab (Resemble-Enhance CFM on MPS/CUDA)** | — | **DELETED (b299ba09, 2026-09-14)** — the ruling (Owen: *"drop and remove the enhance page and the corresponding crucible route. it's unnecessary"*) is carried out end to end. Gone: the page and its feature folder, the `/enhance` route and rail entry, `enhance-bridge.ts`, `components/resemble-env.ts` and its catalog row, the fourteen `enhance:*` IPC channels across main/preload/`electron.service.ts`, the `enhance.*` block in `tool-paths.ts`, the three python scripts only that bridge ran, the `resemble_enhance` ClipForge engine stub, and `AUDIO_ENHANCEMENT.md`. NO `enhance` job type is ever built. `denoise` (the hiss separator) STAYS with all four consumers — `chapter-closer.ts`, `clipforge-chain.ts`, `coverage-align-job.ts`, `denoise-job.ts` — as does RVC voice enhancement; `tools/test-no-enhance-doors.js` (7799933c) pins both halves. |
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

## 4b. Zero-shot — a voice in every respect but where its identity comes from

**Owen, 2026-09-14:** *"zero shot uses a voice reference and the base model i believe. it should
effectively be treated as a model, for all intents and purposes, except the route it takes to
retrieve and return the audio."*

- In Crucible a zero-shot voice IS a `voice` subject: `voices/zeroshot.toml` names the Higgs
  BASE weights (pulled on the Mac already, 8.7 GB), and it loads through the same
  `load-voice` job as every fine-tuned voice — with one extra field, the reference clip
  (`reference: {data: <base64 wav>}`; the SGLang arm takes it that way today; the MLX arm has
  the door and has never been exercised with a real clip — memory `higgs-zero-shot-path`).
  Once loaded it is the resident voice; the streaming session and the render job name it
  as `zeroshot` and nothing downstream knows it was cloned from a clip.
- The CLIP is the client's. BookForge keeps its clips in `<userData>/runtime/higgs-models/refs/`
  and shows them as the four `zeroshot-*` entries in the voice modal; the extension keeps its
  own in `chrome.storage.local` / IndexedDB (a file input in Options, a short name, the WAV
  bytes) and shows them in the voice picker under the `zeroshot` row. Picking one = load
  `zeroshot` with that clip. Two clients, two clip stores, one voice subject — the clip is a
  per-client choice like a voice pick, not an engine fact, so there is no second owner.
- What is NOT built: the extension's clip store and picker (this plan), and the first real
  MLX-arm render with a clip (owed since 09-13; the button's T9 does not cover it — a
  separate measured run on the Mac once the clip picker exists).

> **CONTRACT GAP, measured 2026-09-14 while building step 3 — the clip store is BLOCKED and
> was not built.** Two things this section assumes are not in the contract or the SDK:
>
> 1. **There is no `reference` field.** `load-voice` takes a voice id and nothing else
>    (`@crucible/client` 0.6.0's `loadVoice(voice: string)`; `JobRequest` is
>    `{type, model?, params, inputs}` and PHASE3-TTS.md §6 names no reference channel). The
>    `reference: {data: <base64 wav>}` this section describes exists nowhere I can find. No
>    wire field was invented for it.
> 2. **A `kind = "zeroshot"` voice is refused BEFORE any engine starts**, on either arm, at
>    the load door as well as the render door — PHASE3-TTS.md §5's
>    `narratorvoices.voice_entry` list and §6's `voice_kind_unsupported`, whose own words are
>    *"narrator's `load` message carries `voice`, `modelDir`, `adapterDir`, `baseDir`, `caps`
>    and `warm` — **and no reference clips**. There is no channel on this wire for the thing
>    a zero-shot voice *is*."*
>
> The manifest CAN say `clips = "from-request"` (§157's escape hatch: "a job naming it must
> carry the clips in its `inputs`"), so the shape exists for a render job — but a streaming
> session takes no inputs at all, and the load door refuses the kind regardless. So the
> extension's clip picker needs, in this order: narrator's load message to carry clips, the
> `voice_kind_unsupported` refusal lifted, and a `load-voice` field to put them in. Until
> then a clip store in the extension would be a file input wired to a refusal.

**UNBLOCKED 2026-09-14 late (crucible `743dc1a`/`e342fee`/`d6f2786`, PHASE3-TTS.md §2–§7):** the load door now takes the clip — `POST /v1/jobs {type: "load-voice", model: "zeroshot", params: {reference: {data: <base64 WAV, no data: prefix>, transcript: <book-exact text of the clip>, name: <label>}}}`; SDK `loadVoice(voice, {reference})`; voices row `needs_reference` (SDK `needsReference`); refusals `reference_required` / `reference_not_allowed` / `reference_malformed` (not strict base64, not a readable WAV, blank transcript, over 30 s, over 32 MiB), all before the queue; the resident clip is reported on `GET /v1/activity` as `resident.reference = {name, sha256, seconds}` (null when a checkpoint voice is resident) and on the load job's `done`. Two corrections to the sketch above: **`transcript` is REQUIRED** (narrator refuses an empty one), so the extension's clip picker and BookForge's `refs/` entries each carry the clip's text; and the streaming door no longer refuses the zeroshot kind (it never loads). Still owed: the extension's clip store + picker (with the transcript field), BookForge's voice modal sending its four `zeroshot-*` refs through this door, and the first real MLX render with a clip.

## 5. Order of work

1. Owen's ruling on §2 (takes are the spread) — RULED, see §2; narrator's sampling channel assigned. 2. `shared/listen-text/` + `shared/listen-client/`
extracted from the app with keepers (no behaviour change; the 8766 relay still runs on them).
3. The extension: registry + picker + connect code; load/unload jobs; the stream client;
Orpheus removed; "Buffer before playing" as a client gate. 4. BookForge's Streaming tab on the
shared client. 5. Owen's Sunday check on both machines. 6. Delete the 8766 relay and
`tts-api-server.ts` — **SPLIT (Owen, 2026-09-14 late): the SPEAK relay goes, the tab recorder's
endpoint on that same server STAYS.** The recorder hands raw PCM to a machine with a filesystem
and ffmpeg writes the FLAC; nothing replaces that, so `record.*` keeps its door and the
extension keeps the BookForge host/port/token rows that reach it. 7. Delete the Enhance page and
its bridge (ruled: drop). 8. Delete the TTS server button and its options from BookForge once
the extension carries every one of them.
### Status (2026-09-14, evening)

- **Step 2 — LANDED.** `9d2a85f3` moved the Listen text path to `shared/listen-text/`
  (`normalize.ts`, `chunks.ts`, and the segmenter out of `text-ai.ts`) with no behaviour change
  but one stated exception: `splitIntoSentences` no longer logs per paragraph, because it now
  runs in a browser tab's console. Two knots had to be untied for a browser to compile the
  graph — the packer's 25-char floor became an import instead of a hand-written mirror, and
  `NarrationTextRewrite` moved to `shared/text/` so the pure number rules no longer drag 7,000
  lines of EPUB processor into a bundle. `tts-punctuation.ts`, `tts-number-rules.ts` and
  `number-expansion.ts` stayed in `electron/` ON PURPOSE: the orpheus-finetune side loads them
  as `dist/electron/*.js` (docs/NARRATION_TEXT_PASS.md), so the shared → electron arrow is
  named and reasoned in `normalize.ts`'s header rather than a path changing in silence under a
  second repository. `a7f12592` moved the session policy
  (`shared/listen-client/session-policy.ts`, out of `stream-scheduler.ts`) and the Crucible row
  layer (`crucible-rows.ts`, out of `electron/crucible/stream.ts`); `0d372bce` moved the
  read-ahead depth beside it. Both app files keep their exported surfaces byte-identical to
  their callers, and `test-crucible-stream` (22 checks) is green unchanged — including the exact
  wording a dropped session fails its rows with. The 8766 relay runs on this code.
- **Step 3 — LANDED.** `c6a7897e`. The registry, the picker and the connect code
  (`extension/src/servers.ts`, the SDK's `parsePairing`, one selected server, and no fallback to
  "the first one"); the five doors (`extension/src/crucible.ts`); Load / Unload as `load-voice`
  and `unload-voice` jobs whose own events drive the button; the stream client in the offscreen
  document, on the shared policy and the shared row layer; Orpheus, the engine selector,
  `cpuWorkers`, the device row and the restart row all gone; "Buffer before playing" a pure
  client gate, with `fastStart` off the wire entirely. `db775aa5` is the two keepers —
  `test-listen-text-one-source` (the two bundles' function bodies, byte for byte) and
  `test-extension-option-columns` (both columns of §0's table, by name).
  - **NOT built: the zero-shot clip store (§4b).** See the contract gap recorded there: there is
    no `reference` field on `load-voice`, and a `kind = "zeroshot"` voice is refused before any
    engine starts. Nothing was invented to work around it.
  - **Deliberately KEPT: BookForge's host/port/token rows in Options**, relabelled for what they
    are — and step 6 is now SPLIT so they stay for good: the recorder's endpoint outlives the
    speak relay. Removing those rows would break a working feature to satisfy a table.
- **Step 4 — RULED (Owen, 2026-09-14 late): the Streaming tab STAYS IN THE MAIN PROCESS. No
  renderer token door.** And it already runs the shared client: the policy it drives IS
  `shared/listen-client/session-policy.ts`, the rows behind it ARE
  `shared/listen-client/crucible-rows.ts`, and it reaches the same registry through the same
  venue decision — so the one-owner property step 4 was for is in hand. What is NOT done, and
  now never will be, is moving that client into `src/app/core/listen/` so the RENDERER talks to
  the Crucible itself: that needs a bearer token in the Angular renderer, and
  `electron/crucible/servers.ts` refuses to hand one out by design ("the only type that carries
  a plaintext token out of the registry" is the main-process one; every listing carries
  `tokenMasked`). The alternative — an IPC byte pipe for the session's five verbs — is a relay,
  and this phase exists to delete one. **`src/app/core/listen/` is therefore not a directory
  that is owed. It is a directory that is not wanted**, and this line is here so nobody creates
  it later reading step 4's heading alone. The tab's process buttons are still BookForge's own;
  turning them into the popup's Load/Unload is step 8's work.
