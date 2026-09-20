# narrator — build contracts (read before writing a line)

The design is `docs/NARRATOR_PLAN.md` in this worktree. This file is the working
contract between the builders in this phase. Where the plan and this file disagree,
this file wins; where this file is silent, the plan wins.

## Ground rules (apply to every builder)

- Worktree: `C:\Users\<user>\Projects\bookforge\.claude\worktrees\narrator` (branch
  `feat/narrator`). Work ONLY here. Do not touch the main checkout, do not commit, do
  not push. The orchestrator reviews and commits.
- `C:\Users\<user>\Projects\ebook2audiobook` (branch `bookforge`, HEAD `9daab0ba`) is
  READ-ONLY source material. Never edit it, never run anything that writes into it.
  Note the commit you ported from in every ported module's docstring
  (`Ported from ebook2audiobook@9daab0ba lib/core.py:combine_audio_chapters`).
- Python 3.11 compatible (the WSL env is 3.11; the Windows env is 3.12). Pure
  stdlib + numpy + soundfile for everything outside `engine/`. No new third-party
  dependencies without writing WHY in the module docstring.
- Windows interpreter for tests: `C:\Users\<user>\Projects\ebook2audiobook\python_env\python.exe`
  (3.12, numpy 1.26.4, soundfile 0.13.1, NO pytest). WSL interpreter:
  `/home/<user>/anaconda3/envs/orpheus_tts/bin/python` (3.11, has pytest — do not
  rely on it). Tests are `unittest` modules under `python/narrator/tests/`, run with
  `python -m unittest discover -s python/narrator/tests -t python` from the worktree root.
  Every test must pass under the Windows interpreter before you report.
- ffmpeg/ffprobe: `C:\ProgramData\chocolatey\bin\ffmpeg.exe` on Windows (on PATH).
  Resolve the binary from an explicit argument or `shutil.which`; never hardcode.
- NO FALLBACKS. A missing file, a missing key, a malformed FLAC, a chunk without a
  sample count: raise with a message naming the path. Never `dict.get(k, default)`
  for a required key. Never substitute silence for a missing sentence.
- Never redirect to `NUL` in shell commands (creates a real file on Git Bash). Never
  create files named NUL/CON/PRN/AUX/COM1-9/LPT1-9.
- ASCII only in anything that reaches a console or a log line (em-dashes render as
  `?` on the Windows console).
