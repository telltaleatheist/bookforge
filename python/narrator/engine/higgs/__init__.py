"""narrator.engine.higgs - the Higgs engines.

TWO THINGS LIVE HERE, and only one of them ships.

**`higgs-v3` (v3_served.py + v3_engine.py) IS THE SECOND ENGINE** (Owen,
2026-09-04 evening). Higgs TTS 3, 4B, served by vllm-omni over HTTP - a
`BackendSpec.kind == 'served'` backend that narrator launches, health-checks and
stops. Its facts are in those two modules.

**`higgs-v2-scaffold` (config/codec/prompt/transformers_backend/engine.py) IS
NOT SHIPPED.** Higgs v2 was dropped the same evening - "basically just Orpheus
and we know Orpheus better". The code is kept deliberately, as INTERFACE
SCAFFOLDING: a complete, tested reference implementation of
`narrator.engine.protocol` for an engine that is not SNAC, emits no pads, and
carries its voice as clips in a chat history. It proves the seams fit something
that is not Orpheus, without a server in the way. Nothing renders a book with
it, and no GPU smoke is owed for it - the registry id says so.

The v2 notes below stand as the record of what was measured. Built from the measured campaign
`E:\\training\\_campaigns\\2026-09-01-cod-full-rebuild\\higgs\\` (render_v2.py,
smoke_v2.py, v2_pokemon_para_log.json, HIGGS_NOTES.md), 2026-09-04 - the run
that cloned the deathstalker narrator from two reference clips and rendered nine
Pokemon paragraphs with EOS 9/9, zero runaways and zero cap hits.

    from narrator.engine.higgs import HiggsConfig, HiggsEngine, load_voice
    engine = HiggsEngine(HiggsConfig(voice=load_voice('deathstalker')))
    audio = engine.render_audio('It was a Saturday morning.')

Facts that shape every module here (all measured, none from the card):
  24 kHz mono; 8 codebooks x 1024 codes + stream bos 1024 / eos 1025; 25 LM
  steps per second of audio in a delay pattern; decode = the codec over the
  frame matrix after a `frames - 7` delay-pattern trim AND a content trim of the
  trailing sentinel run; NO pads and NO fades at either end (so `pads` is False
  and the assembler owns the gaps); EOS fires unaided, so there is no boost, no
  floor and no ladder; the voice is reference clips WITH BOOK-EXACT TRANSCRIPTS
  placed in the chat history.

Licence: Boson Higgs Audio 2 Community License. Attribution required ("Built
with Higgs Materials licensed from Boson AI USA, Inc." plus the Meta Llama 3
attribution) and any fine-tune we ship must carry "Higgs Audio 2" in its name.

Licence, v3: Boson Higgs TTS 3 Research and Non-Commercial - fine for personal
use and, under the Creator Use Grant, for credited creator content; production
deployment or embedding in a product needs separate licensing.

Importing this package costs no torch and no transformers.
"""
from .codec import HiggsCodec, HiggsStreamMisaligned
from .config import (HiggsBudget, HiggsConfig, HiggsDefaults,
                     higgs_config_from_worker_kwargs, higgs_stop_policy,
                     load_voice, load_voices)
from .engine import HiggsEngine
from .mlx_backend import (FrameFilterReport, HiggsMlxStreamMisaligned,
                          HiggsV3MlxBudget, HiggsV3MlxCodec, HiggsV3MlxConfig,
                          HiggsV3MlxEngine,
                          higgs_v3_mlx_config_from_worker_kwargs,
                          higgs_v3_mlx_stop_policy, real_code_frames,
                          revert_delay_pattern)
from .prompt import build_conversation
from .v3_engine import (HiggsV3Budget, HiggsV3Codec, HiggsV3Config,
                        HiggsV3Defaults, HiggsV3Engine,
                        higgs_v3_config_from_worker_kwargs,
                        higgs_v3_stop_policy)
from .v3_served import HiggsV3ServedBackend, HiggsV3ServerError

__all__ = [
    'HiggsBudget',
    'HiggsCodec',
    'HiggsConfig',
    'HiggsDefaults',
    'HiggsEngine',
    'HiggsStreamMisaligned',
    'HiggsV3Budget',
    'HiggsV3Codec',
    'HiggsV3Config',
    'HiggsV3Defaults',
    'HiggsV3Engine',
    'HiggsV3MlxBudget',
    'HiggsV3MlxCodec',
    'HiggsV3MlxConfig',
    'HiggsV3MlxEngine',
    'HiggsMlxStreamMisaligned',
    'FrameFilterReport',
    'HiggsV3ServedBackend',
    'HiggsV3ServerError',
    'build_conversation',
    'higgs_v3_config_from_worker_kwargs',
    'higgs_v3_mlx_config_from_worker_kwargs',
    'higgs_v3_mlx_stop_policy',
    'real_code_frames',
    'revert_delay_pattern',
    'higgs_v3_stop_policy',
    'higgs_config_from_worker_kwargs',
    'higgs_stop_policy',
    'load_voice',
    'load_voices',
]
