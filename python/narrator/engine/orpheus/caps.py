"""Per-voice tuning caps: the registry, and the three-step live lookup.

Ported from ebook2audiobook@9daab0ba lib/classes/tts_engines/orpheus.py:
VOICE_CAP_SOURCES / VOICE_CAP_IGNORED / _voice_caps (class block, lines 665-728),
`register_voice_caps` (1924), `_voice_cap` (1966) and `_max_chars_per_sec` (2142).

Pure arithmetic and dict lookups: NO torch, NO vLLM, NO mlx. This is one of the
modules the Windows test interpreter imports directly.
"""
import os


class CapsMixin:
    """Every constant on EngineDefaults is a DEFAULT, never the live value.

    One process can serve more than one voice - the BookForge streaming worker
    switches voices in-process against a resident engine, and per-character
    casting will mix voices inside a single batch - while each fine-tune wants
    its own numbers (deathstalker reads ~23.5 ch/s where the default guard is
    19.0; the bed-free voices need an EOS boost the stock ones must not get).
    Reading a class attribute bound at IMPORT pins whichever voice happened to
    be loaded first onto every later one, which is exactly the bug the streaming
    server worked around by rewriting os.environ per voice (process-global state
    that cannot describe a mixed-voice batch at all).

    So the live value is resolved per call by _voice_cap(), in this order:
      1. a cap registered for that voice (register_voice_caps)
      2. the process environment (ORPHEUS_*) - how the AUDIOBOOK worker is
         configured: the bridge spawns one process per voice and exports the
         catalog's values into it, so that path is unchanged
      3. the class default

    Keys are the camelCase names BookForge's catalog already uses
    (orpheusVoiceCapsForModel in electron/orpheus-models.ts), so a caps payload
    crosses the process boundary verbatim. Value = (env var, class attr).
    """

    VOICE_CAP_SOURCES = {
        'temperature':    ('ORPHEUS_TEMPERATURE',       'TEMPERATURE'),
        'topP':           ('ORPHEUS_TOP_P',             'TOP_P'),
        'minP':           ('ORPHEUS_MIN_P',             'MIN_P'),
        'repPenalty':     ('ORPHEUS_REP_PENALTY',       'REP_PENALTY'),
        'eosBoost':       ('ORPHEUS_EOS_BOOST',         'EOS_BOOST'),
        'eosBoostStart':  ('ORPHEUS_EOS_BOOST_START',   'EOS_BOOST_START'),
        'eosFloor':       ('ORPHEUS_EOS_FLOOR',         'EOS_FLOOR'),
        'eosFloorRate':   ('ORPHEUS_EOS_FLOOR_RATE',    'EOS_FLOOR_RATE'),
        'maxCharsPerSec': ('ORPHEUS_MAX_CHARS_PER_SEC', 'DEFAULT_MAX_CHARS_PER_SEC'),
    }

    # Catalog caps that are NOT generation tuning and are consumed elsewhere:
    # maxChars is a PREP concern (how the packer packs sentences into chunks) and
    # sentenceGap is an ASSEMBLY concern (_classify_gap / ORPHEUS_SENTENCE_GAP).
    # They ride the same catalog payload, so register_voice_caps accepts and
    # ignores them by NAME rather than swallowing anything it doesn't recognise -
    # an unknown key is a typo or a catalog/engine version skew and must be loud.
    VOICE_CAP_IGNORED = ('maxChars', 'sentenceGap')

    # voice token -> {cap key: float}. CLASS-level, not an instance attribute and
    # deliberately NOT in the model registry: the streaming worker rebuilds its
    # engine instance whenever the model changes, and the registry is the MODEL
    # cache. Caps hold no weights, so keeping them for the life of the process
    # costs nothing.
    #
    # The LoRA registry, by contrast, BELONGS in the model registry: its ids key
    # a cache that lives inside the vLLM engine object, so it must die exactly
    # when the engine does. _evict_global_cache drops both together.
    _voice_caps = {}

    @classmethod
    def register_voice_caps(cls, voice: str, caps: dict) -> dict:
        """Register `voice`'s per-voice generation tuning (see VOICE_CAP_SOURCES).

        This is the API the BookForge streaming worker calls on every voice load:
        it is RESIDENT and switches voices without respawning, so its caps cannot
        ride the spawn environment the way the audiobook worker's do. Registering
        them per voice - instead of rewriting os.environ, which is one global slot
        for the whole process - is also what makes a mixed-voice batch possible:
        every sampling value is resolved from the voice of the ITEM.

        Registration REPLACES whatever the voice had, so a cap the new payload
        omits reverts to env/class default rather than lingering from an earlier
        one. Values must be numeric; a key that is neither a cap nor one of the
        explicitly-ignored non-tuning keys (VOICE_CAP_IGNORED) raises - silently
        dropping it would mean a mis-tuned voice renders a whole book with no
        sign anything was wrong. Returns the normalised caps actually stored.
        """
        if not voice:
            raise ValueError('OrpheusEngine.register_voice_caps() requires a voice token')
        stored = {}
        for key, value in (caps or {}).items():
            if key in cls.VOICE_CAP_IGNORED:
                continue
            if key not in cls.VOICE_CAP_SOURCES:
                raise ValueError(
                    f"OrpheusEngine.register_voice_caps({voice!r}): unknown cap '{key}'. "
                    f'Known: {", ".join(sorted(cls.VOICE_CAP_SOURCES))} '
                    f'(ignored: {", ".join(cls.VOICE_CAP_IGNORED)}).'
                )
            if value is None:
                continue
            try:
                stored[key] = float(value)
            except (TypeError, ValueError):
                raise ValueError(
                    f"OrpheusEngine.register_voice_caps({voice!r}): cap '{key}' must be a "
                    f'number, got {value!r}'
                )
        cls._voice_caps[voice] = stored
        return stored

    def _voice_cap(self, key: str, voice: str = None) -> float:
        """The LIVE value of one tuning cap for `voice` (default: this instance's
        voice): registered per-voice cap -> ORPHEUS_* env var -> class default.
        See VOICE_CAP_SOURCES for the full rationale.

        The env var is re-read on every call by design - it is the audiobook
        worker's channel (one voice per process, exported at spawn) and reading it
        here rather than at import is what lets the same lookup serve both paths.
        """
        env_name, attr = self.VOICE_CAP_SOURCES[key]
        if voice is None:
            voice = self.voice
        registered = self._voice_caps.get(voice)
        if registered is not None and key in registered:
            return registered[key]
        raw = os.environ.get(env_name)
        if raw is not None:
            return float(raw)
        return float(getattr(self, attr))

    def _max_chars_per_sec(self, voice: str = None) -> float:
        """The truncation guard's chars/sec threshold for `voice` (default: this
        instance's voice), resolved fresh on every call.

        Single source for both the env var name and its default (see
        DEFAULT_MAX_CHARS_PER_SEC). Callers keep the '<= 0 disables the guard'
        semantics themselves - this returns whatever was configured, including 0,
        rather than deciding for them.
        """
        return self._voice_cap('maxCharsPerSec', voice)
