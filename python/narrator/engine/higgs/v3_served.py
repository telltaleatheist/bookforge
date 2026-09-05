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
`work/patch_vllm.py` + `work/patch_sentinel_filter.py` (the two required
patches),
`HIGGS_V3_LEVERS.md` (the lever sweep, the delivered render, the control-token
vocabulary), `work/refs/manifest.json` (the reference clips) and
`work/serve_v3c.log` (the route table).

THE ENVIRONMENT (owens-pc, WSL Ubuntu, RTX 3090 Ti)

    env      /home/telltale/anaconda3/envs/higgs3 (python 3.11,
             torch 2.13.0+cu130, vllm 0.28.0, vllm-omni 0.28.0)
    launch   BookForge's serve_higgs_v3.sh (transcribed from the campaign's
             serve_v3.sh) - vllm-omni serve <model dir> --served-model-name
             higgs-v3 --host/--port --trust-remote-code --stage-overrides
             <per-stage memory / max_num_seqs / max_model_len>
             --attention-backend FLASH_ATTN --omni, with CUDA_HOME pointed at
             the pip CUDA 13 wheel, VLLM_USE_FLASHINFER_SAMPLER=0,
             VLLM_DISABLE_FLASHINFER_PREFILL=1, TORCH_CUDA_ARCH_LIST=8.6.
             The model dir, the bind address and the concurrency come from
             the HIGGS_* variables narrator exports (`_launch_exports`).
             PER-STAGE, not the global flags the campaign used: vllm-omni
             applies a global --gpu-memory-utilization to EVERY stage, and
             this server is two of them (talker + codec), so 0.60 reserved
             1.2 cards - measured 24.2 of 24.5 GB on 2026-09-05.
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
  work/patch_sentinel_filter.py
                           filters frames by TOKEN IDENTITY: a frame is kept iff
                           all 8 codebooks are in [0, 1023]. THIS IS
                           SERVER-SIDE. Upstream substituted every out-of-range
                           code with 0 - a VALID codec code that decodes to real
                           sound, so the substitution CONVERTED the ramp-down
                           BOC/EOC sentinels into audio - and then trimmed
                           exactly one of the seven frames they smear across,
                           leaving ~240 ms of garbage on every chunk. The patch
                           removes the substitution and the positional trim
                           entirely (`[:, :-1]` occurs twice in the pristine
                           file and zero times after it). The streaming path
                           gets the trailing run only, because Stage 1 trims
                           left_context/right_holdback BY FRAME COUNT and
                           dropping a leading or interior frame would desync
                           those trims and cut real speech. So a patched server
                           returns audio whose tail is already clean and THE
                           CLIENT MUST NOT TRIM AGAIN. What remains is a hard
                           sample boundary, which is a click: `edge_fade` -
                           EdgeFade(10 in, 25 out) - is the assembler's job.
                           SUPERSEDES work/patch_tail_trim.py (retired
                           2026-09-05), which reasoned about WHERE sentinels
                           usually sit and kept the 0-substitution for every one
                           outside the trailing run.

Both belong in a managed-env recipe at cut-over; see ../PORT_NOTES.md 12.7.

WHAT THE REQUEST LOOKS LIKE, and the two ways it goes silently wrong:

  * SAMPLING MUST RIDE IN `extra_params`. `temperature` / `top_p` / `top_k` are
    not fields of `OpenAICreateSpeechRequest`; pydantic drops them without a
    word, and the whole first audition therefore ran at the server default
    while reporting 0.3. AND "the server default" IS THE MODEL DIRECTORY:
    sending nothing means whatever `<model dir>/generation_config.json` holds,
    because `--generation-config` defaults to `auto` and `serve_v3.sh` passes no
    override. A validated merged checkpoint holds temperature 1.0, top_p 0.95,
    top_k 50, repetition_penalty 1.0; a directory WITHOUT the file - which is
    every unmerged `bosonai/higgs-audio-v3-tts-4b` snapshot - gets a bare
    `SamplingParams()` instead: top_p 1.0 and top_k DISABLED, the untruncated
    1026-way codebook tail, which derails long chunks into babble. See
    `require_generation_config` and ../PORT_NOTES.md 12.8d. So base weights are
    sent `SERVER_DEFAULT_SAMPLING` EXPLICITLY (HiggsV3Config.served_sampling)
    and only a checkpoint voice sends nothing.
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
import dataclasses
import io
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import sys
import time
import urllib.error
import urllib.request

import numpy as np

from ..protocol import BackendSpec, ClipsVoice, DefaultVoice
from ..log import log

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
#: WHICH MERGED CHECKPOINT an ATTACHED server is running, when the server
#: cannot say so itself.
#:
#: Normally it CAN: vllm-omni 0.28's `/v1/models` carries `"root": <the model
#: path the server was started on>` beside the served name (measured on
#: owens-pc 2026-09-05: root = the base snapshot path when the launcher was
#: started without HIGGS_MODEL_DIR), and `running_checkpoint()` reads it. This
#: variable is the operator's assertion for a server build whose model list
#: does NOT carry a root; it is consulted only then, and never overrides a root
#: the server reports - a reported path is a fact and an env var is a claim.
CHECKPOINT_ENV = 'NARRATOR_HIGGS3_CHECKPOINT'
#: THE LAUNCH SCRIPT'S OWN KNOBS (`serve_higgs_v3.sh`), exported into the
#: wrapper's environment by narrator at launch. narrator states every one of
#: them rather than inheriting whatever the worker's environment happens to
#: hold, because each is a place the two sides can silently disagree:
#:   HIGGS_MODEL_DIR    the merged checkpoint the server comes up ON. Left
#:                      unset, the script serves the base snapshot - a
#:                      different speaker - and `check_serves_expected_model`
#:                      then (correctly) refuses after a 55-297 s launch.
#:                      That was Owen's first in-app Higgs render (2026-09-05).
#:   HIGGS_HOST/PORT    where the script binds, which must be where narrator
#:                      polls `/health` and posts renders.
#:   HIGGS_MAX_NUM_SEQS how many sequences stage 0 admits at once - and
#:                      therefore how wide narrator's own batch is
#:                      (`serve_concurrency`). One number, stated once.
SERVE_MODEL_DIR_ENV = 'HIGGS_MODEL_DIR'
SERVE_HOST_ENV = 'HIGGS_HOST'
SERVE_PORT_ENV = 'HIGGS_PORT'
SERVE_MAX_NUM_SEQS_ENV = 'HIGGS_MAX_NUM_SEQS'
#: The launch script's own bind defaults, mirrored so that a launch with
#: neither variable set polls the port the script binds. Not a fallback that
#: hides a bug: both sides read the same two literals, and narrator EXPORTS
#: the pair it chose into the wrapper, so they cannot drift apart.
SERVE_DEFAULT_HOST = '127.0.0.1'
SERVE_DEFAULT_PORT = 8095
#: How the base snapshot is recognised in a reported model root: the HF cache
#: directory name of `bosonai/higgs-audio-v3-tts-4b`. A server whose root
#: carries this is serving the BASE weights; any other root is a fine-tune.
BASE_SNAPSHOT_MARKER = 'models--bosonai--higgs-audio-v3-tts-4b'
#: Where launch wrappers record the server's pid, in the GUEST filesystem.
#: One file per backend instance; the glob is what `_own_servers_on_port`
#: scans to recognise a server narrator itself left behind.
PID_FILE_DIR = '/tmp'
PID_FILE_PREFIX = 'narrator-higgs3-'

