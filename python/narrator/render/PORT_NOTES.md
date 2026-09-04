# PORT_NOTES - `narrator/render` and `narrator/compat`

Migration step 3: the worker layer, ported out of ebook2audiobook with session
layout v1 unchanged. What came from where, what deliberately differs, and every
e2a defect reproduced rather than repaired.

**Sources** (all read-only, `ebook2audiobook` at `9daab0ba` branch `bookforge`):

| source | lines | what came from it |
|---|---|---|
| `bookforge_ext/parallel/worker_core.py` | 604 | `render/worker.py` - the loop, the resume rule, the take fan-out, the progress lines |
| `bookforge_ext/parallel/session.py` | 1,315 (the first 356) | `render/session_store.py` - state I/O, scanning, listing, resume |
| `worker.py` (e2a root) | 526 | `render/worker.py`'s signal handlers and parent-death watchdog; `render/retake.py`'s parsing; `compat/worker.py` |
| `bookforge_ext/parallel/args.py` | 218 | `compat/flags.py` - `PARALLEL_OPTIONS` and every help string's meaning |
| `bookforge_ext/parallel/handlers.py` | 142 | `compat/app.py` - the dispatch order and the printed result shape |
| `app.py` | 392 (158-232) | `compat/app.py` - the option list and the unrecognized-option loop |
| `lib/core.py:convert_chapters2audio` | 3724-3865 | READ, NOT PORTED - see section 3 |
| `bookforge_ext/parallel/bilingual.py` | 718 | REFUSED BY NAME. Out of scope; `compat/flags.py` refuses `--bilingual` and its two timing flags |

Companion documents: `render/SESSION_READERS.md` (every implicit reader of the
layout, which is what proves nothing moved) and `compat/FLAGS.md` (every flag,
its verdict, and the bridge that passes it).

---

## 1. What was built

```
render/session_store.py   session-state.json I/O, scan_completed_sentences,
                          calculate_missing_ranges, list_resumable_sessions,
                          check_resume_compatibility, resume_session
render/worker.py          run_worker() + the signal handlers + the parent watchdog
render/retake.py          the four retake flags' parsing, the take layout, run_retake()
compat/flags.py           the flag table: 56 flags, 25 ACCEPT / 23 IGNORE / 8 REFUSE
compat/app.py             app.py --headless, routed
compat/worker.py          worker.py, routed (compat/app with --worker_mode implied)
cli.py                    render / retake / sessions subcommands over the same calls
```

`render/gaps.py` WAS NOT WRITTEN, on purpose - see section 5.

---

## 2. The four parity claims of migration step 3

| claim | how it is held |
|---|---|
| (a) resume an existing e2a session dir untouched | `test_render_worker.ResumeTest` renders a synthetic session with real FLACs, deletes three, re-runs, and sha256-compares every other file. Same `chapters/sentences/N.flac` names, the same >1024-byte skip, the same `take<k>/` layout. **`session-state.json` is never written by the worker, because e2a's worker never writes it** (section 4). |
| (b) progress lines identical | `test_render_worker.ProgressLineTest` asserts against the bridge's own regexes, copied verbatim with their file:line. Section 6. |
| (c) per-sentence retakes produce the same files in the same places | `test_render_retake` asserts `<sentences_dir>/take<k>/<i>.flac` - the layout `correct-sentences-bridge.ts:429-441` globs - plus that nothing selects a winner. |
| (d) `--post_render_filter` semantics preserved | It is an ASSEMBLY flag. `lib/core.py:4236-4249` appends it to the pre-loudnorm `-af` list of the final encode, and `:3967` makes its presence disable the parallel-export shortcut. The worker never sees it. `compat/app.py` forwards it to `assemble()`, which already implements it. `compat/FLAGS.md` records that `parallel-tts-bridge.ts:5181` hard-codes it to `undefined`, so the render path never passes it; `reassembly-bridge.ts:1532` is its only live caller. **The assembly door must also survive the argv it arrives with**, which includes the literal `--tts_engine xtts` on an Orpheus book (`reassembly-bridge.ts:1517`; `parallel-tts-bridge.ts:5164`, `asmEngineArg = assembleOrpheusNative ? 'xtts' : settings.ttsEngine`). `--tts_engine` is engine-agnostic scaffolding there - e2a never consults it while combining audio - so `check_engine` runs on the WORKER route only. An earlier draft gated it before routing and refused every real assembly; `test_the_reassembly_bridges_own_argv_reaches_the_assembler` replays the bridge's argv verbatim so it cannot come back. |

---

## 3. THE ONE DELIBERATE UNIFICATION: two e2a workers, one port

e2a has two worker paths and they are not the same code:

