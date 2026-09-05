"""narrator.engine - the engine seam and the engines behind it.

    engine/
      protocol.py   Engine, Codec, VoiceRef, Budget, StopPolicy, BackendSpec,
                    ServedBackend  (typing.Protocol + dataclasses; no torch)
      registry.py   engine id -> (engine class, config) factories
      orpheus/      the Orpheus port (registry id 'orpheus')
      higgs/        Higgs v2 via transformers (registry id 'higgs-v2')

Importing this package still costs no torch, no vLLM, no mlx and no
transformers: every backend defers its heavy imports to the function that needs
them, and the registry's values are factories that import on demand.

    from narrator.engine import EngineConfig, OrpheusEngine
    from narrator.engine import registry
    engine = registry.engine_class('higgs-v2')(registry.engine_config('higgs-v2', ...))

WHY `OrpheusEngine` AND `EngineConfig` ARE STILL EXPORTED HERE. They were this
package's public surface before the interface was extracted, and
`render/worker.py` (another builder's column) plus the serve worker and the
engine tests import them by that name. Re-exporting keeps a one-engine caller
writing exactly what it wrote before; a caller that needs to CHOOSE an engine
goes through `registry`.
"""
import importlib as _importlib
import sys as _sys

from . import protocol, registry
from .orpheus import (EngineConfig, EngineDefaults, LEFT_CONTEXT_FRAMES,
                      OrpheusEngine, PAYLOAD_FRAMES, RIGHT_CONTEXT_FRAMES,
                      SAMPLES_PER_FRAME, StreamDecodeMisaligned,
                      TOKENS_PER_FRAME, TokenStreamMisaligned,
                      WindowedFrameEmitter, is_fatal_cuda_error)
from .orpheus import asr_gate as _asr_gate     # noqa: F401  (see the alias block)
from .protocol import (BackendSpec, Budget, ClipsVoice, Codec,
                       DescriptionVoice, Engine, ReferenceClip, ServedBackend,
                       SpeechRequest, StopPolicy, TokenVoice)

# ---------------------------------------------------------------------------
# Compatibility aliases for the Orpheus modules' OLD import paths.
#
# Until 2026-09-04 every Orpheus module sat directly under `narrator/engine/`,
# and three kinds of caller import them by that path: `render/worker.py`
# (`from ..engine.config import EngineConfig` - another builder's column, not
# touched by this change) and the engine test modules, which name
# `narrator.engine.snac`, `narrator.engine.mlx_fastpath` and every module in
# `tests/test_engine_lazy_imports.py`'s list. Rather than edit files outside
# this column - and rather than leave 17 one-line shim MODULES lying around,
# which would be 17 second module objects with their own class identities - the
# old dotted names are bound to THE SAME module objects the package just
# imported.
#
# These are aliases, not modules: `narrator.engine.snac is
# narrator.engine.orpheus.snac` is True, so a class is one class however it was
# reached. `import narrator.engine.snac` works because the import machinery
# re-checks sys.modules after importing a parent package (CPython
# `_find_and_load_unlocked`, the branch commented "Crazy side-effects!").
#
# CANONICAL PATH IS `narrator.engine.orpheus.<module>`. Everything inside this
# column already uses it. When render/ and the engine tests are re-pointed, this
# block goes away with them.
#
# `registry` is DELIBERATELY NOT in this list: `narrator.engine.registry` is now
# the ENGINE registry (id -> factory), and Orpheus's loaded-model cache is
# `narrator.engine.orpheus.registry` (e2a's `loaded_tts`). Nothing outside
# engine/orpheus/ ever imported the latter.
#
# The aliases are bound for modules the imports above ALREADY pulled in. Two
# are not pulled in by `from .orpheus import ...` on its own:
#   asr_gate      light (difflib/os/re at module scope; torch is lazy inside),
#                 imported explicitly above so `import narrator.engine.asr_gate`
#                 keeps resolving - tests/test_engine_lazy_imports.py imports it
#                 by that exact dotted path, in a fresh subprocess.
#   mlx_fastpath  HEAVY: its module scope does `import mlx.core`, so it must not
#                 be imported on a machine without MLX. It is reached through
#                 this package's `__getattr__` instead, which is what
#                 `from narrator.engine import mlx_fastpath` uses and what the
#                 MLX tests already do.
_MOVED_TO_ORPHEUS = (
    'adapters', 'asr_gate', 'audio', 'caps', 'config', 'cuda_env', 'engine',
    'errors', 'guards', 'mlx_backend', 'mlx_fastpath', 'prompt', 'sampling',
    'snac', 'text', 'transformers_backend', 'vllm_backend',
)
for _name in _MOVED_TO_ORPHEUS:
    _moved = _sys.modules.get(f'{__name__}.orpheus.{_name}')
    if _moved is not None:
        _sys.modules[f'{__name__}.{_name}'] = _moved
del _name, _moved


def __getattr__(name):
    """`from narrator.engine import <moved module>` for a module the package
    import did not already bind - see _MOVED_TO_ORPHEUS. Anything else is a
    plain AttributeError, as it was before."""
    if name in _MOVED_TO_ORPHEUS:
        module = _importlib.import_module(f'.orpheus.{name}', __name__)
        _sys.modules[f'{__name__}.{name}'] = module
        return module
    raise AttributeError(f'module {__name__!r} has no attribute {name!r}')

__all__ = [
    # the seam
    'BackendSpec',
    'Budget',
    'ClipsVoice',
    'Codec',
    'DescriptionVoice',
    'Engine',
    'ReferenceClip',
    'ServedBackend',
    'SpeechRequest',
    'StopPolicy',
    'TokenVoice',
    'protocol',
    'registry',
    # Orpheus, re-exported at its historical path
    'EngineConfig',
    'EngineDefaults',
    'OrpheusEngine',
    'TokenStreamMisaligned',
    'StreamDecodeMisaligned',
    'is_fatal_cuda_error',
    'WindowedFrameEmitter',
    'PAYLOAD_FRAMES',
    'RIGHT_CONTEXT_FRAMES',
    'LEFT_CONTEXT_FRAMES',
    'SAMPLES_PER_FRAME',
    'TOKENS_PER_FRAME',
]
