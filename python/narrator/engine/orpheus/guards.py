"""Every verdict the engine takes about a rendered clip, and the evidence it
keeps.

Ported from ebook2audiobook@9daab0ba lib/classes/tts_engines/orpheus.py:
  _reject_lock (class block, 736)   _speech_rate (4146)      _reject_dir (4167)
  _keep_reject (4194)               _keep_reject_locked (4216)
  _emit_guard_event (4266)          _CHUNK_CSV_SENTINEL / _chunk_csv_sentinel (4287)
  _log_chunk_stats (4307)           _log_batch_stats (4331)
  _asr_verify_or_retry (4344)       _guard_truncation (4401)
  _rate_ceiling (4453)              _needs_resplit (4460)
  _report_short_chunk_overrun (4493) _ratchet_after_resplit (4540)

LOAD-BEARING LOG STRINGS. Two of the prints here are parsed by BookForge and
must stay byte-identical:
  [ORPHEUS][ORPHEUS_GUARD_EVENT] {json}   electron/parallel-tts-bridge.ts:111
  [ORPHEUS][SHORT_CHUNK_OVERRUN] ...      counted with `grep -c`
Both are composed from GUARD_EVENT_TAG / SHORT_CHUNK_OVERRUN_TAG in config.py.

torch is imported lazily inside `_speech_rate` and `_keep_reject_locked` only,
so the verdict arithmetic and the reject-directory rule are importable without
it.
"""
import os
import threading