| | `app.py --headless --worker_mode` | `worker.py` |
|---|---|---|
| entry | `handlers.dispatch` -> `session.worker_only` -> `lib/core.convert_chapters2audio` | `worker_core.run_worker_tts` |
| batching | none (`convert_sentence2audio` per chunk) | `convert_batch` at `batch_pool_size` |
| resume rule | `idx_target in missing_sentences or idx_target >= resume_sentence`, computed from a directory listing | `os.path.getsize(f) > 1024` per file |
| progress | `Block N containing M sentences...`, `********* Resuming from sentence N ********`, ` : <the sentence text>` | `Converting sentence N/M (P%)` |
| retake flags | absent | `--sentence_indices`, `--num_takes`, `--take_temperatures`, `--sentence_overrides` |
| empty sentence | skipped, NO file written | 0.1 s silence written |
| takes | absent | `take<k>/` subdirs |
| spawned by | `parallel-tts-bridge.ts:3923`, only when `useLightweightWorker` is off | `parallel-tts-bridge.ts:3880` (renders) and `:3596` (retakes) - the live path |

**narrator ports the second and routes both doors to it.** The observable output
is the same set of files at the same indices; what changes for a caller who used
`app.py --worker_mode` is that they now get batching, the size-gated skip, and a
silence file for an empty row instead of a permanent hole. The old path's
`convert_chapters2audio` also combined chapters when NOT in worker mode - a
non-worker responsibility that `assemble/` owns.

Listed under "Unexercised e2a paths" in the report, because BookForge has not
spawned that arm in the life of the flag.

---

## 4. `session-state.json` IS NEVER WRITTEN BY A RENDER

The brief for this step asked for "the same `session-state.json` v2 updates
(fields, `status`, `updated_at`)". **There are none.** Measured:

- `save_session_state` has exactly one caller in the whole e2a checkout:
  `prep_ebook_info` (`session.py:553`). `lib/core.py` keeps a duplicate with one
  caller, its own prep (`core.py:5483`).
- `status` is set to `'prepared'` there and no code path anywhere assigns it
  again. `grep "'status'"` over `lib/` and `bookforge_ext/` finds only that
  literal and `lib/core.py`'s unrelated in-memory session dict.
- `created_at` and `updated_at` are two `datetime.now()` calls in the same dict
  literal, so they differ by microseconds and agree to the second - the shape all
  three golden fixtures have, and asserted by
  `test_render_session_store.test_status_is_prepared_and_never_moves`.
- A render's progress lives in the filesystem: which `N.flac` exist and how big
  they are. That is what `scan_completed_sentences` reads and what every resume
  path in BookForge reads.

The ONLY writer of the file besides prep is **BookForge itself**:
`reassembly-bridge.ts:1108-1159` reads it, sets `metadata.*` and
`bookforge_metadata.*`, and writes it back; `parallel-tts-bridge.ts:1022-1060`
rewrites the three path keys after moving a session. Both are TypeScript. That
two-way traffic is also why every e2a reader re-derives its directories from the
process dir it was handed instead of trusting the paths inside the file
(`session.py:973-997`), and why `load_session_state` overwrites `process_dir` and
`session_dir` on the way out.

`session_store.save_session_state` and `set_status` exist so the store can
express a write (prep, migration step 4, will need them) and so the round-trip
test has something to drive. **Nothing on the render path calls either.**

---

## 5. Why there is no `render/gaps.py`

The worker realizes no gap. The gap is decided by `engine/prompt.py:_classify_gap`
(a `(lead_gap, trail_gap)` pair) and baked into the chunk's own FLAC by
`engine/audio.py:_save_audio`, which prepends `lead_gap` seconds of zeros and
appends `trail_gap`. Both are `narrator.engine`'s, ported in step 2 from
`orpheus.py:4075` and `:4561`.

`assemble/README.md` section 1 states the rule this produces: **assembly inserts
nothing, every gap is already PCM inside the chunk, so `samples` is the complete
answer.** `electron/scripts/normalize_gaps.py` later lifts each chunk's tail to a
per-voice floor, and that script is BookForge's, explicitly out of this column.

A `render/gaps.py` would therefore have contained either a re-implementation of
an engine method (a second copy of a guard, which the brief forbids) or nothing.
It contains nothing because it does not exist.

---

## 6. The progress lines, and the regexes that read them

Copied verbatim into `tests/test_render_worker.py` with their file:line, from
`C:\Users\tellt\Projects\bookforge\electron\parallel-tts-bridge.ts`:

