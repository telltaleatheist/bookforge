"""Higgs TTS 3 (`higgs-audio-v3-tts-4b`) as a SERVED backend.

Higgs v3 is narrator's second engine (Owen, 2026-09-04 evening). It does NOT run
in this process: `model_type: higgs_multimodal_qwen3` has no HF modeling class -
it is implemented inside vllm-omni - and its dependency set (torch 2.13.0+cu130,
vllm 0.28.0) cannot share an environment with Orpheus's vLLM 0.7.3. So something
must LAUNCH a server, wait for its health endpoint, use it over HTTP, and kill
it. That lifecycle is `BackendSpec.kind == 'served'` and it is what this module
implements.

EVERY FACT BELOW IS MEASURED, from the campaign
`E:\\training\\_campaigns\\2026-09-01-cod-full-rebuild\\higgs\\`: `serve_v3.sh`
(the launch), `work/render_final.py` + `work/confirm.py` (the request),
`work/patch_vllm.py` + `work/patch_tail_trim.py` (the two required patches),
`HIGGS_V3_LEVERS.md` (the lever sweep, the delivered render, the control-token
vocabulary), `work/refs/manifest.json` (the reference clips) and
`work/serve_v3c.log` (the route table).

THE ENVIRONMENT (owens-pc, WSL Ubuntu, RTX 3090 Ti)

    env      /home/telltale/anaconda3/envs/higgs3 (python 3.11,
             torch 2.13.0+cu130, vllm 0.28.0, vllm-omni 0.28.0)
    launch   <campaign>/serve_v3.sh - vllm-omni serve <snapshot>
             --served-model-name higgs-v3 --host 127.0.0.1 --port 8095
             --trust-remote-code --gpu-memory-utilization 0.60
             --max-model-len 8192 --max-num-seqs 2
             --attention-backend FLASH_ATTN --omni, with CUDA_HOME pointed at
             the pip CUDA 13 wheel, VLLM_USE_FLASHINFER_SAMPLER=0,
             VLLM_DISABLE_FLASHINFER_PREFILL=1, TORCH_CUDA_ARCH_LIST=8.6
    cost     COLD START 55-297 s to health=200 (measured on this box, same
             script, same env: 55 s warm page cache, 146 s, and 297 s cold, in
             narrator's own smoke). The spread is disk and first-run
             compilation. The server preallocates to the utilization target
             (0.60 of 24 GB), so it OWNS the GPU while up.
    stop     SIGTERM the `vllm-omni serve` process (their work/release_gpu.sh
             does exactly this and then drops the shared lock)

narrator INVOKES THEIR SCRIPT. It does not write a launcher of its own: the
script is where the CUDA_HOME/flashinfer workarounds live, and a second copy of
them would drift.

TWO SITE-PACKAGES PATCHES ARE REQUIRED, and must be RE-APPLIED AFTER ANY PIP
UPGRADE in that env:

  work/patch_vllm.py       vLLM 0.28 rejects any prompt id < 0; vllm-omni's
                           clone path deliberately emits AUDIO_PLACEHOLDER_ID
                           == -100 for the talker to substitute reference
                           embeddings at prefill. Without the patch EVERY clone
                           request is HTTP 400 "Token id -100 is out of
                           vocabulary" - which is what made cloning look broken
                           in the first audition.
  work/patch_tail_trim.py  trims the trailing sentinel run BY CONTENT instead of
                           one frame, in both the sync collector and the async
                           flush. THIS IS SERVER-SIDE. Read it: it replaces
                           `codes_qt[:, :-1]` with `_trim_trailing_sentinel_frames`
                           and moves the sentinel->0 substitution BELOW the trim.
                           So a patched server returns audio whose tail is
                           already clean and THE CLIENT MUST NOT TRIM AGAIN.
                           What remains is a hard sample boundary, which is a
                           click: `edge_fade_ms` (10 in / 25 out) is the
                           assembler's job.

Both belong in a managed-env recipe at cut-over; see ../PORT_NOTES.md 12.7.

WHAT THE REQUEST LOOKS LIKE, and the two ways it goes silently wrong:

  * SAMPLING MUST RIDE IN `extra_params`. `temperature` / `top_p` / `top_k` are
    not fields of `OpenAICreateSpeechRequest`; pydantic drops them without a
    word, and the whole first audition therefore ran at the server default
    while reporting 0.3. Sending NOTHING is the delivered render's choice and
    uses the deploy defaults (temperature 1.0, top_p 0.95, top_k 50).
  * A CONTROL TOKEN THAT IS NOT IN THE VOCABULARY IS READ ALOUD AS WORDS and
    derails generation into a degenerate loop - ASR coverage 0.000, pitch std
    0.28 st, speaker cosine 0.05. `<|emotion:calm|>`, `<|emotion:neutral|>`,
    `<|prosody:pause_long|>` and the v2-only `<|scene_desc_start|>` are all
    traps. Hence `validate_control_tokens`, run on every request.

EXACTLY ONE REFERENCE. vllm-omni refuses multi-shot cloning, so "two clips"
means ONE concatenated wav (clips joined by 0.35 s of silence) with the
transcripts joined in the same order - and the total is capped at 30 s (42 s is
HTTP 400 "Reference audio too long"). Measured: no reference 0.093 speaker
cosine, one clip 0.680, two clips 0.692, against a 0.766 narrator self-ceiling;
same-book vs cross-book is worth +0.076, the second clip only +0.012.

LICENCE: Boson Higgs TTS 3 Research and Non-Commercial. Fine for personal use
and, under the Creator Use Grant, for credited creator content; production
deployment or embedding in a product needs separate licensing.
"""
import io
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

import numpy as np

from ..protocol import BackendSpec, ClipsVoice, DefaultVoice

