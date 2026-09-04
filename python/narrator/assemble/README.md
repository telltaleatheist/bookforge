# assemble/ - the discovered rules

Everything here was read out of `ebook2audiobook@9daab0ba` and the BookForge main
checkout, and where a number is claimed it was measured on a real session
(Kershaw, `ebook-ccd14111-da29-4fb0-a489-a19a0f126bac`, rendered 2026-09-03).

---

## 1. THE GAP RULE

**Assembly inserts nothing. Every gap is already PCM inside the chunk's own FLAC,
so `samples` is the complete answer and `gapBefore`/`gapAfter` are 0.0 for every
e2a session.**

That is not a placeholder. It is the rule, and it is what makes the VTT and the
audio unable to disagree.

### Where the silence is written

| Producer | What it writes | Reference |
|---|---|---|
| Orpheus engine | model audio + the model's own trained tail + `trail_gap` seconds of `torch.zeros`, all in one file | e2a `lib/classes/tts_engines/orpheus.py:4594-4602` (`_save_audio`) |
| Orpheus engine, empty/SML-only row | a 0.1 s all-zero FLAC | e2a `orpheus.py:4139-4144` (`_write_silence`), `bookforge_ext/parallel/worker_core.py:394-410` |
| BookForge gap-normalization | strips the exact-zero pad, then writes `max(tail + gap_seconds, min_gap_seconds)` of fresh zeros | bookforge `electron/scripts/normalize_gaps.py:130-157` |

The gap policy itself: `_classify_gap` (e2a `orpheus.py:4107-4137`) returns
`(lead_gap, trail_gap)`. `trail_gap` defaults to 0.6 s from
`ORPHEUS_SENTENCE_GAP`, but every voice in BookForge's catalog declares
`sentenceGap: 0.0` (`electron/data/orpheus-models.json`), so on current renders
the engine appends nothing and the trailing silence is the model's own tail,
later lifted to a per-voice floor (`minChunkGap`, 0.55 s for the shipped voices)
by `normalize_gaps.py`.

### Where the silence is NOT written

- **Not at the sentence concat.** `combine_audio_sentences` (e2a
  `lib/core.py:4108-4114`) writes one bare `file '...'` line per chunk and hands
  it to `assemble_audio_chunks` (`lib/core.py:4814-4828`), whose ffmpeg command
  has no `-af`, no `apad`, no `adelay`, no `anullsrc`.
- **Not at the chapter concat.** `combine_audio_chapters` (`lib/core.py:4721-4728`
  and `:4763-4770`) and `export_audio_parallel` (`:4504-4518`) are equally bare.
- **Not at a chapter boundary.** Traced end to end through
  `convert_chapters2audio` (`:3724-3865`), the BookForge assembly loop
  (`bookforge_ext/parallel/session.py:1260-1289`) and `chapter-closer.ts:222-241`.
  A chapter boundary gets whatever trailing silence the last chunk of that chapter
  happens to carry - the same treatment as any other join.

### `docs/NARRATOR_PLAN.md` is wrong about chapter boundaries

The plan says "Chapter boundaries carry >= 0.5 s of silence, so AAC's ~21 ms
priming at a join is inaudible." **That guarantee does not exist.** Nothing adds
silence at a chapter boundary; the only thing that ever lifts a join is
`normalize_gaps.py`'s per-voice `min_gap_seconds` floor, which (a) applies to
*every* chunk, not specially to chapter-final ones, (b) is 0 for a voice that
declares no `minChunkGap`, and (c) does not run at all for a non-Orpheus session
(`sentence-gap.ts`, `planSentenceGap`).

It does not matter for correctness here, because the concat is sample-exact by
construction and the VTT is computed from sample counts, not from the encoded
timeline - see section 3.

### Why a non-zero gap is refused rather than realized

`chapters.py` raises `NotImplementedError` on any chunk with a non-zero gap.
Realizing one at concat time means splicing a generated silence FLAC into the
list, and a generated FLAC's STREAMINFO max-blocksize will not match the rendered
set's - which is exactly the condition the homogeneity guard exists to refuse
(section 2). Bake the gap into the audio and point the manifest at that set; that is what
the whole pipeline already does.

