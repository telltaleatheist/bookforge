"""Assembly: manifest -> chapter audio -> AAC -> one m4b, plus the VTT.

Reads ONLY a Manifest. Nothing in here opens session-state.json or knows what an
e2a session directory looks like; `narrator.render.session_v1` is the only bridge
between the two.

`assemble` IS LAZY (PEP 562), and that is load-bearing rather than tidy.
Importing it pulls in `encode` -> `chapters` -> `edges` -> **soundfile**, which
the assembly envs have and the WHISPERX env does not. `align/sentences.py`
imports `assemble.vtt` for `format_timestamp` and `chunk_spans` - deliberately,
so a sentence cue and its chunk cue round the same number the same way - and
importing a submodule runs this file. Eager, that made
`python -m narrator.align.worker` die on `No module named 'soundfile'` inside the
whisperx env before it aligned a single chunk. `from narrator.assemble import
assemble` still works and still imports everything; it just does it when asked.
"""


def __getattr__(name):
    if name in ('AssembleResult', 'assemble'):
        from . import run
        return getattr(run, name)
    raise AttributeError(f'module {__name__!r} has no attribute {name!r}')


def __dir__():
    return sorted(list(globals()) + ['AssembleResult', 'assemble'])
