"""The stanza seam - and the measurement that closes it.

Ported from ebook2audiobook@9daab0ba:
  lib/core.py   get_chapters (837), the stanza.Pipeline construction at :920-941
  lib/conf.py   os.environ['STANZA_RESOURCES_DIR'] = <e2a_root>/models/stanza (:78)

`docs/NARRATOR_PLAN.md` step 4 says "text/ ports the packer (stanza stays until
parity is shown on the golden set)". THIS MODULE IS THE ANSWER TO THAT SENTENCE,
and the answer is that on the path narrator renders, stanza was never doing any
work.

## What e2a actually does with stanza

ONE construction, at `get_chapters` (core.py:920):

    if session['language'] in year_to_decades_languages:      # 'eng' IS in it
        stanza_nlp = stanza.Pipeline(session['language_iso1'],
                                     processors='tokenize,ner,mwt',
                                     use_gpu=<device is CUDA/ROCm/XPU>,
                                     download_method=DownloadMethod.REUSE_RESOURCES,
                                     dir=os.getenv('STANZA_RESOURCES_DIR'))

and ONE consumer, in `filter_chapter`:

    if tts_engine == TTS_ENGINES['ORPHEUS']:
        ... book-exact, no lexical transform ...
    elif stanza_nlp:
        ... get_date_entities(text, stanza_nlp) -> year2words / num2words ...

The pipeline is built for every English book and consulted only from the `elif`.
**For Orpheus that `elif` is unreachable**, so the pipeline is loaded, held in
`loaded_tts`, and never asked a question. The processors are `tokenize,ner,mwt`
and the thing wanted from it is NER date spans - it was never the sentence
segmenter. e2a's sentence segmentation is `get_sentences`' PASS 1 regex, top to
bottom (`text/packer.py`).

So: narrator's packer needs no stanza, and no stanza model, and the two versions
in the two envs cannot make the chunk lists differ, because neither version is
ever called. `tests/test_text_prep_golden.py` proves it by producing byte-identical
chunk lists under both interpreters with **no stanza imported at all**:
`narrator.text` never imports the package. stanza IS installed in both
environments, at two different versions - that is the table below, and it is the
whole point. What narrator never does is call it.

## The stanza facts per machine (measured 2026-09-04)

| machine | interpreter | stanza | STANZA_RESOURCES_DIR | models present |
|---|---|---|---|---|
| Windows | `ebook2audiobook\\python_env\\python.exe` (3.12.12) | 1.10.1 | `<e2a>\\models\\stanza` (set by `lib/conf.py:78`, NOT in the ambient env) | **NONE** - the directory does not exist |
| WSL Ubuntu | `/home/telltale/anaconda3/envs/orpheus_tts/bin/python` (3.11.14) | 1.11.0 | `/home/telltale/ebook2audiobook/models/stanza` (same line) | `en`, `de`, `resources.json` - 591 MB |

`STANZA_RESOURCES_DIR` is unset in both ambient environments (checked in WSL
through a login shell, which is how `spawnWithWslSupport` runs Orpheus); e2a sets
it itself from `models_dir` at import.

## What that means, stated as a behaviour difference

e2a's English prep on WINDOWS has no stanza models to reuse, so
`stanza.Pipeline(...)` either downloads ~591 MB or raises - and if it raises,
`get_chapters` returns `[]` and the whole prep fails. All three goldens were
prepped in WSL, where the models are present, which is why they exist at all.

narrator does not construct the pipeline. That REMOVES a model load, 591 MB of
per-machine state and a failure mode; it adds none, and it cannot change a single
chunk, because the object was never consulted. Recorded in `text/PORT_NOTES.md`
as behaviour difference 1 - the only one in this column that a reader could call
a deviation rather than a transcription.

If a future engine needs the date/NER transform back, this is where it goes: build
the pipeline here, hand it to `chapters.filter_chapter`, and the `elif` branch
comes back with it.
"""
from __future__ import annotations

#: e2a's processor list, recorded so the seam is documented rather than guessed
#: if it is ever reopened. Not used.
E2A_STANZA_PROCESSORS = 'tokenize,ner,mwt'

#: The environment variable `lib/conf.py:78` sets, and which e2a's Pipeline reads
#: back through `os.getenv`. narrator never sets it and never reads it.
STANZA_RESOURCES_DIR_ENV = 'STANZA_RESOURCES_DIR'