### The measurement

Kershaw, 133 chunks, one chapter:

```
sum(STREAMINFO samples of chapters/sentences/*.flac) = 62,769,504 = 2615.396 s
chapters/1.flac (what e2a's assembly produced) = 62,974,573 = 2623.941 s
difference = 205,069 = 8.545 s
```

The chapter FLAC is 8.5 s LONGER than the raw sentences. That is not silence
added at concat: it is that the assembly was pointed at a **different sentence
set** - the gap-normalized one the bridge builds at
`<outputDir>/.gap-<jobId>` and passes as `--sentences_dir`
(`reassembly-bridge.ts:1341`, `:1420`). Confirmed against the reference VTT,
whose first cue ends at 2.921 s while the raw chunk 0 is 2.3893 s long.

`metadata.txt` in that session records `END=2623941`, which is
`round(62974573 / 24000 * 1000)` exactly - so a manifest built against the same
sentences directory reproduces the chapter atom to the millisecond.

---

## 2. THE HOMOGENEITY GUARD (the Witnesses incident)

ffmpeg's concat demuxer silently drops every FLAC frame whose blocksize exceeds
the **first** list entry's STREAMINFO max-blocksize, **and still exits 0**. A
mixed-encoder sentence set therefore produces a shorter audiobook with no error
anywhere. `render/flac_header.py:assert_concat_homogeneous` refuses a set whose
max-blocksize, sample rate or channel count is not uniform - ported from e2a
`lib/core.py:4079-4105`.

---

## 3. THE DURATION GUARDS

| Guard | Tolerance | Ported from | Incident |
|---|---|---|---|
| concat / per-chapter encode | `0.5 + 0.01 * n_files` s | `lib/core.py:4841` | Witnesses - concat dropped frames, exit 0 |
| finished export | `2.0` s | `lib/core.py:4351` | Nuremberg 2026-08-11 - a 20.12 h source exported as a valid, playable 14.72 h m4b |

Both compare against the **sample-count** total, which is exact. `probe_duration`
raises rather than returning 0.0 for an unreadable file, because a 0.0 does not
look like an error to a guard - it looks like a file that is trivially short
enough to pass.

Note that the VTT's timeline and the m4b's timeline are computed from different
things: the VTT from sample counts, the m4b from what the AAC encoder produced.
e2a has always had that seam and this preserves it. On Kershaw the m4b measures
2624.000 s against a 2623.941 s sample total - 59 ms of AAC priming/padding at
the single join, well inside both guards and well inside the bridge's own
5-second promotion gate (`reassembly-bridge.ts:2219`).

---

## 4. WHICH ENCODE PATH

e2a picks between a serial encode and a per-chapter parallel encode, and
`encode.py:parallel_export_unsupported_reason` reproduces the gate exactly
(`lib/core.py:3933`). The choice is **audible**, which is why narrator does not
just always take the fast path:

- serial, book <= 2 h: `loudnorm=I=-16:LRA=11:TP=-1.5:linear=true,afftdn=nf=-70`
- parallel, book > 2 h: no loudnorm at all (it measures the whole file and cannot
  be decomposed per chapter - which is also why e2a skips it above 2 h on the
  serial path, so the two paths agree)

Kershaw (43 min) therefore takes the **serial** path, and the session directory
proves it: it contains `concat_list_chapters_1.txt` and a whole-book
`Working_Towards_The_Fuhrer.flac`, both written only by the non-split serial
branch (`lib/core.py:4761-4777`).

### Where narrator is faster anyway

e2a materializes one FLAC per chapter and, on the serial path, one whole-book
FLAC on top of that - 1.5 GB of pure write on a 20 h book - purely to hand one
file to one encoder. narrator feeds the sentence FLACs to ffmpeg's concat demuxer
directly on both paths. The PCM the encoder sees is identical (that intermediate
was a lossless concat of exactly these files); the write never happens.

---

## 5. THE EXACT FFMPEG COMMANDS

Per chapter (parallel path):

```
ffmpeg -hide_banner -nostats -v error \
  -f concat -safe 0 -i <chapter concat list> \
  -c:a aac -b:a 192k -ar 44100 -ac 1 \
  -y <work>/<n>.m4a
```