| narrator emits | bridge matcher | line | effect |
|---|---|---|---|
| `Converting sentence <i>/<total> (<pct>%)` | `/Converting sentence (\d+)\/(\d+)\s*\(([\d.]+)%\)/i` | 4176 (stdout), 4279 (stderr) | the render bar; refreshes `lastProgressAt`, which is the watchdog's clock |
| - (never emitted) | `/Converting sentence (\d+) - ([\d.]+)%: (\d+)\/(\d+)/i` | 4175 | e2a's OLDER shape, tried first. narrator must NOT match it or the bridge reads the fields off the wrong pattern - asserted |
| `[WORKER] ...`, `[MEMORY] ...` | none | - | operator-read; grepped over `electron/` and parsed by nothing. `[MEMORY] After first sentence TTS` is logged once PER TAKE on the batched path, because e2a declares its `first_logged` flag inside the take loop (`worker_core.py:468`) |
| the RESULT dict, as ONE compact line | `t.startsWith('{') && t.includes('"success"')`, applied per trimmed stdout line | `:3747` | `worker.py:518` prints `json.dumps(result)` with no `indent`. A pretty-printed result has no matching line, and the bridge falls to `:3756-3768` - marking EVERY index failed and reporting the stderr tail as the error, on a run that succeeded. `_print_worker_result` vs `_print_app_result` in `compat/app.py` keeps the worker's shape and the app door's `indent=2` (`handlers.py`) apart |
| `Loading Orpheus TTS with voice '<v>'...` (engine) | `MODEL_LOAD_START_RE` | 2526 | "loading model" stage |
| `Orpheus TTS Loaded!` (engine) | `MODEL_LOAD_DONE_RE` | 2527 | stage ends |
| `Processed prompts` / `Adding requests` (vLLM), `MLX batch generating ...` (engine) | `GENERATION_ACTIVITY_RE` | 2513 | watchdog activity during a long flush |
| `audio-token cap`, `re-rendering split` (engine) | `GENERATION_ACTIVITY_RE`, `REPAIR_START_RE` | 2513, 2534 | repair stage note |
| `[ORPHEUS][ORPHEUS_GUARD_EVENT] {json}` (engine) | `parseOrpheusGuardEvent`, a literal prefix slice | 110-120 | reads `reason` and `sentence_index` |

The worker's own lines must not FALSELY trip the last three, or the UI shows a
repair that never happened; `test_the_worker_emits_nothing_that_falsely_trips_the_watchdog_regexes`
asserts that too.

**Timing that depends on the line arriving.** `WORKER_STARTUP_TIMEOUT_MS` = 10
min with no progress at all, `WORKER_PROGRESS_TIMEOUT_MS` = 12 min since the last
one, polled every 30 s (`parallel-tts-bridge.ts:2492-2501, 4754`). A stalled
worker is stopped cooperatively on WSL (SIGTERM, then `wsl.exe -t <distro>` -
never SIGKILL inside the guest) and with `taskkill /F /T` natively, then retried
up to twice.

**A batched flush prints its lines only when it RETURNS**, so they arrive in
blocks of `pool_size`. This is e2a's behaviour and is preserved exactly.

### On vLLM, `GENERATION_ACTIVITY_RE` cannot fire during a healthy batch

MEASURED in the GPU smoke (2026-09-04): a clean 5-chunk vLLM flush emitted ZERO
lines matching it. Of its five alternatives (`parallel-tts-bridge.ts:2513`):

| alternative | can it appear on the vLLM audiobook worker? |
|---|---|
| `Processed prompts`, `Adding requests` | **No.** They are vLLM's own tqdm, and the engine passes `use_tqdm=False` to every `generate()` call - `vllm_backend.py:284, 324, 413`, and e2a `orpheus.py:3347, 3387, 4772`, identically. The comment there is "a per-call progress bar adds overhead and noise" |
| `MLX batch generating` | No - MLX only |
| `audio-token cap`, `re-rendering split` | Only when a GUARD trips, i.e. not on a healthy render |

So during a vLLM flush the watchdog's only heartbeat is the block of
`Converting sentence` lines the PREVIOUS flush printed. The bridge's own comment
says this regex exists so "a batch of chunks ... can generate for minutes between
'Converting sentence' lines" without a false kill - on vLLM that protection is
inactive, and the 12-minute `WORKER_PROGRESS_TIMEOUT_MS` is doing the work alone.

It is safe at today's numbers and by a wide margin: the smoke measured 72.5 s for
5 chunks (~14.5 s/chunk), so a full 16-wide flush is ~4 minutes against a 12-minute
budget. It would take a ~50-chunk flush, or chunks ~5x slower, to reach the
timeout. **Pre-existing and identical in e2a** - not introduced by this port - but
worth knowing before anyone raises `ORPHEUS_BATCH_SIZE` for a long book.

---

## 7. Cancel, and the CUDA-poison fast-fail

There is **no cancel protocol on the worker's stdin** and no cancel file. Every
stop is a signal from outside plus the worker's own two rules:

