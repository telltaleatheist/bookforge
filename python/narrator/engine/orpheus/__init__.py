"""narrator.engine.orpheus - the Orpheus TTS engine, ported out of ebook2audiobook.

It is narrator's FIRST implementation of `narrator.engine.protocol.Engine`
(registry id `orpheus`). The modules below moved here UNCHANGED from
`narrator/engine/*.py` when the engine interface was extracted (2026-09-04);
only their import paths moved. `interface.py` is the one addition - the
protocol surface (codec / budget / stop_policy / backend_spec / pads /
edge_fade_ms), which reads the same constants and the same per-voice cap lookup
the engine already had. See ../PORT_NOTES.md for the old -> new table.


Ported from ebook2audiobook@9daab0ba lib/classes/tts_engines/orpheus.py (5,507
lines), lib/classes/tts_engines/orpheus_stream_decode.py,
lib/classes/tts_engines/orpheus_mlx_fastpath.py, the platform CUDA block of
lib/conf.py, and the four helpers orpheus.py took from
lib/classes/tts_engines/common/. See PORT_NOTES.md for the full dependency
table, the function -> module map, and the list of dead code left behind.

    from narrator.engine import EngineConfig, OrpheusEngine

    eng = OrpheusEngine(EngineConfig(
        voice='deathstalker',
        base_dir='/home/telltale/orpheus-models/_base',
        adapter_dir='/home/telltale/orpheus-models/deathstalker',
        sentences_dir=session / 'chapters' / 'sentences',
        process_dir=session,
    ))
    eng.convert_batch([(0, 'Chapter one.'), (1, 'It was a dark and stormy night.')])

Importing this package does NOT import torch, vLLM or mlx: every backend defers
those to the function that needs them, which is what lets the caps / prompt /
sampling / snac / guard arithmetic be tested on an interpreter with none of
them installed.
"""
from .config import EngineConfig, EngineDefaults
from .engine import OrpheusEngine
from .errors import TokenStreamMisaligned, is_fatal_cuda_error
from .interface import OrpheusBudget, OrpheusCodec, OrpheusInterfaceMixin
from .snac import (LEFT_CONTEXT_FRAMES, PAYLOAD_FRAMES, RIGHT_CONTEXT_FRAMES,
                   SAMPLES_PER_FRAME, TOKENS_PER_FRAME, StreamDecodeMisaligned,
                   WindowedFrameEmitter)

__all__ = [
    'EngineConfig',
    'EngineDefaults',
    'OrpheusBudget',
    'OrpheusCodec',
    'OrpheusEngine',
    'OrpheusInterfaceMixin',
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
