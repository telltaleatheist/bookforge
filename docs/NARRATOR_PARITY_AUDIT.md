# NARRATOR_PARITY_AUDIT — did narrator take over everything e2a did for us?

Read-only audit, 2026-09-05, on `main` at `557abeef`, branch
`chore/narrator-parity-audit`. The question is Owen's: *"make sure the new
narrator module does everything e2a did for us, since it replaced e2a. make sure
there aren't any loose ends."*

**Scope.** Every behaviour BookForge INVOKED in ebook2audiobook — the flags its
bridges built, and the e2a code those flags turned on — against what
`python/narrator` implements today. Not a review of e2a; a review of the seam.

Companion documents, which this one does not repeat:
`docs/NARRATOR_CUTOVER.md` (what each phase changed, and the live proof ledger),
`python/narrator/compat/FLAGS.md` (all 58 flags with their verdicts),
`python/narrator/render/PORT_NOTES.md` (the worker layer, 14 declared
deviations, 9 preserved bugs), `python/narrator/text/PORT_NOTES.md` (the packer),
`python/narrator/assemble/README.md` (the gap rule, the ffmpeg commands).

**Sources.** e2a at `C:\Users\tellt\Projects\ebook2audiobook`, branch
`bookforge`, `9daab0ba` — read-only, never written to.

**Headline: no phase of the pipeline is missing.** Prep, worker, retake,
assembly, resume, list, serve and the CLI all reach narrator, and every one of
them has been RUN live on at least one platform (`NARRATOR_CUTOVER.md`'s proof
ledger). What this audit found is **one behavioural gap** (two m4b tags, now
fixed), **one question that needs Owen** (a `.txt` input a CLI door still
advertises), and **a Phase-6-shaped tail**: the app still resolves its tools
python, its session scratch and its installer payload out of the e2a checkout,
under e2a's names.

---

## Needs Owen's ruling

### 1. `cli/orpheus-batch-render.js --input passage.txt` no longer works

**What happens.** The door's own header says *"A `.txt` is prepped block by
block"*, and `prepareNarrationInput` (`electron/parallel-tts-bridge.ts:7341-7386`)
documents `.txt` as one of the two formats it reads — *"what `--tts --text` and
`--tts --input passage.txt` render"*. It hands the file to `renderRangeHeadless`,
which passes it straight through as `epubPath` (`:8100`) into the prep spawn's
`--ebook`. e2a Calibre-converted it (`lib/core.py:convert2epub:577`). narrator
refuses it by name — `text/epub.py:accept_epub:79-97`, *"narrator's prep reads
EPUB only… Convert this input in Foundry first."*

So a voice audition from a passage — the thing that CLI exists for — fails at
prep with advice that does not apply to a three-paragraph text file.

**Option A — narrator wraps a `.txt` into a minimal one-chapter EPUB.** No
Calibre (the reason the refusal exists is that Calibre over an EPUB was
destructive; over a `.txt` it never was — it was just a dependency). ~40 lines in
`text/epub.py`, one chapter, the filename as the title. Restores the door
exactly as it worked.

**Option B — the CLI refuses `.txt` at its own door** and the two docstrings are
corrected to say EPUB only.

**Recommendation: A.** The refusal's stated reason ("Foundry produces an EPUB for
every book") is true of BOOKS and false of the audition path, which is the only
caller that ever passed a `.txt`. B deletes a working feature to make a docstring
true. But A adds an input format to prep, which is a contract change, so it is
not mine to make unannounced.

### 2. The shipped `.m4b.vtt` has one cue fewer than the book has chunks