1. `SIGTERM`/`SIGINT` -> `SystemExit(143)` (`worker.py:33`). Python's default
   SIGTERM disposition skips atexit, so torch/vLLM never release the GPU and the
   zombie collides with the next job. Raising instead unwinds the loop, drops the
   in-flight outputs and runs atexit - the GPU is released from INSIDE the
   process, which matters because SIGKILLing a guest process parked in a dxg GPU
   wait wedges the whole WSL VM.
2. The parent-death watchdog (`worker.py:54-343`), armed from
   `BOOKFORGE_OWNER_PID` + `BOOKFORGE_OWNER_PLATFORM`, which
   `parallel-tts-bridge.ts:4020-4021` sets on every worker spawn. Two rules - the
   ppid changed, or the named owner is gone / was replaced (start time compared
   via `ps -o lstart=`, the pid-reuse guard). Either fires SIGTERM to self, waits
   `ORPHEUS_WORKER_ORPHAN_GRACE_SECONDS` (default 60), then `os._exit(143)`.

**The CUDA-poison fast-fail keeps its exact shape, which is that it has no exit
code of its own.** `is_fatal_cuda_error` makes the engine RE-RAISE instead of
retrying the batch per item (`orpheus.py:4859-4861`: "Do NOT fall through to the
per-item retry: with a poisoned CUDA context..."), the exception reaches
`run_worker`'s outer `except Exception`, and the result is
`{'success': False, 'error': '<the CUDA message>'}` with exit 1. Confirmed by
grep: no `sys.exit(3)`, no sentinel string, nothing in the bridge keyed on a
numeric code (`parallel-tts-bridge.ts:4330-4383` treats every non-zero code the
same). The bridge's real defence is the completeness gate,
`findMissingSentenceFiles` at `:4564`, which refuses to assemble a book with
holes. `test_compat_flags.ExitCodeTest` pins this.

`isOomError` (`:4407`) is a regex over the error TEXT, not a code, so the OOM
tier ratchet also depends on the message reaching stdout/stderr unchanged.

---

## 8. Behaviour differences (exhaustive)

Twelve, all structural.

1. **`engine_factory` is a parameter of `run_worker`.** e2a built
   `TTSManager(session)` inline, which made the loop untestable without a 6 GB
   model on a GPU. The default builds the real engine and nothing in the loop
   changes. It is not reachable from any command line - `compat/app.py` takes it
   as a Python keyword only, exactly as `serve/worker.py` made `--fake-engine` an
   argv flag rather than an env var.
2. **`TTSManager` is not ported.** Four one-line delegations plus a registry
   lookup keyed on `session['tts_engine']`; narrator holds the engine directly.
   `supports_batch` / `batch_size` / `batch_pool_size` moved into
   `worker._render_take` and `_pool_size` with their coercions intact.
3. **The empty-sentence silence is the engine's `_write_silence`, not a second
   copy.** e2a's `worker_core._write_empty_sentence_silence` and
   `orpheus._write_silence` are the same three lines (`torch.zeros(1, sr*0.1)`,
   `torchaudio.save`, `format=flac`) at the same path. Calling the engine's keeps
   torchaudio inside `engine/` and cannot drift.
4. **The take directory is set by repointing `engine.config.sentences_dir`.** e2a
   repointed `session['sentences_dir']`, a shared DictProxy the engine read live;
   `EngineConfig` is a dataclass the engine also reads live (`_sentence_file`
   reads `self.config.sentences_dir` at every write), so the mechanism is
   identical.
5. **`[WORKER DEBUG] Full session dict:` prints a reconstructed view.** e2a
   dumped its whole session dict minus `chapter_sentences`. narrator has no such
   dict; `_debug_view` assembles the same information (which model, which
   directory, which voice, which output) from the state, the request and the
   engine config. Parsed by nothing.
6. **`log_memory`'s psutil import moved inside the function.** e2a imported it at
   worker_core's module scope. `psutil` is present in every env that has ever run
   an e2a worker (worker_core imports it unconditionally) and in the Windows test
   interpreter (7.2.2), but importing `narrator.render.worker` should cost
   nothing. This was flagged rather than edited because `python/pyproject.toml`
   is builder A's column; **it has since been added there** (`psutil>=5.9`), so
   nothing is owed.
7. **The `session_dir` default reads `E2A_TMP_DIR` and refuses when unset.** e2a
   fell back to `lib/conf.tmp_dir` = `E2A_TMP_DIR` or `<e2a_root>/tmp`; narrator
   has no e2a root and will not guess one.

   An earlier draft of this note claimed the variable is set on every spawn. It
   is not, and the distinction matters:
   **native spawns carry it** (`buildCondaSpawnEnv`,
   `electron/e2a-paths.ts:448`, unconditionally), but **WSL spawns do not** -
   `spawnWithWslSupport` does not pass the Windows environment into the guest at
   all; it re-exports a fixed `forwardKeys` list inside the bash command
   (`parallel-tts-bridge.ts:1590-1601`, the `ORPHEUS_*` tuning vars plus the two
   owner-pid vars) and `E2A_TMP_DIR` is not on it. The Orpheus render path is
   exactly the one that goes through WSL, so inside the guest this variable is
   simply absent.

   That is survivable because **every live render and retake spawn passes
   `--session_dir` explicitly** (`parallel-tts-bridge.ts:3896-3938`, `:3609`),
   which never reaches the derived form. The refusal message now says
   `pass --session_dir` rather than only naming the variable, because inside WSL
   setting the variable is not something the caller can do.
8. **`resolve_device` lowercases first, as `worker.py:487` does.** An earlier
   draft dropped the `.lower()`. The bridge always sends the UPPERCASE form
   (`resolveTtsDeviceArg` -> `'CUDA'`, because `app.py` wants uppercase), so
   without it `'CUDA' == 'cuda'` is False, neither availability branch is
   entered, and the `CUDA not available, falling back to CPU` diagnostic can
   never print. Restored and pinned by
   `test_the_device_is_lowercased_before_it_is_compared`.
9. **Retake argument errors print `Error: <message>` and exit 1** rather than
   escaping as a traceback. `worker.py:437/441/450/453/465` prints exactly those
   five lines; `compat/app.py:main` and `cli.py:_run_render` catch
   `RetakeArgumentError` and reproduce them.
10. **`save_session_state` is atomic, and has TWO declared byte deviations.**
   e2a truncates the real file and streams into it, so a crash mid-write leaves a
   state its own loader then refuses forever; a temp file plus `os.replace`
   removes that failure mode and adds none. The two byte deviations:

   - **LF on every platform** - the same deviation the VTT took
     (`assemble/README.md` section 7). e2a's own line endings already depend on
     which machine prepped the book (text-mode `open`, CRLF on Windows).
   - **`ensure_ascii=False`**, where e2a takes json's `True` default. THE LAST
     WRITER OF A LIVE `session-state.json` IS NOT e2a:
     `reassembly-bridge.ts:1108-1159` writes `metadata.*` and
     `bookforge_metadata.*` back through `JSON.stringify`, which never escapes
     non-ASCII. A real file on disk therefore already carries the literal
     accented character, and re-emitting it as `\u00fc` would churn bytes on
     every book with an accent in its title, for no reader's benefit. Matching
     the file's actual last writer is the smaller deviation. Pinned by
     `test_non_ascii_is_written_literally_not_escaped`.
11. **`list_resumable_sessions` does NOT sort its listing**, because
   `session.py:230` does not. An earlier draft sorted it "for stability"; nothing
   downstream reads the order (the one caller discards the whole answer), so
   matching e2a costs nothing and the sort was a difference for its own sake.
   `find_process_dir` still sorts - see 9.5, where the choice is between two
   valid sessions rather than an unread ordering.
12. **`session_store.load_session_state` raises on a corrupt state.** e2a keeps
   two copies of this function: `session.py`'s raises (deliberately hardened -
   "treating a corrupt state as 'no session' made callers start fresh over an
   existing session's rendered files"), `worker_core.py`'s swallows and returns
   None. narrator ports the loud one. Same outcome for a worker - it refuses -
   with a message that says what is wrong instead of "No session-state.json found
   in <dir>".

### Every changed message string

| e2a | narrator | cause |
|---|---|---|
| `[WORKER] Stop requested — dropped N in-flight output(s); exiting cleanly` | `... - dropped ...` | U+2014 -> `-` (CONTRACTS.md forbids non-ASCII on a console) |
| `[WORKER] Stop requested — exiting cleanly` | `... - exiting cleanly` | same |
| `[WORKER] Signal N received — shutting down cleanly...` | `... - shutting down ...` | same |
| every `—`/`→` in the watchdog's refusal lines | `-` / `->` | same |
| `No tts_engine in session state or args — the session state must name its engine` | `... - the session ...` | same |
| `[MEMORY] Before TTSManager init` / `After TTSManager init (model loaded)` | `Before engine init` / `After engine init (model loaded)` | `TTSManager` does not exist in narrator. Verified against all seven bridge regexes: none matches either form (`MODEL_LOAD_DONE_RE` needs a `!`) |
| `[WORKER] Registered TTS engine: <name>` | not emitted | `register_tts_engine` was a dynamic importlib dispatch over eight engine modules, to avoid loading 20 GB of unused engines. narrator has one engine and imports it directly |
| `[MEMORY] After imports` (`worker_core.py:56`) | not emitted | printed at IMPORT of `worker_core`, measuring the cost of the module-scope torch/psutil/TTSManager imports narrator does not have |
| `[MEMORY] After register_tts_engine` (`worker_core.py:370`) | not emitted | measures the importlib dispatch above, which is gone |
| `[MEMORY] After first sentence TTS` | emitted, once per TAKE on the batched path | e2a's `first_logged` is declared inside the take loop (`worker_core.py:468`), so it resets each take; the serial arm's `if processed == 1` tests a cumulative counter and fires once per RUN. The two arms genuinely differ in e2a and both are preserved |
| `[WORKER] Loading TTS worker core...` (`worker.py:481`) | not emitted | announced the deferred heavy import of `worker_core`; narrator's equivalent boundary is `[MEMORY] Before engine init`, which is emitted |

Everything else - `[WORKER] Loaded session:`, `[WORKER] Processing N sentence(s)
on X`, `[WORKER] TTS engine: e, fine_tuned: v`, `[WORKER] Batched inference
enabled ...`, `[WORKER] Take k: sampling temperature = t`, `Converting sentence
i/N (p%)`, `[WORKER] Warning: Failed to convert sentence i`, `[WORKER] Completed:
c converted, s skipped in Ts`, `[WORKER] ERROR: n sentence(s) failed to convert:
[...]`, `[WORKER] Chapter mode: chapters a-b = sentences s-e` - is byte-identical.

---

## 9. Suspected bugs preserved

Recorded, not repaired. Each is e2a's behaviour at `9daab0ba` and each is pinned
by a test so a future fix is deliberate.

### 9.1 The resume floor is inconsistent with itself

`scan_completed_sentences` counts a file as complete at `>= 1024` bytes;
`run_worker_tts`'s loop skips one only at `> 1024`. A file of exactly 1024 bytes
is therefore "done" to every resume scan and "missing" to the worker, which
re-renders it. Harmless (the re-render is correct) and exactly one byte wide.
Pinned by `ResumeTest.test_a_file_at_or_below_the_floor_is_re_rendered`.

### 9.2 The silence written for an empty row can never satisfy the scan

A 0.1 s digital-silence FLAC is about 100 bytes, far below the 1024-byte floor,
so an empty chunk is reported missing by every scan and rewritten on every pass -
forever. e2a documents this in `worker_core`'s own comment and calls the rewrite
"idempotent and cheap". The consequence is subtler than the comment admits: a
book with any empty chunk NEVER reports 100 % complete to
`scan_completed_sentences`, so `list_resumable_sessions` lists it forever and
`resume_session` never returns `complete: true`. Pinned by
`ResumeTest.test_the_silence_written_for_an_empty_row_is_rescanned_forever`.

### 9.3 Chapter-mode range resolution silently yields 0 for an unmatched chapter

`chapter_range_to_sentences` initialises `work_start = work_end = 0` and only
assigns them when a chapter number MATCHES. `--chapter_start 99` on a 3-chapter
book therefore renders sentences `0..0` instead of refusing. Preserved verbatim.

### 9.4 The model-directory keys resolve independently

`args.get('orpheus_model_dir') or state.get('orpheus_model_dir')`, and the same
for `adapter_dir` and `base_dir`, are three separate expressions. Passing
`--orpheus_adapter_dir` to a session whose state carries an `orpheus_model_dir`
therefore hands the engine BOTH, and `_validate_adapter_mode` refuses the pair.
Loud, so not dangerous - but the refusal blames the flags rather than the state.
Pinned by `test_the_orpheus_model_flags_reach_the_engine_config`.

### 9.5 `find_process_dir` takes whichever hash dir the filesystem lists first

e2a iterates raw `os.listdir(session_dir)` and returns on the first subdirectory
holding a state file. A session directory with two hash dirs (a re-prep of a
changed EPUB) resolves non-deterministically - and the two hash dirs hold
DIFFERENT books' audio, so the choice is not cosmetic. narrator sorts the
listing, so the choice is at least STABLE across runs and platforms; that is a
smaller change than refusing and it is the only alteration to this function.

`list_resumable_sessions` is the opposite case and is NOT sorted: there the
listing order is an output nothing reads, so e2a's raw `os.listdir`
(`session.py:230`) is kept verbatim.

### 9.6 `--resume_session`'s output cannot be parsed by its only caller

`handlers.py:44` prints `json.dumps(result, indent=2)`, which spans lines.
`parallel-tts-bridge.ts:8818-8828` tries `JSON.parse` on each stdout LINE and
takes the last one that parses and has a `success` field. A pretty-printed object
has no such line, so `checkResumeStatus` always resolves
`{success: false, error: 'Failed to parse resume check output'}`. This is a
BookForge defect, not an e2a one, and the live path is
`checkResumeStatusFromProcessDir` (`:8619`), which reads `session-state.json` in
Node and spawns nothing. narrator reproduces e2a's byte shape rather than
"fixing" it, because fixing it would change the output of a command whose caller
is already dead code.

### 9.7 `--list_sessions`'s output is discarded

`parallel-tts-bridge.ts:8906-8909` logs the stdout and resolves `[]`
unconditionally, with a comment calling the format "human-readable output (not
JSON)" - which it is not; e2a prints JSON. Nothing calls the function.