Final mux (parallel path) - chapters, atoms and tags in ONE pass:

```
ffmpeg -hide_banner -nostats -v error \
  -f concat -safe 0 -i <encoded concat list> \
  -f ffmetadata -i <work>/metadata.txt \
  -map 0:a -c:a copy \
  -map_metadata 1 \
  -movflags +faststart+use_metadata_tags \
  -threads 0 -y <output_dir>/<final_name>.m4b
```

Serial path (whole book in one encode):

```
ffmpeg -hide_banner -nostats -thread_queue_size 1024 \
  -f concat -safe 0 -i <sentence concat list> \
  -f ffmetadata -i <work>/metadata.txt \
  -map 0:a -c:a aac -b:a 192k -ar 44100 -ac 1 \
  -movflags +faststart+use_metadata_tags \
  -map_metadata 1 \
  -filter_threads 0 -af loudnorm=I=-16:LRA=11:TP=-1.5:linear=true,afftdn=nf=-70 \
  -threads 0 -progress pipe:1 -y <output_dir>/<final_name>.m4b
```

Then, in both cases, the cover:

```python
from mutagen.mp4 import MP4, MP4Cover
audio = MP4(final_file)
audio['covr'] = [MP4Cover(open(cover, 'rb').read(),
                          imageformat=MP4Cover.FORMAT_JPEG)]
audio.save()
```

`-hwaccel auto` (e2a `lib/core.py:4259`) is deliberately dropped: it is a no-op
for an audio-only graph.

### Why the cover is a second pass, and not an ffmpeg input

It looks like a free win to attach the cover in the same mux with
`-i cover.jpg -map 2:v -c:v copy -disposition:v:0 attached_pic`, and it saves a
full rewrite of a multi-gigabyte file. It does not work.

MEASURED, ffmpeg 7.x, 2026-09-04: **`-movflags +use_metadata_tags` and an
attached picture are mutually exclusive.** With the flag set, the mov muxer takes
the `mdta` keys/ilst path and writes no `covr` atom at all - the mapped picture
is silently dropped and ffprobe reports no video stream in the output.

And the flag is load-bearing. It is what carries the ffmetadata keys the MP4 spec
does not define - `year` and `language` - into freeform (`----`) atoms. All three
golden references carry them:

| reference | container tags | cover stream |
|---|---|---|
| kershaw | title, artist, language=en, year=1993 | mjpeg attached_pic |
| blacksun | title, artist, language=en | none |
| mutineer | title, artist, language=en, year=1991 | mjpeg attached_pic |

Dropping `+use_metadata_tags` to keep the cover loses `language` and `year`
outright. So narrator does what e2a does, for the reason e2a does it: mux with
the flag, then attach the cover with mutagen (`lib/core.py:4384-4391`). That is
why `mutagen` is a declared dependency rather than an avoidable one.

(An earlier revision of this file justified writing `date=` instead by pointing
at a `"date": "1993"` tag on a shipped BookForge m4b. That was the wrong
evidence: the shipped file has been through BookForge's own later metadata pass
(`applyM4bMetadata`), and e2a's actual output - the reference - carries `year`,
not `date`. The parity comparison now checks the whole tag set, so this cannot
drift again.)

## 6. THE PROGRESS LINES

Each line below is emitted so that `electron/reassembly-bridge.ts` needs no
change at cut-over. The bridge byte-filters its stdout before decoding, so the
exact substrings matter as much as the regexes.