#: WHERE AN ATTACHED SERVER'S LOG IS, named by the operator. NO DEFAULT.
#:
#: In LAUNCH mode narrator owns the server's output and writes it itself (see
#: `server_log`), so this is not needed. In ATTACH mode the server belongs to
#: somebody else and its output went wherever they sent it; narrator cannot
#: discover that and will not guess, because the wrong file is worse than none -
#: a stale log from an earlier run would let the sentinel proof pass on evidence
#: from a server that is no longer up.
#:
#: The training side's own launcher tees to
#: `E:\\training\\_campaigns\\2026-09-01-cod-full-rebuild\\higgs\\v3_ft\\logs\\serve_current.log`,
#: OVERWRITTEN PER START, and that is the path an operator points this at when
#: attaching to their server. Give it in the form the READING process sees: a
#: narrator worker runs inside WSL, so that file is `/mnt/e/training/...` there.
SERVER_LOG_ENV = 'NARRATOR_HIGGS3_SERVER_LOG'

#: `vllm_omni/deploy/higgs_multimodal_qwen3.yaml` stage 0 - THE DEPLOY DEFAULT
#: FOR THE BASE WEIGHTS, and nothing more than that.
#:
#: It is NOT what a request gets by sending no `extra_params`. `vllm-omni serve`
#: on the CLI never reads that YAML; it resolves sampling from the MODEL
#: DIRECTORY (`--generation-config` defaults to `auto`), so an empty request
#: gets `<model dir>/generation_config.json` - and, when the directory has no
#: such file, a bare `SamplingParams()`: top_p 1.0, top_k DISABLED. The
#: `bosonai/higgs-audio-v3-tts-4b` snapshot ships no such file, which is why a
#: merged checkpoint must carry one (`require_generation_config`) and why base
#: weights are sent these values EXPLICITLY rather than assumed
#: (`HiggsV3Config.served_sampling`). See ../PORT_NOTES.md 12.8d.
#:
#: `seed` rides at the request's TOP LEVEL and never inside `extra_params`
#: (`build_request_body` refuses the duplicate), so it is excluded wherever this
#: mapping is used as a sampling payload.
SERVER_DEFAULT_SAMPLING = {'temperature': 1.0, 'top_p': 0.95, 'top_k': 50,
                           'repetition_penalty': 1.0, 'seed': 42}

#: The log file narrator writes a server it LAUNCHED to, inside the session's
#: process dir when there is one. narrator has no other log FILE anywhere - its
#: own engine lines go to a STREAM the host chooses (`engine/log.py`) - so this
#: is a new artifact, and it lives beside `session-state.json` because that is
#: the directory that already holds a run's own per-run files (the Orpheus
#: guards file their rejects there too). One per SESSION, overwritten per start,
#: exactly like the training side's `serve_current.log`.
SERVER_LOG_NAME = 'higgs-v3-server.log'

#: WHAT A CLEAN CHUNK LOOKS LIKE IN THAT LOG, and it is not zero.
#:
#: `patch_sentinel_filter.py` counts out-of-range frames in the async path
#: BEFORE it trims the trailing run, so it counts the model's normal 2-frame EOC
#: ramp and prints it as "outside the trailing run". That is an INSTRUMENTATION
#: BUG in the patch, measured by the fine-tuning session 2026-09-05 in
#: sequential and concurrent renders alike: the frames are trimmed correctly and
#: the audio is right. So the expected reading is exactly 2 per line, and any
#: OTHER count is the thing worth refusing on - that is what a sentinel the trim
#: does not reach would print.
EXPECTED_TRAILING_SENTINEL_FRAMES = 2

#: The three lines the sentinel filter can write, matched by MESSAGE and not by
#: `file:line`. On the certified build they are `higgs_audio_v3.py:403` (async),
#: `:126` (sync interior) and `:119` (everything was a sentinel) - but a line
#: number is a property of the patch's layout, and the whole point of a
#: certificate is that the patch may be re-cut (the one-line fix for the count
#: above will move all three). The MESSAGE text is what the patch owns.
_ASYNC_SENTINEL_RE = re.compile(
    r'higgs_audio_v3 \(async\): (\d+) frame\(s\) carry a stream sentinel '
    r'outside the trailing run')
_SYNC_INTERIOR_RE = re.compile(
    r'higgs_audio_v3 \(sync\): (\d+) interior sentinel frame\(s\) dropped')
_EMPTY_CHUNK_RE = re.compile(
    r'higgs_audio_v3[^:]*: every frame carried a stream sentinel')

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


class HiggsV3ServerDown(HiggsV3ServerError):
    """Nothing answered at all: the server is not there.

    Distinct from a refusal so a BATCH can tell the two apart. A 400 on one
    chunk (an over-long reference, a bad control token) is that chunk's
    failure and the rest of the batch proceeds; a connection refused is the
    whole server gone, and rendering the remaining thousand chunks against it
    would mark every one of them failed one at a time.
    """


def serve_concurrency() -> int:
    """How many requests the server admits at once - `HIGGS_MAX_NUM_SEQS`.

    THE ONE NUMBER BEHIND BATCHING on the served arm. vllm-omni's continuous
    batcher schedules up to stage 0's `max_num_seqs` sequences together, and its
    own `/v1/audio/speech/batch` endpoint is nothing more than an
    `asyncio.gather` over the items (serving_speech.py:create_speech_batch,
    measured 2026-09-05) - so N concurrent POSTs to the plain endpoint ARE the
    batch, and there is nothing to be gained from the batch endpoint except a
    response that arrives when the slowest item does.

    Read from the environment because the same variable is what the launch
    script passes as `max_num_seqs`: BookForge sets it from the catalog's
    serving block, narrator exports it into the wrapper at launch and sizes
    `BATCH_SIZE` from it. Refused by name when absent - a guessed width is
    either a server idling at 1 or a queue the render never asked for.
    """
    raw = (os.environ.get(SERVE_MAX_NUM_SEQS_ENV) or '').strip()
    if not raw:
        raise ValueError(
            f'Higgs v3: {SERVE_MAX_NUM_SEQS_ENV} is not set. It is the number of '
            'sequences the server admits at once (the launch script passes it as '
            'stage 0 max_num_seqs) and the width of narrator\'s batch; BookForge '
            "sets it from the catalog's serving block. There is no default.")
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(
            f'Higgs v3: {SERVE_MAX_NUM_SEQS_ENV}={raw!r} is not an integer.') from None
    if value < 1:
        raise ValueError(
            f'Higgs v3: {SERVE_MAX_NUM_SEQS_ENV}={value} must be at least 1.')
    return value


def launch_base_url() -> str:
    """Where a server narrator LAUNCHES will answer: the `HIGGS_HOST` /
    `HIGGS_PORT` pair the launch script binds, from the environment when
    BookForge stated them and the script's own literals otherwise. The pair is
    exported into the wrapper too, so the script binds exactly what this
    returns."""
    host = (os.environ.get(SERVE_HOST_ENV) or '').strip() or SERVE_DEFAULT_HOST
    raw_port = (os.environ.get(SERVE_PORT_ENV) or '').strip()
    if raw_port:
        try:
            port = int(raw_port)
        except ValueError:
            raise ValueError(
                f'Higgs v3: {SERVE_PORT_ENV}={raw_port!r} is not a port number.') from None
    else:
        port = SERVE_DEFAULT_PORT
    return f'http://{host}:{port}'


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