Note the contrast with the WORKER's result, which has the same "parse each line"
consumer (`:3747`) and IS parsed today - because `worker.py:518` prints it on one
line. The `indent=2` in `handlers.py` is what breaks 9.6 and would have broken
the worker too; see section 8's `_print_worker_result` / `_print_app_result`
split.

### 9.8 An edited sentence's TEXT is never written back

`--sentence_overrides` reaches exactly one place: the string handed to the engine
for that render (`render/worker.py:_text_for`, the port of
`worker_core.py:506/527`). Nothing writes it into `session-state.json`'s
`chapter_sentences`, and every consumer of a chunk's TEXT reads it from there -
the VTT (`bookforge_ext/parallel/session.py:build_vtt_file`), the manifest
(`render/session_v1.py`), and Studio's own cue list
(`correct-sentences-bridge.ts:281-283`, which reads `chapter_sentences` directly
and says so in a comment). After a person commits an edited take, the audio says
one thing and the transcript says another, permanently, with no warning.

Identical in e2a, and NOT fixable in this column. Recorded in
`render/retake.py`'s docstring so the next reader of that module meets it before
they ship a feature on top of it.

**UPDATED 2026-09-04, after migration step 4 shipped.** This section used to say
the fix was "prep's manifest - migration step 4". Step 4 did NOT fix it, and
deliberately: `text/prep.py` writes `chapter_sentences` exactly as e2a's prep
wrote it, and nothing in the retake path writes back into it. Making the fix means
the retake route REWRITING `session-state.json`, a file section 4 above documents
as written exactly once, by prep - a change to the session contract, not a side
effect of porting the packer. So the bug is DEFERRED to the manifest era, where
the manifest (not the session state) owns chunk text and a retake can amend the
document it came from. Owed to the orchestrator as a decision, not to a builder as
a task. See `text/PORT_NOTES.md` section 5.8.