| Line narrator emits | Bridge matcher | Effect |
|---|---|---|
| `[ASSEMBLE] Assembling all N chapters...` | `line.includes('Assembling all')` then `/Assembling (?:all \|audiobook from )(\d+) chapters/` (L1805-1806) | sets `totalChapters` |
| `[ASSEMBLE] Chapter N: sentences A-B` | `/(?:\[ASSEMBLE\] Chapter\|Combining chapter)\s*(\d+)/` (L1817) | `chaptersStarted++`, combine bar |
| `Assemble completed!` | `line.includes('Assemble completed!')` (L1799) | combine -> 100 % |
| `[ASSEMBLE] Creating VTT subtitle file...` | `line.includes('Creating VTT subtitle file')` (L1839) | subtitles stage |
| `[ASSEMBLE] Combining chapters into final audiobook...` | `line.includes('Combining chapters into final')` (L1848) | encode stage begins |
| `[assembly] Parallel encode: N chapters across W workers` | prefilter `Concatenat`/`Export` siblings; informational | log only |
| `Export - P%` | `/Export\s*-\s*([\d.]+)%/` (L1780 stdout, L2023 stderr) | encode bar + ETA |
| `[assembly] Concatenating encoded chapters (stream copy)` | `line.includes('Concatenating')` (L1848) | encode stage |
| `{"success": true, ...}` (indented, as e2a prints it) | `line.includes('"success": true')` (L1924) | metadata stage |

**Not emitted, deliberately:** `********* Combined block audio file saved in ...`
(bridge L1831). That line is e2a's *chapter FLAC* event, and narrator never
writes a chapter FLAC. Emitting it after each chapter encode would drive
`chaptersCompleted` and push the combine bar back DOWN from the 100 % that
`Assemble completed!` already set. The combine stage is driven by the
`[ASSEMBLE] Chapter N` lines and closed by `Assemble completed!` instead.

`Audiobook saved to:` (bridge L1941) is also not emitted - e2a does not emit it
either, and the bridge's `*.m4b` glob is its tested path.

The final JSON is printed with `indent=2`, exactly as e2a's handlers.py does.
That means the bridge's single-line `/\{.*"success":\s*true.*\}/` does NOT match
it (no `s` flag), so the bridge falls through to globbing `*.m4b` in the staging
directory - which is what happens with e2a today and is the path that is tested.

---

## 7. THE VTT

`vtt.py` reproduces `bookforge_ext/parallel/session.py:build_vtt_file` - the copy
the `--assemble_only` route actually reaches, via `handlers.py:121-139`.

```
WEBVTT<LF><LF>
HH:MM:SS.mmm --> HH:MM:SS.mmm<LF>
<cue text><LF>
<LF>
...
```

- one block per rendered chunk, in global index order
- **no cue identifiers**
- **no `NOTE` blocks**
- cue text: markers stripped with `SML_UNSPOKEN_PATTERN`, whitespace collapsed,
  wrapped in `<b>...</b>` when the row is a heading and the payload is non-empty
- times: a running float sum of `samples / sampleRate` plus realized gaps,
  accumulated with e2a's own float arithmetic so the two cannot differ by a
  rounding step

### Line endings: a declared deviation

e2a opens the VTT with `open(vtt_path, 'w', encoding='utf-8')` and no `newline=`
(`bookforge_ext/parallel/session.py:932`), so Python's text layer writes CRLF
when the assembly runs on Windows and LF when it runs in WSL or on the Mac.
e2a's line endings are a property of the machine that assembled the book.

narrator writes LF everywhere, deliberately. **The VTT parity claim is
cue-level - identical cue count, identical cue text, cue times within 1 ms - and
explicitly not byte-level.** It is safe because the bridge's own cue regex
(`reassembly-bridge.ts:36`) matches LF, WebVTT permits either terminator, and the
sidecar a reader actually gets is regenerated from the m4b's `mov_text` track
(`electron/sidecar-migration.ts`), so these bytes never ship.

### `NOTE heading` / `NOTE asr-fallback` do not exist

`docs/NARRATOR_PLAN.md` (contract 5) and `CONTRACTS.md` both describe cue indices
and `NOTE heading` / `NOTE asr-fallback` blocks. A grep for `NOTE ` across e2a's
`lib/` and `bookforge_ext/` at `9daab0ba` returns nothing, and neither
`build_vtt_file` writes a cue identifier. Emitting either would break the byte
parity the same contract demands, so this reproduces what e2a writes.

### The `.m4b.vtt` in a project's `output/` is NOT e2a's raw VTT

