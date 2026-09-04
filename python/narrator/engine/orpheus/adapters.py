"""LoRA voices: validation, the vLLM id registry, and the MLX wrapper applier.

Ported from ebook2audiobook@9daab0ba lib/classes/tts_engines/orpheus.py:
  _MlxAdapterState (106)              _mlx_lora_linear_cls (133)
  _validate_adapter_mode (910)        validate_adapter_dir (977)
  _read_adapter_config (1010)         _validate_adapter_config (1018)
  _validate_adapter_config_vllm (1052) _validate_adapter_config_mlx (1066)
  _mlx_lora_scale (1349)              _mlx_walk (1366)
  _mlx_adapter_plan (1377)            _apply_mlx_adapter (1481)
  _clear_mlx_adapter (1518)           _sync_mlx_adapter (1532)
  _adapter_fingerprint (1688)         _register_lora (1707)
  register_adapter (1771)             set_voice (1805)
  adapter_capable (1869)              _lora_request (1888)

The session-dict reads of `_validate_adapter_mode` become EngineConfig reads;
`loaded_tts` becomes narrator.engine.registry.LOADED. Nothing else moves.

mlx and vllm are imported LAZILY, inside the arms that need them - a stock or
merged session may be running on a machine that has neither.
"""
import math
import os

from .registry import LOADED

_MLX_LORA_LINEAR = None


class _MlxAdapterState:
    """What is applied to the resident MLX model right now, and how to take it off.

    `sites` is a list of (path, parent_module, attr_name, original_module): the
    ORIGINAL projection module for every site the current adapter wrapped. Clearing
    is therefore exact UNWRAPPING - put each original back where it was - never
    arithmetic un-fusing, which on bf16 weights would leave a slightly different
    model behind after every voice switch and drift over a session.

    Deliberately a plain object and not a dict/tuple: mlx's Module.__setattr__ files
    arrays, dicts, lists and tuples into the module's own parameter dict (a Module IS
    a dict), so a state object of any of those shapes would be walked by
    parameters()/eval() as if it were part of the model. Anything else lands as an
    ordinary Python attribute, which is what this needs to be.
    """

    __slots__ = ('adapter_dir', 'fingerprint', 'sites')

    def __init__(self, adapter_dir, fingerprint, sites):
        self.adapter_dir = adapter_dir
        self.fingerprint = fingerprint
        self.sites = sites


def _mlx_lora_linear_cls():
    """The nn.Module that adds one LoRA delta to one projection, built on first use.

    y = base(x) + scale * (x @ A.T) @ B.T

    A PURE FUNCTION OF x, with no state and no shape assumptions beyond the last
    dimension: that is what keeps it compatible with mlx_lm's BatchGenerator, which
    calls the model with (batch, tokens) during prefill and (batch, 1) per decode
    step, at whatever width the batch happens to be. Anything that cached a shape,
    or that behaved differently on the first call, would produce a model that is
    correct solo and wrong in a batch - the hardest possible thing to hear.

    The two matmuls are kept SEPARATE (x@A.T then @B.T) rather than folded into a
    single (B@A) delta matrix: r=64 against 3072x8192 means the pair costs ~2% of
    the base projection, while materialising B@A would cost a full-size matmul per
    layer per step AND another 5 GB resident.
    """
    global _MLX_LORA_LINEAR
    if _MLX_LORA_LINEAR is None:
        import mlx.nn as nn

        class _OrpheusMlxLoRALinear(nn.Module):
            def __init__(self, base, lora_a, lora_b, scale):
                super().__init__()
                self.base = base          # the ORIGINAL nn.Linear, untouched
                self.lora_a = lora_a      # (r, in_features)
                self.lora_b = lora_b      # (out_features, r)
                self.scale = scale        # float: lora_alpha / r

            def __call__(self, x):
                return self.base(x) + (x @ self.lora_a.T) @ self.lora_b.T * self.scale

        _MLX_LORA_LINEAR = _OrpheusMlxLoRALinear
    return _MLX_LORA_LINEAR


