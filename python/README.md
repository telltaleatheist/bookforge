# python/

This exists for one caller: `cli/align_book_chapters.py`, whose qwen3 arm runs
`electron/scripts/align_audiobook.py`, which imports `narrator.align.aligner` and
`narrator.align.run`. The app runs none of it. Audiobook prep, assembly and alignment are TypeScript
(`electron/narrator/`), and Higgs serving belongs to Crucible.

It stays because `cli/*.py` stays as it is (`docs/REORG-PLAN.md`). When that arm moves or goes, this
directory goes.

## The modules, and nothing else

Importing those two modules loads exactly these 18:

| Package | Modules |
|---|---|
| `narrator` | `__init__`, `manifest` |
| `narrator.align` | `__init__`, `aligner`, `coverage`, `env`, `run`, `sentences`, `window` |
| `narrator.assemble` | `__init__`, `coverage_gate`, `engine_profiles`, `sentence_vtt`, `vtt` |
| `narrator.text` | `__init__`, `lang`, `paragraph_packer`, `sml` |

`narrator/text/caps_acronyms.json` is the packer's data, which it reads at import. The app's copy is
`shared/text/caps_acronyms.json`, and `tools/test-one-fact-one-owner.js` holds the two equal.

Some functions in these modules still name modules that are gone (`assemble.run`, `text.chapters`,
`text.packer`). They import them lazily, and nothing on the qwen3 arm calls them.

## How it is found

`align_audiobook.py` looks on `PYTHONPATH`, then walks up from its own file to this directory. Nothing
installs it, so there is no `pyproject.toml`.