The Kershaw reference `output/....m4b.vtt` has `MM:SS.mmm` timestamps and 132
cues for 133 chunks. e2a writes `HH:MM:SS.mmm` and one cue per chunk including
the empty-text one for the trailing `[break]` row. The file in `output/` has been
re-written after promotion (the bridge's own `lastVttCueEndSeconds` at
`reassembly-bridge.ts:36` uses `/-->\s+(\d{2,}):(\d{2}):(\d{2})\.(\d{3})/`, which
only matches the RAW form - proof that what e2a hands the bridge is the HH form).
Anything comparing against a golden `reference.vtt` must use e2a's raw output,
not the promoted sidecar.

---

## 8. PARTIAL ASSEMBLY (`--chapters`)

`render/session_v1.py` ports e2a's `parse_chapters_arg` and
`detect_completed_chapters` (`bookforge_ext/parallel/session.py:707`, `:755`).
The reassembly bridge NEVER passes `--chapters` - it refuses to spawn at all when
any sentence file is missing (`reassembly-bridge.ts:1184-1210`) - but the
`blacksun` golden fixture IS a partially rendered session (512 of 2358 chunks;
e2a's own reference for it covers chapters 1-3), so the path is implemented and
tested.

**A selection must be a contiguous run from chapter 1.** e2a accepts a mid-book
selection and then writes a WRONG VTT for it: `build_vtt_file` globs the sentence
files (which start at index 0) and pairs them positionally with the SELECTED
chapters' texts, so every cue carries the wrong words. narrator raises instead.

**Bilingual sessions are refused.** e2a's bilingual assembly
(`bookforge_ext/parallel/session.py:1163-1222`) is the ONE e2a path where
assembly inserts silence of its own: it re-cuts the whole book into a single
chapter of interleaved source/target chunks with a `bilingual_pause` (0.3 s)
between a pair and a `bilingual_gap` (1.0 s) between pairs. Every timing rule
this module rests on - gaps live in the FLAC, a chapter is a pure concat of its
chunks - is false there. e2a drives it from `args['bilingual']` and writes
nothing about it into `session-state.json` (verified against
`save_session_state`, `session.py:54-123`), so a session on disk cannot normally
be identified as bilingual; narrator exposes no `--bilingual` flag, and
`build_manifest` refuses the one state key a future writer would plausibly use.

Two other places `--chapters` differs from e2a, both deliberate:

- e2a's `parse_chapters_arg` prints a warning and CONTINUES on an unparseable
  part, and silently drops an out-of-range chapter. Either one assembles a
  different book than the caller asked for; narrator raises.
- e2a falls back to "all chapters" when a selection parses to nothing. narrator
  raises.

---

## 8b. PRE-ENCODED CHAPTERS AND WHAT IS REFUSED

`--encoded-chapters-dir` takes the `<chapterNum>.m4a` files BookForge encodes
while the GPU is still rendering (`electron/chapter-closer.ts:255`). Every one is
held to a duration guard: its measured duration must match what the manifest's
sample counts say that chapter is, within **`PRE_ENCODED_TOLERANCE_S` = 0.06 s**.
A correctly named, perfectly valid `.m4a` left
over from an earlier sentence set - a retaken chunk, a re-cut chapter - passes
every name and probe check and would be copied verbatim into the audiobook, and
the only symptom would be that the book quietly disagrees with its own transcript
from that chapter onward. "BookForge vouched for it" is not something this
assembler can verify; the sample counts are.

### Why 0.06 s, and not `concat_tolerance`

This guard must NOT reuse `concat_tolerance` (0.5 + 0.01*n). That formula exists
for a different question - "did every one of n files reach the encoder", where
the demuxer can drop inputs and still exit 0 - and it scales with the chunk
count. Used here it is far too slack: a 4-chunk chapter gets 0.54 s of slack,
which is enough to accept a NEIGHBOURING chapter's audio wholesale.

A pre-encoded chapter was encoded from the exact same sample set the manifest
describes, so the only legitimate difference is the encoder's own framing. The
theoretical worst case is AAC priming plus one frame, ~0.045 s at 24 kHz.
MEASURED on this encoder path (2026-09-04, ffmpeg 7.x) it is far smaller, because
the mp4 muxer writes an edit list that trims the priming and ffprobe honours it:

| sample | chapters | range | max abs delta |
|---|---|---|---|
| synthetic | 19 | 0.05 s - 20.02 s, 1-4 chunks | **0.000 ms** |
| real (kershaw + blacksun) | 4 | 20-78 min, 46-178 chunks | **0.676 ms** |

0.06 s sits just above the theoretical bound and about 88x above the largest
value actually observed, so it cannot fire on a legitimate chapter while still
refusing one that is even a tenth of a second wrong.

`concat_tolerance` keeps the guard it was ported for: verifying that a chapter
THIS assembler just encoded from a concat list carries all of its inputs.

A rejected chapter is named and explained on the log and then encoded from its
sentences (e2a instead aborts the whole assembly). Nothing is ever silently
dropped or silently rebuilt.

---

## 9. MEASURED PARITY (2026-09-04)

narrator against e2a's own assembly of the identical session, on this machine
(ffmpeg 7.x, 16 encode workers), compared with
`tests/golden_tools/compare.py`:

| slug | chunks | cues | max cue delta | m4b duration delta | chapters | cover | tag mismatches | wall |
|---|---|---|---|---|---|---|---|---|
| kershaw | 133 | 133/133 | 0.000 ms | +0.0 ms | 1/1 | yes/yes | 0 | 61.7 s |
| blacksun | 397 (partial, ch 1-3) | 397/397 | 0.000 ms | +0.0 ms | 3/3 | no/no | 0 | 143.6 s |
| mutineer | 1400 | 1400/1400 | 0.000 ms | +0.0 ms | 25/25 | yes/yes | 0 | 163.6 s |

Cue text is identical on all three; chapter titles, chapter starts, audio stream
(aac / 44100 / 1 ch) and the container tag set all match. Blacksun has no cover
in either file - its session is `cover: true` with no staged `cover.jpg`, and
e2a ships it bare too (see section 1 of `render/session_v1.py:_resolve_cover`).

kershaw takes the serial path (a 43-minute book); blacksun and mutineer take the
parallel one. Mutineer is assembled from `chapters/sentences-denoised`, which is
what its reference was assembled from: chunk 0 is 2.1128 s there against
2.1333 s in `chapters/sentences`, and the reference VTT's last cue ends at
34897.489 s, that directory's exact sample total.

The VTT comparison is CUE-LEVEL, not byte-level - see section 7.

**On the speed target.** `docs/NARRATOR_PLAN.md` targets "Mutineer 8 min -> under
1 min". Measured: ~160 s, a 3x improvement, not 8x. The whole-book FLAC write is
gone and the sentence-to-chapter FLAC concat is gone, but the AAC encode is now
the floor and it is gated by the LONGEST chapter rather than by the total: 25
unequal chapters across 16 workers leaves most idle at the end. Encoding a
chapter the moment its last chunk lands - the plan's own next step - is what
closes the rest of the gap, because by the end of the render there would be
nothing left to encode.

---

## 10. THE WORKING DIRECTORY

`<output_dir>/.nw<pid>/` holds the per-chapter `.m4a` files, their concat lists
and `metadata.txt`. It is removed once the finished m4b passes the export
duration guard, and KEPT when anything fails, because then it is the evidence.

Two properties, both learned the hard way:

- **A subdirectory**, so `reassembly-bridge.ts`'s promotion loop (which promotes
  every regular FILE in the staging directory) skips it.
- **Named for the process that owns it.** It used to be the fixed
  `.narrator-work`, and the first thing `assemble()` does is `rmtree(work_dir)` -
  so a second assembly writing into the same `output_dir` deleted the first's
  concat list and half-written chapter files out from under a running ffmpeg.
  The symptom is `Error opening input file ...concat_list_encoded.txt` from an
  assembly that did nothing wrong. Two variants of one book staged into a single
  directory, or one test suite run by several agents at once, is enough. With the
  pid in the name, the start-of-run rmtree can only remove our own leftovers.

Concat lists are flushed and `fsync`ed before the handle closes, and their size
is checked back off the filesystem, because the next thing that happens to one is
that a separate ffmpeg process opens it by name.

The names are short on purpose (`.nw<pid>/7.m4a`, not
`.narrator-work/parallel_encode/00007.m4a`): `output_dir` is often already deep
under the Z: library, and Windows still caps the path at 260 characters for the
APIs ffmpeg uses.