MODEL_ID = 'bosonai/higgs-audio-v3-tts-4b'
SERVED_MODEL_NAME = 'higgs-v3'
DEFAULT_BASE_URL = 'http://127.0.0.1:8095'
SPEECH_PATH = '/v1/audio/speech'
HEALTH_PATH = '/health'
MODELS_PATH = '/v1/models'

#: Where the operator's launch script lives. Named by env because the campaign
#: directory is not narrator's and must not be hard-coded into a shipped file.
SERVE_SCRIPT_ENV = 'NARRATOR_HIGGS3_SERVE_SCRIPT'
#: Attach to an ALREADY-RUNNING server instead of launching one.
BASE_URL_ENV = 'NARRATOR_HIGGS3_URL'
#: The WSL distro to run the launch script in, on Windows.
WSL_DISTRO_ENV = 'NARRATOR_HIGGS3_WSL_DISTRO'
#: WHICH MERGED CHECKPOINT the server on that URL is running.
#:
#: It has to be told, and it cannot be discovered: vllm-omni's `/v1/models`
#: reports the SERVED NAME (`higgs-v3`) and not the directory, and
#: `serve_v3.sh` `exec`s a hard-coded snapshot path, so narrator can neither
#: read the running server's checkpoint nor choose one at launch. For a
#: fine-tuned voice the operator therefore starts the server on that checkpoint
#: and states it here. It is an ASSERTION, not a verification - but a stated
#: assertion that can be checked against the voice is worth far more than a
#: silent assumption, which is a whole book in the wrong narrator.
CHECKPOINT_ENV = 'NARRATOR_HIGGS3_CHECKPOINT'

#: `vllm_omni/deploy/higgs_multimodal_qwen3.yaml` stage 0. Sending no
#: `extra_params` uses these verbatim, which is what the delivered render did.
SERVER_DEFAULT_SAMPLING = {'temperature': 1.0, 'top_p': 0.95, 'top_k': 50,
                           'repetition_penalty': 1.0, 'seed': 42}

#: Total reference audio the server accepts. 42 s returns HTTP 400.
MAX_REFERENCE_SECONDS = 30.0
#: Silence between concatenated reference clips, per HIGGS_V3_LEVERS.md 5.
REFERENCE_JOIN_SECONDS = 0.35

#: Chunk size. <= 600 chars is the measured safe zone; 900 drops the tail
#: reproducibly (coverage 0.78-0.86, tail coverage 0.00-0.31) and a reference
#: clip does NOT fix it. The delivered render used 300. 600 is a PLACEHOLDER
#: until the catalog carries it per (engine, voice).
MAX_CHARS = 600
DELIVERED_MAX_CHARS = 300

#: The fused context window (`--max-model-len 8192`).
CONTEXT_TOKENS = 8192
#: LM frames per second of audio, and the sample rate. Identical to v2.
FRAMES_PER_SECOND = 25.0
SAMPLE_RATE = 24000

#: Assembly fades. 10 ms in / 25 ms out, measured to take a chunk edge from
#: -30 dB to -45..-48 dB against a -70 dB floor.
EDGE_FADE_IN_MS = 10.0
EDGE_FADE_OUT_MS = 25.0

#: Every inline control token v3 actually has, read off
#: `tokenizer.get_added_vocab()` (work/added_vocab.json, 84 added tokens).
#: THIS IS AN ALLOWLIST, NOT DOCUMENTATION - see the module docstring.
ALLOWED_CONTROL_TOKENS = frozenset((
    '<|emotion:affection|>', '<|emotion:amusement|>', '<|emotion:anger|>',
    '<|emotion:arousal|>', '<|emotion:awe|>', '<|emotion:bitterness|>',
    '<|emotion:confusion|>', '<|emotion:contemplation|>',
    '<|emotion:contentment|>', '<|emotion:determination|>',
    '<|emotion:disgust|>', '<|emotion:elation|>', '<|emotion:enthusiasm|>',
    '<|emotion:fear|>', '<|emotion:helplessness|>', '<|emotion:longing|>',
    '<|emotion:pride|>', '<|emotion:relief|>', '<|emotion:sadness|>',
    '<|emotion:shame|>', '<|emotion:surprise|>',
    '<|env:music|>', '<|env:noise|>',
    '<|prosody:expressive_high|>', '<|prosody:expressive_low|>',
    '<|prosody:long_pause|>', '<|prosody:pause|>', '<|prosody:pitch_high|>',
    '<|prosody:pitch_low|>', '<|prosody:speed_fast|>',
    '<|prosody:speed_slow|>', '<|prosody:speed_very_fast|>',
    '<|prosody:speed_very_slow|>',
    '<|sfx:burping|>', '<|sfx:cough|>', '<|sfx:crying|>', '<|sfx:humming|>',
    '<|sfx:laughter|>', '<|sfx:screaming|>', '<|sfx:sigh|>', '<|sfx:sneeze|>',
    '<|sfx:sniff|>',
    '<|style:shouting|>', '<|style:singing|>', '<|style:whispering|>',
))

# Anything shaped like a control token. Deliberately loose: the point is to
# catch `<|emotion:calm|>` and `<|scene_desc_start|>` BEFORE the model reads
# them out loud, so the pattern must match the traps too.
_CONTROL_TOKEN_RE = re.compile(r'<\|[^|>]{1,64}\|>')


class HiggsV3ServerError(RuntimeError):
    """The server refused a request, or would not come up.

    Always carries the server's own message: vllm-omni's 400s say exactly what
    is wrong ("Reference audio too long (42.0s). Maximum 30s supported",
    "'references' only supports a single reference", "Token id -100 is out of
    vocabulary" when the vLLM patch is missing) and paraphrasing them loses the
    one thing a reader needs.
    """


# ---------------------------------------------------------------------------
# The text: control tokens
# ---------------------------------------------------------------------------