#: THE SAMPLING AUTHORITY OF A MERGED CHECKPOINT, and a REQUIRED file of one.
#:
#: `vllm-omni serve <dir>` resolves sampling from the MODEL DIRECTORY:
#: `--generation-config` defaults to `auto`, so this file - and only this file -
#: sets temperature / top_p / top_k for every request the server answers.
#: `OpenAICreateSpeechRequest` has no temperature / top_p / top_k fields (see the
#: module docstring: pydantic drops them silently), so there is no per-request
#: lever that can correct it.
#:
#: MEASURED, 2026-09-05 (the fine-tune campaign): a merged dir WITHOUT this file
#: makes vllm-omni's stage fallback (`entrypoints/openai/stage_params.py`) hand
#: back a bare `SamplingParams()` - temperature 1.0, **top_p 1.0, top_k
#: DISABLED** - which samples the untruncated 1026-way codebook tail and derails
#: long prompts into babble (seed-dependent collapse to 3-10 s of audio at >= 600
#: chars). With the file present the same server renders the same prompts
#: correctly.
GENERATION_CONFIG_FILE = 'generation_config.json'

#: The keys that make that file the SAMPLING file. A `generation_config.json`
#: carrying none of them (an eos_token_id stub, say) is not the file this needs -
#: the server would read it, find no sampling, and fall back exactly as if it
#: were absent. So its presence is checked by CONTENT, not by name.
GENERATION_CONFIG_SAMPLING_KEYS = ('temperature', 'top_p', 'top_k')

#: What a correct one holds for this model family, recorded so a reader can see
#: what "present and valid" looks like. NOT a default and NEVER written by
#: narrator: the FILE is the authority and the merge is what puts it there.
#: These are `vllm_omni/deploy/higgs_multimodal_qwen3.yaml` stage 0's
#: `default_sampling_params` - which `vllm-omni serve` on the CLI does not read,
#: which is why the values have to be materialised into the model directory.
GENERATION_CONFIG_EXPECTED = {'temperature': 1.0, 'top_p': 0.95, 'top_k': 50,
                              'repetition_penalty': 1.0}

_WHY_GENERATION_CONFIG = (
    'vllm-omni serves a checkpoint DIRECTORY and resolves sampling from it '
    '(--generation-config defaults to "auto"), so that file is the temperature / '
    'top_p / top_k the server actually uses; without it vLLM falls back to a bare '
    'SamplingParams (top_p 1.0, top_k DISABLED), which samples the untruncated '
    '1026-way codebook tail and derails long chunks into babble - and '
    'OpenAICreateSpeechRequest has no sampling fields, so no request can correct '
    'it.')


def require_generation_config(checkpoint_dir: str, voice_name: str) -> dict:
    """Read a merged checkpoint's `generation_config.json`, or refuse BY NAME.

    THE ONE PLACE the file is validated, for both arms (see
    `checkpoint_serve_target`). Returns the parsed document so a caller that
    needs the values - the MLX backend, which has no server to read them for it -
    takes them from the FILE and never from a constant here.

    Nothing is copied, synthesized or defaulted. A merged dir that does not
    carry this file is MISCONFIGURED, not under-specified: the merge that built
    it is what puts the file there (it asserts byte-equality with the base, or
    copies a recorded per-run override), and narrator writing one would be
    narrator deciding a model's sampling.
    """
    name = (voice_name or '').strip()
    if not name:
        raise ValueError(
            'require_generation_config() needs the VOICE NAME: every refusal it '
            'makes has to say which voice is misconfigured, and an unnamed one is '
            'a refusal nobody can act on.')
    if not os.path.isdir(checkpoint_dir):
        raise ValueError(
            f"Higgs v3 voice '{name}' names the merged checkpoint directory "
            f'{checkpoint_dir}, which is not a directory. The checkpoint IS the '
            'voice - there is nothing to serve, and nothing to read its sampling '
            'from.')
    path = os.path.join(checkpoint_dir, GENERATION_CONFIG_FILE)
    if not os.path.isfile(path):
        raise ValueError(
            f"Higgs v3 voice '{name}': the merged checkpoint {checkpoint_dir} does "
            f'not carry {GENERATION_CONFIG_FILE}, which is a REQUIRED file of a '
            f'Higgs v3 checkpoint - {_WHY_GENERATION_CONFIG} Re-merge the '
            'checkpoint (the merge writes it) rather than dropping one in by hand.')
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            text = handle.read()
    except OSError as exc:
        # Permissions, a DIRECTORY named generation_config.json, a broken
        # symlink, an unreadable mount. Every other state of this file is
        # refused with the voice, the path and why; a bare OSError from here
        # would be the one refusal in this feature that names neither.
        raise ValueError(
            f"Higgs v3 voice '{name}': {path} exists but could not be read "
            f'({exc}). {_WHY_GENERATION_CONFIG}') from exc
    try:
        document = json.loads(text)
    except ValueError as exc:
        raise ValueError(
            f"Higgs v3 voice '{name}': {path} is not parseable JSON ({exc}). "
            f'{_WHY_GENERATION_CONFIG} A file the server cannot parse is a file it '
            'does not apply.') from exc
    if not isinstance(document, dict):
        raise ValueError(
            f"Higgs v3 voice '{name}': {path} holds a "
            f'{type(document).__name__}, not a JSON object of sampling '
            f'parameters. {_WHY_GENERATION_CONFIG}')
    missing = [key for key in GENERATION_CONFIG_SAMPLING_KEYS
               if key not in document]
    if missing:
        raise ValueError(
            f"Higgs v3 voice '{name}': {path} carries no "
            f"{', '.join(missing)}. A generation_config.json that does not carry "
            'sampling is not the file this needs - the server reads it, finds no '
            f'sampling and falls back exactly as if it were absent. '
            f'{_WHY_GENERATION_CONFIG} It should hold '
            f'{GENERATION_CONFIG_EXPECTED} for this model family.')
    _check_sampling_types(document, path, name)
    return document


