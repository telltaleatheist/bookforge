## Provenance: the shipped m4b DOES belong to this session

Unlike the other two books, the project's shipped
`Mutineer's Moon (Dahak Book 1). Weber, David. (1991).m4b` (2026-09-04 12:47)
really is this session's output: the session was written 12:19-12:46, and its
`concat_list_sentences.txt` names this very session's
`chapters/sentences-denoised/*.flac`. It was nevertheless regenerated here, for
two reasons:

1. **Its `.m4b.vtt` is not e2a's VTT.** It has **1367 cues for 1400 chunks** and
   prints `MM:SS.mmm` below the one-hour mark. Both are signatures of ffmpeg
   re-muxing the m4b's embedded `mov_text` track back to WebVTT
   (`electron/sidecar-migration.ts` -> `extractVttFromM4b`). The arithmetic is
   exact: 33 of the 1400 chunks are marker-only rows (a bare `[break]`) whose cue
   text strips to empty, and the round-trip drops every empty cue.
   1400 - 33 = 1367.
2. **The path that produced it cannot be re-run.** e2a assembled it through
   `--encoded_chapters_dir`, per-chapter AAC in `parallel_encode/NNNNN.m4a`
   (`concat_list_encoded.txt` still names those files). That directory is cleaned
   up after assembly and no longer exists, so the encoded-chapters path is
   unexercised here; this reference comes from the plain concat-and-encode path.

Both files are kept beside the local copy as `shipped.m4b` / `shipped.m4b.vtt`
for comparison.

## The sentences dir: `chapters/sentences-denoised`

**This is the one that matters for parity on this book.** e2a assembled from
`chapters/sentences-denoised`, not `chapters/sentences` - the session's own
`concat_list_sentences.txt` names the denoised files. Both directories hold 1400
FLACs and they are NOT interchangeable: the denoised copies have their own
durations, and measuring the shipped VTT against the raw `chapters/sentences`
sums leaves a residual of up to ~0.1 s per cue and 26 s over the book. So
`sentences.json` here describes `chapters/sentences-denoised`, and a narrator
assembly must be pointed at the same directory.

## How the reference was produced

- e2a checkout: `C:\Users\tellt\Projects\ebook2audiobook`, branch `bookforge`,
  HEAD `9daab0ba9360b4e9e8d538bd6da9b713fed2de21` (read-only; `E2A_TMP_DIR` was
  redirected so the checkout was not written to).
- Runtime: **3 m 13 s** (CPU only).

### `--no_split` is REQUIRED here, and this book is why

BookForge's reassembly bridge passes `--no_split`
(`electron/reassembly-bridge.ts:1519`); CONTRACTS.md says to implement the path
the bridge actually exercises, and on a 9.7 h book the difference is not
cosmetic. Assembled WITHOUT it, e2a split this book at
`default_output_split_hours` into `part1` (5.7 h) and `part2` (4.0 h) - and then
exported **both to the same `final_name`**, so part 2 overwrote part 1. The
resulting "audiobook" was 14281 s long and started at Chapter Sixteen, while
`output_files` still reported a single m4b as if nothing had happened. The VTT,
built before the split, still had all 1400 cues and described the whole book. A
parity run that did not check the m4b's first chapter title would not have
noticed.

```
cd C:\Users\tellt\Projects\ebook2audiobook
set E2A_TMP_DIR=C:\tmp\narrator-G\e2a-tmp
set PYTHONIOENCODING=utf-8
python_env\python.exe app.py --headless --assemble_only --skip_deps --no_split ^
  --tts_engine xtts ^
  --session 88c038b1-cfa1-425b-9226-af6ff456b029 ^
  --session_dir    C:\tmp\narrator-golden\mutineer\ebook-88c038b1-cfa1-425b-9226-af6ff456b029 ^
  --sentences_dir  C:\tmp\narrator-golden\mutineer\ebook-88c038b1-cfa1-425b-9226-af6ff456b029\26f7053065303c4008bfc02aa51fe83c\chapters\sentences-denoised ^
  --output_dir     C:\tmp\narrator-golden\mutineer\e2a-out
```

## What this book is for

The long one, and the assembly benchmark: 1400 chunks, 25 chapters, ~9.7 h. It is
the only one of the three with a `sentences-denoised` directory, the only one
whose chapters are many enough for per-chapter parallel encoding to matter, and
the one whose 33 marker-only chunks make the empty-cue rule impossible to miss.