def validate_control_tokens(text: str) -> None:
    """Refuse any `<|...|>` sequence v3 does not have in its vocabulary.

    Not a nicety. An out-of-vocabulary token is split into 7-10 ordinary text
    pieces and READ ALOUD, and the render collapses: measured ASR coverage
    0.000, pitch std 0.28 st (a near-constant tone), speaker cosine 0.05. The
    request still returns HTTP 200, so nothing downstream would notice.
    """
    unknown = sorted({t for t in _CONTROL_TOKEN_RE.findall(text or '')
                      if t not in ALLOWED_CONTROL_TOKENS})
    if unknown:
        raise ValueError(
            f'Higgs v3 text carries control token(s) it does not have: '
            f"{', '.join(unknown)}. An unknown token is NOT ignored - it is read "
            'aloud as words and collapses the render (coverage 0.000). Note there '
            'is no <|emotion:neutral|>, no <|emotion:calm|>, the pause token is '
            '<|prosody:long_pause|> (not pause_long), and <|scene_desc_start|> is '
            'a v2 token that does not exist in v3.')


# ---------------------------------------------------------------------------
# The voice: one reference, 30 seconds, a data URI
# ---------------------------------------------------------------------------


def reference_seconds(voice: ClipsVoice) -> float:
    """Total reference audio, from the clips' declared durations. Raises if any
    clip has none - the 30 s cap cannot be enforced on a guess, and the server
    enforces it with an HTTP 400 either way."""
    missing = [c.path for c in voice.clips if c.seconds is None]
    if missing:
        raise ValueError(
            f"Higgs v3 voice '{voice.name}' has clip(s) with no duration: "
            f"{', '.join(missing)}. The server caps total reference audio at "
            f'{MAX_REFERENCE_SECONDS:.0f} s and rejects an over-long reference with '
            'HTTP 400, so the duration has to be known before the request is built.')
    return float(sum(c.seconds for c in voice.clips))


def check_reference_budget(voice: ClipsVoice) -> float:
    """The 30 s cap, checked client-side so the refusal names the clips."""
    total = reference_seconds(voice)
    # Concatenating N clips inserts N-1 joins of silence, which count.
    total += REFERENCE_JOIN_SECONDS * max(0, len(voice.clips) - 1)
    if total > MAX_REFERENCE_SECONDS:
        raise ValueError(
            f"Higgs v3 voice '{voice.name}': {total:.1f} s of reference audio across "
            f'{len(voice.clips)} clip(s) (joins included) exceeds the server\'s '
            f'{MAX_REFERENCE_SECONDS:.0f} s cap - it answers HTTP 400 "Reference audio '
            'too long". Two of our ~14 s clips is the practical maximum, and the '
            'second clip is worth only +0.012 speaker cosine anyway; same-BOOK clips '
            'are worth +0.076.')
    return total


def reference_data_uri(path: str) -> str:
    """A `data:audio/wav;base64,...` URI for one wav.

    A bare filesystem path is rejected ("The URL must be either a HTTP, data or
    file URL"), and a `file://` URL needs the server launched with
    `--allowed-local-media-path`. The data URI needs neither, which is why every
    render script uses one.
    """
    import base64
    if not os.path.isfile(path):
        raise ValueError(f'Higgs v3 reference clip does not exist: {path}')
    with open(path, 'rb') as handle:
        return 'data:audio/wav;base64,' + base64.b64encode(handle.read()).decode('ascii')


def reference_for(voice: ClipsVoice) -> dict:
    """The single `references` entry for `voice`.

    vllm-omni accepts EXACTLY ONE reference ("'references' only supports a
    single reference; multi-shot voice clone is not supported"), so a
    multi-clip voice must arrive as one CONCATENATED wav whose transcript is
    the clips' transcripts joined in the same order. narrator does not
    concatenate here: the joined wav is a corpus artifact (see the campaign's
    `work/refs/manifest.json`, where `x2` is exactly that), so a multi-clip
    ClipsVoice is refused with the instruction rather than silently using its
    first clip - which would be a different voice at 89 % of ceiling instead of
    90 %, reported as success.
    """
    check_reference_budget(voice)
    if len(voice.clips) != 1:
        raise ValueError(
            f"Higgs v3 voice '{voice.name}' has {len(voice.clips)} clips. vllm-omni "
            'takes EXACTLY ONE reference; several clips must be pre-joined into one '
            f'wav (clips separated by {REFERENCE_JOIN_SECONDS} s of silence) with the '
            'transcripts joined in the same order, and that joined wav given as a '
            'single clip. Refusing to use just the first one.')
    clip = voice.clips[0]
    return {'audio_path': reference_data_uri(clip.path), 'text': clip.transcript}


# ---------------------------------------------------------------------------
# Fine-tuned voices: MERGED CHECKPOINTS, one server each
# ---------------------------------------------------------------------------

#: The only way vllm-omni serves a fine-tuned Higgs voice.
#:
#: **THERE IS NO RUNTIME LoRA.** Measured by the training side, 2026-09-04
#: (HIGGS_FIELD_NOTES.md): vllm-omni exposes no adapter flags at all, and its
#: higgs_audio_v3 talker class does not implement `SupportsLoRA`. So a voice
#: cannot be attached to a running server, and there is no per-request adapter
#: either. Every fine-tuned voice ships as a MERGED CHECKPOINT DIRECTORY
#: (~8.5 GB, Boson's own layout) and the server is started ON that directory.
#: The LoRA is the archival artifact; merging is a CPU step that happens outside
#: narrator.
#:
#: The consequence for this module: the running server is KEYED ON ITS
#: CHECKPOINT DIR, and a request for a different voice is a server RESTART
#: (~55 s warm, up to ~300 s cold).
CHECKPOINT_STRATEGY = 'checkpoint'