class AdaptersMixin:

    # ---- construction-time validation ---------------------------------------

    def _validate_adapter_mode(self):
        """Reject a half-configured adapter mode before anything loads.

        Every case here would otherwise still PRODUCE audio - in the base voice, in
        a merged voice, or in leah - which is indistinguishable from success until
        someone listens to the finished book. There is no fallback to stock or to
        merged mode: a voice that cannot be served as asked is a hard error.

        THREE legal shapes, not two:

          (model_dir, None)          MERGED - the voice IS the weights.
          (None, base+adapter)       ADAPTER - a LoRA over the shared base.
          (None, base only)          STOCK-FROM-LOCAL-BASE - the built-in voices,
                                     served from the local `_base` copy of
                                     unsloth/orpheus-3b-0.1-ft instead of the HF
                                     cache, on an engine built LoRA-capable.

        base-without-adapter used to be fatal. It is now the deliberate KEY COLLAPSE
        that makes stock<->adapter switching free on the resident streaming server:
        both sessions name the same base, so they are the same engine, so no 6 GB
        reload and no chance of a mid-session HF download on a cold cache.

        The safety argument that makes it acceptable to have a "no adapter attached"
        render path on an adapter-capable engine: a CUSTOM voice can never reach it.
        Only tokens in VALID_VOICES are accepted by the stock branch of __init__ and
        by the streaming server's _row_voice, and every custom voice must have been
        registered against the LIVE engine before a request may name it.

        ADAPTER-without-base is still fatal: an adapter has nothing to apply itself
        to, and the base must already be installed - a render job never downloads it
        mid-job.
        """
        if self.adapter_dir and self.custom_model_dir:
            raise ValueError(
                f'Orpheus got both model_dir ({self.custom_model_dir}) and '
                f'adapter_dir ({self.adapter_dir}). They select different '
                'weights and only one voice can be rendered - pass exactly one.'
            )
        if self.base_dir and self.custom_model_dir:
            raise ValueError(
                f'Orpheus got both model_dir ({self.custom_model_dir}) and '
                f'base_dir ({self.base_dir}). A merged fine-tune IS its own '
                'weights and is never served on top of a base - pass exactly one.'
            )
        if self.adapter_dir and not self.base_dir:
            raise ValueError(
                f'Orpheus adapter mode ({self.adapter_dir}) requires base_dir. '
                'The base model must already be installed locally - a render job never '
                'downloads it mid-job.'
            )
        if not self.base_dir:
            return
        base_config = os.path.join(self.base_dir, 'config.json')
        if not os.path.isfile(base_config):
            raise ValueError(
                f'Orpheus base dir {self.base_dir} is not a model folder: {base_config} is missing'
            )
        if self.adapter_dir:
            # UNIVERSAL checks only: the backend has not been detected yet (that happens
            # in load_engine, which re-validates against it before loading any weights).
            # An adapter that is broken for everyone should still fail here, at
            # construction, rather than after a 6 GB load.
            self.validate_adapter_dir(self.adapter_dir)

    @classmethod
    def validate_adapter_dir(cls, adapter_dir: str, backend: str = None):
        """Every check an adapter folder must pass before it is asked to serve a voice.

        Extracted so ENGINE CONSTRUCTION (_validate_adapter_mode, first adapter) and
        LATE REGISTRATION (register_adapter / set_voice, the 2nd..Nth adapter added to
        a warm engine on the streaming server) run the IDENTICAL validation. They used
        not to: only __init__ validated, so a bad adapter registered onto a live engine
        detonated inside engine.generate() - an opaque vLLM error that fails the
        whole batch, at render time, with nothing naming the adapter. A bad adapter
        must fail at REGISTRATION, with the readable reason, every time.

        `backend` selects which BACKEND-SPECIFIC checks run on top of the universal
        ones. Two backends can now apply a LoRA and they refuse different things, so
        parroting one's limits at the other is worse than not checking. None (the
        default) runs the universal checks alone - that is what construction does,
        before the backend has been detected; load_engine re-validates with the real
        backend before it loads any weights.
        """
        for name in ('adapter_config.json', 'adapter_model.safetensors'):
            path = os.path.join(adapter_dir, name)
            if not os.path.isfile(path):
                raise ValueError(f'Orpheus adapter dir {adapter_dir} is missing {name}')
        path = os.path.join(adapter_dir, 'adapter_config.json')
        config = cls._read_adapter_config(adapter_dir)
        cls._validate_adapter_config(path, config)
        if backend == 'vllm':
            cls._validate_adapter_config_vllm(path, config)
        elif backend == 'mlx':
            cls._validate_adapter_config_mlx(path, config)

    @staticmethod
    def _read_adapter_config(adapter_dir: str) -> dict:
        """The adapter's PEFT config as a dict. One reader, so validation and the MLX
        applier can never disagree about what the file said."""
        import json as _json
        with open(os.path.join(adapter_dir, 'adapter_config.json'), 'r', encoding='utf-8') as handle:
            return _json.load(handle)

    @classmethod
    def _validate_adapter_config(cls, path: str, config: dict):
        """The checks that hold for ANY applier of a LoRA, on any backend.

        Each one names something that would otherwise be silently DROPPED from the
        voice - the failure mode this whole engine is built against, because dropping
        part of a fine-tune still produces confident, finished-sounding audio."""
        if config.get('peft_type', 'LORA') != 'LORA':
            raise ValueError(
                f'Orpheus adapter {path}: peft_type={config["peft_type"]!r}. Only plain '
                'LoRA adapters can be applied - anything else would be ignored.'
            )
        rank = config.get('r')
        if not isinstance(rank, int) or rank <= 0:
            raise ValueError(f'Orpheus adapter {path}: r={rank!r} is not a positive integer rank')
        if config.get('modules_to_save') is not None:
            raise ValueError(
                f'Orpheus adapter {path}: modules_to_save={config["modules_to_save"]!r}. '
                'Only the LoRA A/B pairs are applied, so fully-saved modules would be '
                'silently dropped from the voice.'
            )
        if config.get('use_dora'):
            raise ValueError(
                f'Orpheus adapter {path}: use_dora=true. DoRA rescales each column of the '
                'base weight as well as adding the low-rank delta; applying only the '
                'delta would render a voice that is not the one that was trained.'
            )
        bias = config.get('bias', 'none')
        if bias != 'none':
            raise ValueError(
                f"Orpheus adapter {path}: bias={bias!r}. Only the A/B pairs are applied, "
                'so a trained bias term would be dropped.'
            )

    @classmethod
    def _validate_adapter_config_vllm(cls, path: str, config: dict):
        """What vLLM 0.7.3 in particular refuses, HERE, where the reason is readable.

        PEFTHelper.validate_legal checks the rank against the engine's max_lora_rank
        deep inside engine startup, where the failure surfaces as an opaque worker
        crash with no mention of the adapter."""
        rank = config.get('r')
        if rank > cls.LORA_MAX_RANK:
            raise ValueError(
                f'Orpheus adapter {path}: r={rank!r}, which the engine cannot serve at '
                f'max_lora_rank={cls.LORA_MAX_RANK}'
            )

    @classmethod
    def _validate_adapter_config_mlx(cls, path: str, config: dict):
        """What the MLX applier in particular refuses (see _apply_mlx_adapter).

        No rank ceiling: MLX has no pre-allocated LoRA slots to overflow - the
        wrappers are sized from the weights themselves, so any rank works.

        Per-module rank/alpha overrides do NOT work: _apply_mlx_adapter resolves ONE
        scale from r and lora_alpha and applies it to every wrapped projection.
        Honouring the patterns would be a small change; pretending they are honoured
        while scaling half the model wrongly is a voice that is subtly not the one
        that was trained, with nothing to see."""
        for key in ('rank_pattern', 'alpha_pattern'):
            if config.get(key):
                raise ValueError(
                    f'Orpheus adapter {path}: {key}={config[key]!r}. The MLX applier uses '
                    'one scale (lora_alpha / r) for every wrapped projection and cannot '
                    'honour per-module overrides.'
                )

    # ---- the vLLM registry --------------------------------------------------

    @staticmethod
    def _adapter_fingerprint(adapter_dir: str):
        """A cheap CONTENT identity for an adapter folder: (st_mtime_ns, st_size) of
        adapter_model.safetensors.

        The path alone is not an identity. Re-installing a retrained voice writes the
        new weights to the SAME folder - that is what the installer does, by design -
        so a registry keyed on the path would keep serving the previous training run
        for the life of the engine, with nothing anywhere reporting a problem. Size
        and mtime together change on every real re-download or rsync, and reading them
        costs one stat, so registration keys on them instead.

        Deliberately NOT hashed: a 400 MB adapter would cost ~1s of I/O per voice
        load, and the failure this defends against is "the file was replaced", which
        stat sees.
        """
        st = os.stat(os.path.join(adapter_dir, 'adapter_model.safetensors'))
        return (st.st_mtime_ns, st.st_size)

    @staticmethod
    def _register_lora(voice: str, adapter_dir: str, fingerprint=None) -> int:
        """The int id `voice`'s adapter is served under, registering it if new.

        vLLM caches an adapter's weights under lora_int_id, so within one ENGINE the
        same voice must always present the same id (otherwise its weights are re-read
        from disk on every request) and two voices must NEVER share one (the second
        would be served the first's cached weights - a silent wrong-voice render).
        Ids start at 1 because 0 means "no adapter" to vLLM.

        Engine LIFETIME, not process lifetime: the cache the ids key into lives
        inside the LLM object, so _evict_global_cache drops this registry along with
        the engine and the next engine starts numbering from 1 against an empty
        cache. Within one engine the counter only ever moves FORWARD
        (orpheus_lora_next_id) - an id is never reused, even for a voice that has
        been re-pointed.

        RE-POINTING a voice mints a FRESH id rather than raising, and re-pointing is
        detected on CONTENT, not on the path: a different adapter_dir OR the same
        adapter_dir whose adapter_model.safetensors fingerprint changed. That second
        case is the common one - re-installing a retrained voice overwrites the same
        folder - and keying on the path alone meant the live engine kept serving the
        old training run until the process died.

        `fingerprint` is captured at REGISTRATION and passed in. It is None on the
        per-REQUEST path (_lora_request), which must not stat the adapter once per
        row of every batch - there a registered path simply keeps its id.

        Process-global, not per-instance: the streaming worker switches voices
        in-process against ONE engine, and the ids must line up across those
        instances. The audiobook worker registers exactly one.
        """
        ids = LOADED.get('orpheus_lora_ids')
        paths = LOADED.get('orpheus_lora_paths')
        fingerprints = LOADED.get('orpheus_lora_fingerprints')
        if ids is None or paths is None or fingerprints is None:
            ids, paths, fingerprints = {}, {}, {}
            LOADED['orpheus_lora_ids'] = ids
            LOADED['orpheus_lora_paths'] = paths
            LOADED['orpheus_lora_fingerprints'] = fingerprints
        registered = paths.get(voice)
        registered_fp = fingerprints.get(voice)
        if voice in ids and registered == adapter_dir and (fingerprint is None
                                                           or registered_fp == fingerprint):
            return ids[voice]
        next_id = int(LOADED.get('orpheus_lora_next_id', 1))
        LOADED['orpheus_lora_next_id'] = next_id + 1
        if registered is not None:
            what = ('different weights at the same path' if registered == adapter_dir
                    else f'adapter {registered}')
            print(f"[ORPHEUS] Voice '{voice}' re-pointed ({what}) to {adapter_dir}; "
                  f'issuing a fresh lora id {next_id} (was {ids.get(voice)}) '
                  'so the live engine cannot serve the old cached weights.')
        ids[voice] = next_id
        paths[voice] = adapter_dir
        fingerprints[voice] = fingerprint
        return next_id

    @classmethod
    def register_adapter(cls, voice: str, adapter_dir: str, backend: str = None) -> int:
        """PUBLIC: make `voice` servable as a per-request LoRA on the live engine.

        The BookForge streaming server calls this when it loads an adapter voice onto
        an engine that is already up: a 'load' in adapter mode registers weights, it
        does not build anything, so switching between two adapters over the same base
        costs no vLLM reload and no CUDA-graph recapture. Returns the lora_int_id.

        Runs the SAME validation engine construction does (validate_adapter_dir).

        Registration alone does NOT change which voice a bare generate() renders -
        that is `set_voice`. Both are needed for a default-voice switch; only this one
        is needed to make a voice available to a per-item mixed-voice batch.

        vLLM ONLY, and there is no MLX counterpart on purpose: an int id keying a
        weight cache inside the engine is meaningful only where several adapters can
        be resident at once. MLX attaches exactly one adapter to the model itself, so
        set_voice applies it directly (_sync_mlx_adapter) and there is nothing to
        register in advance.
        """
        if not voice:
            raise ValueError('OrpheusEngine.register_adapter() requires a voice token')
        if not adapter_dir:
            raise ValueError(
                f"OrpheusEngine.register_adapter({voice!r}) requires the voice's adapter dir"
            )
        cls.validate_adapter_dir(adapter_dir, backend)
        return cls._register_lora(voice, adapter_dir,
                                  cls._adapter_fingerprint(adapter_dir))

    def set_voice(self, voice: str, adapter_dir: str = None) -> None:
        """Re-point THIS resident engine's default voice, without reloading weights.

        The streaming server keeps one engine instance alive across voice switches,
        so the instance's own idea of its voice has to move with it - and in adapter
        mode `self.adapter_dir` must move with `self.voice` in LOCKSTEP, because
        _lora_request() serves the instance's own voice straight from self.adapter_dir
        (skipping the registry). Setting `voice` alone would leave the previous
        voice's adapter attached to the new token: the right prompt prefix over the
        wrong LoRA, which renders as plausible audio in the wrong voice.

        What may NOT change here is the engine's LoRA capability or its weights: a
        merged voice IS its weights, and enable_lora is a construction-time property.
        Callers that need a different base (or to leave/enter merged mode) must tear
        the engine down and rebuild; this method refuses rather than pretending.

        Within ONE adapter-capable engine (built with a base_dir), adapter<->adapter
        AND adapter<->stock are both free: passing an adapter_dir attaches that
        adapter, passing none detaches it and serves an allowlisted stock token on
        the bare base.

        The two backends attach an adapter differently and the difference is real, not
        cosmetic. On vLLM "attach" is a REGISTRATION: the adapter becomes servable per
        request and the previous one stays servable too. On MLX it is an
        APPLICATION: the wrappers on the resident model are swapped, so exactly one
        voice is servable at a time and the previous one stops being renderable the
        moment this returns. Callers that track which voices an engine can serve must
        therefore REPLACE their record on MLX rather than add to it - the serve
        worker's engine_voices does.
        """
        if not voice:
            raise ValueError('OrpheusEngine.set_voice() requires a voice token')
        if self.custom_model_dir:
            raise ValueError(
                f'Orpheus is serving the merged model {self.custom_model_dir}, whose voice IS '
                f"its weights - it cannot be re-pointed at '{voice}' in place; reload the engine."
            )
        if adapter_dir and not self.adapter_capable:
            raise ValueError(
                f"OrpheusEngine.set_voice({voice!r}): this engine cannot serve an adapter voice in "
                f'place (base_dir={self.base_dir!r}, backend={self.backend!r}); reload the '
                'engine against the shared base.'
            )
        if self.backend == 'mlx':
            # Apply (or detach) BEFORE moving self.voice/self.adapter_dir. _sync is
            # all-or-nothing, so a failure here leaves the model rendering the voice it
            # was rendering AND this instance still describing that same voice - the
            # two cannot disagree. Validation happens inside, before the model is
            # touched at all.
            self._sync_mlx_adapter(self.mlx_model, adapter_dir)
            self.adapter_dir = adapter_dir
            self.voice = voice
            return
        if adapter_dir:
            self.register_adapter(voice, adapter_dir, self.backend)
        # Lockstep: self.adapter_dir is what _lora_request serves the INSTANCE's own
        # voice from, so it has to move with self.voice in both directions.
        self.adapter_dir = adapter_dir
        self.voice = voice

    @property
    def adapter_capable(self) -> bool:
        """True when the LIVE engine can be re-pointed at an adapter voice WITHOUT
        being reloaded.

        Same condition both loaders build on: a base_dir, on a backend that can apply
        a LoRA. vLLM applies it per request (enable_lora, a construction-time
        property); MLX applies it to the resident model's projection modules
        (_apply_mlx_adapter). transformers has no PEFT wiring here and is excluded -
        load_engine refuses adapter mode there outright.

        Deliberately NOT `bool(self.adapter_dir)` - a stock-from-local-base engine has
        no adapter attached and is still fully capable, which is the entire point of
        the key collapse.

        NOT the same question as "can this engine serve a voice PER REQUEST", which is
        vLLM-only: see _lora_request and BookForge's canServeVoicePerRequest."""
        return bool(self.base_dir) and self.backend in ('vllm', 'mlx')

    def _lora_request(self, voice: str = None):
        """The LoRARequest that renders `voice` (default: this instance's voice), or
        None when this row must reach the BASE weights unmodified.

        None is returned for exactly two things, and nothing else:

          - a session with no adapter attached at all (merged weights, or stock from
            the HF cache) - the pre-adapter behaviour;
          - an allowlisted STOCK token on a LoRA-capable engine. Stock voices are a
            prompt prefix over the base checkpoint, so they are correctly rendered
            with no adapter even while other voices on the same engine have one.

        A voice that is neither raises. That is the guarantee the whole per-request
        voice design rests on: a CUSTOM voice with no registered adapter can never be
        quietly served by the base, which would sound finished and be the wrong
        narrator."""
        if voice is None:
            voice = self.voice
        if voice == self.voice:
            adapter_dir = self.adapter_dir
        else:
            adapter_dir = LOADED.get('orpheus_lora_paths', {}).get(voice)
        if not adapter_dir:
            if self.custom_model_dir:
                return None          # merged: the weights ARE the voice
            if voice == self.voice and not self.adapter_dir:
                return None          # this session simply has no adapter
            if voice in self.VALID_VOICES:
                return None          # allowlisted stock token over the base weights
            raise ValueError(f"Orpheus has no registered adapter for voice '{voice}'")
        # Imported only on the arm that needs it: a stock/merged session may be running
        # on MLX or transformers, where vllm is not installed at all.
        from vllm.lora.request import LoRARequest
        return LoRARequest(voice, self._register_lora(voice, adapter_dir), adapter_dir)

    # ---- the MLX applier ----------------------------------------------------

    @staticmethod
    def _mlx_lora_scale(config: dict) -> float:
        """The one multiplier applied to every LoRA delta: PEFT's own alpha / r
        (alpha / sqrt(r) under rsLoRA).

        READ FROM THE ADAPTER, never assumed. The three deployed Orpheus voices are
        r=64 / alpha=64, i.e. exactly 1.0, so a hardcoded scale would work today and
        silently mis-weight the first voice trained at any other setting - by a
        factor of 2 or 4, which is not a subtle artifact but it is a plausible-
        sounding one.
        """
        rank = config['r']
        alpha = config.get('lora_alpha', rank)
        if config.get('use_rslora'):
            return float(alpha) / math.sqrt(rank)
        return float(alpha) / float(rank)

    @classmethod
    def _mlx_walk(cls, model, path: str):
        """Resolve a dotted PEFT module path against the live MLX model."""
        obj = model
        for part in path.split('.'):
            if part.isdigit():
                obj = obj[int(part)]
            else:
                obj = getattr(obj, part)
        return obj

    def _mlx_adapter_plan(self, model, adapter_dir: str, config: dict):
        """Build every wrapper this adapter needs, WITHOUT touching the model.

        Returns (sites, swap) where `sites` is the new _MlxAdapterState.sites and
        `swap` is the complete list of (parent, attr, module) assignments that make
        the model serve this adapter and nothing else - including restoring any site
        the PREVIOUS adapter wrapped that this one does not.

        Everything that can fail - a missing pair, an unexpected module path, a shape
        that does not match the base weight - fails HERE, with the model still
        rendering the voice it was rendering. That is the whole reason this is a
        separate pass: a half-wrapped model has no name, cannot be reported, and
        sounds like neither voice.
        """
        import mlx.core as mx
        import mlx.nn as nn

        weights = mx.load(os.path.join(adapter_dir, 'adapter_model.safetensors'))
        scale = self._mlx_lora_scale(config)

        # Group the flat key list into {module path: {lora_A: ..., lora_B: ...}}.
        pairs = {}
        for key, value in weights.items():
            if not key.startswith(self.MLX_LORA_PREFIX):
                raise ValueError(
                    f'Orpheus adapter {adapter_dir}: key {key!r} does not start with '
                    f'{self.MLX_LORA_PREFIX!r} - this is not a PEFT LoRA over a '
                    'transformers causal LM.'
                )
            body = key[len(self.MLX_LORA_PREFIX):]
            if not body.endswith('.weight'):
                raise ValueError(f'Orpheus adapter {adapter_dir}: unexpected key {key!r}')
            body = body[:-len('.weight')]
            module_path, _, which = body.rpartition('.')
            if which not in ('lora_A', 'lora_B'):
                raise ValueError(
                    f'Orpheus adapter {adapter_dir}: key {key!r} is neither a lora_A nor a '
                    'lora_B weight. Only the A/B pairs are applied, so it would be dropped.'
                )
            pairs.setdefault(module_path, {})[which] = value

        # The ORIGINAL module at each site, even when a previous adapter is currently
        # wrapped around it: the recorded state is the authority, the live object is
        # only consulted for sites nothing has wrapped.
        state = getattr(model, '_orpheus_mlx_lora', None)
        originals = {path: (parent, attr, original)
                     for path, parent, attr, original in (state.sites if state else [])}

        lora_linear = _mlx_lora_linear_cls()
        sites = []
        swap = []
        for module_path in sorted(pairs):
            entry = pairs[module_path]
            lora_a, lora_b = entry.get('lora_A'), entry.get('lora_B')
            if lora_a is None or lora_b is None:
                raise ValueError(
                    f'Orpheus adapter {adapter_dir}: {module_path} has only '
                    f'{"lora_A" if lora_a is not None else "lora_B"}. Half a LoRA pair '
                    'cannot be applied.'
                )
            if module_path in originals:
                parent, attr, original = originals[module_path]
            else:
                parent_path, _, attr = module_path.rpartition('.')
                try:
                    parent = self._mlx_walk(model, parent_path)
                    original = getattr(parent, attr)
                except (AttributeError, IndexError, KeyError, TypeError) as err:
                    raise ValueError(
                        f'Orpheus adapter {adapter_dir}: {module_path} does not name a module '
                        f'on the loaded MLX model ({err}). The adapter was trained against a '
                        'different architecture than the base model this engine loaded.'
                    )
            if not isinstance(original, nn.Linear):
                raise ValueError(
                    f'Orpheus adapter {adapter_dir}: {module_path} is a '
                    f'{type(original).__name__}, not an nn.Linear. A LoRA can only be applied '
                    'to a plain linear projection (a quantized base would need its own path).'
                )
            weight = original.weight
            out_features, in_features = weight.shape
            if (lora_a.shape[1] != in_features or lora_b.shape[0] != out_features
                    or lora_a.shape[0] != lora_b.shape[1]):
                raise ValueError(
                    f'Orpheus adapter {adapter_dir}: {module_path} shapes do not fit - '
                    f'A{tuple(lora_a.shape)} B{tuple(lora_b.shape)} against a '
                    f'{out_features}x{in_features} projection.'
                )
            # Cast to the BASE's dtype (bf16). The checkpoint stores fp32, and adding an
            # fp32 delta to a bf16 projection would promote every activation on the way
            # through - a different, slower model than the one that was measured.
            wrapper = lora_linear(original, lora_a.astype(weight.dtype),
                                  lora_b.astype(weight.dtype), scale)
            sites.append((module_path, parent, attr, original))
            swap.append((parent, attr, wrapper))

        # Sites the OLD adapter wrapped and this one does not: restore the original,
        # or they would keep serving the previous voice's delta on top of the new one.
        wrapped = {path for path, _, _, _ in sites}
        for path, parent, attr, original in (state.sites if state else []):
            if path not in wrapped:
                swap.append((parent, attr, original))
        return sites, swap

    def _apply_mlx_adapter(self, model, adapter_dir: str, fingerprint=None) -> None:
        """Make the resident MLX model render `adapter_dir`'s voice.

        Replaces whatever adapter is currently applied (see _mlx_adapter_plan), so
        adapter->adapter is one call, not a clear followed by an apply - there is no
        window in which the model is a bare base under a custom voice's name.

        ALL-OR-NOTHING in both phases. The plan is built first and every failure mode
        lives there, with the model untouched; the assignment loop that follows is
        pure setattr, and if one of those ever raised, every site already moved is put
        back exactly as it was before the exception propagates.
        """
        import mlx.core as mx

        config = self._read_adapter_config(adapter_dir)
        self._validate_adapter_config(os.path.join(adapter_dir, 'adapter_config.json'), config)
        self._validate_adapter_config_mlx(os.path.join(adapter_dir, 'adapter_config.json'), config)
        if fingerprint is None:
            fingerprint = self._adapter_fingerprint(adapter_dir)
        sites, swap = self._mlx_adapter_plan(model, adapter_dir, config)

        rollback = [(parent, attr, getattr(parent, attr)) for parent, attr, _ in swap]
        try:
            for parent, attr, module in swap:
                setattr(parent, attr, module)
        except Exception:
            for parent, attr, previous in rollback:
                setattr(parent, attr, previous)
            raise
        model._orpheus_mlx_lora = _MlxAdapterState(adapter_dir, fingerprint, sites)
        # Materialise the new weights NOW. mx.load is lazy, so without this the first
        # sentence of a switched voice pays a 0.4 GB read inside the generation loop -
        # which is exactly the latency the resident base was supposed to remove.
        mx.eval(model.parameters())
        print(f'[ORPHEUS] MLX adapter applied: {adapter_dir} '
              f'({len(sites)} projections, scale {self._mlx_lora_scale(config):g})')

    def _clear_mlx_adapter(self, model) -> None:
        """Put the resident MLX model back to the bare base.

        Exact unwrapping: every original module goes back where it was. Nothing is
        subtracted from any weight, so the base after a hundred voice switches is the
        same object it was after the load."""
        state = getattr(model, '_orpheus_mlx_lora', None)
        if state is None:
            return
        for _path, parent, attr, original in state.sites:
            setattr(parent, attr, original)
        model._orpheus_mlx_lora = None
        print(f'[ORPHEUS] MLX adapter cleared: {state.adapter_dir}')

    def _sync_mlx_adapter(self, model, adapter_dir: str) -> None:
        """Make the resident MLX model serve exactly `adapter_dir` (None = bare base).

        A no-op when the SAME adapter content is already applied - same dir AND same
        fingerprint. The fingerprint half is not paranoia: re-installing a retrained
        voice overwrites the same folder, and a dir-only comparison would keep the old
        training run applied for the life of the process (the identical trap
        _register_lora's fingerprint defends against on vLLM)."""
        if model is None:
            raise ValueError('Orpheus: no MLX model is loaded - cannot apply an adapter to it.')
        state = getattr(model, '_orpheus_mlx_lora', None)
        if not adapter_dir:
            self._clear_mlx_adapter(model)
            return
        fingerprint = self._adapter_fingerprint(adapter_dir)
        if state is not None and state.adapter_dir == adapter_dir and state.fingerprint == fingerprint:
            return
        if state is not None and state.adapter_dir == adapter_dir:
            print(f"[ORPHEUS] MLX adapter at {adapter_dir} changed on disk; re-applying "
                  'so the live model cannot keep serving the previous training run.')
        self._apply_mlx_adapter(model, adapter_dir, fingerprint)