### 9.9 "The same FLAC parameters" is only true given the same interpreter

The assembler refuses a sentence set whose STREAMINFO max-blocksize, sample rate
or channel count is not uniform (`render/flac_header.py:assert_concat_homogeneous`,
ported from `lib/core.py:4079-4105`) - the Witnesses guard, which exists because
ffmpeg's concat demuxer silently DROPS mismatched frames and still exits 0.

But the blocksize is chosen by whatever libsndfile/libFLAC the writing
interpreter links, not by anything narrator or e2a passes. MEASURED: the golden
sentence sets carry max-blocksize **2304** (written by torchaudio in the WSL
`orpheus_tts` env), while the Windows test interpreter's soundfile writes
**4096**. So a retake rendered natively on Windows into a book rendered in WSL
produces a candidate the assembler will refuse - correctly, and loudly, but the
message will blame the file rather than the environment.

This is pre-existing and unchanged by the port: e2a has the same guard and the
same env-decided parameter, and `correct-sentences-bridge.ts:163-174` already
normalizes a candidate's `sample_fmt` for the same class of reason (it does not
touch blocksize). Recorded here and in `SESSION_READERS.md` section 7 so
"narrator writes `N.flac` with the same FLAC parameters" is read with its real
precondition: the same interpreter renders the whole set.

