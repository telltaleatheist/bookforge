## Provenance: why the reference was REGENERATED

The project's `output/` holds exactly one m4b/VTT pair,
`Working Towards The Fuhrer. Kershaw, Ian. (1993).m4b` + `.m4b.vtt`, mtime
2026-09-03 17:59, which does match this session (its `session-state.json` is
17:56 and its `metadata.txt` 17:58). Three older generations are present only as
orphaned sidecars - `Assembly._Ian_Kershaw`, `- LongMix (tr_lm2)`,
`- Mistborn (mb_pc1)`, `- Sigma Male Narrator` each leave a `.m4b.cover.jpg` and
a `.m4b.sidecars.json` but no m4b - so there was never a choice to make between
four m4bs; only one exists.

That shipped pair is nevertheless **not usable as a parity reference**, for two
independent reasons, both measured:

1. **It was assembled from gap-padded copies that no longer exist.** The
   session's own `concat_list_sentences.txt` names
   `Z:\...\output\.gap-step_mtm2801w_edb8afca\<n>.flac`, a BookForge scratch
   directory (`electron/reassembly-bridge.ts:1341` creates `.gap-<jobId>` under
   the output dir) holding silence-padded rewrites of the chunk FLACs. It is
   deleted after the run. The session's shipped `metadata.txt` ends at
   `END=2623941` ms while the raw chunk sample sum is `2615396` ms: 8.545 s of
   inserted silence that cannot be reproduced from anything still on disk.
2. **The `.m4b.vtt` is not e2a's VTT.** It is ffmpeg re-muxing the m4b's
   embedded `mov_text` track back to WebVTT. Proven by round-tripping it:
   `ffmpeg -v error -i reference.m4b -map 0:s:0 -c:s webvtt out.vtt` reproduces
   the shipped sidecar byte-for-byte apart from a trailing newline. That
   round-trip prints `MM:SS.mmm` instead of e2a's `HH:MM:SS.mmm` and drops
   cue 132 (an empty payload), giving 132 cues for 133 chunks.

So the reference here is e2a's own output, regenerated on the local copy.

## How the reference was produced

- e2a checkout: `C:\Users\tellt\Projects\ebook2audiobook`, branch `bookforge`,
  HEAD `9daab0ba9360b4e9e8d538bd6da9b713fed2de21` (read-only; `E2A_TMP_DIR` was
  redirected so the checkout was not written to).
- Runtime: **1 m 22 s** (CPU only).

`--no_split` is passed because that is what BookForge's own reassembly bridge
passes (`electron/reassembly-bridge.ts:1519`), and CONTRACTS.md says to implement
the path the bridge actually exercises. It matters: without it e2a splits a book
over `default_output_split_hours` into parts that all export to the SAME
`final_name`, so part 2 silently overwrites part 1 and the "whole book" m4b is
only its tail. This book is 0.73 h and never splits either way.

```
cd C:\Users\tellt\Projects\ebook2audiobook
set E2A_TMP_DIR=C:\tmp\narrator-G\e2a-tmp
set PYTHONIOENCODING=utf-8
python_env\python.exe app.py --headless --assemble_only --skip_deps --no_split ^
  --tts_engine xtts ^
  --session ccd14111-da29-4fb0-a489-a19a0f126bac ^
  --session_dir C:\tmp\narrator-golden\kershaw\ebook-ccd14111-da29-4fb0-a489-a19a0f126bac ^
  --output_dir  C:\tmp\narrator-golden\kershaw\e2a-out
```

`PYTHONIOENCODING=utf-8` is required on Windows: e2a prints a `->` arrow and a
`Fuhrer` with an umlaut, and the cp1252 console encoder raises
`UnicodeEncodeError` inside the progress printer, which e2a converts into
`Failed to combine sentences for chapter 1`. It is a console artefact, not an
assembly failure.

`metadata.txt` in this fixture is the **regenerated** one, which ends at
`END=2615396` ms - exactly the chunk sample sum. The session's shipped
`metadata.txt` (`END=2623941`) belonged to the gap-padded run and is deliberately
not the file committed here; the regeneration overwrote it in the local copy.

## What this book is for

The short/fast one: 133 chunks, one chapter, ~44 min. Chunk 0 is a `[heading]`
row (bold cue) and chunk 132 is a bare `[break]` row whose cue text is empty and
whose audio is a real 2400-sample (0.1 s) silence - both edge cases the VTT and
the assembler have to get right.

## Gap realization (for builder A)

Measured on this book: **e2a's own assembly inserts nothing between chunks.**
The regenerated VTT's cue times equal the running sum of STREAMINFO sample
counts to within 0.000333 s (pure 3-decimal rounding), and the regenerated
`metadata.txt` total equals the sample sum exactly. Silence between sentences is
carried INSIDE the rendered chunks (the `[break]` row above is literally a chunk
of silence). Any padding in a shipped BookForge audiobook came from the
`.gap-<jobId>` pre-pass, which is a BookForge step upstream of e2a assembly, not
from e2a.