Already recorded in `NARRATOR_CUTOVER.md` ("The shipped sidecar has one cue fewer
than the book has chunks") and reproduced independently on both platforms.
narrator's assembler writes 133 cues, one of them empty; the pipeline ships 132.
The loss is `mov_text`'s (it cannot represent an empty cue) in
`reassembly-bridge.ts`'s embed-then-re-extract round trip, and it PREDATES the
cut-over. Not narrator's, not a cut-over defect, and changing it changes what the
sidecar IS for every book — Owen's call, restated here only so this audit is not
read as clearing it.

### 3. Phase 6 has not happened, and "remove e2a" is not finished without it

Measured on this machine today (details in "The e2a checkout is still load-bearing"
below): the tools python, the default session scratch root and the installer's
staged payload all live inside `C:\Users\tellt\Projects\ebook2audiobook`. Nothing
SPAWNS e2a any more — `tools/test-no-e2a-doors.js` proves that — but deleting the
checkout today breaks the dev app and every installer build. This is a known,
planned phase (`NARRATOR_CUTOVER.md` "Phase 6 is a RELOCATION, not a rename"), not
a discovery; it is listed here because it is the largest remaining loose end and
it needs scheduling, not a decision.

---

## What this pass FIXED

| # | gap | fix | test |
|---|---|---|---|
| 1 | The m4b lost its `description` and `publisher` tags | `Book.description` / `Book.publisher` added to the manifest (additive, `.get` on read, emitted only when present); `session_v1` reads them off `session-state.json`'s `metadata`; `encode.generate_ffmpeg_metadata` writes them between `language` and `year`, e2a's own order | `python/narrator/tests/test_assemble_book_tags.py` (11 cases) |
| 2 | `electron/tts-bridge.ts` — 412 lines of e2a/XTTS-era plumbing whose ONE live call was a duplicate | file deleted; `main.ts`'s `logger:initialize` no longer initializes the same logger twice | `tools/test-no-e2a-doors.js` (unchanged, still green); `tsc` on both projects |

Detail on #1, because it is the only true parity gap this audit found:

e2a wrote six book tags into the ffmetadata document
(`lib/core.py:generate_ffmpeg_metadata:4159-4193`): `title`, `artist`,
`language`, `description`, `publisher` (MP4 family and mp3 — m4b is MP4 family),
`year`. narrator wrote four. `Manifest.Book` had no field for the other two, so
the loss started at the session reader, not at the writer.

It is LIVE, not theoretical: BookForge's own EPUB export writes both DC keys
(`electron/epub-processor.ts:11374`, `:11377`), narrator's prep reads every DC
key into `metadata` (`text/epub.py:METADATA_KEYS`), and nothing downstream
re-stamps a freshly rendered m4b — `applyMetadata` (`electron/metadata-tools.ts:424`)
does write `description`, but its callers are all user actions (metadata edit,
library import/promote), never the render or reassembly chain, and it never
writes `publisher` at all. The three committed goldens carry neither tag, which
is why no test could have caught it and why the fix leaves every golden
byte-identical.

e2a's `isbn`/`asin` branch (`:4186-4192`) is NOT ported and is not a gap:
`session['metadata']['identifiers']` is read there and **set nowhere in the whole
e2a checkout**, so the branch is dead in e2a too.

One declared deviation came with the fix. `_escape_meta_value` REFUSES a value
containing a newline or a `;` — correct for a chapter title, where one means the
source is malformed. A publisher's blurb routinely carries both, and refusing
would fail a whole audiobook over a tag. So the two text tags get
`_escape_meta_text_value`, which escapes exactly the five characters ffmpeg's
ffmetadata spec names (`=`, `;`, `#`, `\`, newline). e2a wrote these values RAW
and therefore wrote a document whose records ended at the blurb's first newline;
nothing was refused there and nothing is refused here — what changes is that the
tag survives instead of corrupting every `[CHAPTER]` block after it.

---

## The parity table

Status key: **PARITY** — narrator does what e2a did for this caller.
**DROPPED** — deliberately, with the ruling cited. **GAP** — a real hole.
**PARTIAL** — implemented but narrower than e2a, with the narrowing named.

### Prep — text, chunking, session state

| behaviour | e2a | narrator | BookForge caller | status |
|---|---|---|---|---|
| the prep door itself | `bookforge_ext/parallel/session.py:prep_ebook_info` + `handlers.py:47-76` | `text/prep.py:prep_session` via `compat/app.py --prep_only` | `parallel-tts-bridge.ts` prep spawn | PARITY (proven live both platforms) |
| sentence hard/soft/space split (PASSES 1-3) | `lib/core.py:2538-2642` | `text/sentences.py`, `text/packer.py` | prep | PARITY |
| short-row merge (PASS 4), refusing to merge across an SML token | `lib/core.py:2644-2690` | `text/packer.py` | prep | PARITY |
| max-chars cap: Orpheus flat 350, `ORPHEUS_MAX_CHARS` | `lib/core.py:2431-2445` | `text/packer.py`, per-voice from the catalog | prep spawn exports `ORPHEUS_MAX_CHARS` | PARITY — **measured**: kershaw at mistborn's 430 packs to **133 chunks, the e2a golden's own number** (`NARRATOR_CUTOVER.md`) |
| min-chars floor, default 25 / `SENTENCE_MIN_CHARS` | `lib/core.py:2110-2276`, `:1926` | `text/packer.py:_apply_min_chars_floor`, `_sentence_min_chars` (default 25) | prep | PARITY |
| short-heading forward merge, `HEADING_MIN_WORDS` 3 | `lib/core.py:1962-2041`, `:1938` | `text/packer.py:_heading_min_words` (default 3) | prep | PARITY |
| `[heading]` inserted, never merged, OWNS its chunk and is a RUN BOUNDARY | `lib/core.py:1394-1421`, `:2105`, PASS 5 at `:2758-3009` | `text/packer.py` (heading breaks the run), `text/sml.py` | prep | PARITY |
| `[item]` opens its own run; exempt from the length floor | `lib/core.py:1422-1447`, `:2927-2966`, `:2190-2224` | `text/packer.py:803-816` (`run_is_item`), floor exemption | prep | PARITY |
| `[break]` / `[pause]` / `[pause:X]` | `lib/core.py:1448-1452`, `:3576` | `text/sml.py`, `text/gaps.py:86-92` | prep | PARITY |
| balanced packing (PASS 5) rather than a starved tail | `lib/core.py:2855-2872` `_balanced_groups` | `text/packer.py` | prep | PARITY |
| anti-runaway near-duplicate split (PASS 6) | `lib/core.py:2976-3007` `_apply_near_dup_split` | `text/packer.py:_split_near_dup_chunk` | prep | PARITY |
| `--sentence_per_paragraph`, `--skip_headings` | `lib/core.py:filter_chapter` | `text/chapters.py` | prep spawn (language-learning toggle) | PARITY (unit-tested, no golden) |
| `session-state.json` v2 write | `session.py:save_session_state:54-120` | `render/session_store.save_session_state` (atomic; LF; `ensure_ascii=False`) | prep | PARITY, 2 declared byte deviations (PORT_NOTES 8.10) |
| chapter titles paired by DOCUMENT IDENTITY, never by position | `lib/core.py:4577-4614` | `render/session_v1.py:_resolve_chapter_titles:312-372` | assembly | PARITY |
| number / punctuation normalization | e2a's own transform PERMANENTLY OFF (`common/orpheus_text.py`) | not narrator's — `prepareNarrationInput` owns it | the Narrate button, `--prep` | DROPPED by ruling (memory `number-normalization-model-pass`) — **not a gap** |
| Calibre conversion of `.txt`/`.pdf`/images | `lib/core.py:convert2epub:577` | `text/epub.py:accept_epub` refuses by name | `cli/orpheus-batch-render.js --input *.txt` | **GAP** — see "Needs Owen's ruling" #1 |
| `--ebooks_dir` batch prep | `lib/core.py:4949` | REFUSE | none, ever | DROPPED |
| non-English books | e2a refuses in `filter_chapter` | `text/lang.py` refuses | none | PARITY (same refusal) |

### Worker — render loop, progress, cancellation

| behaviour | e2a | narrator | BookForge caller | status |
|---|---|---|---|---|
| the batched worker | `bookforge_ext/parallel/worker_core.py:run_worker_tts` | `render/worker.py:run_worker` via `compat/worker.py` | render spawn | PARITY (proven live: 133/133, 10.83x) |
| `app.py --worker_mode` (the UNBATCHED second worker) | `lib/core.py:convert_chapters2audio:3724` | both doors route to the batched port | never spawned (`useLightweightWorker` always on) | DROPPED deliberately — PORT_NOTES 3 |
| **the progress line the app parses** — `Converting sentence {i}/{total} ({pct:.1f}%)`, `total` = the BOOK's `total_sentences` | `worker_core.py:492`, `:538` | `render/worker.py` | `parallel-tts-bridge.ts:4176` / `:4279` | PARITY — **measured live**: 133 hits on stdout, 0 on stderr, and the OLDER `:4175` shape correctly does not match |
| the result JSON as ONE compact line | `worker.py:518`, exit `0 if success` | `compat/app.py:_print_worker_result` (compact) vs `_print_app_result` (`indent=2`) | `:3747` scans stdout line by line | PARITY, and the split is load-bearing |
| resume: a file counts as rendered at >1024 bytes | `worker_core.py:502`, `:522`; scan floor `>=1024` at `session.py:164` | `render/session_store.py`, `render/worker.py` | resume, `checkResumeStatusFromProcessDir` | PARITY, including the one-byte inconsistency (PORT_NOTES 9.1) |
| empty row -> 0.1 s silence FLAC | `worker_core.py:394-410` | the engine's `_write_silence` | render | PARITY, including the "rescanned forever" consequence (9.2) |
| cooperative stop: SIGTERM/SIGINT -> `SystemExit(143)`, in-flight outputs deleted | `worker.py:33-51`, `worker_core.py:584-599` | `render/worker.py` | the bridge's kill ladder; WSL never SIGKILLed | PARITY |
| parent-death watchdog, `BOOKFORGE_OWNER_PID` + start-time pid-reuse guard, 60 s grace | `worker.py:54-343` | `render/worker.py:54-343` | `parallel-tts-bridge.ts:4020` sets both vars | PARITY |
| CUDA-poison fast-fail (no exit code of its own) | `orpheus.py:4859` re-raises | `engine/orpheus/` re-raises; result `{success:false,error:...}`, exit 1 | `:4330-4383` treats every non-zero the same | PARITY, pinned by `ExitCodeTest` |
| `[MEMORY]` / `[WORKER]` log lines | `worker_core.py` | `render/worker.py` | parsed by nothing; watchdog matchers pinned | PARITY, 9 named string changes (PORT_NOTES 8) |
| a FAILED sentence counted as CONVERTED | `worker_core.py:561` | FIXED: `processed - skipped - len(failed)` | `:3747` parses these counts | deliberate FIX, not a deviation (PORT_NOTES 8.13) |

### Retake / correct-sentences

| behaviour | e2a | narrator | BookForge caller | status |
|---|---|---|---|---|
| `--sentence_indices` (scattered set) | `worker.py:367-371`, `worker_core.py:349` | `render/retake.py` | `regenerateSentenceIndices`, `correct-sentences-bridge.ts` | PARITY (proven live: 3 indices, 76.9 s) |
| `--sentence_overrides` JSON `{index: text}` | `worker.py:382-386`, `worker_core.py:506/527` | `render/retake.py`, `worker._text_for` | the Correct Sentences door | PARITY |
| `--num_takes` / `--take_temperatures`, `take<k>/` layout | `worker.py:372-381`, `worker_core.py:412-559` | `render/retake.py` | `correct-sentences-bridge.ts:429-441` globs it | PARITY |
| an edited sentence's TEXT written back into `chapter_sentences` | never, in either | still never IN PYTHON — `commitSentence` in `correct-sentences-bridge.ts` does it, with an `.orig-backup/<i>.txt` twin | Correct Sentences | RESOLVED 2026-09-05 (`a8b29628`), outside narrator by design |
| the override's lead/tail marker runs preserved | n/a | `render/retake.py` (merged `557abeef`) | Correct Sentences | PARITY |

### Assembly

| behaviour | e2a | narrator | BookForge caller | status |
|---|---|---|---|---|
| the assembly door | `session.py:assemble_audiobook` | `assemble/run.py:assemble` over `render/session_v1.build_manifest` | render spawn `:5493`, `reassembly-bridge.ts:1559` | PARITY (proven live both platforms; kershaw golden 2615.4 s / 133 cues) |
| chapter concat + the mixed-FLAC refusal (the Witnesses guard) | `lib/core.py:4050-4125`, refusal at `:4083-4105` | `render/flac_header.py:assert_concat_homogeneous`, `assemble/chapters.py` | assembly | PARITY (hazard 9.9 recorded) |
| the gap rule — Orpheus bakes silence into each chunk; assembly inserts nothing | `orpheus.py:_classify_gap:4075`, `_save_audio:4561` | `engine/orpheus/prompt.py`, `engine/orpheus/audio.py`; `assemble/README.md` s1 | assembly | PARITY, and it is why `render/gaps.py` does not exist |
| `ORPHEUS_SENTENCE_GAP` floor 0.6 s; only an explicit `[pause:X]` differs | `orpheus.py:4075-4137` | `text/gaps.py` (prep-time, unpadded engines), `engine/orpheus/prompt.py` (Orpheus) | assembly | PARITY, one behavioural difference named in `text/PORT_NOTES.md` (read at prep time for a `pads=False` engine) |
| `[break]`/`[pause]` as `uniform(0.3,0.6)` / `uniform(1.0,1.6)` random silence | `common/utils.py:588-592` | not ported | non-Orpheus engines only | DROPPED with those engines |
| `--sentences_dir` (the RVC / denoised handoff) | `session.py:990-997` | `render/session_store.sentences_dir_for` | `:5199` (denoised or `sentences-rvc-<voice>`) | PARITY — and load-bearing (a `Z:` sentences path WSL cannot see) |
| `--encoded_chapters_dir` + its gate (m4b family, no FINAL_DENOISE, no post_render_filter, no split, > 7200 s) | `lib/core.py:3933-4048` | `assemble/encode.py:load_encoded_chapters`, `parallel_export_unsupported_reason` | `reassembly-bridge.ts` | PARITY |
| `--post_render_filter` (per-voice de-ring chain) applied at the FINAL encode only | `lib/core.py:4236-4249`, `:3967` | `assemble/encode.py` | `reassembly-bridge.ts:1532` only, when `applyDeRing` | PARITY |
| FFMETADATA `[CHAPTER]` blocks, ms timebase, cumulative | `lib/core.py:4150-4220` | `assemble/encode.py:generate_ffmpeg_metadata` | assembly | PARITY |
| book tags `title` / `artist` / `language` / `year` | `lib/core.py:4159-4184` | same | assembly | PARITY |
| book tags `description` / `publisher` | `lib/core.py:4165-4168` | **was missing** | every m4b | **GAP — FIXED in this pass** |
| book tags `isbn` / `asin` | `lib/core.py:4186-4192` | not ported | none | not a gap — `identifiers` is READ there and SET nowhere in e2a |
| cover art, and the three states of `session['cover']` | `lib/core.py:4359-4391`, `get_cover:772`, BookForge fallback `session.py:1053-1070` | `render/session_v1.py:_resolve_cover:386`, `assemble/encode.py:attach_cover` | assembly | PARITY |
| output filename recomputed from metadata every run (`final_name` in the state is NOT used) | `session.py:1112-1132` | `assemble/run.py:final_name`, `get_sanitized` | assembly (no `--output_filename` is ever passed) | PARITY |
| VTT built from container headers, bold headings, no cue ids, no NOTE blocks | `session.py:build_vtt_file:836-943`, `conf_models.py:vtt_cue_text:116` | `assemble/vtt.py` | assembly | PARITY — byte-identical to the golden `reference.vtt` modulo line endings |
| `mov_text` embed | **does not exist in e2a** (grep: zero hits) | not narrator's either | `reassembly-bridge.ts` | not a gap; see ruling #2 for the cue it costs |
| loudnorm chain, and skipping it above 2 h | `lib/core.py:4222-4340`, `:4310` | `assemble/encode.py:LOUDNORM_FILTER`, `LOUDNORM_CUTOFF_S = 7200` | assembly | PARITY |
| `FINAL_DENOISE=1` manual escape | `lib/core.py:4132` | `assemble/encode.py:FINAL_DENOISE_FILTER`, read at `run.py:248` | env only, dormant | PARITY |
| post-export duration guard, 2.0 s | `lib/core.py:4342-4358` | `assemble/chapters.py:EXPORT_TOLERANCE_S = 2.0`, `encode.verify_export` | assembly | PARITY |
| `--no_split` (the bridge ALWAYS passes it) / `output_split` 6 h parts above 12 h | `handlers.py:133`, `lib/core.py:4694-4701` | IGNORE — a whole-book assembly is the only shape narrator produces | `:5493`, `reassembly-bridge.ts` | PARITY for the exercised path; the split path is unported by contract (`CONTRACTS.md`) |
| `--chapters` partial assembly (`"1-5"`, `"1,3,5"`, `"auto"`) | `session.py` | ACCEPT, but narrowed to a contiguous run from 1 (`assemble/README.md` s8) | nothing passes it today | PARTIAL, unexercised — recorded, not fixed |
| per-chapter `cancellation_requested` check | `lib/core.py:4194` | none — assembly is a subprocess the bridge kills | the bridge's kill ladder | PARITY of outcome |
| bilingual assembly (`--bilingual`, `_pause` 0.3, `_gap` 1.0) | `bookforge_ext/parallel/bilingual.py` | REFUSE by name | **no longer passed** — the arm is gone from `parallel-tts-bridge.ts` | DROPPED (Phase 4, Owen's Branch A) |

### Resume / list

| behaviour | e2a | narrator | BookForge caller | status |
|---|---|---|---|---|
| `--resume_session` | `session.py:284-355` | `render/session_store.resume_session` | `:8792` — whose reader cannot parse `indent=2` and never could | PARITY of the door; the CALLER is dead code, and the live path is `checkResumeStatusFromProcessDir` (Node, spawns nothing) |
| `--list_sessions` | `session.py:230` | `list_resumable_sessions`, unsorted, as e2a leaves it | `:8888` — logs it and resolves `[]` | PARITY; nothing reads the answer |
| voice/engine mismatch WARNS, never blocks | `session.py:265-281` | `check_resume_compatibility` | resume | PARITY |

### Streaming (`serve`) and the engine guards

| behaviour | e2a / `orpheus_stream.py` | narrator | BookForge caller | status |
|---|---|---|---|---|
| the resident Listen worker | `electron/scripts/orpheus_stream.py` (deleted) | `narrator/serve/worker.py` | `orpheus-worker-pool.ts` via `narrator-spawn.ts` | PARITY (proven live: WSL + Mac, exit 0, full protocol) |
| `cancel` / `stop` / `quit` mid-batch | — | `serve/worker.py:_is_cancelled`, checked per decode step | the pool | PARITY; live cancel against a real model still owed |
| fast-start token streaming (`batch_chunk` slices) | the extension switch | `serve/worker.py`, `engine/orpheus/mlx_fastpath.py` | `ORPHEUS_STREAM_*` | PARITY (21 slices, first at 0.7 s on a 7.0 s row) |
| number normalization for the reader | `orpheus_stream.py:normalize_for_tts` | `serve/worker.py:350` | the extension | PARITY, `test_serve_number_normalization.py` |
| EOS floor / `eosBoost` / `eosBoostStart` | `orpheus.py:541-573`, `:526-539` | `engine/orpheus/guards.py`, `sampling.py`, `caps.py` | per-voice caps from `electron/data/orpheus-models.json` | PARITY |
| truncation detect + re-roll with `force_split` | `orpheus.py:4146`, `:4401-4491` | `guards.py:_needs_resplit`, `_guard_truncation` | render | PARITY |
| rate ratchet (raise-only, per voice) | `orpheus.py:4540-4559` | `guards.py:_ratchet_after_resplit` | render | PARITY |
| per-voice caps — all 9 keys | `orpheus.py:665-728`, `:1925` | `caps.py:VOICE_CAP_SOURCES` (same 9, same camelCase, same precedence), + `VOICE_CAP_IGNORED` for `maxChars`/`sentenceGap` | `orpheusVoiceCapsForModel` | PARITY |
| short-chunk overrun REPORT (25 chars, shipped as-is) | `orpheus.py:606-663`, `:4493` | `guards.py:_report_short_chunk_overrun`, `SHORT_CHUNK_MAX_CHARS` 25 | render | PARITY |
| `MAX_AUDIO_TOKENS` 3700 | `orpheus.py:466` | `engine/orpheus/config.py:152` | render | PARITY |
| MLX continuous batching (`ORPHEUS_MLX_CONTINUOUS`, pool 4x, prefill 16) | `orpheus.py:368-408` | `config.py:225-239`, `engine/orpheus/mlx_backend.py` | Mac render | PARITY |
| ASR gate (risk-flagged only, 15 % foreign skip, >=4-word mismatch) | `orpheus.py:4344-4399` | `engine/orpheus/asr_gate.py` | default OFF (memory `orpheus-asr-gate-default-off`) | PARITY |
| `[ORPHEUS_GUARD_EVENT]` JSON line | `orpheus.py` | `guards.py:_emit_guard_event` | `parseOrpheusGuardEvent` at `:110-120` | PARITY |

### Things e2a did for BookForge that BookForge now does itself

Recorded so they are not mistaken for holes.

| behaviour | where it lives now |
|---|---|
| temp-dir cleanup of `tmp/ebook-<sid>` | BookForge's, always — e2a's `delete_unused_tmp_dirs` keys off `proc-`/`web-`/`voice-`/`model-` prefixes and could never have matched `ebook-` |
| WSL session normalization | `parallel-tts-bridge.ts:normalizeWslSessionToWindows` |
| RVC enhancement, denoise, gap normalization | `rvc-bridge.ts`, `denoise-bridge.ts`, `electron/scripts/normalize_gaps.py` |
| the VTT sidecar / `mov_text` embed and the m4b tag editor | `reassembly-bridge.ts`, `metadata-tools.ts` |
| number + punctuation normalization | `prepareNarrationInput`, `tts-punctuation.ts`, `tts-number-*.ts` |
| XTTS voice downloads (`bookforge_ext/download_model.py`) | nothing spawns it — DROPPED with XTTS |

---

## The e2a checkout is still load-bearing (the stale-reference sweep)

`grep -rn "ebook2audiobook\|e2a\|bookforge_ext\|worker_core" electron/ src/ tools/`
returns **772 hits in 96 files**. Classified:

| class | count | what it is |
|---|---|---|
| **A — LIVE DEPENDENCY** | 10 sites | the app or the build genuinely needs the checkout on disk |
| **B — NAME-ONLY (Phase 6 rename)** | ~200 hits, 13 files | `E2A_PATH`, `E2A_TMP_DIR`, `e2a-paths.ts`, `E2aSession`, `wslE2aPath`, `runtime/e2a-env` — the mechanism is narrator's, the identifier is e2a's |
| **C — DEAD CODE** | 2 | `electron/tts-bridge.ts` (**deleted in this pass**); `shared/tts/gpu-ownership.ts`'s `e2a-worker` / `e2a-app-worker` kinds, which detect a process shape this app can no longer produce (a deliberate pre-cut-over orphan detector — left alone) |
| **D — COMMENT / HISTORY / KEEPER** | ~550 hits | provenance prose ("e2a's default is 19.0"), migration history, fixture paths (`FAKE.e2a`), and `tools/test-no-e2a-doors.js`, which exists to assert the doors are gone |

**No source builds a path to `<e2a>/app.py` or `<e2a>/worker.py`, no `tts:*` IPC
channel survives, and no kill pattern hunts a process the app cannot spawn** —
`tools/test-no-e2a-doors.js` asserts all three and is green.

### What would break if `C:\Users\tellt\Projects\ebook2audiobook` were deleted today

1. **Every installer build.** `packaging/stage-resources.js:70` hard-fails unless
   `<e2a>/app.py` and `<e2a>/lib` exist, then stages the whole checkout into
   `resources/e2a`; `packaging/package-win.js:35-78` resolves the same path and
   derives the seed python from `<e2a>/python_env`. **A packaged BookForge still
   SHIPS the e2a source tree** — `e2a-env-bootstrap.ts:549` copies it to
   `<userData>/runtime/e2a`, and the only thing anything reads out of it is
   `python_env` (`e2aIsReady` stopped asking about `app.py` on purpose).
2. **The dev app's tools-env spawns** — assembly, resume, `--list_sessions`.
   `narrator-spawn.ts:470-492` -> `getPythonInvocation(getDefaultE2aPath())` ->
   `e2a-paths.ts:getEnvPathForEngine:205` -> `<e2a>/python_env`.
3. **The default session scratch root** — `getDefaultE2aTmpPath()` falls back to
   `<e2a>/tmp` (`e2a-paths.ts:106-124`), which is measured behaviour, not theory
   (`cli/narrator-sessions-root.js`'s own comment).
4. **Whisper overlay installs in dev** (`components/whisper-env.ts:87-98`) pip
   into `<e2a>/python_env`.
5. **Orpheus-on-macOS component discovery** searches `<e2aParent>/orpheus_env`
   (`components/component-catalog.ts:148-196`).
6. **Settings' "ebook2audiobook Path" / "Tmp Path" fields** and the Reassembly
   tmp-folder browser point at it.

Packaged installs are self-contained once set up, so this is a DEV and BUILD
dependency, not a shipped one. It is Phase 6's whole job.

### The WSL sessions root

Orpheus prep and render still write their session to
`/home/telltale/ebook2audiobook/tmp/ebook-<uuid>` inside the guest
(`parallel-tts-bridge.ts:3296-3305`, from `getWslE2aPath()`), and
`normalizeWslSessionToWindows` copies it onto a Windows path afterwards.
Known Phase 6 leftover; **recorded, deliberately not relocated here** — moving a
guest scratch root mid-audit would invalidate every in-flight resume on the
machine.

---

## Gates

| gate | result |
|---|---|
| `npx tsc -p tsconfig.electron.json --noEmit` | clean |
| `npx tsc -p tsconfig.app.json --noEmit` | clean |
| `python -m pytest python/narrator/tests -x -q` (WSL, `orpheus_tts`) | baseline 1071 passed / 68 skipped; after this pass 1082 passed / 68 skipped |
