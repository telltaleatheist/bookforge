"""Engine id -> the class that implements it and the config that builds it.

Three ids today, and only two of them are meant to render a book:

    orpheus            narrator.engine.orpheus.OrpheusEngine  (vLLM / MLX /
                       transformers, in-process) - the shipping engine.
    higgs-v3           narrator.engine.higgs.HiggsV3Engine    (vllm-omni, SERVED)
                       - the second engine (Owen, 2026-09-04 evening).
    higgs-v2-scaffold  narrator.engine.higgs.HiggsEngine      (transformers,
                       in-process) - NOT SHIPPED. Higgs v2 was dropped ("it is
                       basically just Orpheus and we know Orpheus better"); the
                       code stays as a reference implementation of the Protocol,
                       proving a non-SNAC, no-pads, clips-in-history engine fits
                       the seams. Its id says so on purpose: nothing should
                       select it by accident, and no GPU smoke is owed for it.

The id is what `NARRATOR_ENGINE` carries into `python -m narrator.serve`, and
what the per-voice tuning catalog keys on together with the voice
(`docs/NARRATOR_PLAN.md`: "the ladder/caps machinery key on (engine, voice), not
voice alone").

WHY FACTORIES AND NOT A DICT OF CLASSES. Importing an engine class imports its
backend module, and a backend module is where the heavy imports live. The
registry must be readable - "which engines exist?", "is 'higgs-v2' known?" - on
an interpreter with neither torch nor transformers installed, which is the
interpreter narrator's tests run on. So the values are zero-argument callables
that import on demand, and `ids()` never imports anything.

NO FALLBACK. An unknown id RAISES, naming the id and listing the known ones. It
does not default to Orpheus: an engine substitution is a whole book rendered by
the wrong model and reported as success.

This module holds NO process state. Orpheus's loaded-model cache (e2a's
`loaded_tts`) moved with the rest of the Orpheus port and is now
`narrator.engine.orpheus.registry.LOADED`.
"""


def _orpheus_engine():
    from .orpheus import OrpheusEngine
    return OrpheusEngine


def _orpheus_config(**kwargs):
    from .orpheus import EngineConfig
    return EngineConfig(**kwargs)


def _higgs_v3_engine():
    from .higgs import HiggsV3Engine
    return HiggsV3Engine


def _higgs_v3_config(**kwargs):
    from .higgs import higgs_v3_config_from_worker_kwargs
    return higgs_v3_config_from_worker_kwargs(**kwargs)


def _higgs_v2_scaffold_engine():
    from .higgs import HiggsEngine
    return HiggsEngine


def _higgs_v2_scaffold_config(**kwargs):
    from .higgs import higgs_config_from_worker_kwargs
    return higgs_config_from_worker_kwargs(**kwargs)


# id -> (engine class factory, config factory). Both are called with no imports
# performed until then; see the module docstring.
ENGINES = {
    'orpheus': (_orpheus_engine, _orpheus_config),
    'higgs-v3': (_higgs_v3_engine, _higgs_v3_config),
    'higgs-v2-scaffold': (_higgs_v2_scaffold_engine, _higgs_v2_scaffold_config),
}

DEFAULT_ENGINE_ID = 'orpheus'


def ids():
    """Every known engine id, sorted. Imports nothing."""
    return sorted(ENGINES)


def _entry(engine_id: str):
    if engine_id not in ENGINES:
        raise ValueError(
            f"Unknown narrator engine '{engine_id}'. Known engines: "
            f"{', '.join(ids())}. Refusing to substitute '{DEFAULT_ENGINE_ID}' - "
            'rendering a book with a different model than the one asked for is a '
            'silent failure.')
    return ENGINES[engine_id]


def engine_class(engine_id: str):
    """The Engine implementation for `engine_id`. Imports its backend module."""
    return _entry(engine_id)[0]()


def engine_config(engine_id: str, **kwargs):
    """The config object `engine_class(engine_id)` takes, built from the
    worker's keyword arguments. Each engine's factory decides which keywords it
    understands and REFUSES the rest by name."""
    return _entry(engine_id)[1](**kwargs)