#: Refused by name. It was one of two candidate strategies while vllm-omni's
#: LoRA support was unknown; it is now known not to exist.
RETIRED_STRATEGIES = {
    'lora-modules': (
        'vllm-omni cannot load a LoRA at runtime: it exposes no adapter flags '
        'and its higgs_audio_v3 talker does not implement SupportsLoRA '
        '(measured 2026-09-04). A fine-tuned Higgs voice is a MERGED CHECKPOINT '
        "directory served on its own - use kind 'checkpoint' with a "
        'checkpointDir.'),
    'merged-dir': (
        "renamed to 'checkpoint' - the voice IS the checkpoint, and calling it a "
        'merged ADAPTER dir kept implying a base model it sits on top of.'),
}


def check_strategy(strategy: str) -> str:
    """The only strategy is `checkpoint`. Anything else is refused BY NAME.

    A wrong strategy is a server that comes up serving the BASE voice and
    renders a whole book in it, so this never guesses.
    """
    if strategy == CHECKPOINT_STRATEGY:
        return strategy
    if strategy in RETIRED_STRATEGIES:
        raise ValueError(
            f"Higgs v3 strategy '{strategy}' is retired: "
            f'{RETIRED_STRATEGIES[strategy]}')
    raise ValueError(
        f"Unknown Higgs v3 voice strategy '{strategy}'. The only one is "
        f"'{CHECKPOINT_STRATEGY}': a merged checkpoint directory, served on its "
        'own.')


def checkpoint_serve_target(checkpoint_dir: str) -> str:
    """What `vllm-omni serve <...>` is pointed at for this voice.

    It IS the checkpoint dir - there are no extra launch arguments, because
    there is no adapter to name. Kept as a function so the one place that
    decides "which directory does this voice's server run on" has a name and a
    test.
    """
    if not (checkpoint_dir or '').strip():
        raise ValueError(
            'Higgs v3: a fine-tuned voice needs its merged checkpoint directory '
            '(checkpointDir). There is no adapter to load onto a base server.')
    return checkpoint_dir


# ---------------------------------------------------------------------------
# The request and the response
# ---------------------------------------------------------------------------


def cap_frames(text: str, chars_per_sec: float = 15.0, slack: float = 2.0,
               slack_frames: int = 150) -> int:
    """`max_new_tokens`, in FRAMES, by work/render_final.py's formula:
    `int(len(text) / 15.0 * 25 * 2.0) + 150`.

    (work/confirm.py uses the same one. render_v3.py, the earlier script, used
    1.8x + 100 - the v2 formula; the delivered render used this.)
    """
    expected_seconds = len(text or '') / chars_per_sec
    return int(expected_seconds * FRAMES_PER_SECOND * slack) + slack_frames


def build_request_body(text: str, voice, max_new_tokens: int, seed=None,
                       sampling=None, model: str = SERVED_MODEL_NAME) -> dict:
    """The POST body for one chunk, as work/render_final.py and work/confirm.py
    send it.

    `voice` is a ClipsVoice (reference cloning), a DefaultVoice (the model's
    own voice, or a fine-tune whose weights are the voice - no `references` key
    at all), or None (the same, unnamed).

    `sampling` EMPTY OR NONE means the server's own defaults, which is what the
    delivered render used. Anything given rides in `extra_params`, never at the
    top level - see the module docstring.
    """
    if not (text or '').strip():
        raise ValueError('Higgs v3 request: no text')
    validate_control_tokens(text)
    body = {
        'model': model,
        'input': text,
        'response_format': 'wav',
        'max_new_tokens': int(max_new_tokens),
    }
    if seed is not None:
        body['seed'] = int(seed)
    if voice is not None and not isinstance(voice, DefaultVoice):
        # A DefaultVoice sends NO `references` key: it IS the model's own voice,
        # which v3 serves text-only. The 30 s cap and the transcript rules have
        # nothing to apply to.
        body['references'] = [reference_for(voice)]
    if sampling:
        if 'seed' in sampling:
            # ONE place carries the seed: the top-level field. vllm-omni copies
            # extra_params onto the stage-0 sampling params, so a seed in both
            # is two sources for one number and nothing says which wins.
            raise ValueError(
                "Higgs v3 sampling carries a seed. The seed is the request's "
                'TOP-LEVEL `seed` field and only that - pass it as build_request_body'
                "(..., seed=...), never inside extra_params.")
        stray = sorted(set(sampling) - set(SERVER_DEFAULT_SAMPLING))
        if stray:
            raise ValueError(
                f'Higgs v3 sampling carries key(s) the stage-0 params do not have: '
                f"{', '.join(stray)}. Known: "
                f"{', '.join(sorted(SERVER_DEFAULT_SAMPLING))}.")
        body['extra_params'] = dict(sampling)
    return body