---

## 10. Could not verify

- ~~**No GPU render.**~~ **RESOLVED 2026-09-04** - see section 11.
- **No real MODEL has been loaded through `render.worker`.** Every test
  substitutes a fake with the `TTSManager` surface. The real path WAS driven once
  by hand on Windows (`python -m narrator render --session-dir <synthetic>
  --sentence-start 5 --sentence-end 5`): `build_engine` constructed a real
  `OrpheusEngine`, which printed its own
  `[ORPHEUS] Session fine_tuned value: 'mistborn'` /
  `Loading Orpheus TTS with voice 'mistborn'...` /
  `Orpheus: Using transformers backend (CUDA)` and then failed at
  `load_engine()` because the synthetic session names a WSL model directory that
  does not exist on Windows - so `engine_config_from`'s field mapping, the
  voice token, the `model_dir` hand-off and the failure's arrival as
  `{"success": false, "error": "OrpheusEngine.__init__() error: ..."}` are all
  proven; only inference is not.
- **The cut-over itself.** `electron/parallel-tts-bridge.ts` still spawns
  `<e2a>/worker.py` and `<e2a>/app.py`; nothing has ever spawned
  `python -m narrator.compat.worker`. `electron/` is out of this column. The
  change is `workerPath` -> `['-m', 'narrator.compat.worker']` and `appPath` ->
  `['-m', 'narrator.compat.app']`, plus making `narrator` importable in the
  Orpheus envs (`pip install -e python/`, or `PYTHONPATH`) - the same two options
  `engine/PORT_NOTES.md` section 9 lists for the streaming pool.
