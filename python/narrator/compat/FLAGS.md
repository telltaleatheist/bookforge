# The headless flag set - every flag, its verdict, and who passes it

`compat/` answers the command lines BookForge's bridges build today. This is the
complete table, generated from the same dict the code routes on
(`compat/flags.py:FLAGS`) so the two cannot drift; `tests/test_compat_flags.py`
asserts every row.

**Counts: 58 flags - 36 ACCEPT, 17 IGNORE, 5 REFUSE.** Plus 18 engine names
refused by name on `--tts_engine`, and 4 near-misses refused for naming no
registry id.

**58, not 56, and the two extras are narrator's own.** `--higgs_voice`
(Higgs did not exist in e2a, and its voice is a catalog id rather than a prompt
token) and `--coverage_report` (e2a had no engine guarded by post-render forced
alignment, so it needed no way to satisfy one). Everything else here is still
e2a's argv answered by narrator.

**Changed for Higgs v3 (2026-09-04, the first cut-over slice):** `--tts_engine`
now accepts `higgs-v3` as well as `orpheus`, on the prep, worker and retake
routes, and the value selects the engine through `engine/registry.py`.
`--higgs_voice` is new. `NARRATOR_ENGINE` may name the engine instead of the
flag; when both are present and DISAGREE the run is refused rather than one
silently winning.

**Changed at migration step 4 (prep, 2026-09-04):** `--prep_only`,
`--sentence_per_paragraph` and `--skip_headings` moved REFUSE -> ACCEPT, and
six flags moved IGNORE -> ACCEPT because PREP records them in
`session-state.json` even though no render reads them: `--ebook`, `--language`,
`--device`, `--voice`, `--custom_model`, `--custom_model_dir`. `--ebooks_dir`
stays REFUSE with a new reason (batch conversion, not "prep is not ported").

## The two doors, and why they are one parser

BookForge spawns ebook2audiobook two ways, and the flag sets differ:

| e2a script | spawned by | has that the other lacks |
|---|---|---|
| `worker.py` | `parallel-tts-bridge.ts:3880` (render), `:3596` (retake) | `--sentence_indices`, `--sentence_overrides`, `--num_takes`, `--take_temperatures` |
| `app.py --headless` | `parallel-tts-bridge.ts:3210` (prep), `:3923` (render, when `useLightweightWorker` is off), `:5183` (assembly), `:8792` (`--resume_session`), `:8888` (`--list_sessions`) | `--prep_only`, `--worker_mode`, `--assemble_only`, `--headless`, and the whole gradio/XTTS option list |

`compat/app.py` accepts the UNION and `compat/worker.py` is the same routing with
`--worker_mode` implied, so each bridge changes one string at cut-over.

**One deliberate unification.** e2a's `app.py --worker_mode` runs
`session.worker_only` -> `lib/core.convert_chapters2audio`, an UNBATCHED loop
with a different resume rule (`idx_target >= resume_sentence`, not a file-size
check) and different progress lines (`Block N containing M sentences...`,
` : <sentence text>`). `worker.py` runs `worker_core.run_worker_tts`, which is
batched, size-gated, and prints the `Converting sentence N/M (P%)` line the
bridge's regex reads. **BookForge renders every book through the second**
(`useLightweightWorker` is on). narrator ports the second and routes BOTH doors
to it. The file set produced is identical - `<i>.flac` at the same indices - so
nothing downstream can tell; what changes is that a caller who used
`app.py --worker_mode` now gets batching and the size-gated skip. Listed under
"Unexercised e2a paths" in the report.

---

## ACCEPT (35)

