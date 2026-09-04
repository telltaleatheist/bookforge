# Every implicit reader of session layout v1

Migration step 3 changes NOTHING about the layout. This table is what proves it:
it is the enumeration `docs/NARRATOR_PLAN.md` calls for under Risks ("The session
layout has many implicit readers (`grep chapters/sentences`); step 3 must
enumerate them before changing a byte").

Produced 2026-09-04 by grepping, in the two read-only checkouts:

- BookForge main `C:\Users\tellt\Projects\bookforge` - `electron/`, `cli/`,
  `shared/`, `src/`
- ebook2audiobook `C:\Users\tellt\Projects\ebook2audiobook` at `9daab0ba` -
  `bookforge_ext/`, `lib/core.py`

Patterns: `chapters/sentences`, `sentences_dir`/`sentencesDir`,
`session-state.json`, `session_state.json`, `sentences-denoised`,
`sentences-rvc`, `parallel_encode`, `concat_list`, `chapter-provenance`,
`process_dir`/`processDir`, `03-tts`, and numbered-FLAC joins (`{i}.flac`).

**R** = reads. **W** = writes/creates/deletes. **KEY** = a JSON key name that
would break silently if renamed. **TYPE** = a TypeScript field name only (no
I/O) - listed because renaming it breaks the IPC contract even though no byte
moves.

---

## 0. The nine things that must not change

| # | The invariant | Why it is load-bearing |
|---|---|---|
| 1 | `<process_dir>/chapters/sentences/<i>.flac`, 0-based, contiguous | Written by the worker; read by 20+ sites, most of which build the path with a literal `path.join(processDir, 'chapters', 'sentences')` rather than through `derived-sentences.ts` |
| 1b | **The contiguity is ENFORCED, not merely expected** | `lib/classes/tts_engines/common/utils.py:637-644` globs `*.flac`, sorts by `int(p.stem)`, and refuses unless the stems are exactly `range(len(files))` - `Missing audio sentence files: [...]` - then refuses again unless that count equals the sentence count. **This is why `take<k>/` and `.orig-backup/` are SUBDIRECTORIES**: any extra `<n>.flac` beside the set would be globbed in and shift every later index |
| 2 | The derived-set names `chapters/sentences-denoised`, `chapters/sentences-rvc-<voiceId>`, and chained `sentences-<a>-<b>` | `electron/derived-sentences.ts:236-290` is the formula; `--sentences_dir` points assembly at one of them |
| 3 | `session-state.json` (HYPHEN) is e2a's; `session_state.json` (UNDERSCORE) is BookForge's own sidecar | Two different files in the same directory, one Python reader, one TS reader. `correct-sentences-bridge.ts:305-308` and `reassembly-bridge.ts:737-769` both call the distinction out explicitly |
| 4 | The state KEY `chapters_dir_sentences` | Written at `session.py:91`, read by `worker_core.py:215`, `session.py:628`, and five TS sites. The single highest-leverage name in the layout |
| 5 | The state KEYS `chapter_sentences`, `total_sentences`, `chapters`, `chapter_titles`, `metadata`, `bookforge_metadata`, `epub_path`, `source_epub_path`, `cover` | Read across the reassembly bridge, the correct-sentences bridge, and the assembler |
| 6 | 1024 bytes is the "is it rendered" floor | `scan_completed_sentences`, both copies. A 0.1 s silence FLAC is ~100 bytes and therefore never counts |
| 7 | `take<k>/` subdirs under the sentences dir for a multi-take retake | `worker_core.py:415`. Studio's re-roll collects candidates from there |
| 8 | `<process_dir>/parallel_encode/<n:05d>.m4a`, `concat_list_sentences.txt`, `concat_list_encoded.txt`, `metadata.txt`, `chapter-provenance.json` | Assembly's own products; `chapter-closer.ts` writes the pre-encoded chapters BookForge hands to `--encoded_chapters_dir` |

---

## 1. BookForge `electron/`

### `electron/parallel-tts-bridge.ts` - the hub

| Lines | R/W | What |
|---|---|---|
| 708-741 | R/W | Stages `session-state.json` into a WSL-visible dir so the worker can read it |
| 996 | R | Regex `[\\/]stages[\\/]03-tts[\\/]sessions[\\/]` gates the WSL-cache logic - the stage path is hardcoded |
| 1022-1060 | R/W | `rewriteSessionStatePaths`: rewrites the KEYs `chapters_dir_sentences`, `chapters_dir`, `epub_path` after a move |
| 2421-2468 | R | Reads `chapter_sentences` KEY; throws when absent |
| 2699-2953 | R/W | `PersistentSessionState`: BookForge's OWN `session_state.json` at `<processDir>/session_state.json` |
| 3392-3440 | R | Finds the process dir under a session dir; derives `<processDir>/chapters/sentences` |
| 3542-3632 | W | `mkdirSync` on the target sentences dir before the spawn (bilingual arm) |
| 3896, 3938 | W | Spawns the worker with `--sentences_dir <chaptersDirSentences>` |
| 4436-4693 | R/W | Denoise/RVC chain; sets `session.denoisedSentencesDir` / `session.rvcSentencesDir` |
| 5013-5024 | R | `sessionDirFromCachedSentences` walks UP to **6 levels** looking for a basename starting with `ebook-`; the three-up `dirname(dirname(dirname(...)))` at `:5023` is only the fallback for a non-standard layout. Both the prefix and the depth are layout assumptions |
| 5026-5036 | R | `findE2aProcessDir`: `session-state.json` in the dir or one level down |
| 5062-5091 | R/W | `normalizeWslSessionToWindows`: copies the session to Windows, rewrites the state, recomputes the sentences dir |
| 5197-5200 | W | Assembly spawn: `--sentences_dir` = the RVC set, else the denoised set |
| 5861-5897 | R | `readRenderedIndices(sentencesDir)` - resume progress by listing the directory |
| 8085-8142 | R | Reads BookForge's `session_state.json` for the Continue wizard's pre-fill |
| 8319-8363, 8424-8526, 8619-8764 | R | Three resume-status scans: find `session-state.json`, read `chapters_dir_sentences` KEY, count files |
| 8830 | R | `parsed.process_dir` KEY off a parsed state |
| 8920-9040 | R | `stages/03-tts/sessions/<lang>/ebook-<uuid>` is the canonical resume location |
| 9095-9137 | R | Derives the sentences dir; reads `chapter_sentences` |

### The other bridges and jobs

| File:lines | R/W | What |
|---|---|---|
| `electron/derived-sentences.ts:236-290` | R | **The naming formula**: `derivedChainDir` = `join(processDir,'chapters','sentences-'+chain.join('-'))`; `rawSentencesDir` = `join(processDir,'chapters','sentences')` |
| `electron/correct-sentences-bridge.ts:195-247` | R | `<processDir>/chapters/sentences`, listed for the retake picker |
| `electron/correct-sentences-bridge.ts:281-283` | R | `buildCuesFromSessionState`: cue text from `session-state.json`'s `chapter_sentences`, not from a VTT |
| `electron/correct-sentences-bridge.ts:232, 305-308, 378` | R | `readSessionSettings`: BookForge's `session_state.json` (underscore) |
| `electron/correct-sentences-bridge.ts:451-526` | R/W | `<sentencesDir>/<i>.flac`; `<sentencesDir>/.orig-backup/` holds the pre-retake original |
| `electron/denoise-job.ts:81-226`, `electron/rvc-job.ts:73-265` | R | `rawSentencesDir` / `derivedChainDir` / the derived-set manifest, for provenance |
| `electron/denoise-bridge.ts:150-218, 494-534` | R | Lists `sentencesDir`, probes `files[0]`'s format |
| `electron/rvc-bridge.ts:110-160` | R | `sentencesDir` is the RVC batch input |
| `electron/sentence-gap.ts:71-125` | R | `resolveSessionSentenceGap(processDir)`; passes a source dir to gap-normalize |
| `electron/chapter-closer.ts:53-498` | R/W | Lists `sentencesDir`, hashes each FLAC; writes the pre-encoded chapters |
| `electron/reassembly-bridge.ts:470-619` | R | `processDir = join(sessionDir, hashDir)`; `<processDir>/chapters/sentences`; reads state + provenance + the dir listing in parallel |
| `electron/reassembly-bridge.ts:650-802` | R | KEYs `total_sentences`, `chapter_titles`, `chapters`, `source_epub_path`, `epub_path`; `findCoverImage(processDir)`; `chapter_sentences.json` |
| `electron/reassembly-bridge.ts:737-769` | R | `<processDir>/session_state.json` - "NOT e2a's session-state.json" |
| **`electron/reassembly-bridge.ts:1108-1159`** | **W** | **BookForge WRITES e2a's `session-state.json` in place**: `metadata.{title,creator,published,description}` and `bookforge_metadata.{title,author,year}` |
| `electron/reassembly-bridge.ts:1164-1208` | R | Verifies every index `0..total_sentences-1` exists under `chapters/sentences` before spawning assembly |
| `electron/reassembly-bridge.ts:1214-1461` | R/W | `--sentences_dir` resolution: config -> gap-closed set -> raw set; may delete an RVC set afterwards |
| `electron/reassembly-bridge.ts:2159-2171` | R | e2a MOVES the VTT out of the process dir into `--output_dir`; scans both |
| `electron/reassembly-bridge.ts:2665-2666` | R | `<projectDir>/stages/03-tts/sessions` |
| `electron/bilingual-assembly-bridge.ts:99-294` | R | `sourceSentencesDir` / `targetSentencesDir` (out of scope: bilingual) |
| `electron/queue-steps/{reassembly,final-denoise,rvc-enhancement,bilingual,tts-conversion}.ts` | R/W | Resolve `processDir` / `sentencesDir` and forward them to the bridges above |
| `electron/main.ts:7288, 9880, 10077` | R/W | IPC: `check-resume-from-dir(processDir)`, `resolve-sentence-gap(processDir)`, `save-metadata(sessionId, processDir, ...)` |
| `electron/main.ts:11689-11723, 11896-11910` | W | Deletes `stages/03-tts/sessions/` (the "delete TTS cache" action), twice |
| `electron/manifest-service.ts:138` | W | `'stages/03-tts'` is in `PROJECT_FOLDERS`, scaffolded for every project |
| `electron/preload.ts` (many) | TYPE | `processDir`, `sentencesDir`, `cachedSentencesDir`, `resolveSentenceGap`, `checkResumeFromDir`, `saveMetadata`, `scanProject -> {sessionDir, sentencesDir, sentenceCount}` |
| `electron/scripts/normalize_gaps.py:55-56` | R | `SENTENCE_RE = ^(?:\d+\|sentence_\d+)\.(?:flac\|wav)$` - the real matcher, accepting the `{i}` form and the legacy `sentence_{i}` form |
| `electron/scripts/normalize_gaps.py:190-232` | R/W | the loop: reads each matched file, strips the exact-zero pad, re-pads to `max(tail + gap_seconds, min_gap_seconds)`, writes it back |
| `electron/wsl-mounts.ts:23` | - | Comment: `--sentences_dir` is a WRITE target from inside WSL |
| `electron/flac-duration.ts:48-57` | R | `sumFlacDurationsSeconds(dir)`: `readdir` filtered on `.flac`, summed from each STREAMINFO. Returns **null**, never 0, when the directory is unreadable - a 0 would divide into a percentage of Infinity |
| `electron/reassembly-bridge.ts:1097-1098` | **W** | writes `<processDir>/cover.jpg` - the optimized cover, copied INTO the session dir so assembly finds it by the name the layout expects |

## 2. BookForge `shared/` and `src/`

| File:lines | R/W | What |
|---|---|---|
| `shared/processing/reset-book.ts:47,64` | W | `'03-tts'` in the stage list a book reset wipes |
| `shared/queue/engine-types.ts:153`, `shared/queue/narration-run.ts:268-732` | TYPE | `processDir` on the queue/narration state |
| `src/.../studio.service.ts:287` | R | Rebuilds `<projectDir>/stages/03-tts/sessions` independently |
| `src/.../sentence-qa-player.component.ts:147` | R | **`${sentencesDir}/${index}.flac`** - the numbered-FLAC URL the QA player plays |
| `src/.../sentence-review.component.ts:162` | R | `session().sentencesDir` for playback |
| `src/.../correct-assemble.component.ts:121-174`, `narration-modal.component.ts:145,1166-1199` | R | `processDir` -> `resolveSentenceGap` |
| `src/.../project-files.component.ts:607` | R | The "Delete Cache" button targets `stages/03-tts/sessions` - must match `main.ts` exactly |
| `src/.../queue.types.ts:407-889`, `correct-sentences.types.ts:23-24`, `queue.service.ts:615` | TYPE | `processDir`, `sentencesDir`, `sourceSentencesDir`, `targetSentencesDir` |
| `src/app/core/services/electron.service.ts:3298-3304` | R | `resolveSentenceGap(processDir)` - the renderer's IPC door to the session dir; every gap-field read in the UI goes through this one signature |
| `src/app/core/services/electron.service.ts:3405-3423` | W | `reassemblySaveMetadata(sessionId, processDir, metadata, coverData)` - the renderer's door to the two WRITES into the session dir (`session-state.json`'s metadata keys and `<processDir>/cover.jpg`) |