- **`--list_sessions` and `--resume_session` end to end through a bridge.**
  Exercised through `compat.app.main` in-process; never spawned by BookForge in a
  way that reads the answer (9.6, 9.7).
- **MPS.** `resolve_device`'s `mps` arm and `memory_cleanup`'s
  `torch.mps.empty_cache()` are ports, unexecuted here (no Mac in this session,
  no torch in the Windows test env).

---

## 11. The GPU smoke (2026-09-04)

Resume of the kershaw golden session: 133 chunks, `0.flac`..`4.flac` deleted from
a copy at `C:\tmp\narrator-R\kershaw-resume\`, re-rendered from WSL through
`python -m narrator.compat.app --headless --worker_mode` with `PYTHONPATH` at the
worktree's `python/`, the deathstalker model at
`/home/telltale/orpheus-models/deathstalker`, and the caps from
`electron/data/orpheus-models.json` (`maxCharsPerSec` 22.6, and `backends.vllm`:
`repPenalty` 1.1, `eosBoost` 8, `eosBoostStart` 2.0, plus `sentenceGap` 0.0).
Guarded by `%APPDATA%\BookForge\external-gpu-job.lock`; 7 min 15 s of GPU across
two runs; no GPU process was ever killed.

**25 of 25 checks passed.**

| claim | result |
|---|---|
| the five files exist | yes, 55296 / 626688 / 425984 / 563200 / 243712 samples |
| 24 kHz mono FLAC | all five: 24000 Hz, 1 ch, 16-bit |
| STREAMINFO blocksize vs the untouched set | **new 2304/2304, untouched 2304/2304 - IDENTICAL** |
| the other 128 files | 128/128 byte-identical (sha256) |
| `session-state.json` | byte-identical AND mtime unchanged - the worker never opened it for writing |
| progress lines | 5 lines, all matching `:4176` `/Converting sentence (\d+)\/(\d+)\s*\(([\d.]+)%\)/i`, each reporting the BOOK total 133; the old `:4175` shape correctly does NOT match |
| model-load stage | `:2526` matched `Loading Orpheus TTS with voice 'deathstalker'...`; `:2527` matched `Orpheus TTS Loaded!` |
| the result JSON | ONE line, parsed by `:3747`'s own predicate: `{"success": true, ..., "sentences_converted": 5, "sentences_skipped": 0, "failed_indices": []}` |
| `narrator assemble` on the resumed dir | **133 cues**, last cue ends 00:43:28.911, m4b 2609.00 s |

### What the smoke settled

- **Finding 9.9 (FLAC blocksize) does NOT bite here, and the smoke says why.**
  narrator rendered these five chunks *in the same WSL env* that produced the
  original 133, so the blocksize matched at 2304 and the set stayed homogeneous.
  The hazard in 9.9 is specifically a **native-Windows** render into a
  WSL-rendered book (soundfile there writes 4096); it is a property of the
  interpreter, not of narrator, and this run confirms the benign half of it.
- **CUDA graphs captured** (`Graph capturing finished in 109 secs`), so
  `ORPHEUS_DISABLE_EAGER=1` crossed into the guest correctly - the whole reason
  Orpheus routes through WSL.
- **The `--sentences_dir` override is load-bearing on a real session.** This
  session's `chapters_dir_sentences` names a `Z:\` network path that WSL cannot
  see at all. The precedence documented in `session_store.sentences_dir_for` is
  what makes the render possible, not a convenience.
- **Two harness notes, neither a narrator defect.** (1) Git Bash mangles
  `/mnt/...` arguments passed to `wsl.exe -c` unless `MSYS2_ARG_CONV_EXCL='*'` is
  set - run the command from a FILE. (2) `wsl.exe > log 2>&1` from Git Bash gives
  the two streams independent file offsets, so under heavy stderr (vLLM's tqdm)
  stdout is silently overwritten; the first run lost every `[WORKER]` line that
  way. Redirect to SEPARATE files. Anyone re-running this smoke needs both.

### Not proven by it

The session was prepped for **mistborn** and the five chunks were re-rendered
with **deathstalker**, as the brief specified, so the resulting audiobook is
deliberately a two-voice chimera. Nothing in the checks depends on the voice, and
no claim here is about audio quality - nobody has listened to it.