def _check_sampling_types(document: dict, path: str, name: str) -> None:
    """The three (four, with `repetition_penalty`) values must be NUMBERS OF THE
    RIGHT KIND, refused by name exactly as absence is.

    Presence without type is not validation. `"top_k": 50.7` truncates silently
    to 50 the moment anything calls `int()` on it; `"temperature": null` raises a
    bare TypeError from whichever caller touched it first, naming neither the
    voice nor the file; and on the served arm nothing reads the values at all, so
    a malformed one goes straight to vLLM. A number that is wrong in a way
    nobody says out loud is the failure this whole file exists to stop.

    `bool` is excluded deliberately: `True` is an `int` in Python and
    `"top_k": true` is not a top-k.
    """
    for key in ('temperature', 'top_p', 'repetition_penalty'):
        if key not in document:
            # Only `repetition_penalty` can be absent here - the other two are
            # required above - and an absent one is vLLM's own default, which
            # narrator neither states nor checks.
            continue
        value = document[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(
                f"Higgs v3 voice '{name}': {path} gives {key} as "
                f'{value!r} ({type(value).__name__}), which is not a number. '
                f'{_WHY_GENERATION_CONFIG}')
        value = float(value)
        if value != value or value in (float('inf'), float('-inf')):
            raise ValueError(
                f"Higgs v3 voice '{name}': {path} gives {key} as {value!r}, "
                'which is not a finite number.')
        if key == 'temperature' and value < 0.0:
            raise ValueError(
                f"Higgs v3 voice '{name}': {path} gives temperature {value!r}. "
                'Temperature is a divisor of the logits and cannot be negative; '
                '0.0 is greedy decoding.')
        if key == 'top_p' and not 0.0 < value <= 1.0:
            raise ValueError(
                f"Higgs v3 voice '{name}': {path} gives top_p {value!r}. "
                'top_p is a probability mass and must be in (0.0, 1.0]. (1.0 is '
                'accepted and means the UNTRUNCATED tail - if a checkpoint '
                'really wants that, it says so here and narrator does not '
                'second-guess it.)')
        if key == 'repetition_penalty' and value <= 0.0:
            raise ValueError(
                f"Higgs v3 voice '{name}': {path} gives repetition_penalty "
                f'{value!r}, which must be positive (1.0 is no penalty).')
    top_k = document['top_k']
    if isinstance(top_k, bool) or not isinstance(top_k, int):
        raise ValueError(
            f"Higgs v3 voice '{name}': {path} gives top_k as {top_k!r} "
            f'({type(top_k).__name__}). top_k is a COUNT of candidate tokens and '
            'must be a whole number - a float here is silently truncated by '
            'every consumer, which is a different sampling than the file states.')
    if top_k < 0:
        raise ValueError(
            f"Higgs v3 voice '{name}': {path} gives top_k {top_k!r}. It must be "
            'a non-negative count. (0 is accepted and DISABLES top-k - a '
            'checkpoint that states that is stating it deliberately.)')


def checkpoint_serve_target(checkpoint_dir: str, voice_name: str) -> str:
    """What `vllm-omni serve <...>` is pointed at for this voice.

    It IS the checkpoint dir - there are no extra launch arguments, because
    there is no adapter to name. Kept as a function so the one place that
    decides "which directory does this voice's server run on" has a name and a
    test - and, since 2026-09-05, so that the one place also PROVES the directory
    carries the sampling the server will read out of it
    (`require_generation_config`). Both v3 arms call this: the served config
    (`HiggsV3Config.__post_init__`), the MLX config builder, and both
    `resolve_load_voice`s.
    """
    if not (checkpoint_dir or '').strip():
        raise ValueError(
            'Higgs v3: a fine-tuned voice needs its merged checkpoint directory '
            '(checkpointDir). There is no adapter to load onto a base server.')
    require_generation_config(checkpoint_dir, voice_name)
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

    `sampling` EMPTY OR NONE sends no `extra_params` at all, which means THE
    MODEL DIRECTORY'S `generation_config.json` decides - a validated merged
    checkpoint's four numbers, or, for a directory without the file, a bare
    `SamplingParams()` (top_p 1.0, top_k DISABLED: the babble case, 12.8d). So
    an empty `sampling` is only correct for a checkpoint voice; base weights
    must state the values, and `HiggsV3Config.served_sampling` is what decides
    which of the two this is. Anything given rides in `extra_params`, never at
    the top level - see the module docstring.
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
    applied: the patched server already drops every sentinel frame by token
    identity (work/patch_sentinel_filter.py), and the fades belong to assembly
    (`edge_fade`).
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
                 checkpoint_dir: str = None, server_log: str = None,
                 concurrency: int = None):
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
        # ATTACH: the URL names the server. LAUNCH: the server will bind
        # whatever HIGGS_HOST/HIGGS_PORT the wrapper exports, and that pair is
        # decided HERE so the poll and the bind cannot name different ports.
        self.base_url = base_url or launch_base_url()
        self.serve_script = serve_script
        # THE WIDTH OF THE BATCH, and stage 0's max_num_seqs. Required for a
        # launch (the wrapper exports it); optional for an attach, where the
        # engine states it from the same variable.
        if concurrency is not None and int(concurrency) < 1:
            raise ValueError(f'Higgs v3: concurrency {concurrency} must be >= 1.')
        if concurrency is None and serve_script:
            # A launching backend must state it (the wrapper exports it); the
            # one source is the contract variable, which refuses when unset.
            concurrency = serve_concurrency()
        self.concurrency = int(concurrency) if concurrency else None
        self.wsl_distro = (wsl_distro or os.environ.get(WSL_DISTRO_ENV)
                           or 'Ubuntu')
        # THE SERVER'S OUTPUT IS EVIDENCE, so it goes to a file this backend
        # owns rather than to DEVNULL.
        #
        # It used to be DEVNULL on both streams, which threw away the only
        # record of what the decode path did - and the sentinel filter's own
        # proof is written into exactly that stream (`verify_sentinel_filter`).
        # It also meant a server that died at startup left its reason nowhere,
        # so `wait_ready`'s "check its log" pointed at nothing.
        #
        # TWO PATHS, kept apart on purpose:
        #   launch_log  where WE write, when we start the server. The session's
        #               process dir when the engine gave us one, else a
        #               per-instance file beside the pid file (same naming, same
        #               reason: two workers must never share one).
        #   named_log   what an OPERATOR says an ATTACHED server writes to. No
        #               default - see SERVER_LOG_ENV.
        self._named_log = (os.environ.get(SERVER_LOG_ENV) or '').strip() or None
        self.launch_log = (server_log or '').strip() or os.path.join(
            tempfile.gettempdir(),
            f'narrator-higgs3-{os.getpid()}-{id(self):x}.log')
        # Which of the two is the PROOF stream is decided by which mode this
        # backend is in, and `start()` corrects it if it adopts a server that
        # was already up (that server's output is not ours either).
        self._log_is_ours = bool(serve_script)
        self.server_log = self.launch_log if serve_script else self._named_log
        self._log_handle = None
        self.spec = BackendSpec(
            kind='served', name='vllm-omni', version='0.28.0',
            base_url=self.base_url,
            server_log=self.server_log,
            notes=('higgs-audio-v3-tts-4b; requires patch_vllm.py and '
                   'patch_sentinel_filter.py in the higgs3 env'))
        # THE SERVER IS KEYED ON THIS. A fine-tuned Higgs voice is a merged
        # checkpoint the server runs ON, so "which voice is up" and "which
        # directory is up" are the same question - and a request for another one
        # is a restart, not a message. In LAUNCH mode this is the directory the
        # wrapper exports as HIGGS_MODEL_DIR; in either mode it is what
        # `check_serves_expected_model` holds the RUNNING server to. None means
        # the base weights.
        self.checkpoint_dir = (checkpoint_dir or '').strip() or None
        self._proc = None
        self._guest_pid = None
        self._pid_file = None

    # -- lifecycle -----------------------------------------------------------

    def pid_file(self) -> str:
        """Where the launch wrapper writes the server's own pid, as the GUEST
        sees the path. One per backend instance, so two workers never read each
        other's."""
        if self._pid_file is None:
            self._pid_file = (f'{PID_FILE_DIR}/{PID_FILE_PREFIX}'
                              f'{os.getpid()}-{id(self):x}.pid')
        return self._pid_file

    def _launch_exports(self) -> str:
        """The `export ...` prefix of the wrapper: every launch-script knob
        narrator has an opinion about, stated explicitly.

        HIGGS_MODEL_DIR is exported for a checkpoint voice and UNSET for the
        base weights - unset, not left alone, because the worker's own
        environment may carry one from a caller and inheriting it would start a
        fine-tune under a request for the base speaker.
        """
        host_port = self.base_url.split('://', 1)[-1].rstrip('/')
        host, _, port = host_port.rpartition(':')
        exports = [
            f'{SERVE_HOST_ENV}={shlex.quote(host)}',
            f'{SERVE_PORT_ENV}={shlex.quote(port)}',
            f'{SERVE_MAX_NUM_SEQS_ENV}={self.concurrency}',
        ]
        if self.checkpoint_dir:
            target = (_to_wsl(self.checkpoint_dir) if sys.platform == 'win32'
                      else self.checkpoint_dir)
            exports.append(f'{SERVE_MODEL_DIR_ENV}={shlex.quote(target)}')
            model = ''
        else:
            model = f'unset {SERVE_MODEL_DIR_ENV}; '
        return f'{model}export {" ".join(exports)}; '

    def _wrapper(self) -> str:
        """The shell the launcher actually runs.

        `serve_v3.sh` ends in `exec vllm-omni ...`, so backgrounding it with `&`
        makes `$!` THE SERVER'S OWN PID - not a shell's. `setsid` puts that
        process at the head of ITS OWN PROCESS GROUP (pgid == pid: a
        backgrounded child of a non-interactive bash is not a group leader, so
        setsid(2) succeeds in place and no fork intervenes), and vllm-omni's
        stage engines - the two `VLLM::StageEngineCoreProc` children that hold
        the actual GPU memory - are born into that group. Recording the pid is
        therefore recording the GROUP, and `stop()` signals the group
        (`kill -TERM -- -<pid>`) inside the distro instead of pattern-killing
        `vllm-omni serve`, which would take another agent's server with it.

        Measured 2026-09-05 (Owen's first in-app render): signalling the pid
        alone left the server up - the pid files held the wrapper shells
        (53079, 54060) while `vllm-omni serve` ran on as 54688 holding 24 GB,
        and it took a by-hand SIGTERM to release the card. The group is what
        was missing.

        `wait` keeps this shell alive for exactly as long as the server, so the
        launcher process still tracks it; the exports before it are the launch
        script's own knobs (`_launch_exports`).
        """
        script = (_to_wsl(self.serve_script) if sys.platform == 'win32'
                  else self.serve_script)
        pid_file = self.pid_file()
        return (f'{self._launch_exports()}'
                f'setsid bash {shlex.quote(script)} & '
                f'echo $! > {shlex.quote(pid_file)}; wait $!')

    def _guest_argv(self, argv: list) -> list:
        """`argv`, run INSIDE the distro on Windows and directly elsewhere.

        `--exec` on the Windows arm for the same reason `launch_command`
        gives: without it wsl.exe hands the line to the distro's default
        shell, which expands `$` before the program sees it.
        """
        if sys.platform != 'win32':
            return list(argv)
        wsl = shutil.which('wsl.exe') or 'wsl.exe'
        return [wsl, '-d', self.wsl_distro, '--exec'] + list(argv)

    def launch_command(self) -> list:
        """The command `start()` runs. Public so a test and a log line can see
        it without a GPU.

        `--exec` ON THE WINDOWS ARM IS LOAD-BEARING, and its absence was a live
        bug. Without it `wsl.exe` hands the command line to the distro's DEFAULT
        SHELL, which expands every `$` before `bash -c` sees the script - so
        `_wrapper()`'s `echo $! > <pidfile>; wait $!` wrote an EMPTY pid file and
        degenerated into a bare `wait`. Measured on owens-pc 2026-09-05 through
        this exact argv: bare and `--` both write `pid=[]`; `--exec` writes
        `pid=[42679]`. The consequence is not cosmetic - `stop()` could then
        never signal the server BY PID inside the distro, which is the one path
        that stops a ~14 GB vllm-omni after the Windows-side `wsl.exe` relay has
        been terminated out from under it. `--` is NOT a substitute: it stops
        wsl.exe parsing its own options and still runs the default shell.
        """
        if not self.serve_script:
            raise ValueError(
                f'This backend is in ATTACH mode ({BASE_URL_ENV}={self.base_url}); '
                'it has no launch command.')
        if sys.platform == 'win32':
            wsl = shutil.which('wsl.exe') or 'wsl.exe'
            return [wsl, '-d', self.wsl_distro, '--exec', 'bash', '-c',
                    self._wrapper()]
        return ['bash', '-c', self._wrapper()]

    def _read_guest_pid(self, timeout: float = 30.0):
        """Read the pid the wrapper wrote, once it exists."""
        read = self._guest_argv(['cat', self.pid_file()])
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                out = subprocess.run(read, capture_output=True, text=True,
                                     timeout=20)
                if out.returncode == 0 and out.stdout.strip().isdigit():
                    self._guest_pid = int(out.stdout.strip())
                    log(f'[HIGGS3] server guest pid {self._guest_pid}', flush=True)
                    return self._guest_pid
            except (OSError, subprocess.SubprocessError):
                pass
            if self._proc is not None and self._proc.poll() is not None:
                return None
            time.sleep(0.5)
        log('[HIGGS3] WARNING: the launch wrapper never wrote a pid; stop() will '
              'not be able to signal the server inside the distro if the launcher '
              'exits without taking it down.', flush=True)
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
            try:
                self.check_serves_expected_model()
            except HiggsV3ServerError as wrong:
                # The wrong server. If NARRATOR left it there (a refused start,
                # a crashed worker, a stop that never reached the group), it is
                # ours to take down and replace; anything else on the port is
                # somebody else's and the refusal stands. Never a second launch
                # onto a busy port - that pays 55-297 s and ~20 GB to fail to
                # bind, which is exactly the "retrying" loop Owen's first
                # render fell into.
                self._reclaim_port(wrong)
            else:
                # ADOPTED, NOT LAUNCHED: that process's output goes wherever
                # its own launcher sent it, so the file we would have written
                # is not the proof stream and the spec must stop claiming it is.
                self._log_is_ours = False
                self.server_log = self._named_log
                self.spec = dataclasses.replace(self.spec, server_log=self.server_log)
                log(f'[HIGGS3] adopting the server already on {self.base_url}; '
                    f'its log is '
                    f'{self.server_log or "not named (see " + SERVER_LOG_ENV + ")"}',
                    flush=True)
                return
        command = self.launch_command()
        log(f'[HIGGS3] launching: {" ".join(command)}', flush=True)
        # BOTH STREAMS INTO ONE FILE, opened 'wb' so each start overwrites -
        # the same contract as the training side's serve_current.log, and the
        # reason the proof can say "this run" rather than "some run". stderr is
        # merged into stdout because vLLM logs to stderr and the ordering
        # between the two only means anything interleaved.
        self._open_log()
        # `start_new_session` on POSIX: the wrapper shell leads its own session,
        # so a stop can never reach back into the worker's own group. The server
        # itself gets a further group of its own from the wrapper's `setsid`.
        self._proc = subprocess.Popen(command, stdout=self._log_handle,
                                      stderr=subprocess.STDOUT,
                                      start_new_session=(sys.platform != 'win32'))
        self._read_guest_pid()

    #: The scan `_own_servers_on_port` runs INSIDE the distro. Plain python3,
    #: stdlib only, so it runs on the guest's system interpreter without the
    #: higgs3 env: for every narrator pid file, drop it if its pid is dead, and
    #: report it if any process in that pid's GROUP is a server bound to the
    #: port asked for (its argv carries `--port <port>`, which the launch script
    #: passes verbatim). Prints one JSON list.
    _OWN_SERVERS_SCAN = r"""
import glob, json, os, sys
port = sys.argv[1].encode()
found = []
for path in sorted(glob.glob(sys.argv[2])):
    try:
        pid = int(open(path).read().strip())
    except (OSError, ValueError):
        try: os.remove(path)
        except OSError: pass
        continue
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        try: os.remove(path)
        except OSError: pass
        continue
    except PermissionError:
        pass
    hit = False
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            stat = open('/proc/%s/stat' % entry).read()
            pgrp = int(stat[stat.rindex(')') + 2:].split()[2])
            if pgrp != pid:
                continue
            argv = open('/proc/%s/cmdline' % entry, 'rb').read().split(b'\0')
        except (OSError, ValueError):
            continue
        for i, a in enumerate(argv):
            if a == b'--port' and i + 1 < len(argv) and argv[i + 1] == port:
                hit = True
        if hit:
            break
    if hit:
        found.append({'pid': pid, 'pidFile': path})
print(json.dumps(found))
"""

    def _own_servers_on_port(self) -> list:
        """Every server NARRATOR started that is bound to our port, as
        `[{'pid', 'pidFile'}]`, from the pid files in the guest's /tmp. Stale
        files (dead pids) are removed on the way. Raises if the scan itself
        cannot run - an unanswerable ownership question is not a "no"."""
        port = self.base_url.rsplit(':', 1)[-1].rstrip('/')
        pattern = f'{PID_FILE_DIR}/{PID_FILE_PREFIX}*.pid'
        argv = self._guest_argv(['python3', '-c', self._OWN_SERVERS_SCAN,
                                 port, pattern])
        try:
            out = subprocess.run(argv, capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.SubprocessError) as exc:
            raise HiggsV3ServerError(
                f'Higgs v3: could not scan for narrator\'s own servers on port '
                f'{port} ({exc}); refusing to decide whether the server already '
                'there is ours.') from exc
        if out.returncode != 0:
            raise HiggsV3ServerError(
                f'Higgs v3: the ownership scan for port {port} failed (exit '
                f'{out.returncode}): {out.stderr.strip()[:400]}')
        try:
            return json.loads(out.stdout.strip() or '[]')
        except ValueError as exc:
            raise HiggsV3ServerError(
                f'Higgs v3: the ownership scan for port {port} printed '
                f'{out.stdout[:200]!r}, not JSON.') from exc

    def _reclaim_port(self, wrong: HiggsV3ServerError,
                      timeout: float = 180.0) -> None:
        """The server on our port is the wrong one. Take it down IF IT IS OURS,
        cooperatively, and wait for the port to free; otherwise re-raise the
        refusal, now saying whose it is not.

        Cooperative means SIGTERM to the process group and patience: a vLLM
        that is mid-teardown holds CUDA state, and a SIGKILL to a process
        holding the GPU inside WSL wedges the whole VM until a Windows reboot
        (memory: wsl-wedge-proofing). So there is no KILL here, only a longer
        wait and then a refusal that names the pid.
        """
        owned = self._own_servers_on_port()
        if not owned:
            raise HiggsV3ServerError(
                f'{wrong} No pid file of narrator\'s names a server on that port, '
                'so it is not one this program started and it will not be '
                'stopped from here. Stop it yourself, or point '
                f'{BASE_URL_ENV} at a server running the right checkpoint.') from wrong
        for row in owned:
            log(f'[HIGGS3] the server on {self.base_url} is the wrong checkpoint '
                f'and it is OURS (pid {row["pid"]}, {row["pidFile"]}); stopping '
                'it before launching', flush=True)
            self._signal_guest(row['pid'], 'TERM')
        deadline = time.time() + float(timeout)
        while time.time() < deadline:
            if not self.ping():
                break
            time.sleep(1.0)
        else:
            raise HiggsV3ServerError(
                f'Higgs v3: narrator\'s own server on {self.base_url} (pid(s) '
                f'{", ".join(str(r["pid"]) for r in owned)}) is still answering '
                f'{timeout:.0f}s after SIGTERM. It is NOT being killed: a KILL to '
                'a process holding the GPU inside WSL wedges the VM. Wait for it, '
                'or stop it by hand, then retry.')
        for row in owned:
            self._remove_guest_file(row['pidFile'])
        log(f'[HIGGS3] port {self.base_url.rsplit(":", 1)[-1]} reclaimed', flush=True)

    def _remove_guest_file(self, path: str) -> None:
        try:
            subprocess.run(self._guest_argv(['rm', '-f', path]), timeout=30,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError) as exc:
            log(f'[HIGGS3] could not remove {path}: {exc}', flush=True)

    def _open_log(self) -> None:
        """Open (and truncate) the launch log. Failure is LOUD.

        A log we cannot open is not a cosmetic loss: it is the sentinel proof's
        only stream, and starting a 14 GB server whose evidence goes nowhere is
        the state this change exists to end.
        """
        directory = os.path.dirname(self.launch_log)
        try:
            if directory:
                os.makedirs(directory, exist_ok=True)
            self._log_handle = open(self.launch_log, 'wb')
        except OSError as exc:
            raise HiggsV3ServerError(
                f'Higgs v3: could not open the server log {self.launch_log} '
                f'({exc}). That file is where this server\'s stdout and stderr go '
                'and it is the stream the sentinel-filter proof reads '
                '(verify_sentinel_filter), so a server started without it would '
                'render with no evidence of what its decode path did.') from exc
        log(f'[HIGGS3] server log: {self.launch_log}', flush=True)

    def _close_log(self) -> None:
        handle, self._log_handle = self._log_handle, None
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass

    def proof_log(self):
        """The log `verify_sentinel_filter` reads, or None.

        Ours when we launched the server; the operator's named file when we
        attached to (or adopted) somebody else's. None when neither - which is
        an honest answer and not a path to guess at.
        """
        return self.launch_log if self._log_is_ours else self._named_log

    def verify_sentinel_filter(self) -> dict:
        """PROOF (a) OF THE SENTINEL FILTER: read the server's own log.

        The other half, (b) "no one-frame trim left in the stage processor", is
        a static grep BookForge's doctor runs before any server starts. This is
        the half that needs the running decode path to say what it did, and
        until 2026-09-05 narrator threw that away on `subprocess.DEVNULL`.

        WHAT IS ASSERTED, and why each one:

          * THE STREAM EXISTS. No log, or an unreadable one, is a REFUSAL - the
            proof is the stream, and "no evidence" must never read as "no
            problem". (An attached server with no operator-named log has no
            stream at all; `load_engine` reports the proof UNAVAILABLE in that
            case rather than calling this, and calling it anyway refuses by
            name.)
          * EVERY ASYNC SENTINEL LINE REPORTS EXACTLY
            `EXPECTED_TRAILING_SENTINEL_FRAMES` = 2. Not zero: the patch counts
            before it trims, so a correct chunk prints the normal 2-frame EOC
            ramp (see that constant). A line reporting any OTHER count is a
            sentinel the trailing-run trim did not reach, and that is refused BY
            NAME with the count and the line.
          * ZERO SYNC-PATH INTERIOR DROPS. The sync path takes the FULL filter,
            so an interior drop there is a frame that failed the token test
            while sitting between two good ones - not an expected shape on any
            real generation, and never observed offline. One is a refusal.
          * ZERO EMPTY CHUNKS. "every frame carried a stream sentinel" means the
            filter emitted no audio for a chunk at all.

        Returns a report - log path, lines scanned, async lines seen and the
        frame count they agree on - so a caller can put it in a ledger.
        """
        path = self.proof_log()
        if not path:
            raise HiggsV3ServerError(
                'Higgs v3 sentinel proof: there is no server log to read. This '
                'backend attached to a server it did not start, so its output went '
                f'wherever that operator sent it. Name it in {SERVER_LOG_ENV} '
                '(the training side tees to <campaign>/higgs/v3_ft/logs/'
                'serve_current.log, overwritten per start) - narrator will not '
                'guess a path, because a stale log from an earlier run would let '
                'this proof pass on evidence from a server that is no longer up.')
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as handle:
                lines = handle.read().splitlines()
        except OSError as exc:
            raise HiggsV3ServerError(
                f'Higgs v3 sentinel proof: the server log {path} could not be read '
                f'({exc}). The proof IS the stream - refusing to report a render as '
                'proved when nothing was read.') from exc

        async_counts = []
        for line in lines:
            found = _ASYNC_SENTINEL_RE.search(line)
            if found:
                frames = int(found.group(1))
                async_counts.append(frames)
                if frames != EXPECTED_TRAILING_SENTINEL_FRAMES:
                    raise HiggsV3ServerError(
                        f'Higgs v3 sentinel proof FAILED in {path}: a chunk reported '
                        f'{frames} sentinel frame(s) outside the trailing run, not the '
                        f'{EXPECTED_TRAILING_SENTINEL_FRAMES} that the patch\'s '
                        'count-before-trim instrumentation prints for a normal EOC '
                        'ramp. Any other count is a sentinel the trailing-run trim did '
                        f'not reach, and those frames were substituted with codec code '
                        f'0 - a VALID code that decodes to real sound. The line was: '
                        f'{line.strip()}')
                continue
            interior = _SYNC_INTERIOR_RE.search(line)
            if interior:
                raise HiggsV3ServerError(
                    f'Higgs v3 sentinel proof FAILED in {path}: the SYNC path dropped '
                    f'{interior.group(1)} INTERIOR sentinel frame(s) - a frame that '
                    'failed the token test while sitting between two good ones. That '
                    'is not an expected shape on any real generation and has never '
                    'been observed offline; the filter drops it and logs rather than '
                    'splicing silently, which is what this line is. The audio for that '
                    f'chunk has a frame missing from its middle. The line was: '
                    f'{line.strip()}')
            if _EMPTY_CHUNK_RE.search(line):
                raise HiggsV3ServerError(
                    f'Higgs v3 sentinel proof FAILED in {path}: a chunk was emitted '
                    'with NO audio - every one of its frames carried a stream '
                    f'sentinel. The line was: {line.strip()}')

        log(f'[HIGGS3] sentinel proof OK: {len(async_counts)} trailing-ramp line(s), '
            f'all reporting {EXPECTED_TRAILING_SENTINEL_FRAMES} frame(s); 0 sync '
            f'interior drops; {len(lines)} line(s) read from {path}', flush=True)
        return {
            'log': path,
            'linesRead': len(lines),
            'trailingRampLines': len(async_counts),
            'framesPerLine': EXPECTED_TRAILING_SENTINEL_FRAMES,
            'syncInteriorDrops': 0,
        }

    def _models_payload(self) -> list:
        """The rows of `/v1/models`. Raises if it cannot be read."""
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
        rows = payload.get('data') if isinstance(payload, dict) else None
        return [row for row in (rows or []) if isinstance(row, dict)]

    def served_models(self) -> list:
        """The model ids `/v1/models` reports. Raises if it cannot be read."""
        return [row.get('id') for row in self._models_payload()]

    def running_checkpoint(self):
        """The model path the server on this URL was started on, or None.

        DISCOVERED: vllm-omni's `/v1/models` row for the served name carries
        `"root": <model path>` - the directory `vllm-omni serve` was pointed at,
        which for a fine-tune is the merged checkpoint and for the base weights
        is the HF-cache snapshot (measured 2026-09-05; see CHECKPOINT_ENV).
        When the row has no root - another server build - the operator's
        `NARRATOR_HIGGS3_CHECKPOINT` is taken as their assertion, and with
        neither the answer is None, which every caller treats as "unknown",
        never as "fine".
        """
        for row in self._models_payload():
            if row.get('id') != SERVED_MODEL_NAME:
                continue
            root = row.get('root')
            if isinstance(root, str) and root.strip():
                return root.strip().rstrip('/') or root.strip()
            break
        asserted = (os.environ.get(CHECKPOINT_ENV) or '').strip()
        return asserted or None

    def check_serves_expected_model(self, checkpoint_dir: str = None) -> None:
        """Prove the server on this port is OURS before anything is sent to it.

        `/health` answering 200 says only that SOMETHING is listening. This
        checks `/v1/models` carries `higgs-v3`, and that the model the server
        was started on is the one this voice needs: the merged checkpoint for a
        fine-tune, the base snapshot for the base voice. Every Higgs voice is a
        whole merged checkpoint and one server serves exactly one of them, so a
        leftover server from ANOTHER voice answers `/health` and `/v1/models`
        identically and would render a whole book in the wrong narrator while
        every log line here named the right one - in either direction.
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
        running = self.running_checkpoint()
        if running is None:
            raise HiggsV3ServerError(
                f'Higgs v3: the server at {self.base_url} does not report which '
                f'model it was started on ({MODELS_PATH} carries no "root" for '
                f"'{SERVED_MODEL_NAME}'), and {CHECKPOINT_ENV} is not set. This "
                'voice is '
                + (f'the merged checkpoint {checkpoint_dir}' if checkpoint_dir
                   else 'the base weights')
                + ', and an unidentified server would render the whole book in '
                'whatever narrator it happens to hold. If this is your own server, '
                f'state its model directory in {CHECKPOINT_ENV}.')
        if checkpoint_dir:
            if os.path.normpath(running) != os.path.normpath(checkpoint_dir):
                # Both are known; they disagree, which is decidable and fatal.
                raise HiggsV3ServerError(
                    f'Higgs v3: the server at {self.base_url} is running on '
                    f'{running}, but this voice is {checkpoint_dir}. vllm-omni cannot '
                    'load a voice into a running server - it has no adapter flags and '
                    'its talker does not implement SupportsLoRA - so serving another '
                    'voice means RESTARTING on that checkpoint.')
            log(f'[HIGGS3] serving checkpoint {checkpoint_dir} (reported by the '
                'server)', flush=True)
        else:
            if BASE_SNAPSHOT_MARKER not in running:
                raise HiggsV3ServerError(
                    f'Higgs v3: this voice is the BASE weights, but the server at '
                    f'{self.base_url} is running on {running}, which is a merged '
                    f'fine-tune (no {BASE_SNAPSHOT_MARKER!r} in its path). Serving '
                    'the base means RESTARTING on the base snapshot.')
            log(f'[HIGGS3] serving the base snapshot {running} (reported by the '
                'server)', flush=True)

    #: The sentinel-filter tail measurement: RMS in dBFS over the last 300 ms
    #: of a one-word render.
    #:
    #: IT IS A SENSOR AND NOT A GATE, and that is a correction rather than a
    #: relaxation. Until 2026-09-05 this window was gated at -45 dBFS, derived
    #: from two points: our own smoke read -62.4 dBFS against a server carrying
    #: the retired `patch_tail_trim.py`, and the campaign's diagnosis put an
    #: UNPATCHED tail near -31 dBFS. `patch_sentinel_filter.py` invalidates the
    #: gate: it drops the sentinel frames entirely, so what the window now holds
    #: is THE MODEL'S OWN AUDIO, and the certifying box measured -35 to -38 dBFS
    #: here on BOTH builds. A -45 dB gate would fail a correct server, and no
    #: level distinguishes the two builds at all - the tail measurement cannot
    #: decide this question, whichever number is chosen.
    #:
    #: So the band below is RECORDED, LOGGED AND COMPARED, and nothing is
    #: refused on it. No threshold is invented to keep a gate alive.
    SENTINEL_TAIL_WINDOW_SECONDS = 0.3
    SENTINEL_TAIL_CERTIFIED_DBFS = (-38.0, -35.0)
    SENTINEL_PROBE_TEXT = 'Yes.'
    SENTINEL_PROBE_SEED = 4242

    def probe_sentinel_filter(self, voice=None) -> float:
        """Render one fixed-seed word and REPORT its tail level in dBFS.

        WHAT THIS NO LONGER DOES: prove `work/patch_sentinel_filter.py` is
        applied. It used to (as `probe_tail_trim`), because an unpatched server
        left ~240 ms of decoded sentinel garbage on the end of every chunk at
        about -30 dB and a quiet tail was therefore evidence. Under the sentinel
        filter the trailing frames are GONE rather than quiet, so the window
        holds ordinary speech decay: -35 to -38 dBFS on the certifying box, on
        the patched and the band-aided build alike (measured 2026-09-05). A
        level gate here would now fail correct servers and could never separate
        the two builds. Keeping it would have been a number defended for its own
        sake.

        WHAT WOULD PROVE THE PATCH, both halves measured by the fine-tuning
        session:

          (a) THE SERVER'S OWN LOG, READ. `verify_sentinel_filter` - DONE
              2026-09-05, and the reason `start()` no longer sends the
              launcher's streams to DEVNULL. It counts the trailing-ramp lines
              (every one must report exactly
              EXPECTED_TRAILING_SENTINEL_FRAMES = 2; any other count is a
              sentinel the trim did not reach) and refuses a single SYNC-path
              interior drop - a frame that failed the token test between two
              good ones, which offline classification of every saved talker
              matrix puts at zero on all real shapes and which the detector has
              never fired on. A missing or unreadable log is itself a refusal:
              the proof IS the stream.
          (b) NO TRIM CODE LEFT IN THE STAGE PROCESSOR. `[:, :-1]` occurs twice
              in the pristine `higgs_audio_v3.py` and zero times after the
              patch. This half IS enforced today, statically and before any
              server starts: BookForge's Higgs doctor greps the file in
              site-packages for `_filter_sentinel_frames` AND for the absence of
              `[:, :-1]`, and reports `trim-survived` for a half-applied or
              stacked file (electron/tool-paths.ts HIGGS_PATCHES,
              electron/scripts/higgs/install_higgs_env.sh).

        NOT A FAILURE: the async warning at higgs_audio_v3.py:403 ("frame(s)
        carry a stream sentinel outside the trailing run") is an INSTRUMENTATION
        BUG in the patch - the count is taken BEFORE the trailing-run trim, so it
        counts the normal 2-frame EOC ramp. Expect exactly "2 frame(s)" per
        chunk, in sequential renders as much as concurrent ones. COUNT them and
        report the count; do not read them as contamination.

        Cost: one ~1 s generation, once per server start. Returns the dBFS.
        """
        body = build_request_body(
            self.SENTINEL_PROBE_TEXT, voice,
            cap_frames(self.SENTINEL_PROBE_TEXT),
            seed=self.SENTINEL_PROBE_SEED)
        payload, ctype = self.post_speech(body, timeout=600,
                                          with_content_type=True)
        audio, rate = decode_response(payload, ctype)
        window = audio[-int(rate * self.SENTINEL_TAIL_WINDOW_SECONDS):]
        if window.size == 0:
            # The one thing this probe still REFUSES on, and it is decidable: a
            # server that answers 200 with no audio at all is not a level
            # question.
            raise HiggsV3ServerError(
                'Higgs v3 sentinel-filter probe: the probe render produced no audio.')
        rms = float(np.sqrt(np.mean(np.square(window.astype(np.float64)))))
        dbfs = 20.0 * float(np.log10(max(rms, 1e-12)))
        low, high = self.SENTINEL_TAIL_CERTIFIED_DBFS
        where = ('inside' if low <= dbfs <= high else 'OUTSIDE')
        log(f'[HIGGS3] sentinel-filter probe: {dbfs:.1f} dBFS over the last '
            f'{self.SENTINEL_TAIL_WINDOW_SECONDS * 1000:.0f} ms, {where} the '
            f'certified band {low:.0f}..{high:.0f} dBFS. REPORTED, NOT GATED - the '
            'tail level does not distinguish a filtered server from a band-aided '
            'one; the patch is proved by the doctor\'s marker/absent-marker grep '
            'of the stage processor.', flush=True)
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
        if proc is None and self._guest_pid is None:
            # Never launched (start() adopted, or refused before Popen).
            self._close_log()
            return
        # THE SERVER FIRST, BY GROUP. Signalling the wrapper shell was the
        # orphan bug: bash does not forward SIGTERM to a backgrounded child, so
        # the shell died, `proc.poll()` reported a tidy exit, and vllm-omni ran
        # on with the GPU. The group signal reaches the server and its stage
        # engines; the wrapper's `wait $!` then returns on its own.
        if self._guest_pid is not None:
            self._signal_guest(self._guest_pid, 'TERM')
        if proc is not None and proc.poll() is None:
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                # The wrapper outlived the server's own teardown window. It is a
                # shell, not a GPU holder: terminating IT is safe.
                log('[HIGGS3] launch wrapper still up after the server was '
                    'signalled; terminating the wrapper', flush=True)
                try:
                    proc.terminate()
                    proc.wait(timeout=30)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        self._verify_gone(timeout=timeout)
        # Closed LAST, so the server's own shutdown lines are in the file the
        # proof reads. The file stays: it is the run's evidence, and a ledger
        # entry naming it must still resolve after the worker exits.
        self._close_log()

    def _verify_gone(self, timeout: float = 60.0) -> None:
        """Poll the port until nothing answers, then drop the pid file.

        NO KILL, EVER. A SIGKILL to a process holding the GPU inside WSL wedges
        the whole VM until a Windows reboot (memory: wsl-wedge-proofing), so
        the escalation after a second SIGTERM is a loud warning that names the
        pid - and the pid file is LEFT IN PLACE, which is what lets the next
        `start()` recognise the survivor as ours and reclaim the port
        cooperatively instead of refusing it as a stranger's.

        Only ever runs for a server WE launched (`_guest_pid` is set at launch),
        so an attached server is left alone even if it is still up.
        """
        deadline = time.time() + float(timeout)
        while time.time() < deadline:
            if not self.ping():
                self._forget_pid_file()
                return
            time.sleep(1.0)
        if self._guest_pid is None:
            log(f'[HIGGS3] WARNING: something is still serving {self.base_url} '
                  'and this process did not record a guest pid for it; leaving it '
                  'alone rather than killing a server it may not own.', flush=True)
            return
        log(f'[HIGGS3] server still up after the launcher exited; signalling '
              f'guest process group {self._guest_pid} again', flush=True)
        self._signal_guest(self._guest_pid, 'TERM')
        deadline = time.time() + 120.0
        while time.time() < deadline:
            if not self.ping():
                self._forget_pid_file()
                return
            time.sleep(1.0)
        log(f'[HIGGS3] WARNING: guest process group {self._guest_pid} is still '
            f'serving {self.base_url} after two SIGTERMs. NOT killing it - a KILL '
            'on a GPU holder inside WSL wedges the VM. Its pid file '
            f'{self.pid_file()} stays so the next start reclaims it.', flush=True)

    def _forget_pid_file(self) -> None:
        """The server is gone; its pid file no longer names anything."""
        if self._guest_pid is not None:
            self._remove_guest_file(self.pid_file())
        self._guest_pid = None

    def _signal_guest(self, pid: int, signame: str) -> None:
        """Signal one process GROUP inside the distro, by its leader's pid,
        never by pattern. The wrapper's `setsid` made the server that leader,
        so `-<pid>` reaches the server and its stage-engine children together.
        `KILL` is refused by name: see `_verify_gone`."""
        if signame != 'TERM':
            raise ValueError(
                f'Higgs v3: refusing to send SIG{signame} to a server process. '
                'A KILL on a process holding the GPU inside WSL wedges the VM; '
                'only TERM is sent, and a server that ignores it is reported, '
                'not killed.')
        if sys.platform != 'win32':
            try:
                os.killpg(int(pid), signal.SIGTERM)
            except OSError as exc:
                log(f'[HIGGS3] could not signal process group {pid}: {exc}',
                    flush=True)
            return
        try:
            subprocess.run(self._guest_argv(['kill', '-TERM', '--', f'-{int(pid)}']),
                           timeout=30, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError) as exc:
            log(f'[HIGGS3] could not signal guest process group {pid}: {exc}',
                flush=True)

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
            raise HiggsV3ServerDown(
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