| flag | passed by | what narrator does |
|---|---|---|
| `--prep_only` | `parallel-tts-bridge.ts:3219` (the prep spawn is `:3210-3253`) | -> `text.prep.prep_session` (migration step 4). See "The prep route" below |
| `--worker_mode` | `parallel-tts-bridge.ts:3936` | -> `render.worker.run_worker` |
| `--assemble_only` | `parallel-tts-bridge.ts:5207`, `reassembly-bridge.ts:1530` | -> `assemble.assemble` over `render.session_v1.build_manifest` |
| `--list_sessions` | `parallel-tts-bridge.ts:8888` | -> `session_store.list_resumable_sessions`, printed as `json.dumps(..., indent=2)` |
| `--resume_session` | `parallel-tts-bridge.ts:8792` | -> `session_store.resume_session` |
| `--session` | every spawn | the session id; echoed into the result JSON |
| `--session_dir` | every spawn | the `ebook-<uuid>` dir OR the `<hash>` dir under it; both resolve |
| `--sentences_dir` | `:3896`, `:3938`, `:3609` (retake scratch), `:5199` (assembly source) | the authoritative sentence store: written and skip-checked in worker mode, the sentence SOURCE in assembly |
| `--encoded_chapters_dir` | `reassembly-bridge.ts` | pre-encoded `<N>.m4a` chapters, each held to the 0.06 s duration guard |
| `--output_dir` | `:3919`, `:3931`, `:5187` | where assembly writes the m4b and the VTT |
| `--coverage_report` | nothing today | **narrator's own flag** - the report `narrator align --report` wrote, passed straight to `assemble(coverage_report=...)`. REQUIRED for an engine guarded by post-render forced alignment (Higgs v3), where its absence is a refusal by name; a no-op for Orpheus, whose `CoveragePolicy` is not enforced. See `align/README.md` and `assemble/coverage_gate.py` |
| `--sentence_start` / `--sentence_end` | `:3915-3918` | the contiguous 0-based inclusive range |
| `--chapter_start` / `--chapter_end` | `:3911-3914` (chapter mode) | 1-based inclusive; converted to a sentence range |
| `--chapters` | nothing today | assembly's chapter selection; must be a contiguous run from 1 (`assemble/README.md` s8) |
| `--sentence_indices` | `parallel-tts-bridge.ts:3644` | -> `render.retake`; a scattered explicit set |
| `--sentence_overrides` | `:3652` | -> `render.retake`; a JSON file of `{index: text}` |
| `--num_takes` | `:3649` (only when > 1) | -> `render.retake` |
| `--take_temperatures` | `:3647` | -> `render.retake`; its COUNT sets `num_takes` |
| `--tts_engine` | every spawn | SELECTS THE ENGINE: `orpheus` or `higgs-v3`, checked on the prep, worker and retake routes and resolved through `engine/registry.py`. NOT checked on `--assemble_only` / `--list_sessions` / `--resume_session` - see below |
| `--higgs_voice` | the Higgs spawns | **narrator's own flag** - Higgs has no `--fine_tuned` voice TOKEN; its voice is a CATALOG ID naming a fine-tuned adapter or a set of reference clips. Recorded in `session-state.json` as `higgs_voice`, never as `fine_tuned` |
| `--fine_tuned` | `pushVoiceArgs` (`:244`, `:263`, `:277`, `:293`) | the Orpheus voice token -> `EngineConfig.voice` |
| `--orpheus_model_dir` | `pushVoiceArgs:243, 276` | a merged fine-tune |
| `--orpheus_adapter_dir` / `--orpheus_base_dir` | `pushVoiceArgs:268-270` | LoRA adapter over a shared base |
| `--post_render_filter` | `reassembly-bridge.ts:1532` only | the per-voice ffmpeg `-af` chain, applied at the FINAL assembly encode. See below |
| `--output_format` | worker/assembly spawns | assembly's container; `m4b` is the only shape exercised. PREP also builds `final_name` from it |
| `--ebook` | the prep spawn (`:3214`), and the assembly spawn (`:5188`) | **prep parses it** - it is the whole input. Every other route ignores it; e2a's assembly ignored it too |
| `--language` | the prep and assembly spawns | **prep** resolves it through `iso639` into `language`/`language_iso1` and gates the book on it (Orpheus is English-only). The ENGINE has no language-dependent behaviour |
| `--device` | every spawn | **prep** normalizes it through e2a's `devices` table and records it in `device`. The worker ignores it: `detect_backend()` reads no session device |
| `--voice` | `pushVoiceArgs:290` (custom XTTS voices only) | **prep** records it in `voice`. No Orpheus render reads it |
| `--custom_model` / `--custom_model_dir` | `pushVoiceArgs:288-289` | **prep** records them in `custom_model`/`custom_model_dir`. No Orpheus render reads them |
| `--sentence_per_paragraph` | `parallel-tts-bridge.ts:3248` (language-learning mode) | prep splits on `[break]` before `escape_sml` runs, so each paragraph is one chunk and the packer never runs |
| `--skip_headings` | `parallel-tts-bridge.ts:3253` | prep suppresses the TEXT of real `h1`-`h6` headings (still parsed for chapter detection). It does NOT suppress a TOC-matched title recovered from body text, and never did |

