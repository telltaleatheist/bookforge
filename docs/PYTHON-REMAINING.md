# Python remaining, and why

After B6 step 8, BookForge's own audiobook path (prep, assembly, alignment, resume, session listing, m4b tags)
runs no Python, and Higgs serving is Crucible's. This is every piece of Python left in the repo that the app or a
CLI still reaches, and what reaches it. The plan's scope line decides most of it: "cli/*.py and ClipForge stay as
they are" (`docs/REORG-PLAN.md`), so whatever they depend on stays, even inside `python/` or `electron/scripts/`.

## Kept for the command line

| File | Consumer | Why it stays |
|---|---|---|
| `python/narrator/` (18 modules, listed in `python/README.md`) | `electron/scripts/align_audiobook.py` | Its qwen3 arm imports `narrator.align.aligner` and `narrator.align.run` |
| `python/narrator/text/caps_acronyms.json` | `python/narrator/text/paragraph_packer.py` | Read at import. The app's copy is `shared/text/caps_acronyms.json`; `tools/test-one-fact-one-owner.js` holds them equal |
| `electron/scripts/align_audiobook.py` | `cli/align_book_chapters.py` | Runs it directly. The app does not; `electron/whisperx-align-bridge.ts` only names it in comments |
| `electron/scripts/measure_cue_edges.py` | `cli/align_book_chapters.py` | Same. It imports nothing from narrator |
| `cli/bookforge-tts.py`, `cli/align_book_chapters.py`, `cli/cue_window_check.py` | operators | Out of scope |
| `cli/orpheus-batch-render.js`, `cli/orpheus-audiobook-render.js` (JavaScript, named here because of their names) | `cli/bookforge-tts.py:92-93` | Despite the names, they are that CLI's Higgs render doors. Their Orpheus-only flags refuse by name |

## Kept for ClipForge

| File | Consumer | Why it stays |
|---|---|---|
| `electron/scripts/run_audio_separator.py` | `electron/denoise-bridge.ts` `runSeparator`, reached only from `denoiseFile`, whose only caller is `electron/clipforge-chain.ts` | The app's own denoise goes through Crucible (`crucibleBlockSeparator`) |
| `cli/py/*.py` | `cli/clipforge-process.js` | ClipForge's workers |

## Kept for the rest of the app

These were never part of narrator, and step 8 does not touch them.

| File | Consumer | Why it stays |
|---|---|---|
| `electron/scripts/vllm/text_model_download.py`, `serve_text_vllm.sh` | `electron/text-server.ts` | The local text server, in WSL |
| The tools env's Python (`electron/tools-env-bootstrap.ts`, which checks `fitz` and `numpy`) | `electron/vlm-convert.ts` (PyMuPDF), `electron/components/component-manager.ts` | Page conversion and component checks. The tools env outlives narrator; only its narrator role went |

## Data kept, read by no code

| File | State |
|---|---|
| `electron/data/orpheus-models.json` | Kept by the lead's ruling, as data for ClipForge and `cli/bookforge-tts.py`. **No code reads it.** The app's one reader, `orpheus-assembly-tuning.ts`, was deleted in step 8, and neither ClipForge nor that CLI opens it: `cli/clipforge-process.js:1352` names it in a help line, and `tools/test-higgs-engine.js:1794`, `electron/higgs-models.ts:375` and `settings.service.ts:302` name it in comments. It is a record of the measured tuning |

## Standalone tools

`tools/*.py`, `tools/foundry-ocr/`, `tools/ocr-lab/`, `tools/aligner/`, `tools/catalog-indexer/`, `tools/blocks/`,
`scripts/test-pymupdf-redaction.py` and `test-pymupdf-redact.py` are developer tools. The app reaches none of them.

## Known bug, left alone

`cli/align_book_chapters.py --help` crashes on a literal `%` in a help string (`ValueError: unsupported format
character`). It did so before step 8, and `cli/*.py` is out of scope. Running the script without `--help` is
unaffected.

## What removes the rest

`python/` and `electron/scripts/align_audiobook.py` go when `cli/align_book_chapters.py`'s qwen3 arm moves or goes.