- Scratch: `C:\tmp\narrator-<yourname>\` for anything transient; delete what you create
  when you are done. Golden copies live in `C:\tmp\narrator-golden\` (owned by the
  golden builder; read-only for everyone else).
- The library is on `Z:\<library>` (a network drive: slow, and invisible to WSL).
  Read from it; never write into a project directory there.
- No GPU work unless your brief explicitly allows it and states the guard.
- Final report: every file created/changed, what was run and its exact result, what
  could NOT be run and why, and every place you had to guess.

## Package layout and ownership (this phase)

```
python/
  pyproject.toml                    A
  narrator/
    __init__.py                     A   (version string, nothing else)
    CONTRACTS.md                    orchestrator
    manifest.py                     A
    render/__init__.py              A
    render/session_v1.py            A   (e2a session dir -> Manifest)
    assemble/**                     A
    engine/**                       E
    serve/**                        E
    cli.py                          A   (subcommands: assemble, manifest; E adds serve later)
    tests/test_manifest*.py         A
    tests/test_assemble*.py         A
    tests/test_engine_*.py          E   (ports of e2a tools/test_*.py)
    tests/golden/**                 G   (fixtures, small text/JSON only)
    tests/golden_tools/**           G   (fixture builder + parity scripts)
```

Do not create files outside your column. If you need something from another
builder's column, write the smallest stub you need under YOUR column and say so in
your report; the orchestrator reconciles.

## The e2a session layout v1 (measured 2026-09-04 on a real session)

```
<project>/stages/03-tts/sessions/<lang>/ebook-<uuid>/<epub_content_hash>/   = process_dir
  session-state.json          e2a state, version 2 (keys below)
  session_state.json          BookForge's OWN sidecar (runs, rates, settings) - not ours
  chapter-provenance.json     {chapter_docs:[...], ...}
  staged-<uuid>.epub          the EPUB that was rendered
  cover.jpg                   present when session-state.cover is true
  metadata.txt                ;FFMETADATA1 with [CHAPTER] blocks in ms (written by assembly)
  concat_list_sentences.txt   ffmpeg concat list (written by assembly)
  concat_list_encoded.txt     ffmpeg concat list of parallel_encode/*.m4a (written by assembly
                              when --encoded_chapters_dir was used)
  parallel_encode/NNNNN.m4a   per-chapter AAC, when present
  chapters/N.flac             per-chapter concatenated FLAC (1-based), written by assembly
  chapters/sentences/N.flac   THE rendered chunks, 0-based, contiguous 0..total_sentences-1
  chapters/sentences-denoised/N.flac       post-render filtered copies (de-ring), optional
  chapters/sentences-rvc-<voice>/N.flac    RVC-enhanced copies, optional
```

`session-state.json` (version 2) keys that matter: `session_id`, `epub_content_hash`,
`total_sentences`, `total_chapters`, `chapters: [{chapter_num (1-based),
sentence_count, raw_sentence_count, sentence_start, sentence_end}]` (global 0-based
inclusive indices), `chapter_sentences: [[text, ...] per chapter]` with the literal
`[heading]`/`[break]`/`[item]` markers as stored, `language` (3-letter),
`language_iso1`, `fine_tuned`, `orpheus_model_dir`, `orpheus_adapter_dir`,
`orpheus_base_dir`, `tts_engine`, `output_format`, `metadata: {title, creator,
language, published}`, `bookforge_metadata: {title, author, year}`, `cover: bool`,
`final_name`, `chapter_titles: [str]`, `chapter_docs: [str]`, `chapter_titles_by_doc`.
`chapter_sentences` HAS ONE WRITER AND ONE CORRECTOR. Prep writes the file, once
(`text/prep.py` -> `render/session_store.save_session_state`), and nothing on the
render path rewrites it. The single exception is a committed sentence correction:
`electron/correct-sentences-bridge.ts:commitSentence` replaces the ONE chunk whose
audio it just swapped, with the same string it handed the worker as
`--sentence_overrides` (the row's own leading/trailing SML marker runs, restored
around the corrected words). The pre-correction row is kept beside the
pre-correction audio at `chapters/sentences/.orig-backup/<i>.txt`, so `revert`
undoes the text and the audio together. Nothing else may edit this key - a chunk's
text and its FLAC are one fact, and the two writers of that fact are prep and a
commit.

Paths inside it (`session_dir`, `process_dir`, `chapters_dir`, ...) are from whichever
machine wrote them (WSL or Windows) and are NOT trusted: the reader takes the
directory it was given and derives everything from it, exactly as e2a's
`assemble_audiobook` does ("Always derive directories from corrected process_dir").

Assembly inputs the reassembly bridge passes today: `--session`, `--session_dir`,
`--sentences_dir` (may point at `sentences-denoised` or `sentences-rvc-<voice>`),
`--encoded_chapters_dir` (optional), `--output_dir`, `--output_format`. The
bridge's expectations of what lands where are in
`electron/reassembly-bridge.ts` (main checkout, read-only) - read the spawn site
and the post-run promotion before deciding output filenames.

## The render manifest (schema v1) - `manifest.py` owns this

One JSON document. Prep (later) writes it; everything else reads it. For this phase
it is BUILT from an e2a session dir by `render/session_v1.py`.

```json
{
  "version": 1,
  "source": {"kind": "e2a-session-v1", "processDir": "<abs>", "sessionId": "<uuid>",
             "epubContentHash": "<md5>"},
  "book": {"epubPath": "<abs or null>", "title": "...", "author": "...",
           "year": "<str or null>", "language": "en", "language3": "eng",
           "cover": "<abs path or null>"},
  "voice": {"engine": "orpheus", "fineTuned": "deathstalker",
            "modelDir": "<str or null>", "adapterDir": null, "baseDir": null},
  "sampleRate": 24000,
  "sentencesDir": "<abs>",
  "chapters": [
    {"index": 1, "title": "INTO THE FIELD OF FIRE", "doc": "text/c0001.xhtml",
     "chunks": [
       {"index": 0, "text": "[heading]INTO THE FIELD OF FIRE.", "kind": "heading",
        "gapBefore": 0.0, "gapAfter": 0.0,
        "file": "chapters/sentences/0.flac", "samples": 123456, "take": 1}
     ]}
  ]
}
```

- `chunks[].index` is the GLOBAL 0-based sentence index (== FLAC stem). Chapters are
  contiguous and cover 0..N-1 with no holes; the builder verifies that.
- `text` is the chunk text exactly as stored in `chapter_sentences` (markers kept).
  `kind`: `[heading]` ANYWHERE in the text -> heading (e2a `vtt_cue_text` uses
  `SML_HEADING_PATTERN.search`, conf_models.py:146 - e.g. `[break][heading]Book Two.`),
  else `[item]` -> item, else prose. Do NOT strip markers in the manifest; consumers (VTT, prompt) do that.
- `file` is relative to `source.processDir` (absolute in the manifest) - NEVER to the
  manifest file's own location, so a manifest saved anywhere still resolves the same
  audio; `save()` rewrites nothing (review finding F1, 2026-09-04); `samples` is the FLAC's
  STREAMINFO total-samples (exact; read the header bytes, never decode, never
  ffprobe). `samples` is null only for a chunk not rendered yet.
- `gapBefore`/`gapAfter` are seconds of silence the ASSEMBLER inserts around the
  chunk. Builder A must discover how e2a realizes gaps today (in
  `combine_audio_sentences` / `combine_audio_chapters` / the sentence writer) and
  encode that rule here so that assembly from the manifest reproduces e2a's timing.
  Write the discovered rule down in `assemble/README.md`.
- `manifest.py` exposes: dataclasses (`Manifest`, `Chapter`, `Chunk`), `load(path)`,
  `save(manifest, path)`, `validate(manifest)` (raises), `flat_chunks(manifest)`.
  Validation is strict: version, contiguity, kinds, non-negative gaps, samples int
  or null, unique files.

## The VTT (contract 5 of the plan) - CORRECTED 2026-09-04 by measurement

Reproduce e2a `build_vtt_file` (core.py ~5763) byte-for-byte. MEASURED at 9daab0ba: the
file has NO cue identifiers and NO `NOTE` blocks of any kind (grep "NOTE " across
e2a lib/ and bookforge_ext/ returns nothing); the plan's "NOTE heading / NOTE
asr-fallback" description was wrong and is withdrawn. Cue text rule as in e2a
`tools/test_vtt_bold_headings.py`. Times come from the manifest's running sum of
`samples` + realized gaps. Parity target against e2a's own VTT for the same session
and the same sentences dir: identical cue count, text and timestamps. Line endings:
narrator writes LF on every platform (e2a on Windows writes CRLF via text-mode open,
session.py:932) - a declared deviation; parity is cue-level, not byte-level.

**Output naming (corrected):** e2a does NOT write session-state's `final_name`
(`staged-<uuid>.m4b`). `assemble_audiobook` recomputes the name from metadata every
run (bookforge_ext/parallel/session.py ~1119-1132): `get_sanitized("<title>. <author>.
(<year>).m4b")` and the VTT beside it as `<same stem>.vtt`; the bridge passes no
`--output_filename` and ALWAYS passes `--no_split`. A whole-book assembly is the only
shape narrator produces; e2a's output_split path (every part overwriting
`final_name`, core.py:4738) is an unexercised path and must not be ported.

## Golden fixtures (G owns) - format every builder reads

`python/narrator/tests/golden/<slug>/` (committed, text only, < 2 MB per book):

```
README.md                 book, source project dir on Z:, e2a commit, how produced, sizes
session-state.json        verbatim copy
chapter-provenance.json   verbatim copy
metadata.txt              e2a's ;FFMETADATA1 as written by e2a's assembly (if present)
sentences.json            [{"index":0,"file":"chapters/sentences/0.flac","samples":N,
                            "sampleRate":24000,"channels":1,"bytes":N,"sha256":"..."}]
                          for EVERY rendered chunk, from the FLAC STREAMINFO header
reference.vtt             e2a's VTT for this session (the one beside the m4b)
reference-m4b.json        ffprobe -show_format -show_chapters -show_streams of e2a's
                          m4b, as JSON, plus "sha256" of the file and "bytes"
```

Local binary copies (NOT committed): `C:\tmp\narrator-golden\<slug>\` holding the
whole process_dir (sentences, denoised/rvc dirs if present, cover, epub) and
`reference.m4b` + `reference.vtt`. `C:\tmp\narrator-golden\index.json` maps slug ->
{localProcessDir, referenceM4b, referenceVtt, sourceProcessDir}. Tests that need the
binaries read `NARRATOR_GOLDEN_LOCAL` (default `C:\tmp\narrator-golden`) and SKIP
with a clear message when the directory is absent - that is the one permitted
"missing input" behaviour, and only in tests.

Golden slugs for this phase (chosen 2026-09-04 from `Z:\<library>\projects`):

| slug | project dir | chunks | why |
|---|---|---|---|
| `kershaw` | `Working_Towards_The_Fuhrer_-_Ian_Kershaw_(1993)` (session `ebook-ccd14111-...`, 133 chunks, 2026-09-03) | short | fast iteration; latest packer |
| `blacksun` | `Black_Sun_-_Aryan_Cults,_Esoteric_Nazism,_and_the_Politics_of_Identity_-_Nicholas_Goodrick-Clarke_(2009)` (512 chunks, 2026-08-31) | medium | headings-heavy non-fiction |
| `mutineer` | `Mutineer_s_Moon_-_David_Weber_(2020)` (session `ebook-88c038b1-...`, 1400 chunks, 2026-09-04) | long | `sentences-denoised` + `parallel_encode` present; the 8-minute assembly benchmark |

Reference m4b/vtt = the newest `<title>. <author>. (<year>).m4b` + `.m4b.vtt` in the
project's `output/` (or `archive/`) whose mtime matches the session. If a book has
NO matching reference VTT, produce one by running e2a's own assembly on a LOCAL
COPY (never on Z:): e2a `app.py --headless --assemble_only --tts_engine xtts
--session <uuid> --session_dir <copy of ebook-<uuid>> --output_dir <scratch>`
with `python_env\python.exe` from the e2a checkout - that runs on CPU. Record the
exact command in the README.

## The per-item take channel (`serve/worker.py` + `engine/item_sampling.py`)

Added 2026-09-14 for Crucible's take ladder, completed 2026-09-15. Owen's
ruling of the first day (`docs/EXTENSION-TO-CRUCIBLE-PLAN.md` section 2): *a
retake must not reuse the settings that produced the problem; the spread IS the
take ladder.* The ladder itself is Crucible's (`crucible/docs/PHASE3-TTS.md`
section 3, `[[voice.takes]]` per voice, take 0 = the boson default 0.8 / 0.95 /
50); a job carries `take: N` and the server resolves the rung. narrator had
nowhere to put it - its sampling arrived through the `NARRATOR_HIGGS_VOICES`
document, written per LOAD - so Crucible refused every rung above 0 by name
(`sampling_not_wired`). This is the channel that lifts it.

**A RUNG IS TWO FACTS: (sampling deltas, seed offset).** The numbers landed on
2026-09-14 and were half a rung. narrator seeds chunk i at `config.seed + i` on
both Higgs arms (`_seed_for`) and the ladder never varied it, so take 0 and take
N of one chunk were BYTE-IDENTICAL renders whenever their sampling matched - and
two take-0 re-rolls always were, because take 0's rung is by definition the
voice's own numbers. Owen, 2026-09-14: *"if a sentence/chunk was problematic
before, it'll likely be problematic again with the same settings"*. A seed is a
setting. So the item carries `take` beside `sampling`, and the two are
INDEPENDENT: a rung that declares no sampling override is still a different
draw, because the lane moved.

**The fields.** `sampling` and `take` on ONE ITEM of `generate_batch`, and on
`generate`:

```json
{"action": "generate_batch",
 "items": [{"i": 412, "text": "...", "take": 1,
            "sampling": {"temperature": 0.7}}]}
```

Keys: `temperature`, `topP`, `topK`, `repetitionPenalty` - **exactly the voices
document's spelling** (`engine/higgs/config.py:_SAMPLING_KEYS`), pinned equal to
`engine/item_sampling.py:WIRE_KEYS` by `tests/test_serve_sampling.py`. A second
spelling would be two names for one fact.

**Its meaning.**

- ABSENT -> the voice's loaded sampling, which IS take 0. That is the
  documented meaning of "no rung", not a default substituted for a missing
  value.
- PRESENT -> that item renders under those numbers, laid **OVER** take 0 key by
  key (`engine/item_sampling.py:apply_over`). An overlay and not a replacement
  because PHASE3-TTS's take 1 is one line, `temperature = 0.7`, and a rung that
  replaced the voice's sampling would send no `top_k` - which on SGLang-Omni is
  the untruncated 1026-way codebook tail, measured 2026-09-05 as one chunk
  running to the cap with 80 s of silence.
- A BATCH MAY MIX RUNGS. Every engine either renders row by row (free) or
  splits its slab by sampling group: the MLX arm's `_step_batch_sampler` takes
  ONE temperature for every active row, so `_mlx_batch_groups` breaks a group
  when the rung changes. **No path renders a row at another row's numbers.**
- The rung is keyed by CHUNK INDEX through the guarded driver
  (`render_many(..., sampling_by_index=, take_by_index=)`), because a re-roll
  and both halves of a split carry their parent's index and must render at
  their parent's numbers and in their parent's lane. A chunk a map does not
  name is refused, never rendered at take 0.

**`take`'s meaning.** A whole number `>= 0`, ABSENT = 0, at most
`item_sampling.MAX_TAKE` (999). It moves the render's SEED into that take's own
lane and changes nothing else:

```
seed = base + index + REROLL_SEED_STRIDE * (TAKE_REROLL_LANES * take + attempt)
```

`in_take_lane` contributes `TAKE_SEED_STRIDE * take` and `reroll_seed`
contributes `REROLL_SEED_STRIDE * attempt`, and `TAKE_SEED_STRIDE` IS
`REROLL_SEED_STRIDE * TAKE_REROLL_LANES` (100,003 x 16 = 1,600,048) precisely so
the two add into one multiple of `REROLL_SEED_STRIDE`. With `attempt <
TAKE_REROLL_LANES` and `index < REROLL_SEED_STRIDE` - the bound the re-roll
stride already assumes, ~50x the longest book rendered - the map
`(take, attempt, index) -> seed` is INJECTIVE: **no take's draw is any other
take's draw, and no take's draw is any re-roll's.** `take = 0, attempt = 0` is
`base + index`, the rule this engine has always had, which is what makes the
channel additive. All of it lives in `engine/higgs/truncation.py`; the lane is
applied in ONE place per arm (`_request_seed`), to whatever seed the ladder
chose, so take N's whole ladder - its take 0, its re-roll, both halves of a
split - rides inside take N's lane. `MAX_TAKE` exists so the worst seed stays
inside a signed 32-bit int, which is what goes on the wire.

On the MLX arm one `mx.random.seed` serves a whole slab, so `_mlx_batch_groups`
breaks a group when the TAKE changes exactly as it does when the sampling
changes. **No path renders a row in another row's lane.**

**The four refusals**, all per ITEM (the neighbours still render), all by name
at the head of the message:

| name | when |
|---|---|
| `sampling_malformed` | not an object, empty, an unknown key, a non-positive or non-numeric value, a fractional `topK`. The field is named. |
| `sampling_not_supported` | well formed and this engine has no such lever: `repetitionPenalty` on the MLX arm (mlx-audio has no repetition penalty), or ANY rung on Orpheus. |
| `take_malformed` | not a whole number `>= 0` (a bool, a float - `2.0` included - a string, a negative), or above `MAX_TAKE`. Never rounded and never clamped. |
| `take_not_supported` | well formed, above 0, and this engine has no seed lane: Orpheus, whose seeding is not `seed + index` at all. Take 0 always passes. |

**Per backend.** `higgs-v3` served (vllm-omni `extra_params` / SGLang-Omni
top-level): per request, all four levers, mixes freely. `higgs-v3` MLX: three
levers, solo renders mix freely, the slab is SPLIT by sampling group.
`higgs-v2-scaffold` (transformers, unshipped): three levers, serial.
`orpheus`: **refused** - it is deprecated, it is not a Crucible engine, its
sampling is the per-voice cap registry resolved per render and it has no seed
lane, so either half of a rung there would be ignored and reported as applied.

**The handshake.** `ready` carries `itemTake: true`. It is a BUILD fact, sent
before any engine loads, and it says only that this narrator parses a per-item
rung at all - BOTH halves, under ONE key, because a build has both or neither.
(It was `itemSampling` for one day, 2026-09-14 to 2026-09-15; renamed when the
seed half landed rather than joined by a second key, which would have been two
owners of one answer. Nothing had shipped under the old name.) Whether the
LOADED engine has a given lever or a lane is the per-row answer above.

Nothing about take 0's defaults, its seed, the guard, the retake ladder, the
caps or the frame budget is changed by this.

## The batch's judging flag, its band and its width (`serve/worker.py`)

Added 2026-09-19 on Owen's ruling. **The CALLER decides whether narrator
judges.** Until then an engine that COULD guard a batch always did: the arm was
picked by a capability probe on `render_many` and the caller had no say. The
fine-tuning ladder is what broke that. Screening a checkpoint has no measured
pace and no measured cap *by definition* - measuring them is what the render is
for - so judging that render means judging one model against another model's
band. BookForge wants the opposite: the guarded render, judged against the band
it read off the voice row. Both are one flag.

**The fields**, all BATCH-level on `generate_batch`, none on an item:

```json
{"action": "generate_batch",
 "retake": true,
 "band": {"paceCharsPerSec": 17.2, "maxCharsPerSec": 21.7, "minCharsPerSec": 13.6},
 "width": 4,
 "items": [{"i": 412, "text": "..."}]}
```

- **`retake`** (bool, optional, ABSENT = false). `true` takes the guarded arm -
  the engine's own PaceTracker, re-roll and split ladder - and its rows come
  back with `guard`, the verdict the ladder reached. `false` or absent takes
  the bare arm: **every row is rendered exactly once as it was sent, nothing is
  judged, nothing is retaken, nothing is split**, and the row carries NO `guard`
  key at all. Absent is not a fallback; it is the documented meaning of "nobody
  asked to be judged". A value that is not a boolean is refused, never coerced -
  `bool("false")` is `True`, and a client that spelled the flag wrong would get
  the exact opposite of what it asked for on every row of a book, silently,
  because both answers are ordinary audio.
- **`band`** (object, optional) - `paceCharsPerSec`, `maxCharsPerSec`,
  `minCharsPerSec`, three positive numbers with `min < pace < max`. It is the
  band the batch is judged against, and with `retake: true` it is
  **REQUIRED**. narrator will NOT fall back to the engine's own band: that
  fallback was the defect. A band centred at 15.0 chars/s against a book
  actually running near 17.2 called healthy chunks run-ons and re-rolled them
  to MAX_DEPTH. A band sent with `retake` false or absent is **accepted and not
  used** - Owen: *"it won't do anything with the number because it wasn't asked
  to"* - so it is not even parsed, and a malformed one riding along is not a
  refusal.
- **`width`** (int >= 1, optional, ABSENT = the serving width the engine was
  started with). How many rows of THIS batch narrator may keep in flight - the
  guarded driver's pool/slab width. MEASURED 2026-09-19: SGLang started 16 wide
  at `mem_fraction_static` 0.60 summed to 24.2 GB on a 24 GB card and WDDM
  paged the excess to host RAM, 4-10x slower with no error and no log line;
  the fine-tuning ladder renders 4 wide on voices whose manifest says 16.
  narrator does not restart or reconfigure the server for it - the width only
  limits what it asks of the server it already has - and it **cannot be
  raised**: a width above the serving width is refused, never clamped. The
  BARE arm renders one row at a time, so what it keeps in flight is 1, inside
  any width a caller can ask for; the width is a ceiling, not a target.

**THE BAND HAS ONE OWNER, AND IT IS THE BATCH.** `truncation.tracker_for` takes
the band explicitly; nothing in narrator builds a `PaceTracker` from a voice
entry any more. The voices document still carries and validates the three keys
(`config._length_band`) and they still reach `ClipsVoice` - because they are
what the CLIENT reads off the voice row and sends back here. narrator's own
audiobook path (`convert`, `convert_many`, `convert_batch`) passes
`truncation.engine_band(...)`, the engine's own measured pair, and says so at
the call site; that path is narrator acting as its own client.

**The refusals**, all for the WHOLE batch (the flag and the band are the
batch's, so answering some rows and refusing others would be two answers to one
question). Each is delivered in this door's existing shape - one `batch_item`
carrying `{i, message}` for every requested `i`, then `batch_done` - with the
name at the head of the message:

| name | when |
|---|---|
| `retake_without_band` | `retake: true` and no `band`. |
| `band_malformed` | `retake: true` and the band is not three positive numbers with `min < pace < max`. Never checked when `retake` is false - it was not asked for. |
| `retake_malformed` | `retake` present and not a boolean. Never coerced. |
| `retake_unsupported` | `retake: true` and this engine offers no `render_many` (Orpheus). Refused rather than rendered unjudged, which would report a success for a render that silently skipped the retake it was asked for. |
| `retake_with_stream` | `retake: true` on a batch any of whose items carry `stream: true`. A streamed row leaves as it generates, so there is nothing left to re-roll by the time the ladder could decide. |
| `width_malformed` | `width` present and not a whole number `>= 1`. |
| `width_over_serving` | `width` above the width the engine was started with (`BATCH_SIZE`: `HIGGS_MAX_NUM_SEQS` on the served arms, `NARRATOR_HIGGS3_MLX_BATCH` on MLX). Refused, not clamped. |

**MEASUREMENT IS UNCONDITIONAL**, on both arms. Every retired row carries

- **`capped`** (bool) - whether generation reached `cap_frames`' ceiling for
  that chunk. It is a FACT about the render, never a verdict on it, and the
  bare arm is exactly the one whose numbers nobody else has. COUNTED on the MLX
  arm, which generates in this process and can see the frames it produced;
  INFERRED on the served arms from the decoded audio, which is still exact for
  this question (a generation that hit the cap emitted no EOS, so no sentinel
  run was stripped and the delay diagonal - 7 frames - is all that was:
  `cap - 7` frames come back, and `cap_frames` is 2x the expected duration plus
  150 frames of slack, so nothing that stopped on EOS is near it). A chunk the
  ladder SPLIT is capped when any part was.
- **`tokens`** (int) - the frames the model generated, which is
  `max_new_tokens`' own unit. Sent **only when the count is counted**: on the
  served arms the only thing that crosses the HTTP boundary is a WAV (no token
  count, no stop reason - `v3_served.decode_response`), so what narrator can
  see there is a lower bound and stating it would state a number nobody
  generated. Closing that means a metadata channel on `/v1/audio/speech`, which
  is a server change and not narrator's to make.

A missing `capped` or `tokens` means **"narrator did not say"** and must never
be read as `false` / 0: a runaway reported as "not capped" is the one failure
the field exists to prevent (crucible/docs/PHASE18-UNCERTIFIED.md).

**`maxChars` IS THE CLIENT'S PACKING SIZE**, and narrator no longer refuses a
voice without it. Three refusals retired with this ruling - the voices-document
gate (`config.load_voices`) and the budget belts on both v3 arms
(`HiggsV3Budget.max_chars`, `HiggsV3MlxBudget.max_chars`); the v2 scaffold's
belt went with them so the two cannot drift. The reasoning they rested on is
unchanged and still worth acting on (a fine-tune's safe chunk length is a
measured property of THAT model), but the refusal was in the wrong place: the
client packs the book, narrator renders what it is sent, and the screening
render of an unmeasured checkpoint is precisely the render that produces the
number. A voice with none packs at the engine placeholder and
`max_chars_source` says `placeholder`. **Nothing narrator does per chunk reads
it**: the frame ceiling is `cap_frames(text)` over the text actually sent (the
engine's own arithmetic over `HiggsDefaults.CHARS_PER_SEC`), and the stop
policy's `max_new_tokens` "for the largest permitted chunk" is the ENGINE's own
`config.max_chars` constant, never the voice's. One consequence had to be fixed
with the retirement: `_safe_band` and the `targetChars` ceiling now cross-check
against the voice's **stated** `maxChars` and skip when it states none, because
comparing a measured safe band against a placeholder the voice never claimed
refuses it against another model's number.

**`take` is unchanged.** It is the client's starting seed lane
(`seed = base + index + REROLL_SEED_STRIDE * (TAKE_REROLL_LANES * take +
attempt)`); with `retake` false, `attempt` is always 0, so the draw is a pure
function of `(index, take)`. narrator refuses a take only for being malformed
or above `MAX_TAKE`, or on an engine with no seed lane at all - it has never
required a take to name a declared rung, and does not now.

**The index on the bare arm is the CALLER'S `i`.** Behind the render door both
arms seed the chunk with `seed + i`, and a row whose `i` is not an integer is
refused by name. The bare arm used to seed by POSITION IN THE BATCH, which made
chunk 412 render differently depending on which rows happened to travel with it
in a read-ahead window - so a resume or a single-chunk re-render stopped
reproducing. The Listen door keeps the position: its `i` is a label the player
resolves by, and its engine is Orpheus, whose seeding is not `seed + index` at
all.

## Reporting a guess

If a behaviour of e2a is ambiguous (two code paths, a flag the bridge never
passes), do not pick silently: implement the path the bridge actually exercises
today and list the other in your report under "Unexercised e2a paths".