## 3. BookForge `cli/`

| File:lines | R/W | What |
|---|---|---|
| `cli/orpheus-batch-render.js:55-179` | R | `readdirSync(sentencesDir)`, `/^\d+\.flac$/`, expects `{i}.flac` |
| `cli/orpheus-audiobook-render.js:63-66` | W | Prunes `<projectDir>/stages/03-tts/sessions/<language>` |
| `cli/orpheus-audiobook-render.js:165-338` | R/W | Resume candidate scan; `processDir` into the denoise step; the denoised dir becomes assembly's `sentencesDir` |
| `cli/bookforge-tts.py:150-159` | - | **Does NOT spawn e2a.** It requires `dist/electron/parallel-tts-bridge.js` and drives the render IN-PROCESS through node (`_require((REPO_ROOT/'dist'/'electron'/'parallel-tts-bridge.js').is_file(), ...)`), so BookForge must be BUILT. Its relationship to the layout is entirely second-hand, through the bridge |

## 4. e2a `bookforge_ext/`

| File:lines | R/W | What |
|---|---|---|
| `worker_core.py:89-102` | R | Scans `session_dir`'s subdirs for `session-state.json`; injects `process_dir` KEY |
| `worker_core.py:112-123` | R | `scan_completed_sentences`: `<sentences_dir>/{i}.{ext}` for flac/wav/mp3, >= 1024 bytes |
| `worker_core.py:194-215` | R | `voice_dir = <process_dir>/voices`; the three-way `sentences_dir` precedence |
| `worker_core.py:315-316` | W | `makedirs(sentences_dir)` before rendering |
| `worker_core.py:379-418` | W | `take<k>/` subdirs when `num_takes > 1` or `--take_temperatures` is given |
| `worker_core.py:501, 521` | R | the RESUME existence+size checks (`os.path.exists(...) and getsize(...) > 1024`), not the write |
| `worker_core.py:509, 531` | W | `_write_empty_sentence_silence(output_file)` - the only `<sentences_dir>/{i}.flac` the worker writes ITSELF |
| `lib/classes/tts_engines/orpheus.py:4040` (`_sentence_file`), `:4139` (`_write_silence`), `:4561` (`_save_audio`) | W | THE per-chunk write, in the ENGINE. The worker only hands it an index; the path is `os.path.join(session['sentences_dir'], f'{i}.{fmt}')`. The other engine classes have the same three methods |
| `worker_core.py:589-591` | W | Deletes in-flight `{idx}.flac` on a cooperative stop |
| `session.py:56-112` | W | `save_session_state` -> `<process_dir>/session-state.json`, version 2, 38 keys |
| `session.py:125-154` | R | `load_session_state`; raises on a corrupt state |
| `session.py:164-190` | R | `scan_completed_sentences` (a second copy of worker_core's) |
| `session.py:223-246` | R | `list_resumable_sessions`: `<process_dir>/chapters/sentences` under `tmp_dir` |
| `session.py:306-338` | R | `resume_session` returns `process_dir`, `chapters_dir`, `chapters_dir_sentences` |
| `session.py:472-486` | W | **The canonical construction**: `process_dir = <session_dir>/<md5(ebook_path)>`, `chapters_dir = <process_dir>/chapters`, `sentences_dir = <chapters_dir>/sentences`, `epub_path = <process_dir>/__<name>.epub` |
| `session.py:609-628` | R | Resume: the same three-way `sentences_dir` precedence |
| `session.py:760-871, 1194-1207` | R/W | The VTT: reads `<sentences_dir>/{i}.flac`, writes `<process_dir>/<stem>.vtt` |
| `session.py:973-1078` | R | Assembly ALWAYS re-derives directories from the corrected `process_dir`, because the state may have been written on another machine |
| `bilingual.py` (whole file) | R/W | Out of scope by name (see `compat/FLAGS.md`) |
| `args.py:143-151` | - | `--sentences_dir`'s help text is the layout's own specification: "the single authoritative sentence store... existing `{i}.<ext>` files are skipped (resume)" |
| `args.py:204-218` | - | `--encoded_chapters_dir`'s help text specifies `<N>.m4a`, 1-indexed, "the same numbering as `<N>.flac` in the session's chapters dir" |

## 4b. e2a root scripts

| File:lines | R/W | What |
|---|---|---|
| `worker.py:357-427` | - | THE entry point BookForge spawns for every render and retake. `--session_dir`, `--sentences_dir`, `--sentence_indices`, `--num_takes`, `--take_temperatures`, `--sentence_overrides` are declared HERE and nowhere else; `app.py` has never had the last four |
| `worker.py:503-515` | - | hands them to `worker_core.run_worker_tts`, which is where the layout is actually touched |
| `lib/worker_core.py:151` | R | **A THIRD copy** of the sentences-dir resolution: `state.get('chapters_dir_sentences') or os.path.join(process_dir,'chapters','sentences')`. Note it has NO `args` override - the `--sentences_dir` flag does not reach this copy at all. It is the sixth reader of the `chapters_dir_sentences` KEY (after `session.py:91` writes it, `session.py:628`, `worker_core.py:215`, and two TS sites) |

## 5. e2a `lib/core.py`

| Lines | R/W | What |
|---|---|---|
| 228-234 | W | `makedirs(process_dir)`, `makedirs(sentences_dir)` |
| 496-530 | R/W | `chapter_provenance_path(process_dir)` = `<process_dir>/chapter-provenance.json` |
| 3736, 3747 | R | Resume detection: lists `chapters_dir` and `sentences_dir` by regex `^(\d+)\.flac$` |
| 3855-3859 | - | the CALL SITE of `combine_audio_sentences` inside `convert_chapters2audio` (worker mode skips it) |
| 4050-4127 | R/W | `combine_audio_sentences` itself: reads `<sentences_dir>/{i}.flac` for `start..end`, writes `chapters/<file>`; refuses a non-homogeneous FLAC set |
| 4057, 4106-4115 | W | `<process_dir>/concat_list_sentences.txt` |
| 4393 | W | `<process_dir>/<final>.vtt` |
| 4420-4520 | R/W | `export_audio_parallel`: `<process_dir>/parallel_encode/{idx:05d}.m4a`, `<process_dir>/concat_list_encoded.txt`; BookForge's pre-encoded chapters bypass the dir and are never deleted |
| 4693-4773 | W | `concat_list_chapters_1.txt` / `metadata.txt` (and the `_part{N}` variants of both) |
| 5101-5103, 5412-5424 | W | Two more copies of the `process_dir`/`chapters_dir`/`sentences_dir` formula |
| 5496-5538 | W | `save_session_state` (a duplicate of `session.py`'s, on the non-parallel path) |
| 5551-5571 | R | `load_session_state` + `scan_completed_sentences` (duplicates) |
| 5602-5719 | R | `list_incomplete_sessions` |
| 5777-5797, 5922-5935 | R | The VTT reads `<sentences_dir>/{i}.flac` |
| 5970-6030, 6194-6219 | R | Assemble-only re-derives everything from the corrected `process_dir` and requires `chapter_sentences` |

---

## 6. Three "sentences" that are NOT this layout

Named so an audit does not chase them:

| What | Where | Why it is different |
|---|---|---|
| The LL / bilingual text cache | `electron/ll-jobs.ts:987-1326`, `main.ts:10954-11080` | `<projectDir>/sentences/<lang>.json` - per-language TEXT, no audio |
| The single-book render service store | `electron/book-render-service.ts:84-87` | `<i>.wav`, its own directory, not a session |
| The playback `SessionState` | `src/.../play.types.ts:55` | A UI enum that happens to share the name |

---

## 7. What step 3 changes

Nothing on this page. `render/session_store.py` reproduces e2a's readers and its
one writer; `render/worker.py` writes `<sentences_dir>/{i}.flac` and `take<k>/`
at the same paths with the same FLAC parameters; `render/retake.py` writes the
same take layout `correct-sentences-bridge.ts` collects from. The only new file
narrator can create anywhere in a session directory is the sentence FLAC itself.

**"The same FLAC parameters" has a precondition: the same interpreter.** The
STREAMINFO max-blocksize is chosen by whatever libsndfile/libFLAC the writing
process links, not by anything the caller passes. MEASURED: the golden sentence
sets are **2304** on all three books (torchaudio in the WSL `orpheus_tts` env,
read out of `C:	mp
arrator-golden` with `flac_header.read_streaminfo`); the
Windows test interpreter's soundfile writes **4096** for the same 24 kHz mono
PCM_16 input. Both assemblers refuse a mixed set (the
Witnesses homogeneity guard - and they must, because ffmpeg's concat demuxer
drops the mismatched frames and still exits 0), so a natively-rendered retake
committed into a WSL-rendered book is refused. Pre-existing, identical in e2a,
and recorded in `PORT_NOTES.md` section 9.9.
