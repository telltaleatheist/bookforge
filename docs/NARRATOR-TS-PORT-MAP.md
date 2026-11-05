# narrator → TypeScript port map (B6) — read-only survey, 2026-11-04

Repo `C:\Users\tellt\Projects\bookforge` @ `1861e4c1` (main, clean). Nothing was edited, nothing was run
except read-only greps and an AST survey script in the scratchpad. Sources: `docs/REORG-PLAN.md`,
`python/narrator/CONTRACTS.md`, `assemble/README.md`, `render/SESSION_READERS.md`, `docs/LEGACY-REMOVAL.md`,
the spawn sites in `electron/`.

---

## 0. What is actually still spawned (this decides what is live)

`electron/narrator-spawn.ts` `PHASE_MODULE` lists 7 phases. After LEGACY-REMOVAL (local render venue
deleted; every render goes to a Crucible server), the LIVE spawns are:

| phase | module + argv | spawn site(s) | live? |
|---|---|---|---|
| `prep` | `-m narrator.compat.app --headless --ebook E --session ID --session_dir D --language L --tts_engine higgs --prep_only [--sentence_per_paragraph] [--skip_headings] [--higgs_voice V]` + env `NARRATOR_HIGGS_VOICES`, `NARRATOR_SENTENCE_GAP`, venue band | `parallel-tts-bridge.ts:4498` (`buildJobSpawn`, `onHost` for Crucible venue) | LIVE |
| `assembly` | `-m narrator.compat.app --headless [--ebook E] --output_dir O --session ID --session_dir P [--sentences_dir S] [--encoded_chapters_dir C] --device CPU --language L --tts_engine T --assemble_only --no_split [--coverage_report R] [--post_render_filter F] --chapter_gap G` | `parallel-tts-bridge.ts:5992` (post-render), `reassembly-bridge.ts:1812` (reassembly), `reassembly-bridge.ts:3180` (import probe `-c import narrator.assemble`) | LIVE |
| `align` | `-m narrator.cli align --session-dir P --report R --language L --chapter-gap G` **+ either** `--alignment A.json` (Crucible items, CPU only) **or** `--backend qwen3 --device D --python PY --workers N` (local model) | `coverage-align-job.ts:1071` (`coverageAlignArgs` 498-560) | LIVE (two arms) |
| `resume` | `-m narrator.compat.app --headless --resume_session PATH` | `parallel-tts-bridge.ts:10589` `checkResumeStatus` ← `main.ts:9532` IPC | LIVE (one IPC; the `Fast`/`FromProcessDir` variants are already TS) |
| `list` | `-m narrator.compat.app --headless --list_sessions` | `parallel-tts-bridge.ts:10687` `listResumableSessions` | export with no caller found in electron/src/cli — likely dead, verify |
| `worker` | `-m narrator.compat.worker ...` | none (only used as a WSL question at `parallel-tts-bridge.ts:1986`) | DEAD |
| `serve` | `-m narrator.serve` | none in app (Crucible serves) | leaves with Crucible |

Other Python reached from electron (non-narrator-package):