def decode_response(body: bytes, content_type: str = None):
    """The response body -> (float32 mono at 24 kHz, sample rate).

    FORMAT ASSUMPTION, STATED AS ONE: with `"response_format": "wav"` the
    endpoint returns a WAV FILE as the raw response body - that is what every
    render script does (`sf.read(io.BytesIO(r.content))`) and there is no
    recorded capture in the campaign to check byte for byte. If a capture ever
    lands in `<campaign>/higgs/captures/`, the fixture in
    tests/test_higgs_v3.py replaces the script-derived one and this function is
    where any correction goes - it is the single place the format is decided.

    A 200 whose body is not a WAV is REFUSED by name (see below).

    Multi-channel is averaged down, as the scripts do. NO TRIM AND NO FADE is
    applied: the patched server already trims the sentinel tail by content
    (work/patch_tail_trim.py), and the fades belong to assembly
    (`edge_fade_ms`).
    """
    import soundfile as sf
    if not body:
        raise HiggsV3ServerError('Higgs v3 returned an empty body')
    # A 200 that is not a WAV is the shape a proxy, an error page or a changed
    # `response_format` produces, and soundfile's own message for it ("Error
    # opening <_io.BytesIO ...>: Format not recognised") names nothing a reader
    # can act on. Check the RIFF/WAVE magic and say what actually arrived.
    if not (body[:4] == b'RIFF' and body[8:12] == b'WAVE'):
        head = body[:16]
        raise HiggsV3ServerError(
            'Higgs v3: expected a WAV body from /v1/audio/speech; got content-type '
            f'{content_type!r}, first bytes {head!r}. The request asks for '
            '"response_format": "wav" and every render script reads the body as a '
            'WAV file - see decode_response. A JSON or HTML body here is usually a '
            'proxy or an error page reaching us with status 200.')
    audio, rate = sf.read(io.BytesIO(body), dtype='float32', always_2d=True)
    audio = audio.mean(axis=1)
    if int(rate) != SAMPLE_RATE:
        raise HiggsV3ServerError(
            f'Higgs v3 returned {rate} Hz audio; this codec is fixed at '
            f'{SAMPLE_RATE} Hz and a manifest built on the wrong rate mis-times '
            'every cue after it.')
    return np.asarray(audio, dtype=np.float32).reshape(-1), int(rate)


# ---------------------------------------------------------------------------
# The backend
# ---------------------------------------------------------------------------


