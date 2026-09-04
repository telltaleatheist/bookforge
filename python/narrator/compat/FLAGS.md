# The headless flag set - every flag, its verdict, and who passes it

`compat/` answers the command lines BookForge's bridges build today. This is the
complete table, generated from the same dict the code routes on
(`compat/flags.py:FLAGS`) so the two cannot drift; `tests/test_compat_flags.py`
asserts every row.

**Counts: 56 flags - 25 ACCEPT, 23 IGNORE, 8 REFUSE.** Plus 18 engine names
refused by name on `--tts_engine`.

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

## ACCEPT (25)

| flag | passed by | what narrator does |
|---|---|---|
| `--worker_mode` | `parallel-tts-bridge.ts:3936` | -> `render.worker.run_worker` |
| `--assemble_only` | `parallel-tts-bridge.ts:5207`, `reassembly-bridge.ts:1530` | -> `assemble.assemble` over `render.session_v1.build_manifest` |
| `--list_sessions` | `parallel-tts-bridge.ts:8888` | -> `session_store.list_resumable_sessions`, printed as `json.dumps(..., indent=2)` |
| `--resume_session` | `parallel-tts-bridge.ts:8792` | -> `session_store.resume_session` |
| `--session` | every spawn | the session id; echoed into the result JSON |
| `--session_dir` | every spawn | the `ebook-<uuid>` dir OR the `<hash>` dir under it; both resolve |
| `--sentences_dir` | `:3896`, `:3938`, `:3609` (retake scratch), `:5199` (assembly source) | the authoritative sentence store: written and skip-checked in worker mode, the sentence SOURCE in assembly |
| `--encoded_chapters_dir` | `reassembly-bridge.ts` | pre-encoded `<N>.m4a` chapters, each held to the 0.06 s duration guard |
| `--output_dir` | `:3919`, `:3931`, `:5187` | where assembly writes the m4b and the VTT |
| `--sentence_start` / `--sentence_end` | `:3915-3918` | the contiguous 0-based inclusive range |
| `--chapter_start` / `--chapter_end` | `:3911-3914` (chapter mode) | 1-based inclusive; converted to a sentence range |
| `--chapters` | nothing today | assembly's chapter selection; must be a contiguous run from 1 (`assemble/README.md` s8) |
| `--sentence_indices` | `parallel-tts-bridge.ts:3644` | -> `render.retake`; a scattered explicit set |
| `--sentence_overrides` | `:3652` | -> `render.retake`; a JSON file of `{index: text}` |
| `--num_takes` | `:3649` (only when > 1) | -> `render.retake` |
| `--take_temperatures` | `:3647` | -> `render.retake`; its COUNT sets `num_takes` |
| `--tts_engine` | every spawn | checked **only on the worker route**, where it must be `orpheus`. NOT checked on `--assemble_only` / `--list_sessions` / `--resume_session` - see below |
| `--fine_tuned` | `pushVoiceArgs` (`:244`, `:263`, `:277`, `:293`) | the Orpheus voice token -> `EngineConfig.voice` |
| `--orpheus_model_dir` | `pushVoiceArgs:243, 276` | a merged fine-tune |
| `--orpheus_adapter_dir` / `--orpheus_base_dir` | `pushVoiceArgs:268-270` | LoRA adapter over a shared base |
| `--post_render_filter` | `reassembly-bridge.ts:1532` only | the per-voice ffmpeg `-af` chain, applied at the FINAL assembly encode. See below |
| `--output_format` | worker/assembly spawns | assembly's container; `m4b` is the only shape exercised |

(22 rows; the paired `start`/`end` and `adapter`/`base` rows carry two flags
each, which is what makes 25 flags.)

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

Nothing is lost by this. The refusal that decides what gets RENDERED lives in
`render/worker.py`, which refuses a SESSION whose `tts_engine` is not `orpheus`
even when the flag was never passed.

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

## IGNORE (23) - parsed, honoured by nobody, and that is correct

| flag | passed by | why nothing happens |
|---|---|---|
| `--headless` | every `app.py` spawn | narrator has no GUI; headless is the only mode |
| `--no_split` | `parallel-tts-bridge.ts:5208` (ALWAYS), `reassembly-bridge.ts` | a whole-book assembly is the only shape narrator produces, so the flag already describes the behaviour (`CONTRACTS.md`: e2a's `output_split` path is unexercised and must not be ported) |
| `--skip_deps` | `:3934`, `:5210` | narrator installs nothing |
| `--device` | every spawn | reported in the worker log; the Orpheus backend is picked by `detect_backend()`, which reads no session device (`engine/PORT_NOTES.md` s1: `device` is not one of the eight session keys the engine read) |
| `--language` | prep and assembly spawns | the engine has no language-dependent behaviour: the prompt is `voice: text` and every guard measures characters |
| `--voice` | `pushVoiceArgs:290` (custom XTTS voices only) | the XTTS reference-clip path; an Orpheus voice arrives in `--fine_tuned` |
| `--speed` | `:3906`, `:3962` (only when != 1.0) | XTTS only |
| `--temperature`, `--top_p`, `--top_k`, `--repetition_penalty`, `--length_penalty`, `--num_beams`, `--enable_text_splitting` | the prep spawn, XTTS branch | XTTS only. Orpheus's equivalents arrive as `ORPHEUS_TEMPERATURE` / `ORPHEUS_TOP_P` / `ORPHEUS_REP_PENALTY` env vars or as registered per-voice caps |
| `--text_temp`, `--waveform_temp` | nothing | bark only |
| `--output_channel` | nothing | assembly is mono, as e2a's default was |
| `--script_mode` | nothing | the docker/native switch |
| `--workflow` | nothing | an e2a test hook that pinned a fixed session id |
| `--share` | nothing | a gradio flag |
| `--custom_model`, `--custom_model_dir` | `pushVoiceArgs:288-289` | the XTTS pre-staged voice path |
| `--ebook` | prep spawn, and the assembly spawn (`:5186`) | prep parses the EPUB; narrator renders from the state prep wrote. e2a's assembly ignores it too |

---

## REFUSE (8) - narrator raises, by name

| flag | message |
|---|---|
| `--prep_only` | "prep is migration step 4; use ebook2audiobook for prep until then" |
| `--ebooks_dir` | batch conversion is a prep-era feature |
| `--sentence_per_paragraph` | a prep/packer flag; the packer is step 4 |
| `--skip_headings` | a prep/packer flag; the packer is step 4 |
| `--bilingual` | bilingual assembly is the one e2a path where assembly inserts silence of its own (`bilingual_pause` 0.3 s between a pair, `bilingual_gap` 1.0 s between pairs), which falsifies every timing rule narrator rests on. `bookforge_ext/parallel/bilingual.py` is out of scope by name. **PASSED BY A LIVE SPAWN** - see below |
| `--bilingual_pause` | see `--bilingual`. Passed by the same spawn |
| `--bilingual_gap` | see `--bilingual`. Passed by the same spawn |
| `--skip_assembly` | a dual-voice bilingual hook |

(8 flags, 6 distinct reasons: the two bilingual timing flags defer to
`--bilingual`, and the two packer flags share one.)

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
`app.py:190` accepted either). Anything else is "unknown engine". Only `orpheus`
is accepted, and `render/worker.py` refuses a SESSION whose `tts_engine` is not
`orpheus` even when the flag was never passed.

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