| script | spawned by | what | class |
|---|---|---|---|
| `electron/scripts/normalize_gaps.py` (267) | `denoise-bridge.ts:545 normalizeSentenceGaps` ← `sentence-gap.ts:127`, `chapter-closer.ts:223`, `reassembly-bridge.ts:1533`; runs in the **rvc-env** python | strip exact-zero trailing pad, append fresh silence floor; numpy+soundfile | **CPU → port** |
| `electron/scripts/write_m4b_tags.py` (105) | `metadata-tools.ts:346 writeM4bTagsInPlace` (stdin JSON `{file,tags,cover}`, stdout `{"ok":..}`), tools env | mutagen in-place ilst/covr/stik write, 5-try lock backoff | **CPU → port** |
| `electron/scripts/measure_cue_edges.py` (334) | only `cli/align_book_chapters.py` (dev/corpus tool) — no electron caller | VTT cue-edge accuracy vs RMS envelope | **CPU dev tool, not app** — port only if the corpus cutter survives; otherwise leave with cli/*.py decision |
| `align_audiobook.py` (2513) | `whisperx-align-bridge.ts` (epub-align), imports `narrator.align.aligner/run` via `PYTHONPATH=narratorPythonRoot()` | whisperx/faster-whisper/qwen3 longform align | GPU → Crucible (C2; `crucible/align-longform.ts` exists) |
| `transcribe_audiobook.py` (361) | `transcribe-bridge.ts` | faster-whisper | GPU → Crucible (`crucible/asr.ts` exists) |
| `separator_worker.py` (152), `run_audio_separator.py` (18) | `denoise-bridge.ts` | audio-separator roformer | GPU → Crucible (`crucible/denoise.ts` exists) |
| `whisper_download.py` (47) | `whisper-models.ts` | HF download | dies with local whisper (C2) |
| `orpheus_download.py` (124), `orpheus_fuse.py` (694) | Orpheus catalog (retired) | Orpheus install | DELETE (Orpheus retired) |

Out of scope but violates "no Python in BookForge": `cli/bookforge-tts.py` (3577, the operator CLI front
end), `cli/align_book_chapters.py`, `cli/cue_window_check.py`, `cli/py/*.py` (~3k), `tools/*.py` (~2.4k).
Someone has to rule on those (port the CLI front-end to node, move dev tools to a tools repo).

---

## 1. Module-by-module map (in-scope Python, excluding `engine/` and `serve/`)

Legend: **P** = port (live CPU), **D** = dead (do not port), **C** = Crucible-bound/GPU, **½** = split.

### Top level

| module | lines | does | I/O | called by | deps → TS | verdict |
|---|---|---|---|---|---|---|
| `manifest.py` | 651 | render manifest v1 dataclasses, `from_dict/to_dict/load/save/validate/flat_chunks/chunk_path/total_samples` | JSON (indent 2, ensure_ascii=False); paths relative to `source.processDir` | session_v1, assemble, align | stdlib → plain TS types + validator | **P** (leaf) |
| `env.py` | 63 | `env_number` policy reader | env | only `engine/`, `serve/` | — | moves with Crucible, not BookForge |
| `cli.py` | 701 | `narrator <prep|manifest|render|retake|sessions|align|assemble|serve>` | argv → JSON stdout | app uses ONLY `align`; operators paste others | argparse → none | **½**: port `align` arg semantics into the TS align function signature; `render/retake/serve` D; `prep/assemble/sessions/manifest` are thin wrappers over the same functions — fold into node `cli/` adapters if wanted |
| `__main__.py`, `__init__.py` | 9 | version | — | — | — | D |

### `compat/` (1,058) — the e2a-flag door

| module | lines | does | verdict |
|---|---|---|---|
| `compat/app.py` | 637 | parses e2a's `app.py --headless` flags; routes `route_prep`, `route_assemble`, `route_resume_session`, `route_list_sessions`, `route_worker`; prints e2a-shaped JSON (indent 2 on success, compact on failure) | **½**. The ROUTING disappears (TS calls functions directly); what must survive is the per-route option resolution: `route_prep` (lines ~266-383: Higgs ⇒ `chunking='paragraph'`, budget from `engine.higgs.v3_engine.higgs_v3_prep_budget` ← **imports engine/**, B1 replaces with `GET /v1/voices`), `route_assemble` (~492: `build_manifest` + `assemble`), resume/list (~205-214). `route_worker` D. |
| `compat/flags.py` | 346 | ACCEPT/IGNORE/REFUSE table of e2a flags; `resolve_engine`, `engine_factory_for` (**imports `engine.registry`**) | **D** as a module — there is no argv any more. Carry over only the refusals that encode behaviour (e.g. `--post_render_filter`, `--chapters` refusals) as typed-arg validation. |
| `compat/worker.py` | 61 | `worker.py` door | D |
| `compat/FLAGS.md` | — | doc | keep as historical note or delete |

### `render/` (3,217)

| module | lines | does | I/O | deps → TS | verdict |
|---|---|---|---|---|---|
| `render/flac_header.py` | 245 | 42-byte STREAMINFO reader; `fatal_inhomogeneity` (rate/channels) vs `fixable_inhomogeneity` (blocksize/bits); `assert_concat_homogeneous` | reads FLAC headers | stdlib → `fs` read 42 bytes. `electron/flac-duration.ts` already decodes rate + 36-bit total (returns null instead of raising — the port must RAISE with the path, keep both) | **P** (leaf) |
| `render/session_store.py` | 624 | read/write `session-state.json` (v2), `order_state`, `scan_completed_sentences` (1024-byte floor), `calculate_missing_ranges`, `sessions_root()` (`NARRATOR_SESSIONS_ROOT`, refuses legacy `E2A_TMP_DIR`), `list_resumable_sessions`, `check_resume_compatibility`, `resume_session` | JSON indent 2 ensure_ascii=False, temp+rename | stdlib → TS (use the repo's `fs-retry`/`fs-replace` for renames — NAS EPERM rule) | **P** |
| `render/session_v1.py` | 845 | e2a session dir → Manifest: state load, `--sentences_dir` override, cover resolution, chapter titles by doc identity, `chunk_kind`, `parse_chapters_arg`, `detect_completed_chapters`, reads `gaps.json` (beside audio, then canonical), refuses pads=False w/o gaps and pads=True with gaps, bilingual refusal | reads state, provenance, FLAC headers, gaps.json, cover | stdlib + flac_header + engine_profiles | **P** |
| `render/retake.py` | 205 | multi-take re-render (`--sentence_indices/--num_takes/--take_temperatures/--sentence_overrides`) | | imports `.worker` (torch) | **D** — retakes are `crucible/reroll.ts`; `correct-sentences-bridge.ts` commits in TS already. Keep the layout facts (`take<k>/`, `.orig-backup/`) which live in TS readers. |
| `render/worker.py` | 1280 | GPU render worker (torch, psutil, engine registry) | | torch | **D / C** |
| `PORT_NOTES.md`, `SESSION_READERS.md` | — | the layout contract (10 invariants) | | | keep: move to `docs/narrator/` |

### `assemble/` (3,519) — highest-value port

| module | lines | does | I/O | deps → TS | verdict |
|---|---|---|---|---|---|
| `engine_profiles.py` | 199 | `EngineProfile{pads, edgeFade in/out ms}`, `CoveragePolicy` per engine (`orpheus` pads, `higgs-v3` 10/25 ms) | — | dataclasses → const table. NB `shared/queue/coverage-policy.ts` already MIRRORS the coverage policy, kept equal by `tools/test-coverage-policy-mirror.js` → after the port, ONE owner (TS) | **P** (leaf) |
| `ffmpeg_tools.py` | 118 | resolve ffmpeg/ffprobe, `run`, `probe_duration` (raises, never 0.0), `write_concat_list` (fsync + size check) | concat lists | subprocess → `child_process.spawn` with `getFfmpegPath()` (`electron/tool-paths.ts`) | **P** |
| `edges.py` | 203 | raised-cosine fades (`0.5-0.5cos(pi*i/(n+1))`), `fade_samples` (`int(round(ms*sr/1000))`), `gap_frames` (`int(round(s*sr))`), write faded/normalized/silence FLAC via soundfile (PCM_16/24/32 = widest in set) | FLAC in → FLAC in work dir | **numpy+soundfile** → decode with `ffmpeg -f s16le/s32le` to Int16/Int32Array, multiply in Float64, requantize with libsndfile's rule, encode with `ffmpeg -c:a flac -frame_size N -sample_fmt s16/s32`. See §3 numerics. | **P** (numerics-critical) |
| `chapters.py` | 588 | `plan_chapters` (per-chapter list, padded vs unpadded, `_normalize_mixed` rewrite, threaded prepare with `[ASSEMBLE] Preparing sentences D/T` progress), `total_duration`, `concat_tolerance` (0.5+0.01n), `check_duration` | concat lists, work dir `e<n>/` | ThreadPool → `Promise` pool with a fixed width | **P** |
| `encode.py` | 1005 | `;FFMETADATA1` doc (`generate_ffmpeg_metadata`, ms = `int(round(s*1000))`, `sanitize_meta_chapter_title`, `ellipsize_utf8_bytes`), serial vs parallel gate (`parallel_export_unsupported_reason`: >2 h ⇒ parallel, no loudnorm), `encode_chapter` (aac 192k 44.1k mono), `concat_encoded` (stream copy + `-movflags +faststart+use_metadata_tags`), `chapter_gap_flac/m4a`, `load_encoded_chapters` (0.06 s guard), `attach_cover` (**mutagen**), `verify_export` (2.0 s guard), `Export - P%` progress | metadata.txt, `*.m4a`, final `.m4b` | subprocess ffmpeg (keep verbatim argv — README §5); **mutagen → in-place MP4 atom writer** (see §1d) | **P** |
| `coverage_gate.py` | 254 | reads `coverage.json`, verifies version/engine, `retake_indices`, `report_failures`, `check()` → refuse or proceed (policy per engine) | coverage.json | stdlib | **P** |
| `vtt.py` | 195 | chunk VTT: `format_timestamp` (`HH:MM:SS.mmm` via `{s:06.3f}`), `cue_text` (strip `SML_UNSPOKEN_PATTERN`, collapse ws, `<b>` for headings), `chunk_spans` (running float sum of samples/sr + realized gaps + chapter gap), `vtt_duration` | `<stem>.vtt` LF | regex → JS regex (u-flag) | **P** |
| `sentence_vtt.py` | 368 | sentence transcript type + writer; ESTIMATED cues (character share of chunk span) with `NOTE estimated chunk <i>`; `last_cue_end_seconds` | `<stem>.sentences.vtt` in process dir | imports `text.paragraph_packer.split_sentences, spoken` (lazy) | **P** — needs the text-core port first |
| `run.py` | 582 | `assemble()`: work dir (`mkdtemp narrator-asm-`), progress lines, plan → encode → VTT → seal measured or estimated sentence VTT (refuses transcript ending >5 s early/late), `final_name` = `get_sanitized("<title>. <author>. (<year>).m4b")`, copy to output with % progress, final JSON | m4b + vtt in `output_dir` | stdlib | **P** |
| `README.md` | 742 | the discovered rules (gap rule, chapter gap, homogeneity, guards, exact ffmpeg commands, progress lines, VTT) | | | keep as the port's spec |

#### §1d m4b tag writing (both `encode.attach_cover` and `write_m4b_tags.py`)
- mutagen edits atoms IN PLACE (no audio rewrite; near-instant on 500 MB). `ffmpeg -c copy -metadata` is a FULL
  REMUX (minutes on a 20 h book, plus a temp copy on a NAS) — REORG-PLAN says "m4b tags native (ffmpeg from TS)",
  but a remux is a behaviour change (speed + it rewrites mdat on Z:). Recommend an in-place writer:
  - candidate npm: `node-taglib-sharp` (pure TS port of TagLib#, writes MP4 `ilst` incl. `covr`, `stik`,
    freeform `----`), or a small own atom editor (`moov/udta/meta/ilst` rewrite, reuse adjacent `free`
    padding, else grow moov and patch every `stco`/`co64` offset — the files are `+faststart`, so moov
    precedes mdat and growth shifts every chunk offset). Must MEASURE: mutagen's output atom layout vs the
    candidate's; preserve the `----:com.apple.iTunes:year`/`language` freeform atoms that
    `+use_metadata_tags` wrote; preserve the mov_text subtitle track `embedAndVerifyVtt` adds.
  - KEYMAP to port verbatim: title `©nam`, artist `©ART`, composer `©wrt`, grouping `©grp`, genre `©gen`,
    date `©day`, description `desc`, `stik=2`, cover PNG if `.png` else JPEG; empty/None values skipped
    (not cleared); lock backoff delays `(0, .3, .6, 1.2, 2.0)` on EACCES/EBUSY/EPERM.
  - The cover attach inside assembly is the same writer with only `covr`.
  - **ASSEMBLY STEP CHECKLIST:** `encode.attach_cover` is still Python mutagen, which can move all the audio in place on the only copy. When assembly is ported it must call `electron/narrator/assemble/m4b-tags.ts` (`setM4bItems` with `coverItem`), so it takes the same safe path (Owen, 2026-11-05). Note that `audiobookItems` also sets `stik`; `attach_cover` does not, so it passes only the `covr` item.

### `text/` (5,775) — the prep path (largest, riskiest)

| module | lines | does | deps → TS | verdict |
|---|---|---|---|---|
| `sml.py` | 247 | in-band markup: `[heading] [break] [item] [pause:X]`, `SML_UNSPOKEN_PATTERN`, `SML_HEADING_PATTERN`, escape/restore, `split_sml_edges` | **`regex`** (`\p{L}`/`\p{N}`) → JS `u`/`v` flags | **P** (text core, needed by assembly VTT) |
| `gaps.py` | 129 | `classify_gap` / `classify_gap_seconds`: per-chunk trailing floor (`NARRATOR_SENTENCE_GAP`) + explicit `[pause:X]` | re | **P** (leaf; prep writes gaps.json from it) |
| `lang.py` | 263 | e2a `conf_lang` tables (language entries, abbreviations, chars_remove, punctuation tables, `default_*`) | — | **P** — GENERATE a JSON from Python once and commit; `shared/text/sentence-abbreviations.ts` already mirrors part of it (`tools/test-sentence-abbreviations.js`) → collapse to one owner |
| `normalize.py` | 254 | `normalize_text` (Orpheus/Higgs branch: emoji strip, `foreign2latin`, newline→`[pause]`, punctuation switch (with the preserved `...` bug), `chars_remove`, ws collapse), `foreign2latin` (tokenize `\w+|\s+|[^\w\s]`, `unicodedata.name`-based script detection) | **unidecode** (on the English path for digit tokens — identity there), pypinyin/pykakasi/phonemizer lazily, all inside `try/except Exception → unidecode(word)` | **P**; MEASURE which of pypinyin/pykakasi/phonemizer exist in the tools env: if absent, today's behaviour for every non-Latin token is `unidecode(word)` and the faithful TS port is just a unidecode table (npm `unidecode` is also a Text::Unidecode port but tables differ by version — pin with vectors) |
| `epub.py` | 279 | open EPUB (ebooklib), spine, TOC flatten, Dublin Core, cover (PIL → re-encoded JPEG q75), `path_md5` (md5 of the PATH STRING, names `process_dir` and `epub_content_hash`), staging | **ebooklib, bs4 (`html.parser`), PIL** → `jszip` + `parse5`/`htmlparser2` (both in node_modules) or foundry-core's EPUB reader; PIL → `sharp`/`jpeg-js` (cover bytes WILL differ — needs Owen ruling or accept "decoded-image-equal") | **P** |
| `chapters.py` | 853 | spine walk → chapters, heading text, filter chapter, `chapter-provenance.json`, `chapters.json`; calls `packer.get_sentences` (e2a policy) or the paragraph chunker | bs4, regex | **P** (paragraph path only — see packer) |
| `packer.py` | 894 | e2a's char-window "parity packer" (`get_sentences`, `orpheus_max_chars`, `difflib` near-dup) | difflib, regex | **D for prep** (Orpheus-only; Higgs refuses `chunking='e2a'`, prep.py:407). Only `orpheus_max_chars` is referenced by `paragraph_packer.orpheus_budget_from_env` and `chapters.py` — port the constant/branch only if the Orpheus branch is kept; otherwise drop. |
| `paragraph_packer.py` | 2172 | THE Higgs chunking policy: blocks from XHTML, `strip_unspoken_glyphs`, `fold_caps_run` (keep-set = `lettered ∪ spokenAsWord` from `caps_acronyms.json`), `spoken`, `split_sentences` (abbreviations), clause splitting for over-cap sentences, `pack_paragraphs` (floor/cap merge), tables, `CatalogBudget` | bs4, ebooklib, regex; `engine.protocol.Budget` is **TYPE_CHECKING-only** (no runtime engine import) | **P** — split: "text core" (`spoken`, `split_sentences`, `strip_unspoken_glyphs`, `fold_caps_run`) first, packing later |
| `prep.py` | 575 | `prep_session`: language (iso639 `Lang`), chunking choice, budget, chapters, `count_real_sentences`, result dict, `save_session_state`, `write_gaps_file` (pads=False only) | **iso639-lang**, regex, uuid, datetime | **P**; iso639 → a generated 3↔1 table JSON (only the codes the product supports) |
| `sentences.py` | 81 | documents that stanza is never imported | — | D (doc) |
| `caps_acronyms.json` | — | THE acronym list, read by `paragraph_packer.py` AND `shared/listen-text/normalize.ts` AND `electron/tts-spoken-forms.ts` | — | MOVE to `shared/text/caps_acronyms.json` (one file, three TS readers), update `tools/test-one-fact-one-owner.js` |

### `align/` (3,203)

| module | lines | does | verdict |
|---|---|---|---|
| `aligner.py` | 1254 | dataclasses (`AlignedWord/TextSpan/AudioSpan/Alignment`, `alignment_from_dict`), `decode_audio` (ffmpeg → f32le 16 kHz), `detect_silences` (strided RMS, float64 mean, `20log10 < noise_db`), `speech_fraction`, `chunk_words`, `_normalized`, `PrecomputedItem/precomputed_items`, `_map_items_onto_words`, `_rate_plausibility`, `_derive_scores`, `_spans`, `align_chunk` (precomputed OR model), `_rejoin_split_words`; model loaders `_load_whisperx`, `_whisperx_words`, `_load_qwen3`, `_qwen3_words`, `load_backend`, `check_device`, `gpu_lock_path` | **½**: everything on the `--alignment` (Crucible) path is CPU → **P**; the whisperx/qwen3 loaders and device/lock code → **C** (dies when the local arm dies) |
| `run.py` | 662 | `align_session`: jobs per chunk, `_from_alignment` (Crucible doc) or `_run` (local), `backend_for_alignment`, coverage + sentence cues, `gate_refusal`, `write_outputs` (`coverage.json` indent 2 ensure_ascii default=True, `<stem>.sentences.vtt`) | **½**: `--alignment` half **P**, `_run`/`align_env.run_jobs` **C** |
| `coverage.py` | 263 | `evaluate_chunk` (missing/inserted text), `coverage_document` | **P** |
| `sentences.py` | 298 | sentence cues inside a chunk span from the alignment (seam snapped to pause middle) | **P** |
| `window.py` | 119 | library door used by the corpus cutter / `align_audiobook.py` | **C** (only GPU callers) |
| `env.py` | 419 | discover align python, worker env, `run_jobs` JSON-lines pool | **C/D** |
| `worker.py` | 138 | `python -m narrator.align.worker` | **C/D** |

Third-party deps summary for the ported set → TS:

| Python dep | where | TS replacement |
|---|---|---|
| numpy | edges, chapters (via edges), normalize_gaps, aligner precomputed path (`detect_silences`) | `Float64Array`/`Int16Array` + hand-written ops; for `np.mean` replicate numpy PAIRWISE summation (§3) |
| soundfile | edges (read/write FLAC), normalize_gaps | ffmpeg child process: decode `-f s16le`/`s32le`, encode `-c:a flac -frame_size N` (README §1a already proves ffmpeg must write the chapter gap FLAC for blocksize reasons) |
| mutagen | encode.attach_cover, write_m4b_tags.py | in-place MP4 atom writer (§1d) |
| bs4 (`html.parser`) | epub, chapters, paragraph_packer | `parse5`/`htmlparser2`/`cheerio` (present). bs4's html.parser tree-building on malformed XHTML differs from parse5 (HTML5 spec) — closest is `htmlparser2` non-xml mode. Vector-pin on every library book. |
| ebooklib | epub, paragraph_packer | `jszip` + OPF/NCX/nav parse (or foundry-core) |
| PIL | epub cover | `sharp` or `jpeg-js` (bytes differ) |
| regex | sml, normalize, packers, prep | JS RegExp with `u` (or `v`) flag; Python `\w`, `\s`, `\b`, `str.split()` whitespace set differ from JS — write explicit classes |
| unidecode | normalize | npm `unidecode`/own table, pinned by vectors |
| iso639-lang | prep | generated table |
| difflib | packer (e2a) only | not needed if packer.py is dropped |
| num2words | serve only | not BookForge (Crucible/serve) |
| psutil, torch, whisperx, qwen_asr | render/worker, aligner model half | Crucible |

---

## 2. GPU/engine-bound vs pure CPU

Imports of `engine/` or `serve/` from the remaining parts (must be cut or wait for Crucible):

| importer | import | nature | resolution |
|---|---|---|---|
| `compat/app.py:310` `route_prep` | `engine.higgs.v3_engine.higgs_v3_prep_budget` (reads `NARRATOR_HIGGS_VOICES` via `engine/higgs/config.load_voice`) | runtime, prep's chunk cap/floor | **B1** (prep reads char budgets from `GET /v1/voices`). The TS prep takes `{chars, floorChars}` as an argument from the venue band (`electron/crucible/voice-band.ts`, `prep-band.ts`) — port depends on B1 landing. |
| `compat/flags.py:317` | `engine.registry` | worker engine factory | dead with the worker route |
| `compat/worker.py` | `engine.log` | dead | — |
| `render/worker.py`, `render/retake.py` | `engine`, torch | dead | — |
| `cli.py:641` | `serve.worker` | `serve` subcommand | dead in BookForge |
| `text/paragraph_packer.py:188` | `engine.protocol.Budget` | `TYPE_CHECKING` only | none needed |
| `align/aligner.py` | whisperx, qwen_asr, torch (lazy) | local model arm | dies with C2 / the local arm |

Pure CPU (no engine, no model): `manifest`, `render/flac_header`, `render/session_store`, `render/session_v1`,
all of `assemble/`, `text/*` (except the B1 budget seam), `align/{coverage,sentences}` + the precomputed half of
`align/{aligner,run}`, `normalize_gaps.py`, `write_m4b_tags.py`, `measure_cue_edges.py`.

Note: `tests/test_engine_protocol.py::test_the_engines_agree_with_the_assemblers_own_table` keeps
`engine_profiles.py` equal to each engine's `pads/edge_fade`. When Higgs moves to Crucible this becomes a
cross-repo fact: either Crucible publishes `pads`/`edgeFade` per voice/engine (like `GET /v1/voices` does for
band/cap — "voice facts live on Crucible") or BookForge's TS table is the owner and Crucible's engine is checked
against it. Raise with crucible pc 1.

---

## 3. Contracts that must stay identical, and what pins them

### File formats (value-level unless stated)

| contract | owner after port | pinned by (Python) | pinned by (TS, exists) |
|---|---|---|---|
| session layout v1 — the 10 invariants (`SESSION_READERS.md` §0): `chapters/sentences/<i>.flac` contiguous; derived-set names; `session-state.json` (hyphen) vs `session_state.json` (underscore); `chapters_dir_sentences`; required keys; 1024-byte floor; `take<k>/`; `parallel_encode/<n:05d>.m4a`, concat lists, `metadata.txt`, `chapter-provenance.json`; `gaps.json` presence rule | TS `session/` | `test_render_session_store.py` (501), `test_session_v1.py` (740), `test_golden_fixtures.py` (418) | `tools/test-crucible-render-session.js`, many bridges read these |
| `session-state.json` v2 (key order via `order_state`, indent 2, ensure_ascii=False) | TS session_store | `test_render_session_store.py`, `test_text_prep_golden.py`, `test_compat_prep.py` (1163) | bridges JSON.parse it — value-level is enough for TS readers |
| `gaps.json` `{"version":1,"engine":id,"gaps":{"<i>":{"before":s,"after":s}}}` (indent 2, ensure_ascii default) | TS prep | `test_session_v1.py`, `test_compat_prep.py` | `correct-sentences-bridge.ts` reads it |
| `chapter-provenance.json`, `chapters.json` | TS prep | `test_text_prep_golden.py`, `test_text_epub.py` | — |
| manifest v1 (CONTRACTS.md) — in-memory during assembly, `save()` for operators | TS | `test_manifest.py` (456) | — |
| `;FFMETADATA1` `metadata.txt` (chapter START/END ms = `int(round(s*1000))`, title sanitize + UTF-8 ellipsize) | TS encode | `test_assemble_synthetic.py`, `test_assemble_book_tags.py`, golden `metadata.txt` ×3 | — |
| chunk VTT (no ids, no NOTE, LF, `HH:MM:SS.mmm`, `<b>` headings) | TS vtt | `test_vtt.py` (165), golden `reference.vtt` ×3, `test_assemble_golden.py` | `reassembly-bridge.ts:36` cue regex, `correct-sentences-bridge.ts` cue parser |
| sentence VTT (`.sentences.vtt`, `NOTE estimated chunk <i>`, quality notes) | TS | `test_align.py` (2941), `test_assemble_synthetic.py` | sealed into m4b by `metadata-tools.ts embedAndVerifyVtt` |
| `coverage.json` (`SUPPORTED_REPORT_VERSION`, engine, per-chunk) | TS align → read by TS assemble | `test_align.py`, `test_assemble_*` | `tools/test-coverage-audit-reports.js`, `shared/queue/coverage-policy.ts` |
| Crucible `alignment.json` (input) | Crucible | `test_align.py` (`backend_for_alignment` refusals) | `electron/crucible/align.ts` |
| m4b: aac 192k / 44.1 kHz / mono; serial (≤2 h, loudnorm+afftdn) vs parallel (>2 h, none); `+faststart+use_metadata_tags`; chapters; tags title/artist/language/year; `covr` | TS encode | `test_assemble_golden.py`, `reference-m4b.json` ×3 (ffprobe JSON + sha256) | `reassembly-bridge.ts` 5 s promotion gate |
| progress lines (README §6 table) — parsed by `reassembly-bridge.ts` and `shared/queue/assembly-prepare.ts` | becomes a typed progress callback; keep StageTracker semantics ("Assembling all N" starts PREPARE, combine starts at first `Chapter N`, `Assemble completed!` closes combine) | — | `tools/test-assembly-prepare-progress.js` (asserts the format strings against narrator SOURCE — must be repointed) |
| final name `get_sanitized("<title>. <author>. (<year>).m4b")`, VTT `<stem>.vtt` beside | TS | `test_assemble_synthetic.py` | bridges glob `*.m4b` in staging |
| prep stdout JSON (indent 2, `default=str`) | gone — bridge already reads `session-state.json` from disk after prep (`parallel-tts-bridge.ts` ~4670) | `test_compat_prep.py` | — |
| normalize_gaps output: same-named files, non-audio files copied verbatim (that is how `gaps.json` travels into derived sets) | TS | none in python/narrator/tests — **write one** | derived-set identity params in `sentence-gap.ts` |
| write_m4b_tags stdin/stdout protocol | disappears (in-process call) | none — **write one** | `metadata-tools.ts` |

### Numeric behaviour (the places a naive TS port silently differs)

1. **Python `round()` is round-half-EVEN**; `Math.round` is half-up. Used in `gap_frames`, `fade_samples`,
   chapter ms (`int(round(s*1000))`), session_v1/encode ms. Write one `roundHalfEven()` and use it everywhere.
2. **`{s:06.3f}` vs `toFixed(3)`**: Python rounds the exact binary value half-even; `toFixed` picks the LARGER on
   an exact tie. Ties are real here: timestamps are `samples/24000`, e.g. 25,500 samples = 1.0625 s exactly →
   Python `01.062`, JS `01.063`. Port `format_timestamp` with exact decimal rounding (e.g. scale with BigInt or
   check the tie explicitly). Also preserve the quirk that 59.9996 formats as `60.000`.
3. **Running float sums** (`vtt.chunk_spans`): IEEE doubles are identical in JS if the ORDER of additions is
   identical — port the loop literally (no reduce-then-add reordering, no precomputed totals).
4. **`np.mean` uses pairwise summation** (blocks of 8 unrolled, 128-element leaves). `detect_silences`
   thresholds `20*log10(rms) < noise_db`; a naive JS sum can flip a frame at the threshold. Port numpy's pairwise
   algorithm for that one reduction, or prove with vectors that it never flips on real chunks.
5. **`np.cos` vs `Math.cos`**: last-ulp differences are possible (V8 fdlibm vs numpy/libm SIMD). After
   requantization to PCM16/24 they almost never change a sample, but "almost" must be measured: compare faded
   chunk PCM sample-by-sample on every chunk of a Higgs golden. Tolerance to declare: 0 differing samples
   expected; ≤1 LSB on any sample is the ruling to ask for if not.
6. **libsndfile float↔int scaling**: `sf.read(dtype=float64)` and `sf.write(subtype=PCM_x)` define the
   requantization (normalization factor and lrint/clipping). `write_normalized_chunk` is asserted
   sample-identical in Python, so the TS port should avoid the float round-trip entirely for untouched samples
   (work in integers; only the fade windows multiply) and reproduce libsndfile's rounding for the faded
   samples. MEASURE against Python output — this is the one place the "faithful" port must be proven, not read.
7. **String length**: Python `len()` counts code points; JS `.length` counts UTF-16 units. Every cap/floor
   (`maxChars`, `safeMinChars`, clause split, `ellipsize_utf8_bytes` works on UTF-8 bytes) must use code-point
   length (`[...s].length`) or byte length as the Python does.
8. **Case/whitespace semantics**: `str.isupper/islower/isalnum/isdigit`, `str.split()` (Python's whitespace set
   includes `\x1c-\x1f`, `\x85`), `\w`/`\s`/`\b` under `regex` are Unicode-aware; JS `\w` and `\b` are ASCII
   even with `u`. Write explicit `\p{...}` classes. `unicodedata.name()` (foreign2latin's script detection)
   has no JS equivalent → `\p{Script=...}` approximation must be vector-checked.
9. **Python json formatting** (for byte-identical diffs, and for any interim Python reader): floats keep `.0`
   (`0.0`, `2.0`), exponent form `1e-05`; `ensure_ascii` default True escapes non-ASCII as `\uXXXX`
   (`gaps.json`, `coverage.json`); separators `", "`/`": "` with indent 2. Recommend a `pyJsonDumps()` helper so
   every ported writer emits the bytes the Python did — then parity is `diff`, and a still-Python reader during
   the transition never sees `2` where it type-checked a float.
10. **Durations from ffprobe** parsed from text in Python (`int(raw)/1_000_000.0` in encode.py ~973) — keep the
    integer-microsecond parse, do not parseFloat a seconds string.

### Text-rule outputs (one fact, one owner)
- `caps_acronyms.json`: keep-set = `lettered ∪ spokenAsWord`; three readers. `tools/test-one-fact-one-owner.js`
  computes both keep-sets, pins the derivation expression in `paragraph_packer.py` by SOURCE scan, refuses a
  second hard-coded set in `shared/listen-text/normalize.ts`, and folds fixtures through BOTH implementations
  when Python is found. After the port the Python half of that test becomes "the ported packer and Listen fold
  call the SAME TS function" (ideally Listen imports the ported `foldCapsRun`, and the fixture fold vectors
  captured from Python become the golden).
- Sentence abbreviations: `shared/text/sentence-abbreviations.ts` mirrors `lang.py` (`tools/test-sentence-abbreviations.js`) → one owner.
- Coverage policy: `shared/queue/coverage-policy.ts` mirrors `engine_profiles.py` (`tools/test-coverage-policy-mirror.js`) → one owner.
- Chapter gap: `shared/audio/chapter-gap.ts` already owns the default (3 s); align and assemble must keep taking the SAME resolved value.

### Golden fixtures — state today
- Committed text goldens exist: `python/narrator/tests/golden/{kershaw,blacksun,mutineer}/` (session-state,
  provenance, `metadata.txt`, `reference.vtt`, `reference-m4b.json`, `sentences.json` with per-FLAC sha256).
  **All three are Orpheus/e2a-era sessions** (pads=True, no gaps.json, no edge fades, no coverage.json).
- **`C:\tmp\narrator-golden` does NOT exist** on this machine (the 4.6 GB binary copies). It is rebuildable on
  CPU: `python -m narrator.tests.golden_tools.build_fixture` (+ `make_index.py`) from the source projects on
  `Z:` (Z: is mounted). `test_assemble_golden.py` and the binary half of `test_golden_fixtures.py` SKIP without it.
- There is NO Higgs golden. The live path (pads=False, 10/25 ms fades, gaps.json, chapter gap, coverage gate,
  measured sentence VTT from a Crucible `alignment.json`) is only covered by synthetic tests
  (`test_assemble_edges.py` 752, `test_assemble_chapter_gap.py` 403, `test_assemble_synthetic.py` 685,
  `test_align.py` 2941).

---

## 4. Parity strategy

**Principle: the Python is the oracle until the TS is proven, then the oracle's outputs are frozen as fixtures
and the Python is deleted.** Nothing is "unchanged" without numbers (REORG-PLAN rule).

1. **Rebuild and extend the goldens (CPU only, read-only on Z:).**
   - Rebuild `C:\tmp\narrator-golden` for kershaw/blacksun/mutineer with `build_fixture`.
   - Add 2-3 **Higgs** goldens from recent library books rendered through Crucible: a short one, a long one
     (>2 h, parallel path), one with `sentences-denoised`/`rvc` derived set and pre-encoded `parallel_encode/`,
     each with its `gaps.json`, `coverage.json`, Crucible `alignment.json` (if kept on disk — check
     `artifacts-owed.ts`/render-artifacts for where it lands) and the EPUB. Copy to `C:\tmp\narrator-golden\<slug>`
     (never write into Z:).
2. **Oracle vector dump** (a Python script on the port branch, run with the current tools env): for each golden
   and for the full library's EPUBs where available, write JSON vectors:
   - text core: `spoken`, `split_sentences`, `fold_caps_run`, `strip_unspoken_glyphs`, `cue_text`,
     `normalize_text`, `foreign2latin`, `classify_gap_seconds` over every chunk/paragraph string;
   - prep: the whole `session-state.json`, `chapter-provenance.json`, `chapters.json`, `gaps.json` per EPUB
     (mask `created_at`/timestamps and the random session uuid by passing a fixed `--session`);
   - session_v1: the built manifest per golden and per sentences-dir variant;
   - numerics: `format_timestamp` on every chunk boundary and on synthetic ties (samples = 1500·k etc.),
     `gap_frames`/`fade_samples` on a grid incl. .5 ties, `detect_silences` on every chunk of a Higgs golden,
     faded-chunk PCM (as sha256 of s16le/s32le) per chunk;
   - align: `coverage.json` + `.sentences.vtt` from `--alignment` per Higgs golden.
   Commit the text vectors (small) under e.g. `test-fixtures/narrator/`; keep audio hashes, not audio.
3. **Run both on the same inputs and diff:**
   - **audio**: per-chunk decoded PCM sha256 of every work-dir file (faded / normalized / gap), chapter
     `.m4a` decoded PCM sha256 and packet md5 (`ffmpeg -map 0:a -c copy -f md5 -`), final m4b audio packet
     md5 and sample count; total samples vs manifest sum. Encoded AAC should be bit-identical given identical
     PCM and the same ffmpeg binary and argv (native aac encoder is deterministic) — confirm once, then hold it.
   - **container**: `ffprobe -show_format -show_chapters -show_streams` JSON diff (mask none expected),
     extracted `covr` bytes sha256, tag set. Whole-file sha256 will differ only if the tag writer lays atoms out
     differently from mutagen — measure; if it differs, state it (atom layout) and compare the parsed atoms.
   - **text**: VTT and sentence VTT byte diff (both LF, so byte-level is achievable now, unlike e2a);
     `metadata.txt` byte diff; JSON files byte diff via `pyJsonDumps`.
   - **refusals**: every named refusal in the Python tests (missing gaps.json, padded+gaps, inhomogeneous rate,
     pre-encoded chapter off by >0.06 s, transcript >5 s early/late, contiguity, bilingual) has a TS test with
     the same trigger; message text need not be byte-equal but the name/condition must.
4. **Port the unittest suites, not just the goldens.** The ~13k lines of in-scope tests (manifest, session_v1,
   session_store, assemble_*, vtt, align, compat_prep, text_*) are the behavioural spec; port each to node
   (`node:test`, matching the repo's `tools/test-*.js` style) alongside its module. Tests needing real ffmpeg
   stay real-ffmpeg.
5. **In-app checkpoints** after each swap (Owen tests in-app first): reassemble a golden in the app, open in the
   Bookshelf player, check chapter seek + transcript sync.

**Nondeterminism to mask or pin:**
- `created_at`/`updated_at` (`datetime.now`) in session-state; session uuid (pass fixed); `mkdtemp` work-dir
  names in logs; `[assembly] Working directory:` line.
- Parallel-encode completion ORDER and progress interleaving (outputs per chapter are deterministic; the
  concat list is in chapter order).
- Python set/frozenset iteration order anywhere it reaches output (check `paragraph_packer`, `lang` tables —
  set iteration of strings is hash-randomized per process unless PYTHONHASHSEED is fixed; if any output depends
  on it, the Python itself is nondeterministic and the vectors must be produced with a fixed seed and the TS
  must choose an explicit order).
- ffmpeg version: pin the same binary for both sides of a parity run (`getFfmpegPath()`); AAC/FLAC encoder
  bytes change across ffmpeg versions.
- Cover JPEG re-encode (PIL q75 vs a JS encoder): bytes differ by construction → needs a ruling (see §6).
- loudnorm single-pass on the serial path is deterministic but version-sensitive — same pin.

---

## 5. Proposed TS layout and order

```
electron/narrator/
  index.ts                 the public functions the bridges call (prepSession, assemble, alignFromCrucible,
                           checkResume, listSessions, normalizeGaps, writeM4bTags)
  py-compat.ts             roundHalfEven, formatFixedHalfEven, pyJsonDumps, codepointLength, pyWhitespace,
                           pairwiseSum   (the §3 numerics, one place, heavily vector-tested)
  manifest.ts              (manifest.py)
  session/flac-header.ts   (render/flac_header.py; absorb electron/flac-duration.ts or have it delegate)
  session/store.ts         (render/session_store.py)
  session/session-v1.ts    (render/session_v1.py)
  assemble/engine-profiles.ts  (+ becomes the owner shared/queue/coverage-policy.ts reads)
  assemble/ffmpeg.ts       (ffmpeg_tools.py)
  assemble/edges.ts        assemble/chapters.ts   assemble/encode.ts   assemble/mp4-tags.ts (mutagen half)
  assemble/coverage-gate.ts  assemble/vtt.ts  assemble/sentence-vtt.ts  assemble/run.ts
  align/types.ts (aligner dataclasses + alignment_from_dict)  align/precomputed.ts (items→words, scores,
  spans, align_chunk precomputed arm, decode_audio, detect_silences)  align/coverage.ts  align/sentences.ts
  align/run.ts (align_session over a Crucible document)
  text/sml.ts  text/gaps.ts  text/lang.ts (+ lang.json generated)  text/normalize.ts  text/core.ts
  (spoken/split_sentences/fold_caps/strip glyphs — imported by shared/listen-text too, or moved to shared/)
  text/epub.ts  text/chapters.ts  text/paragraph-packer.ts  text/prep.ts
  gaps/normalize-gaps.ts   (electron/scripts/normalize_gaps.py)
shared/text/caps_acronyms.json   (moved from python/narrator/text/)
```
Anything the renderer (Listen) also needs (text core, acronyms) goes under `shared/` with relative imports
(no `@shared/*` at runtime — memory note).

**Order (smallest risk first; each step deletes a spawn):**

| step | port | deletes | checkpoint |
|---|---|---|---|
| 0 | goldens rebuilt + Higgs goldens + oracle vector dump; `py-compat.ts` with its vector tests | — | vectors committed; TS numerics green on all ties |
| 1 | `write_m4b_tags.py` → `assemble/mp4-tags.ts` (in-place). Self-contained, no narrator coupling, measurable on any m4b | `metadata-tools.ts` spawn, `write_m4b_tags.py` | edit metadata/cover on a library m4b in-app; ffprobe + covr diff vs mutagen on copies; timing on a 500 MB file |
| 2 | `manifest`, `flac_header`, `session_store`, `session_v1` (leaves) | `resume` + `list` phases (`checkResumeStatus`, `listResumableSessions`) | resume check in-app; manifest JSON byte-equal to Python's for every golden |
| 3 | `normalize_gaps.py` → `gaps/normalize-gaps.ts` | the rvc-env python dependency of the gap pass | PCM-identical output dir on an Orpheus session; non-audio files copied |
| 4 | text core (`sml`, `gaps`, `spoken`, `split_sentences`, `fold_caps`, `strip_unspoken_glyphs`) + move `caps_acronyms.json`; Listen imports the same functions | one-fact-one-owner Python half | `test-one-fact-one-owner.js` repointed and green; vectors equal |
| 5 | `assemble/*` (engine_profiles, ffmpeg, edges, chapters, encode, coverage_gate, vtt, sentence_vtt, run) | `assembly` phase in BOTH bridges + the import probe (`reassembly-bridge.ts:3155-3210`) + tools-env `narrator.assemble` requirement | 3 Orpheus + Higgs goldens: audio packet md5, ffprobe, VTT bytes, metadata.txt bytes; Owen reassembles a book in-app (both serial ≤2 h and parallel >2 h) |
| 6 | `align` Crucible half (`--alignment`) | `align` phase for Crucible-routed rows | coverage.json + sentences.vtt byte-equal on Higgs goldens; local qwen3 arm either waits for C2 or is deleted once every align row is Crucible (`crucible/align.ts`) |
| 7 | prep (`lang`, `normalize`, `epub`, `chapters`, `paragraph_packer` packing, `prep`) — needs **B1** (budget from `/v1/voices`) | `prep` phase, tools env for narrator entirely | session-state/provenance/gaps.json equal for every Higgs book in the library (re-prep to scratch, never Z:); Owen narrates a book end to end |
| 8 | remove `python/narrator` (after Crucible C1 owns engine/serve), `electron/scripts/*.py`, narrator-spawn phases, tools-env narrator bootstrap, Python test suites (their vectors now live in TS fixtures) | — | `grep -r narrator.compat` empty; app builds with no Python env |

Assembly works end-to-end after every step because each step swaps one door and the others still spawn the
Python (they communicate only through files on disk, which is why §3's byte-level JSON matters during the
transition: e.g. TS-written `coverage.json` (step 6) read by Python assembly would happen only if step 6 lands
before step 5 — keep 5 before 6).

---

## 6. Risks, and what NOT to port

**Do not port (dead or leaving):**
- `render/worker.py`, `render/retake.py`, `compat/worker.py`, `compat/app.route_worker`, `compat/flags.py`
  engine factory, `cli.py` `render/retake/serve` — no spawn site; local render venue deleted (LEGACY-REMOVAL).
  Their tests (`test_render_worker.py` 1216, `test_render_retake.py` 291) go with them.
- `text/packer.py` (e2a char-window packer, difflib) — Orpheus-only prep policy; Higgs refuses it. Confirm no
  Orpheus PREP can still be requested (render doors refuse `orpheus`), then drop it and `test_text_packer.py`
  (782). Its golden prep parity (`test_text_prep_golden.py`, Orpheus sessions) is therefore not a port target
  either — the Higgs paragraph path needs new prep goldens (§4).
- `align/{env,worker,window}.py` and the whisperx/qwen3 model half of `aligner.py`/`run.py` → Crucible (C2).
- `env.py` (top level) — only engine/serve use it.
- `orpheus_download.py`, `orpheus_fuse.py`, `whisper_download.py`, `transcribe_audiobook.py`,
  `separator_worker.py`, `run_audio_separator.py`, `align_audiobook.py` → delete / Crucible.
- Packaging-only tests: `test_declared_dependencies.py`, `test_package_data.py`, `test_engine_lazy_imports.py`.
- e2a compat spellings (underscore flags, `xtts` mentions) — the TS API takes typed options.

**Keep even though "Orpheus":** the `orpheus` row of `engine_profiles` (pads=True) and the padded assembly path,
the inhomogeneity rewrite, and `normalize_gaps` — existing Orpheus sessions on disk are still REASSEMBLED
(the three goldens are Orpheus). DECIDED 2026-11-05 (lead): `normalize_gaps` is not ported and stays working in Python until step 8; see the entry for Owen in docs/REORG-PLAN.md, and re-read it before step 8, because he can overrule it. If Orpheus reassembly goes,
the padded path + normalize_gaps + Orpheus goldens can go too (big simplification).

**Risks:**
1. **m4b tag writer** — no drop-in mutagen equivalent in npm; an ffmpeg remux is a regression (speed, full
   rewrite on the NAS). Biggest unknown in the CPU set; do it first (step 1) so it is measured early.
2. **libsndfile requantization + fade arithmetic** (§3.5-3.6) — the only place PCM is computed, not copied.
3. **HTML parsing parity** (bs4 `html.parser` vs parse5/htmlparser2) and **regex semantics** for prep —
   thousands of lines of judgment rules; chunk boundaries move silently. Mitigation: whole-library vector diff,
   prep last.
4. **Rounding/formatting ties** (§3.1-3.2) — produce wrong-by-1 ms timestamps/markers that nothing flags.
5. **Cover JPEG** — PIL re-encode cannot be reproduced byte-for-byte; needs Owen's ruling (accept pixel-close,
   or pass JPEG bytes through unchanged when the EPUB cover is already JPEG — a behaviour change).
6. **Non-Latin romanization** (`unicodedata.name`, unidecode tables, pypinyin/pykakasi/phonemizer if installed)
   — measure what is installed and how often non-Latin tokens occur in the library.
7. **Cross-repo fact**: engine edge/pad table and the Higgs prep budget move with Crucible's Higgs (C1, B1) —
   steps 5 and 7 must coordinate with crucible pc 1.
8. **Interim mixed writers**: during the transition TS and Python write/read the same session files; use
   `pyJsonDumps` and keep the step order (5 before 6).
9. **Progress protocol**: `reassembly-bridge.ts`/`parallel-tts-bridge.ts` parse stdout substrings; replacing the
   child with an in-process call must keep the stage machine (`shared/queue/assembly-prepare.ts`, StageTracker)
   — and `tools/test-assembly-prepare-progress.js` reads narrator's Python SOURCE today.
10. **Main-thread load**: assembly in the Electron main process — PCM work (fades on every chunk of a 1400-chunk
    book) and JSON of 600 KB states must not block the UI (memory: "bookshelf server blocks desktop UI"). Run
    the PCM loop in a `worker_thread` or keep ffmpeg doing the heavy lifting; ffmpeg encodes are already child
    processes.
11. **cli/*.py and tools/*.py** are also Python in BookForge and are not covered by B6 — needs a ruling.
12. `list` phase looks unused — verify and delete rather than port.