class GuardsMixin:

    # _keep_reject's mutual exclusion (2026-09-04). Two threads can reach it at
    # once: the MLX decoder thread takes a retired row's _needs_resplit verdict
    # while the main thread takes another row's, and fast start makes that the
    # NORM rather than a rarity (a streamed row's verdict is taken on the
    # decoder thread at every flush). The body makedirs, torchaudio.save's a
    # numbered stem, and - the part that actually corrupts - APPENDS a JSON line
    # to one shared events.jsonl. Two interleaved appends produce a half-written
    # record that no post-mortem can parse.
    #
    # A LOCK, NOT A HAND-OFF. The alternative was to defer every streamed row's
    # verdict to the main thread at shutdown, but that would hold a streamed
    # row's on_row (and therefore the client's "sentence done") until the whole
    # bucket ends - which is the exact latency fast start exists to remove.
    #
    # Class-level: the streaming server has one engine, but two engines in one
    # process would still share a reject directory.
    _reject_lock = threading.Lock()

    _CHUNK_CSV_SENTINEL = None   # cached: False = checked and absent

    # ---- rate ---------------------------------------------------------------

    def _speech_rate(self, clean: str, audio_np):
        """chars-per-second of the SML-stripped text over the audio's speech-only
        duration - trailing/leading silence trimmed EXACTLY as _save_audio used
        to (trim_audio, silence_threshold=0.01, buffer_sec=0.20), and BEFORE any
        inter-clip gap pad is appended. Returns None when the metric can't apply
        (no audio). This is how a silent early-EOS truncation is caught: a
        fine-tuned voice trained on short clips tends to emit end-of-audio EARLY
        past ~300 chars, dropping trailing text. The clip then FINISHES cleanly
        (no token-cap hit - the existing cap re-split can't see it) but is far too
        short for the words, i.e. an impossibly high chars/sec (healthy prose is
        ~15 ch/s, p90 ~17; a truncated 400+ char chunk measured ~21)."""
        import numpy as np
        import torch
        from .audio import trim_audio
        if audio_np is None or len(audio_np) == 0:
            return None
        audio_tensor = torch.from_numpy(np.asarray(audio_np)).float()
        if audio_tensor.dim() == 1:
            audio_tensor = trim_audio(audio_tensor, self.SAMPLE_RATE,
                                      silence_threshold=0.01, buffer_sec=0.20)
        seconds = len(audio_tensor) / self.SAMPLE_RATE
        if seconds <= 0:
            return None
        return len(clean) / seconds

    # ---- evidence -----------------------------------------------------------

    def _reject_dir(self):
        """Where a rejected render is kept for post-mortem.

        OUTSIDE the session dir on purpose: BookForge deletes the whole scratch
        session when a job finishes, which would take the evidence with it. Default
        is a sibling of the session: <tmp>/tts_rejects/<ebook-uuid>/. Override with
        ORPHEUS_REJECT_DIR (or EngineConfig.reject_dir) to collect them somewhere
        permanent.
        """
        # THE ENVIRONMENT IS THE ONLY OVERRIDE, exactly as e2a. An earlier
        # version of this port also honoured an `EngineConfig.reject_dir` field;
        # that field is gone (adversarial review, 2026-09-04). It was a second
        # source for one decision, and when the env var was UNSET it would have
        # changed where rejects land versus e2a - a new precedence rule for a
        # knob nothing asked for. parallel-tts-bridge.ts sets
        # ORPHEUS_REJECT_DIR per job and that is the whole interface.
        override = os.environ.get('ORPHEUS_REJECT_DIR', '').strip()
        if override:
            return override
        # getattr, not self.config: a guard can fire from a context that never
        # adopted a config at all (a probe, a harness exercising the guard alone,
        # a bare __new__ instance in a test). e2a wrote
        # `getattr(self, 'session', None)` here for exactly that, and dropping the
        # guard would turn the missing attribute into an exception that eats the
        # report the caller actually wanted.
        config = getattr(self, 'config', None)
        # No process_dir means nowhere to file a reject - the same answer e2a gave
        # for a session with no process_dir, not an error worth breaking the
        # guard's one-line report over.
        proc = getattr(config, 'process_dir', None) if config else None
        if not proc:
            return None
        ebook_dir = os.path.dirname(os.path.normpath(proc))   # <tmp>/ebook-<uuid>
        tmp_root = os.path.dirname(ebook_dir)                 # <tmp>
        if not tmp_root or not os.path.basename(ebook_dir):
            return None
        return os.path.join(tmp_root, 'tts_rejects', os.path.basename(ebook_dir))

    def _keep_reject(self, sentence_index: int, clean: str, audio_np, reason: str,
                     detail: dict = None):
        """Preserve a render the guards threw away, plus WHY.

        Without this a truncation is only ever a log line: the bad audio is
        overwritten by the re-render, so there is no way to see WHERE it cut - mid
        word, at a clause boundary, right after a number. Keeping it turns every
        guard fire into a data point (Owen 2026-07-28, after chunk 1005 of Killing
        America truncated at 55% of its correct length and the evidence was gone).

        BEST-EFFORT BY DESIGN: this is diagnostics, not product. Any failure here is
        reported and swallowed - losing a post-mortem must never take down a book.

        SERIALIZED (_reject_lock): a decoder thread and the main thread can both
        be in here, and events.jsonl is one shared append-only file.
        """
        try:
            with self._reject_lock:
                self._keep_reject_locked(sentence_index, clean, audio_np, reason, detail)
        except Exception as err:
            print(f'Orpheus: could not keep the rejected render for sentence {sentence_index} ({err})')

    def _keep_reject_locked(self, sentence_index: int, clean: str, audio_np,
                            reason: str, detail: dict = None):
        """_keep_reject's body, called with _reject_lock held. Split out only so
        the lock wraps every path including the early return."""
        import json as _json
        import numpy as np
        import torch
        import torchaudio
        # Same getattr as _reject_dir, for the same reason: the record's provenance
        # fields are an honest hole when there is no config, never an exception
        # that eats the whole record. (e2a: `getattr(self, 'session', None) or {}`.)
        config = getattr(self, 'config', None)
        directory = self._reject_dir()
        if not directory:
            return
        os.makedirs(directory, exist_ok=True)
        stem = os.path.join(directory, f'{sentence_index:06d}_{reason}')
        seconds = None
        if audio_np is not None and len(audio_np) > 0:
            wave = torch.from_numpy(np.asarray(audio_np)).float()
            if wave.dim() == 1:
                wave = wave.unsqueeze(0)
            torchaudio.save(stem + '.wav', wave, self.SAMPLE_RATE)
            seconds = round(float(wave.shape[-1]) / self.SAMPLE_RATE, 3)
        record = {
            'sentence_index': sentence_index,
            # 'short' = truncated, re-rendered split | 'empty' = no audio |
            # 'cap' = never emitted EOS, hit the token ceiling |
            # 'overrun' = short chunk spoke too long; the take SHIPPED anyway
            'reason': reason,
            'chars': len(clean),
            'audio_seconds': seconds,
            'chars_per_second': round(len(clean) / seconds, 2) if seconds else None,
            'voice': getattr(config, 'voice', None),
            'model_dir': getattr(config, 'model_dir', None),
            # Adapter mode: model_dir is None and the voice lives in the adapter,
            # so a post-mortem needs both refs to know what actually rendered this.
            'adapter_dir': getattr(config, 'adapter_dir', None),
            'base_dir': getattr(config, 'base_dir', None),
            'max_audio_tokens': self.MAX_AUDIO_TOKENS,
            'text': clean,
        }
        if detail:
            record.update(detail)
        with open(stem + '.json', 'w', encoding='utf-8') as handle:
            _json.dump(record, handle, indent=1, ensure_ascii=False)
        # One append-only file per run, so a post-mortem is a single read
        # rather than a directory walk, and so the record survives even if
        # the per-event wav could not be written.
        with open(os.path.join(directory, 'events.jsonl'), 'a', encoding='utf-8') as handle:
            handle.write(_json.dumps(record, ensure_ascii=False) + '\n')
        self._emit_guard_event(record)

    def _emit_guard_event(self, record: dict):
        """Print one parseable line for a guard fire. Best-effort like its caller.

        LOAD-BEARING: `[ORPHEUS][ORPHEUS_GUARD_EVENT] ` is the exact prefix
        electron/parallel-tts-bridge.ts slices off before json.parse.

        Kept separate from _keep_reject so a chunk whose audio is NOT thrown away
        (the short-chunk overrun - the take ships and is only counted) can report
        through the same channel without pretending to be a rejection.
        """
        try:
            import json as _json
            compact = dict(record)
            # The text can be 500 characters of book; the console line stays
            # readable and the full text is already in the per-event JSON.
            text = compact.get('text') or ''
            if len(text) > 120:
                compact['text'] = text[:120]
                compact['text_truncated'] = True
            print(f'[ORPHEUS][{self.GUARD_EVENT_TAG}] '
                  + _json.dumps(compact, ensure_ascii=False, separators=(',', ':')))
        except Exception:
            pass

    # ---- instrumentation ----------------------------------------------------

    def _chunk_csv_sentinel(self):
        """BookForge only forwards allowlisted ORPHEUS_* vars into the WSL
        subshell, so the CSV toggle can also live in a sentinel file:
        ~/.orpheus_chunk_csv containing the destination path. Checked once per
        process."""
        cls = type(self)
        if cls._CHUNK_CSV_SENTINEL is None:
            try:
                sentinel = os.path.expanduser('~/.orpheus_chunk_csv')
                if os.path.exists(sentinel):
                    with open(sentinel, encoding='utf-8') as handle:
                        cls._CHUNK_CSV_SENTINEL = handle.read().strip() or False
                else:
                    cls._CHUNK_CSV_SENTINEL = False
            except Exception:
                cls._CHUNK_CSV_SENTINEL = False
        return cls._CHUNK_CSV_SENTINEL or None

    def _log_chunk_stats(self, idx, clean, out, audio_np):
        """T0 instrumentation: one CSV line per generation. Inert unless
        ORPHEUS_CHUNK_CSV names a file. Best-effort - diagnostics must never fail
        a render.

        Columns: sentence_index, chars, prompt_tokens, generated_tokens,
        eos_emitted, decoded_audio_seconds (pre-trim), unix_time."""
        path = os.environ.get('ORPHEUS_CHUNK_CSV') or self._chunk_csv_sentinel()
        if not path:
            return
        try:
            import time as _time
            gen_ids = list(out.outputs[0].token_ids)
            n_prompt = len(out.prompt_token_ids) if getattr(out, 'prompt_token_ids', None) else 0
            secs = (len(audio_np) / self.SAMPLE_RATE) if audio_np is not None and len(audio_np) else 0.0
            with open(path, 'a', encoding='utf-8') as handle:
                handle.write(f'{idx},{len(clean)},{n_prompt},{len(gen_ids)},'
                             f'{int(self.END_OF_AUDIO_TOKEN in gen_ids)},{secs:.3f},{_time.time():.3f}\n')
        except Exception:
            pass

    def _log_batch_stats(self, n_prompts, wall_s):
        """Companion batch line for _log_chunk_stats: BATCH,n_prompts,wall_ms.
        Same file, same gating, same best-effort contract."""
        path = os.environ.get('ORPHEUS_CHUNK_CSV') or self._chunk_csv_sentinel()
        if not path:
            return
        try:
            import time as _time
            with open(path, 'a', encoding='utf-8') as handle:
                handle.write(f'BATCH,{n_prompts},{wall_s*1000:.0f},{_time.time():.3f}\n')
        except Exception:
            pass

    # ---- the ASR gate -------------------------------------------------------

    def _asr_verify_or_retry(self, sentence_index: int, clean: str, audio_np, rerender):
        """ASR verify gate (census 2026-08-29): on a risk-flagged chunk (see
        asr_gate_risk - number-word runs and digit clusters, the measured
        derailment sites), transcribe the generated audio with CPU wav2vec2 and
        confirm the words were actually spoken. On a >= 4-word hole: keep the
        bad take as evidence, re-render ONCE (fresh sampling - the derailments
        are stochastic), and keep whichever take scores better. Un-flagged
        chunks cost nothing; an unavailable ASR stack fails open.

        vLLM path only for now: the MLX (Mac) env's torchaudio is unverified
        and MLX regeneration semantics differ - extend after a Mac smoke test."""
        from . import asr_gate
        from .text import asr_gate_risk
        if not asr_gate.gate_enabled():
            return audio_np
        risk = asr_gate_risk(clean)
        if risk is None:
            return audio_np
        # A substantially foreign chunk (German title, Dutch name) is
        # unverifiable by the English CTC model - every consistent double-fail
        # measured 2026-08-29 was one of these. Skip rather than burn a retry
        # on a mismatch that can never clear; the offline census adjudicates.
        if asr_gate.foreign_fraction(clean) > 0.15:
            return audio_np
        verdict = asr_gate.check(audio_np, self.SAMPLE_RATE, clean)
        if verdict['ok']:
            return audio_np
        self._keep_reject(sentence_index, clean, audio_np, 'asr_mismatch',
                          {'risk': risk, 'ratio': verdict['ratio'],
                           'drop_run': verdict['drop_run'],
                           'heard': verdict['heard'][:300]})
        print(f"Orpheus: sentence {sentence_index} failed the ASR gate "
              f"(risk={risk}, drop_run={verdict['drop_run']}, ratio={verdict['ratio']}); "
              f"re-rendering once")
        try:
            retry_np = rerender(clean)
        except Exception as retry_err:
            print(f'Orpheus: ASR-gate re-render failed for sentence {sentence_index} '
                  f'({retry_err}); keeping the first take')
            return audio_np
        retry_verdict = asr_gate.check(retry_np, self.SAMPLE_RATE, clean)
        keep_retry = retry_verdict['ok'] or retry_verdict['ratio'] >= verdict['ratio']
        # Both takes failing with near-identical scores is a CONSISTENT
        # mismatch - text the ASR cannot verify, not a stochastic derailment.
        consistent = (not retry_verdict['ok']
                      and abs(retry_verdict['ratio'] - verdict['ratio']) < 0.05)
        self._emit_guard_event({'reason': 'asr_consistent_mismatch' if consistent
                                          else 'asr_retry_outcome',
                                'sentence': sentence_index, 'risk': risk,
                                'first_ratio': verdict['ratio'],
                                'retry_ratio': retry_verdict['ratio'],
                                'retry_ok': retry_verdict['ok'],
                                'kept': 'retry' if keep_retry else 'first',
                                'text': clean})
        return retry_np if keep_retry else audio_np

    # ---- the truncation guard ----------------------------------------------

    def _guard_truncation(self, sentence_index: int, clean: str, audio_np, resplit,
                          voice: str = None):
        """Backstop for silent early-EOS truncation (see _speech_rate). If the
        rendered clip is too short for the text, re-render it split at sentence
        boundaries via `resplit` (the backend's _generate_*_safe ladder). `resplit`
        takes the clean text and returns a numpy waveform - and it must ACTUALLY
        split, not merely re-render: the failure detected here is a CLEAN early
        EOS, so a whole-chunk re-render would most likely clean-EOS (truncated)
        again. Both backends' callers therefore pass their ladder with
        force_split=True.

        Guard applies only when clean length > 150 chars (short chunks' rates are
        noisy) and the voice's maxCharsPerSec > 0 (DEFAULT_MAX_CHARS_PER_SEC when
        unset; set 0 to disable).

        SELF-CALIBRATING RATCHET (self._rate_ceiling(voice)): that default was
        calibrated on ~15-17 ch/s voices; a faster fine-tune (e.g. one that
        naturally reads ~20 ch/s) trips the guard on every long healthy chunk,
        each false positive costing a full wasted serialized re-render. But the
        force-split re-render hands us GROUND TRUTH for the voice's natural rate:
        the pieces are short, and early-EOS truncation only strikes past ~300
        chars, so a split render CANNOT itself be truncated. Therefore when the
        re-render's rate2 STILL exceeds the threshold, that is not "still short"
        - it PROVES the voice's true speaking rate is above the configured
        threshold. So we ratchet the session ceiling up to rate2 + 0.5 and log it
        LOUDLY. The effective threshold used for every check is max(configured,
        ratchet); the ratchet only ever moves UP, only from split-render rates,
        and NEVER resurrects a disabled guard (cap <= 0 short-circuits before the
        ratchet is ever consulted).

        EMPTY audio for non-empty text (immediate early-EOS / unparseable stream)
        is a definite failure, not a noisy metric, so it gets its one re-render
        regardless of the 150-char floor.

        `voice` (default: this instance's voice) is the row's own voice, so a
        mixed-voice batch judges each row against ITS fine-tune's rate threshold."""
        reason = self._needs_resplit(sentence_index, clean, audio_np, voice)
        if reason is None:
            return audio_np
        audio_np = resplit(clean)
        if reason == 'short':
            self._ratchet_after_resplit(clean, audio_np, voice)
        return audio_np

    def _rate_ceiling(self, voice: str = None) -> float:
        """This session's ratcheted chars/sec ceiling for `voice` (0.0 = never
        ratcheted). Per-voice because the thing it calibrates is ONE voice's
        natural speaking rate: a resident streaming engine serves several voices,
        and a ceiling ratcheted up by a fast fine-tune (deathstalker ~23.5 ch/s)
        would otherwise disarm the guard for a slow one still reading at ~15."""
        if voice is None:
            voice = self.voice
        return self._rate_ceilings.get(voice, 0.0)

    def _needs_resplit(self, sentence_index: int, clean: str, audio_np, voice: str = None):
        """DECISION half of _guard_truncation. Returns 'empty', 'short', or None.

        Split out from the re-render so the BATCH path can defer the expensive half:
        the verdict depends only on text and already-rendered audio, so every chunk in
        a batch can be judged immediately and their re-renders pooled into one call
        (see _render_deferred_resplits). The log lines still fire here, at detection
        time, so the reason a chunk gets re-rendered is visible where it happens.

        `voice` (default: this instance's voice) picks BOTH the configured threshold
        and the ratchet, because how many chars a second is "too fast to be real" is a
        property of the fine-tune, not of the process.
        """
        if (audio_np is None or len(audio_np) == 0) and clean and clean.strip():
            print(f"Orpheus: sentence {sentence_index} produced no audio - re-rendering split at sentence boundaries")
            self._keep_reject(sentence_index, clean, audio_np, 'empty')
            return 'empty'
        env_rate = self._max_chars_per_sec(voice)
        # A disabled guard (cap <= 0) stays disabled - the ratchet must NEVER
        # resurrect it. Only past this gate does the session ceiling apply.
        if env_rate <= 0 or len(clean) <= 150:
            return None
        max_rate = max(env_rate, self._rate_ceiling(voice))
        rate = self._speech_rate(clean, audio_np)
        if rate is None or rate <= max_rate:
            return None
        print(f"Orpheus: sentence {sentence_index} audio too short for text "
              f"({rate:.1f} ch/s > {max_rate:.1f}) - re-rendering split at sentence boundaries")
        self._keep_reject(sentence_index, clean, audio_np, 'short',
                          {'measured_chars_per_second': round(rate, 2),
                           'threshold_chars_per_second': round(max_rate, 2)})
        return 'short'

    def _report_short_chunk_overrun(self, sentence_index: int, clean: str, audio_np) -> bool:
        """PRINT - and only print - when a sub-floor chunk's audio runs far longer
        than its text can justify. Returns whether it reported, for the tests; the
        audio is never touched and every caller ignores the return.

        THIS MEASURES A MODEL DEFECT, IT DOES NOT COMPENSATE FOR ONE. The
        duplication is in the generated audio, not the text, so the cure is a
        fine-tune that commits to end-of-audio after a very short utterance.

        Deliberately NOT folded into _needs_resplit. That guard answers the
        opposite question (audio too SHORT for the text, i.e. a truncation), it
        explicitly refuses chunks of 150 chars or fewer so it has never had an
        opinion about a heading, and it ACTS where this only observes.

        Measured on the GENERATED waveform: every caller reports BEFORE _save_audio
        appends the inter-clip gaps, so the number is what the model emitted.

        LOAD-BEARING: the one-line form `[ORPHEUS][SHORT_CHUNK_OVERRUN] ...` is
        what `grep -c SHORT_CHUNK_OVERRUN <log>` counts.
        """
        if audio_np is None or len(audio_np) == 0:
            return False
        n_chars = len(clean)
        if self.SHORT_CHUNK_MAX_CHARS <= 0 or n_chars <= 0 or n_chars >= self.SHORT_CHUNK_MAX_CHARS:
            return False
        seconds = len(audio_np) / self.SAMPLE_RATE
        allowed = self.SHORT_CHUNK_SECONDS_BASE + self.SHORT_CHUNK_SECONDS_PER_CHAR * n_chars
        if seconds <= allowed:
            return False
        # ONE line, one tag, everything needed to count and to find the clip.
        # The text is last because it is the only unbounded field.
        print(f"[ORPHEUS][{self.SHORT_CHUNK_OVERRUN_TAG}] sentence={sentence_index} "
              f"chars={n_chars} seconds={seconds:.3f} allowed={allowed:.3f} "
              f"ratio={seconds / allowed:.2f} text={clean!r}")
        # Also report through the structured channel, so one collector sees every
        # guard fire. The audio is KEPT alongside it: this take ships, but it is
        # the only recording of the doubling. Saved under its own reason so it is
        # never mistaken for a chunk that was thrown away and re-rendered.
        self._keep_reject(sentence_index, clean, audio_np, 'overrun',
                          {'allowed_seconds': round(allowed, 3),
                           'overrun_ratio': round(seconds / allowed, 3),
                           'audio_kept': True})
        return True

    def _ratchet_after_resplit(self, clean: str, audio_np, voice: str = None) -> None:
        """RATCHET half of _guard_truncation - see its docstring for the full rationale.

        The split render is un-truncatable, so if its rate STILL exceeds the threshold
        that is the voice's real speaking rate, not a truncation: raise the session
        ceiling (never lower it) so subsequent healthy fast chunks stop tripping.
        Only ever called for a 'short' verdict - an 'empty' one carries no rate signal.
        """
        if voice is None:
            voice = self.voice
        env_rate = self._max_chars_per_sec(voice)
        if env_rate <= 0:
            return
        max_rate = max(env_rate, self._rate_ceiling(voice))
        rate2 = self._speech_rate(clean, audio_np)
        if rate2 is not None and rate2 > max_rate:
            new_ceiling = rate2 + 0.5
            self._rate_ceilings[voice] = new_ceiling
            print(f"Orpheus: voice '{voice}' measured natural rate {rate2:.1f} ch/s exceeds guard "
                  f"threshold {max_rate:.1f} - recalibrating threshold to {new_ceiling:.1f} for this session")
