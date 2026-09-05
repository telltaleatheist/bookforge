## Provenance: this session is INCOMPLETE, and the shipped m4b is a DIFFERENT render

Two facts have to be stated plainly, because CONTRACTS.md describes this book as
"512 chunks" and that number is the count of rendered FLACs, not the size of the
session:

1. **The session is a partial render.** `session-state.json` declares
   **2358 chunks across 18 chapters**, but only **512** chunk FLACs exist in
   `chapters/sentences` (indices 0..511, contiguous). Chapters 1-3 are fully
   rendered (0..396); chapter 4 (397..552) is cut off at 511.
2. **The m4b in the project's `output/` is not this session's.** The shipped
   `Black Sun ... (2009).m4b` + `.m4b.vtt` are dated 2026-08-29 15:12, while this
   session's `session-state.json` is 2026-08-31 19:11 - the session POSTDATES the
   audiobook. The shipped VTT has **2304 cues** and runs to 16:05:20.965
   (a 16-hour book); the 512 rendered chunks here total 13678.636 s (3.8 h). It is
   an older, complete, differently-chunked render. Nothing about it can serve as a
   parity reference for this session.

The session directory itself confirms it was never assembled: it has no
`metadata.txt`, no concat lists, no `chapters/*.flac` and no `cover.jpg` - only
`chapters/sentences/`.

So the reference here was produced by running e2a's own assembly over the
completed chapters. This fixture is therefore a **PARTIAL** one: it covers
**chapters 1-3 = 397 chunks**, which is exactly what e2a's `--chapters auto`
selects (`detect_completed_chapters` walks the chapters in order and stops at the
first one that is not fully rendered). The remaining 115 rendered chunks
(397..511) belong to an unfinished chapter 4 and are deliberately outside the
fixture - a parity run must assemble the same 3 chapters.

## How the reference was produced

- e2a checkout: `C:\Users\tellt\Projects\ebook2audiobook`, branch `bookforge`,
  HEAD `9daab0ba9360b4e9e8d538bd6da9b713fed2de21` (read-only; `E2A_TMP_DIR` was
  redirected so the checkout was not written to).
- Runtime: **3 m 19 s** (CPU only).

`--no_split` is passed because that is what BookForge's reassembly bridge passes
(`electron/reassembly-bridge.ts:1519`). This book's 3 assembled chapters are
2.9 h and would not have split anyway.

```
cd C:\Users\tellt\Projects\ebook2audiobook
set E2A_TMP_DIR=C:\tmp\narrator-G\e2a-tmp
set PYTHONIOENCODING=utf-8
python_env\python.exe app.py --headless --assemble_only --skip_deps --no_split ^
  --tts_engine xtts ^
  --session ce93d332-1c6a-47b1-86f2-6dec63306486 ^
  --session_dir C:\tmp\narrator-golden\blacksun\ebook-ce93d332-1c6a-47b1-86f2-6dec63306486 ^
  --chapters auto ^
  --output_dir  C:\tmp\narrator-golden\blacksun\e2a-out
```

e2a named the result `... __Partial_Ch_1-3_.m4b`; it is committed here as
`reference-m4b.json` / `reference.vtt` under the neutral names. e2a logged
`[VTT] Warning: 512 audio files vs 397 sentences` and wrote 397 cues - it clamps
to the selected chapters, which is the behaviour this fixture pins.

## Two traps this book carries

- **`session-state.json` says `"cover": true` but there is no `cover.jpg`.** The
  reference m4b consequently has **no cover stream** (audio + `bin_data` only),
  unlike the other two books. A reader that trusts the `cover` flag and then
  opens the path will fail; derive cover presence from the file, not the flag.
- **e2a skipped loudnorm**: it logged `Skipping loudnorm filter for long
  audiobook (2.9 hours) to avoid memory issues`. Any narrator assembly that
  applies loudnorm here will not match this reference's levels.

## What this book is for

The headings-heavy non-fiction case: 18 numbered chapters with real TOC titles,
all 18 resolved from the EPUB by document identity
(`[ASSEMBLE] 18/18 chapter titles resolved from the TOC by document identity`),
and `chapter-provenance.json` covering all 18 even though only 3 are assembled.