class HiggsV3ServedBackend:
    """`narrator.engine.protocol.ServedBackend` for Higgs v3.

    Two modes, chosen by what it is given:

      ATTACH   `base_url` names a server somebody else started (the operator,
               or a previous session). `start()` is a no-op, `stop()` refuses to
               kill a process it did not launch.
      LAUNCH   `serve_script` names the campaign's `serve_v3.sh`. `start()` runs
               it - through `wsl.exe -d <distro> bash <script>` on Windows,
               directly on Linux - and `stop()` terminates it.

    narrator never writes its own launch line: the script carries the CUDA_HOME
    and flashinfer workarounds without which the server does not start at all.
    """

    def __init__(self, base_url: str = None, serve_script: str = None,
                 wsl_distro: str = None, extra_args=None,
                 checkpoint_dir: str = None):
        base_url = (base_url or os.environ.get(BASE_URL_ENV) or '').strip()
        serve_script = (serve_script
                        or os.environ.get(SERVE_SCRIPT_ENV) or '').strip()
        if not base_url and not serve_script:
            raise ValueError(
                f'Higgs v3 needs either {BASE_URL_ENV} (attach to a running '
                f'vllm-omni server) or {SERVE_SCRIPT_ENV} (the path to the '
                "campaign's serve_v3.sh, which narrator runs rather than "
                'reimplementing). Neither is set.')
        if extra_args:
            raise ValueError(
                'serve_v3.sh takes no arguments - it `exec`s a fixed vllm-omni '
                f'command line - so {sorted(extra_args)} cannot be passed through it. '
                'Either the script gains a "$@" passthrough (their file, not ours), '
                'or launch the server by hand with those arguments and point '
                f'{BASE_URL_ENV} at it.')
        self.base_url = base_url or DEFAULT_BASE_URL
        self.serve_script = serve_script
        self.wsl_distro = (wsl_distro or os.environ.get(WSL_DISTRO_ENV)
                           or 'Ubuntu')
        self.spec = BackendSpec(
            kind='served', name='vllm-omni', version='0.28.0',
            base_url=self.base_url,
            notes=('higgs-audio-v3-tts-4b; requires patch_vllm.py and '
                   'patch_tail_trim.py in the higgs3 env'))
        # THE SERVER IS KEYED ON THIS. A fine-tuned Higgs voice is a merged
        # checkpoint the server runs ON, so "which voice is up" and "which
        # directory is up" are the same question - and a request for another one
        # is a restart, not a message.
        self.checkpoint_dir = (checkpoint_dir
                               or (os.environ.get(CHECKPOINT_ENV) or '').strip()
                               or None)
        self._proc = None
        self._guest_pid = None
        self._pid_file = None

    # -- lifecycle -----------------------------------------------------------

    def pid_file(self) -> str:
        """Where the launch wrapper writes the server's own pid, as the GUEST
        sees the path. One per backend instance, so two workers never read each
        other's."""
        if self._pid_file is None:
            self._pid_file = f'/tmp/narrator-higgs3-{os.getpid()}-{id(self):x}.pid'
        return self._pid_file

    def _wrapper(self) -> str:
        """The shell the launcher actually runs.

        `serve_v3.sh` ends in `exec vllm-omni ...`, so backgrounding it with `&`
        makes `$!` THE SERVER'S OWN PID - not a shell's. Recording it is what
        lets `stop()` signal the server BY PID inside the distro instead of
        pattern-killing `vllm-omni serve`, which would take another agent's
        server with it. `wait` then keeps this shell alive for exactly as long
        as the server, so the launcher process still tracks it.
        """
        script = (_to_wsl(self.serve_script) if sys.platform == 'win32'
                  else self.serve_script)
        pid_file = self.pid_file()
        return (f'bash {shlex.quote(script)} & '
                f'echo $! > {shlex.quote(pid_file)}; wait $!')

    def launch_command(self) -> list:
        """The command `start()` runs. Public so a test and a log line can see
        it without a GPU."""
        if not self.serve_script:
            raise ValueError(
                f'This backend is in ATTACH mode ({BASE_URL_ENV}={self.base_url}); '
                'it has no launch command.')
        if sys.platform == 'win32':
            wsl = shutil.which('wsl.exe') or 'wsl.exe'
            return [wsl, '-d', self.wsl_distro, 'bash', '-c', self._wrapper()]
        return ['bash', '-c', self._wrapper()]

    def _read_guest_pid(self, timeout: float = 30.0):
        """Read the pid the wrapper wrote, once it exists."""
        if sys.platform == 'win32':
            wsl = shutil.which('wsl.exe') or 'wsl.exe'
            read = [wsl, '-d', self.wsl_distro, 'cat', self.pid_file()]
        else:
            read = ['cat', self.pid_file()]
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                out = subprocess.run(read, capture_output=True, text=True,
                                     timeout=20)
                if out.returncode == 0 and out.stdout.strip().isdigit():
                    self._guest_pid = int(out.stdout.strip())
                    print(f'[HIGGS3] server guest pid {self._guest_pid}', file=sys.stderr, flush=True)
                    return self._guest_pid
            except (OSError, subprocess.SubprocessError):
                pass
            if self._proc is not None and self._proc.poll() is not None:
                return None
            time.sleep(0.5)
        print('[HIGGS3] WARNING: the launch wrapper never wrote a pid; stop() will '
              'not be able to signal the server inside the distro if the launcher '
              'exits without taking it down.', file=sys.stderr, flush=True)
        return None

    def start(self) -> None:
        """Launch the server. Idempotent: a second call while it is up does
        nothing, and never a second process on the same port."""
        if not self.serve_script:
            return                     # attach mode: somebody else owns it
        if self._proc is not None and self._proc.poll() is None:
            return
        if self.ping():
            # Already serving on that port. ADOPT IT ONLY IF IT SERVES WHAT WE
            # ASKED FOR - port 8095 is not proof of identity, and a leftover
            # server from another model, another adapter or another agent's
            # session would otherwise render a whole book in the wrong voice
            # while every message here said the right one.
            # check_serves_expected_model raises by name if it is the wrong
            # server; that is better than starting a second one, which would
            # fail to bind after paying a 55-297 s launch and ~14 GB.
            self.check_serves_expected_model()
            print(f'[HIGGS3] adopting the server already on {self.base_url}',
                  file=sys.stderr, flush=True)
            return
        command = self.launch_command()
        print(f'[HIGGS3] launching: {" ".join(command)}', file=sys.stderr, flush=True)
        self._proc = subprocess.Popen(command, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL)
        self._read_guest_pid()

    def served_models(self) -> list:
        """The model ids `/v1/models` reports. Raises if it cannot be read."""
        try:
            with urllib.request.urlopen(self.base_url + MODELS_PATH,
                                        timeout=10) as response:
                payload = json.loads(response.read().decode('utf-8'))
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise HiggsV3ServerError(
                f'Higgs v3: {self.base_url}{MODELS_PATH} could not be read ({exc}). '
                'Something is listening on that port but it does not answer the '
                'OpenAI model list, so it cannot be identified - refusing to send a '
                'render to it.') from exc
        return [row.get('id') for row in (payload.get('data') or [])]

    def check_serves_expected_model(self, checkpoint_dir: str = None) -> None:
        """Prove the server on this port is OURS before anything is sent to it.

        `/health` answering 200 says only that SOMETHING is listening. This
        checks `/v1/models` carries `higgs-v3`, and - when this voice is a
        fine-tune - that the running server is the one started ON ITS
        CHECKPOINT. The second check is why the backend records
        `checkpoint_dir` at all: every Higgs voice is a whole merged checkpoint
        and one server serves exactly one of them, so a leftover server from
        ANOTHER voice answers `/health` and `/v1/models` identically and would
        render a whole book in the wrong narrator while every log line here
        named the right one.
        """
        checkpoint_dir = checkpoint_dir or self.checkpoint_dir
        models = self.served_models()
        if SERVED_MODEL_NAME not in models:
            raise HiggsV3ServerError(
                f"Higgs v3: the server at {self.base_url} serves "
                f"{models or '(none)'}, not '{SERVED_MODEL_NAME}'. That is somebody "
                "else's server (or one left over from another model) on this port - "
                'refusing to render against it. Stop it, or point '
                'NARRATOR_HIGGS3_URL somewhere else.')
        if checkpoint_dir:
            running = self.running_checkpoint()
            if running is None:
                raise HiggsV3ServerError(
                    f'Higgs v3: this voice is the merged checkpoint {checkpoint_dir}, '
                    f'but nothing says which checkpoint the server at {self.base_url} '
                    f'is running. Set {CHECKPOINT_ENV} to the directory it was '
                    'started on. It cannot be discovered: /v1/models reports the '
                    'SERVED NAME, not the path, and serve_v3.sh execs a hard-coded '
                    'snapshot - so narrator can neither read it nor choose it. '
                    'Unchecked, a server left running for another voice would render '
                    'this whole book in that narrator.')
            if os.path.normpath(running) != os.path.normpath(checkpoint_dir):
                # Both are stated; they disagree, which is decidable and fatal.
                raise HiggsV3ServerError(
                    f'Higgs v3: the server at {self.base_url} is running on '
                    f'{running}, but this voice is {checkpoint_dir}. vllm-omni cannot '
                    'load a voice into a running server - it has no adapter flags and '
                    'its talker does not implement SupportsLoRA - so serving another '
                    'voice means RESTARTING on that checkpoint.')
        if checkpoint_dir:
            print(f'[HIGGS3] serving checkpoint {checkpoint_dir} (asserted, not '
                  'discovered - see CHECKPOINT_ENV)', file=sys.stderr, flush=True)

    def running_checkpoint(self):
        """Which merged checkpoint the server on this URL is running - as
        recorded at construction or through `NARRATOR_HIGGS3_CHECKPOINT`, never
        discovered. See CHECKPOINT_ENV for why it cannot be discovered."""
        return self.checkpoint_dir

    #: The tail-trim probe's gate, in dBFS of RMS over the last 300 ms of a
    #: one-word render. MEASURED: narrator's own smoke against a PATCHED server
    #: read -62.4 dB (its last 20 ms frames rising from -71 to -58 dB). An
    #: UNPATCHED server leaves ~250 ms of ramp-down sentinels decoded as real
    #: sound at about -30 dB, which puts the same window near -31 dB. -45 dB
    #: sits between them with ~14 dB of margin on each side.
    TAIL_TRIM_MAX_DBFS = -45.0
    TAIL_TRIM_WINDOW_SECONDS = 0.3
    TAIL_TRIM_PROBE_TEXT = 'Yes.'
    TAIL_TRIM_PROBE_SEED = 4242

    def probe_tail_trim(self, voice=None) -> float:
        """Prove `work/patch_tail_trim.py` is applied. Returns the measured dBFS.

        WHY A RENDER AND NOT A VERSION CHECK. The patch edits a file inside the
        higgs3 env's site-packages; it leaves no marker, no version bump and no
        endpoint - it writes only `higgs_audio_v3.py.orig` beside the file it
        rewrites, which is not visible over HTTP. An unpatched server is
        therefore INDISTINGUISHABLE from a patched one until you listen: it
        answers 200 and returns audio with ~240 ms of decoded sentinel garbage
        on the end of EVERY chunk. Owen heard exactly that as "a stray syllable
        or sound after each sentence", through a whole render.

        So the probe renders one short word at a fixed seed and measures the RMS
        of its last 300 ms. Cost: one ~1 s generation, once per server start.
        """
        body = build_request_body(
            self.TAIL_TRIM_PROBE_TEXT, voice,
            cap_frames(self.TAIL_TRIM_PROBE_TEXT),
            seed=self.TAIL_TRIM_PROBE_SEED)
        payload, ctype = self.post_speech(body, timeout=600,
                                          with_content_type=True)
        audio, rate = decode_response(payload, ctype)
        window = audio[-int(rate * self.TAIL_TRIM_WINDOW_SECONDS):]
        if window.size == 0:
            raise HiggsV3ServerError(
                'Higgs v3 tail-trim probe: the probe render produced no audio.')
        rms = float(np.sqrt(np.mean(np.square(window.astype(np.float64)))))
        dbfs = 20.0 * float(np.log10(max(rms, 1e-12)))
        if dbfs > self.TAIL_TRIM_MAX_DBFS:
            raise HiggsV3ServerError(
                'Higgs v3 tail-trim probe FAILED: the last '
                f'{self.TAIL_TRIM_WINDOW_SECONDS * 1000:.0f} ms of a one-word render '
                f'measured {dbfs:.1f} dBFS, above the {self.TAIL_TRIM_MAX_DBFS:.0f} '
                'dBFS gate. That is the signature of an UNPATCHED server: after the '
                'delay pattern is reverted the trailing frames still hold the '
                'ramp-down BOC/EOC sentinels, the shipped code maps them to codec '
                'code 0 - which decodes to real sound - and trims one frame of the '
                'seven. Every chunk would end in ~240 ms of audible garbage and '
                'nothing downstream would notice. Apply work/patch_tail_trim.py in '
                'the higgs3 env and restart the server. (A patched server measures '
                'about -62 dBFS here.)')
        print(f'[HIGGS3] tail-trim probe OK: {dbfs:.1f} dBFS over the last '
              f'{self.TAIL_TRIM_WINDOW_SECONDS * 1000:.0f} ms '
              f'(gate {self.TAIL_TRIM_MAX_DBFS:.0f})', file=sys.stderr, flush=True)
        return dbfs

    def ping(self) -> bool:
        """True when the health endpoint answers 200."""
        try:
            with urllib.request.urlopen(self.base_url + HEALTH_PATH,
                                        timeout=3) as response:
                return response.status == 200
        except (urllib.error.URLError, OSError):
            return False

    def wait_ready(self, timeout: float) -> bool:
        """Poll `/health` until it answers, or `timeout` seconds pass.

        Returns False on timeout rather than raising - a slow start is the
        caller's decision, and MEASURED COLD STARTS RANGE 55-297 s on this box
        (page cache and first-run compilation), so patience has to be generous.
        RAISES if the
        process we launched has DIED, naming its exit status: waiting out a
        timeout on a corpse is the failure mode this exists to avoid.
        """
        deadline = time.time() + float(timeout)
        while time.time() < deadline:
            if self._proc is not None and self._proc.poll() is not None:
                raise HiggsV3ServerError(
                    f'Higgs v3 server exited with status {self._proc.returncode} '
                    'before becoming ready. Its log is wherever the launch script '
                    'sends it; the usual causes are the flashinfer JIT (needs '
                    'CUDA_HOME + VLLM_USE_FLASHINFER_SAMPLER=0) and OOM at a '
                    'gpu-memory-utilization the card cannot honour.')
            if self.ping():
                return True
            time.sleep(1.0)
        return False

    def stop(self, timeout: float = 60.0) -> None:
        """Terminate the server we launched, and VERIFY it is gone.

        Idempotent, and it never kills a process it did not start: in ATTACH
        mode (`NARRATOR_HIGGS3_URL`) it returns at once, leaving the server
        running and unpolled.

        THE WINDOWS PROBLEM. On Linux the child IS `vllm-omni` (serve_v3.sh
        `exec`s it), so SIGTERM reaches the server. On Windows the child is
        `wsl.exe`, and terminating it kills the Windows-side relay - the guest
        process may keep running, holding ~14 GB of VRAM, invisible to
        `proc.poll()`, which now reports a tidy exit. So the port is polled
        after the terminate, and if something is still serving there the guest
        process is signalled BY PID inside the distro. The pid is the one
        `launch_command()` recorded at launch (the wrapper prints it), never a
        pkill pattern: `pkill -f "vllm-omni serve"` would kill another agent's
        server too.
        """
        if not self.serve_script:
            # ATTACH MODE: this backend never launched anything, so there is
            # nothing of ours to terminate and nothing to wait for. Returning
            # immediately is not a shortcut - polling the port here would block
            # on somebody else's healthy server for the whole timeout and then
            # report it as a leak.
            return
        proc = self._proc
        self._proc = None
        if proc is not None and proc.poll() is None:
            try:
                proc.send_signal(signal.SIGTERM)
            except (OSError, ValueError):
                pass
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                print('[HIGGS3] launcher did not stop on SIGTERM; killing',
                      file=sys.stderr, flush=True)
                proc.kill()
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    pass
        self._verify_gone(timeout=timeout)

    def _verify_gone(self, timeout: float = 60.0) -> None:
        """Poll the port until nothing answers; escalate to a guest-side signal.

        Only ever runs for a server WE launched (`_guest_pid` is set at launch),
        so an attached server is left alone even if it is still up.
        """
        deadline = time.time() + float(timeout)
        while time.time() < deadline:
            if not self.ping():
                return
            time.sleep(1.0)
        if self._guest_pid is None:
            print(f'[HIGGS3] WARNING: something is still serving {self.base_url} '
                  'and this process did not record a guest pid for it; leaving it '
                  'alone rather than killing a server it may not own.', file=sys.stderr, flush=True)
            return
        print(f'[HIGGS3] server still up after the launcher exited; signalling '
              f'guest pid {self._guest_pid}', file=sys.stderr, flush=True)
        self._signal_guest(self._guest_pid, 'TERM')
        deadline = time.time() + 30.0
        while time.time() < deadline:
            if not self.ping():
                return
            time.sleep(1.0)
        print(f'[HIGGS3] guest pid {self._guest_pid} ignored TERM; sending KILL',
              file=sys.stderr, flush=True)
        self._signal_guest(self._guest_pid, 'KILL')

    def _signal_guest(self, pid: int, signame: str) -> None:
        """Signal one pid INSIDE the distro, by pid, never by pattern."""
        if sys.platform != 'win32':
            try:
                os.kill(int(pid), signal.SIGKILL if signame == 'KILL'
                        else signal.SIGTERM)
            except OSError as exc:
                print(f'[HIGGS3] could not signal {pid}: {exc}', file=sys.stderr, flush=True)
            return
        wsl = shutil.which('wsl.exe') or 'wsl.exe'
        try:
            subprocess.run([wsl, '-d', self.wsl_distro, 'kill', f'-{signame}',
                            str(pid)], timeout=30, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError) as exc:
            print(f'[HIGGS3] could not signal guest pid {pid}: {exc}', file=sys.stderr, flush=True)

    # -- use -----------------------------------------------------------------

    def speak(self, request):
        """One `SpeechRequest` -> (float32 mono, sample rate).

        `request.voice` is a ClipsVoice; `request.sampling` empty means the
        server's own defaults. A non-200 raises with the server's own message.
        """
        body = build_request_body(request.text, request.voice,
                                  request.max_new_tokens, seed=request.seed,
                                  sampling=request.sampling)
        payload, content_type = self.post_speech(body, with_content_type=True)
        return decode_response(payload, content_type)

    def post_speech(self, body: dict, timeout: float = 1800,
                    with_content_type: bool = False):
        """POST `body` to /v1/audio/speech and return the raw response bytes
        (or `(bytes, content_type)` when asked)."""
        payload = json.dumps(body).encode('utf-8')
        req = urllib.request.Request(
            self.base_url + SPEECH_PATH, data=payload,
            headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                data = response.read()
                ctype = response.headers.get('Content-Type')
                return (data, ctype) if with_content_type else data
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode('utf-8', 'replace')[:800]
            if 'Token id -100' in detail:
                # The one 400 whose text does not say what to do about it.
                raise HiggsV3ServerError(
                    f'Higgs v3 HTTP {exc.code}: {detail}\n'
                    'THE vLLM PATCH IS MISSING. vllm-omni builds every voice-clone '
                    'prompt with AUDIO_PLACEHOLDER_ID == -100, which the talker '
                    'substitutes with reference embeddings at prefill, but vLLM '
                    "0.28's blanket negative-id check rejects it first. Apply "
                    'work/patch_vllm.py in the higgs3 env and restart the server. '
                    'Without it EVERY cloned request fails this way and only an '
                    'un-cloned one succeeds - which renders in the model\'s own '
                    'voice, at 12 % of the narrator ceiling.') from exc
            raise HiggsV3ServerError(
                f'Higgs v3 HTTP {exc.code}: {detail}') from exc
        except urllib.error.URLError as exc:
            raise HiggsV3ServerError(
                f'Higgs v3 server at {self.base_url} is unreachable: {exc.reason}. '
                'Is it started (serve_v3.sh; cold start measured 55-297 s) and are '
                'both site-packages patches applied?') from exc


def _to_wsl(path: str) -> str:
    r"""A Windows path -> the path WSL sees.

        C:\x\y                    -> /mnt/c/x/y
        \\wsl$\Ubuntu\home\t        -> /home/t   (already INSIDE the distro)
        \\wsl.localhost\Ubuntu\opt  -> /opt
        /already/posix             -> unchanged

    The UNC forms matter and are not theoretical: a script living in the
    distro's own filesystem is reached from Windows as `\\wsl$\<distro>\...`,
    and running that through the drive-letter rule would produce a path with no
    meaning on either side - the launch would fail with a confusing "No such
    file" from bash rather than from here.
    """
    path = (path or '').replace('\\', '/')
    lowered = path.lower()
    for prefix in ('//wsl$/', '//wsl.localhost/'):
        if lowered.startswith(prefix):
            # Drop the prefix AND the distro name; what remains is an absolute
            # path in the guest.
            _distro, _, tail = path[len(prefix):].partition('/')
            return '/' + tail
    if len(path) > 1 and path[1] == ':':
        return '/mnt/' + path[0].lower() + path[2:]
    return path