(31 rows; the paired `start`/`end`, `adapter`/`base` and
`custom_model`/`custom_model_dir` rows carry two flags each, which is what makes
35 flags.)

### The prep route

`--prep_only` is `bookforge_ext/parallel/session.prep_ebook_info` (NOT
`lib/core.py`'s dead copy of the same name) plus `handlers.py:47-76`'s argument
normalization: `--ebook` is made absolute (the process-dir md5 is taken over that
string), `--output_dir` becomes `audiobooks_dir`, and `--device` is mapped through
`conf.devices`.

**Where the session goes.** e2a put it at `$E2A_TMP_DIR/ebook-<session id>`,
and `parallel-tts-bridge.ts:3196-3202` COMPUTES THE SAME PATH ITSELF and then
reads `session-state.json` out of it. narrator honours `--session_dir` when a
caller passes one and otherwise derives the identical path from
`session_store.sessions_root()`.

**AT CUT-OVER THE PREP SPAWN MUST PASS `--session_dir`, AND THAT IS THE ONLY
FIX.** `sessions_root()` reads `$E2A_TMP_DIR`; e2a survived without it because
`lib/conf.py` fell back to `<e2a_root>/tmp`, which is exactly the path the bridge
had computed. narrator has no e2a root and refuses to guess.

Forwarding `E2A_TMP_DIR` into WSL is NOT an alternative, and an earlier draft of
this file wrongly offered it as one. Two independent reasons:

1. **The variable holds the wrong path.** For a WSL prep the bridge derives the
   session dir from the WSL e2a ROOT - ``sessionDir = `${wslE2aPath}/tmp/ebook-
   ${sessionId}` `` (`parallel-tts-bridge.ts:3180`) - while `E2A_TMP_DIR` is
   resolved from `getDefaultE2aTmpPath()`, a WINDOWS path. Exporting it inside
   the guest would point prep at a directory that does not exist there, and the
   bridge would then read `session-state.json` from a place prep never wrote.
2. `spawnWithWslSupport` does not hand the Windows environment to the guest at
   all: it re-exports a fixed `forwardKeys` list (`:1590-1601`) - the `ORPHEUS_*`
   tuning vars plus the two owner-pid vars.

The render and retake spawns already pass `--session_dir` explicitly
(`:3896-3938`, `:3609`). The PREP spawn (`:3210-3253`) does not, and must: one
argument, `'--session_dir', sessionDir`, using the variable the bridge has
already computed on both branches. Until then narrator refuses by name, so the
failure is a sentence an operator can act on rather than a session written to the
wrong disk.

**Nothing parses prep's stdout.** `prepareSession` logs it, skips any line
starting with `{` (`:3305-3310`), and reads `session-state.json`
(`:3394-3435`). The result JSON is still printed in e2a's shape
(`json.dumps(result, indent=2, default=str)` on success; a COMPACT
`{"success": false, "error": "prep_ebook_info failed"}` on failure) because that
is what the door printed.

**PREP WRITES A GAP FILE FOR A `pads=False` ENGINE, AND ONLY THEN.**
`<process_dir>/chapters/sentences/gaps.json` -
`{"version":1,"engine":"higgs-v3","gaps":{"<global chunk index>":{"before":<s>,"after":<s>}}}`,
one key per chunk, `0..N-1` as strings. The values are
`text/gaps.classify_gap`'s, which IS `engine/orpheus/prompt.py`'s
`_classify_gap` moved down to `text/` unchanged - so the silence the file asks
the assembler to insert around a Higgs chunk is exactly the silence Orpheus
would have baked into the same chunk. `assemble/engine_profiles.py` is the table
that decides (`orpheus` pads, `higgs-v3` does not); an engine it does not know
raises rather than being guessed at. **An Orpheus prep writes no such file, and
that absence is the signal**, not an omission - its gaps are in the audio.

Expect ONE REPEATED VALUE in it. At 9daab0ba the paragraph and section tiers are
gone (2026-07-17, measured as purely additive dead air), so a heading, a
`[break]`, an `[item]` and a plain sentence end all classify to `(0.0, 0.6)`;
only an explicit `[pause:X]` differs. `ORPHEUS_SENTENCE_GAP` still moves the
floor and is read at PREP time here, which is the one behavioural difference
from the Orpheus path (`text/PORT_NOTES.md`).

**A non-EPUB `--ebook` is refused by name.** e2a Calibre-converted txt/pdf/image
inputs; Foundry produces an EPUB for every book, and e2a's own EPUB branch
refuses to Calibre an EPUB because it was destructive. `text/PORT_NOTES.md`
section 4 lists it under "Unexercised e2a paths".

### `--tts_engine` on assembly is scaffolding, and BOTH spawns pass `xtts`

The flag names the engine that RENDERS. On `--assemble_only` it names nothing:
e2a needs a session to declare some engine to set itself up and then never
consults it while combining audio, and BookForge exploits that deliberately.

| spawn | line | what it passes |
|---|---|---|
| reassembly | `reassembly-bridge.ts:1517` | the literal `'--tts_engine', 'xtts'`, unconditionally, on every book including Orpheus ones |
| inline render -> assemble | `parallel-tts-bridge.ts:5164` | `asmEngineArg = assembleOrpheusNative ? 'xtts' : settings.ttsEngine` - `'xtts'` whenever native Windows Orpheus assembly runs, because it runs in the generic bundled env |

`CLAUDE.md` records the same thing for the WSL-normalization path ("assembly uses
the generic bundled env + `--tts_engine xtts` (engine-agnostic)").

So `check_engine` is called from the worker route ONLY (`compat/app.py:dispatch`).
An earlier draft ran it before routing and refused every real assembly - the
review's blocking finding. `--list_sessions` and `--resume_session` are not gated
either: they read the filesystem and never load a model.

### `higgs-v3`, and the four names that are not it

`check_engine` accepts exactly `orpheus` and `higgs-v3`. Four near-misses are
refused by name rather than helpfully resolved, because guessing which Higgs a
caller meant is how a whole book gets rendered by the wrong model:

| name | why not |
|---|---|
| `higgs` | names no registry id |
| `higgs-v2` | dropped (Owen, 2026-09-04: "basically just Orpheus and we know Orpheus better"); only the v3 served backend ships |
| `higgs-v2-scaffold` | interface scaffolding in the registry, never a render engine |
| `higgs_v3` | narrator spells it with a hyphen |

**WHAT WORKS TODAY FOR HIGGS, AND WHAT DOES NOT.** `--prep_only --tts_engine
higgs-v3 --higgs_voice <id>` prepares a session end to end: the engine is
recorded exactly as given, the voice under `higgs_voice`, and the book is chunked
by `text/paragraph_packer.py` against the Higgs `Budget` (prep forces
`chunking=paragraph`, because the ported e2a packer is Orpheus-only and refuses
by name otherwise).

**The RENDER route now takes `higgs-v3` too** (2026-09-04). It used to refuse it
while `render/worker.py` could not carry a Higgs voice; both changes it named
have landed - `WorkerRequest.higgs_voice`, and a config chosen by engine id
through `engine/registry.py` rather than an Orpheus `EngineConfig` built
unconditionally. What survives from that refusal is the narrower check that
`--higgs_voice` and `--tts_engine` AGREE: `--fine_tuned` is a prompt TOKEN and
`--higgs_voice` is a CATALOG ID, so one handed where the other is expected
resolves to the wrong voice for a whole book. A Higgs render still needs
`NARRATOR_HIGGS_VOICES` to point at the voice document, and says so by name when
it does not.

**PREP GATES THE ENGINE TOO, just not through `check_engine`.** Since migration
step 4 the flag decides what gets PARSED as well as what gets rendered: the
Orpheus branch of `normalize_text`/`get_sentences` is the only one ported, so
`text.prep.prep_session` and `text.chapters.get_chapters` each refuse a
non-Orpheus engine with `UnsupportedEngine` before reading a byte of the book.
That refusal leaves `compat/app.py` as `Error: <message>` and exit 1, not as
e2a's `prep_ebook_only failed` dict - see "The prep route".

Nothing is lost by this. The refusal that decides what gets RENDERED lives in
`render/worker.py`, which resolves the SESSION's `tts_engine` through
`engine/registry.py` and refuses an id the registry does not know - naming the
ones it does - even when the flag was never passed.

### `--post_render_filter`: who applies it, and when

Applied by **assembly only**, never by the worker: `lib/core.py:4236-4249` appends
it to the pre-loudnorm filter list of the single final encode, and
`lib/core.py:3967` makes its presence disable the parallel-export shortcut so it
cannot be skipped. It is one opaque argument (a chain may contain `|`, `:`, `/`,
quotes) and is never shell-interpolated.

Passed by exactly one site: `reassembly-bridge.ts:1532`, and only when the caller
ticked `applyDeRing`, resolving the voice's `postRenderFilter` from
`electron/data/orpheus-models.json` via `orpheus-models.ts:1299`. The render
path's assembly spawn hard-codes it to `undefined`
(`parallel-tts-bridge.ts:5181`, with a comment: silently de-ringing every book
"dulled sibilants on books that had no ringing"), so on that path it is never
passed at all.

---

## IGNORE (17) - parsed, honoured by nobody, and that is correct

| flag | passed by | why nothing happens |
|---|---|---|
| `--headless` | every `app.py` spawn | narrator has no GUI; headless is the only mode |
| `--no_split` | `parallel-tts-bridge.ts:5208` (ALWAYS), `reassembly-bridge.ts` | a whole-book assembly is the only shape narrator produces, so the flag already describes the behaviour (`CONTRACTS.md`: e2a's `output_split` path is unexercised and must not be ported) |
| `--skip_deps` | `:3934`, `:5210` | narrator installs nothing |
| `--speed` | `:3906`, `:3962` (only when != 1.0) | XTTS only |
| `--temperature`, `--top_p`, `--top_k`, `--repetition_penalty`, `--length_penalty`, `--num_beams`, `--enable_text_splitting` | the prep spawn, XTTS branch | XTTS only. Orpheus's equivalents arrive as `ORPHEUS_TEMPERATURE` / `ORPHEUS_TOP_P` / `ORPHEUS_REP_PENALTY` env vars or as registered per-voice caps |
| `--text_temp`, `--waveform_temp` | nothing | bark only |
| `--output_channel` | nothing | assembly is mono, as e2a's default was |
| `--script_mode` | nothing | the docker/native switch |
| `--workflow` | nothing | an e2a test hook that pinned a fixed session id |
| `--share` | nothing | a gradio flag |

---

## REFUSE (5) - narrator raises, by name

| flag | message |
|---|---|
| `--ebooks_dir` | batch conversion (`convert_ebook_batch`) is a gradio-era feature no BookForge spawn has ever used: it loops one prep per file and `sys.exit(1)`s on the first failure. Pass `--ebook` once per book |
| `--bilingual` | bilingual assembly is the one e2a path where assembly inserts silence of its own (`bilingual_pause` 0.3 s between a pair, `bilingual_gap` 1.0 s between pairs), which falsifies every timing rule narrator rests on. `bookforge_ext/parallel/bilingual.py` is out of scope by name. **PASSED BY A LIVE SPAWN** - see below |
| `--bilingual_pause` | see `--bilingual`. Passed by the same spawn |
| `--bilingual_gap` | see `--bilingual`. Passed by the same spawn |
| `--skip_assembly` | a dual-voice bilingual hook |

(5 flags, 2 distinct REASONS in 4 message strings: `--ebooks_dir` stands alone,
and the other four are all the bilingual reason - `--bilingual` states it,
`--skip_assembly` names itself a bilingual hook and points at it, and the two
timing flags say only "see `--bilingual`".)

### The bilingual refusal is reachable from the app, and that is the point

`parallel-tts-bridge.ts:5211-5215` appends all three flags to the assembly spawn
whenever `config.bilingual?.enabled`:

```
...(config.bilingual?.enabled ? [
  '--bilingual',
  '--bilingual_pause', String(config.bilingual.pauseDuration ?? 0.3),
  '--bilingual_gap', String(config.bilingual.gapDuration ?? 1.0)
] : [])
```

`bilingual-assembly-bridge.ts` is a second bilingual path. So this is not a
theoretical flag: a language-learning book assembled after cut-over would hit the
refusal. **That is the intended outcome - bilingual books stay on
ebook2audiobook.** The refusal names the flag and says why, so the failure is a
sentence an operator can act on rather than a wrong-length audiobook. Whoever
cuts over `parallel-tts-bridge.ts` must route a bilingual job to e2a (or leave
that branch spawning e2a) rather than to narrator; there is no partial support to
fall back to, because every timing rule in `assemble/` is false for that layout.

Refusals exit 1 after printing `Error: <flag> is not supported by narrator: <reason>.`

An **unknown** flag exits 1 with `Error: Unrecognized option "--x". narrator
accepts: <the full sorted list>` - e2a's own pre-argparse loop (`app.py:226-230`),
kept in the same place and for the same reason.

## `--tts_engine`: 18 names refused, on the worker route

`xtts`/`XTTSv2`, `bark`/`BARK`, `vits`/`VITS`, `tortoise`/`TORTOISE`,
`fairseq`/`FAIRSEQ`, `tacotron`/`TACOTRON`, `yourtts`/`YOURTTS`, `f5`/`F5`,
`voxtral`/`VOXTRAL` (both the lowercase CLI form and e2a's `TTS_ENGINES` key, since
`app.py:190` accepted either). Anything else is "unknown engine". Only the
registry's render ids are accepted (`orpheus`, `higgs-v3`), and
`render/worker.py` refuses a SESSION whose `tts_engine` is not one of them even
when the flag was never passed - a DELETED e2a engine by name and with the
"use ebook2audiobook" advice, anything else as an unknown id listing
`registry.ids()`.

This check runs on the WORKER route only. See "`--tts_engine` on assembly is
scaffolding" above for why an assembly spawn passing `xtts` must be honoured.

---

## What compat does NOT reproduce

- **The `--worker_mode` result JSON's extra keys.** e2a's `session.worker_only`
  returned `{success, session_id, sentence_start, sentence_end}`;
  `worker_core.run_worker_tts` returns those plus `sentences_processed`,
  `sentences_converted`, `sentences_skipped`, `sentences_failed`,
  `failed_indices`, `elapsed_seconds`. narrator always returns the LARGER set,
  because that is the one BookForge parses.
- **The worker's result JSON is ONE LINE, the app door's is `indent=2`.**
  `worker.py:518` prints `json.dumps(result)` compact and exits
  `0 if result.get('success') else 1` (`:521`); `handlers.py` prints
  `json.dumps(result, indent=2)` and `app.py:278` exits
  `0 if result.get('success', True) else 1`. Both shapes are reproduced on their
  own routes, because `parallel-tts-bridge.ts:3747` scans stdout LINE BY LINE for
  `t.startsWith('{') && t.includes('"success"')` - a pretty-printed result is
  invisible to it and the bridge falls to its degraded branch, marking every
  index failed on a run that succeeded.
- **`--list_sessions`'s consumer.** `parallel-tts-bridge.ts:8907-8909` logs the
  stdout and resolves `[]` regardless. The format is preserved as e2a writes it;
  nothing reads it.
- **`--resume_session`'s consumer, as written, cannot parse the answer.**
  `handlers.py:44` prints `json.dumps(result, indent=2)` - multi-line - and
  `parallel-tts-bridge.ts:8818-8828` tries `JSON.parse` on each stdout LINE, so
  no line ever parses and `checkResumeStatus` always resolves "Failed to parse
  resume check output". The live path is `checkResumeStatusFromProcessDir`
  (`:8619`), which reads `session-state.json` in Node and never spawns anything.
  narrator preserves e2a's output byte-shape rather than "fixing" it, and the
  fact is recorded in `render/PORT_NOTES.md`.
