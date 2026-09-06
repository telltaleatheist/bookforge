"""Higgs TTS 3 served by **SGLang-Omni 0.1.4** - the second serving stack.

WHY THERE IS A SECOND STACK AT ALL. Measured by the training side on the night of
2026-09-05 (HIGGS_FIELD_NOTES.md 4n, `night3/sgl/`): the same 50 packed chunks of
*Working Towards the Fuhrer*, the same merged checkpoint (ckpt-1080), the same
sampling, one seed, scored by `higgs_ladder.py score` (whisper coverage,
max_skip_words, insert_rate, early-stop) plus 3 s ECAPA windows for voice
switches:

    engine, in flight        early stops   damaged/50   sustained switches   chars/min
    vllm-omni 0.28.0, 1          0             5                0              1,064
    vllm-omni 0.28.0, 16         4            13                6             10,752
    SGLang-Omni 0.1.4, 16        0             5                0             26,666
    SGLang-Omni 0.1.4, 1         1             7                0              2,636

vllm-omni's damage at width is its BATCHED TALKER, not the model and not the
text: at 1 in flight the same build is clean, and the damage lands on the
NEWEST batch row - the request that prefills while others decode, which is the
row vLLM's condense moves when an earlier row retires (`pt_condense`: long B
damaged 3/6 while the short and long A were clean 12/12). Upstream knows half of
it (issue #6418, PR #6422's request-id keyed state pool, which IS in the
installed talker and does not fix it). The 6 sustained voice switches Owen hears
are the same defect: 12 of 50 chunks carry a 3 s ECAPA window under the 0.50 the
narrator never produces, against 0 at width 1 and 0 on this stack.

So this stack is 2.5x the throughput AND the clean one at 16 wide. What remains
damaged on every clean engine (~10 %) is text-domain - em-dashes missing from
the corpus, a footnote welded onto a chunk head, umlauts - and is addressed
elsewhere.

WHAT IS DIFFERENT FROM `v3_served.py`, and every one of these is a way to be
silently wrong:

  1. SAMPLING RIDES AT THE REQUEST'S **TOP LEVEL**, and it MUST BE SENT.
     `sglang_omni/serve/protocol.py:CreateSpeechRequest` has real
     `temperature` / `top_p` / `top_k` / `repetition_penalty` / `seed` fields -
     there is no `extra_params` - and
     `models/higgs_tts/request_builders.py:build_sglang_higgs_request` sets
     `top_p`/`top_k` on the SamplingParams ONLY when the request carried them.
     There is no deploy profile and no `generation_config.json` read: **a request
     that sends nothing samples the untruncated tail.** Measured 2026-09-05:
     without top_k one chunk ran to the cap with 80 s of silence. This is the
     exact opposite of vllm-omni, where a checkpoint voice sends NOTHING because
     the server reads the checkpoint's own `generation_config.json`
     (`--generation-config auto`). Hence `HiggsV3Config.served_sampling` branches
     on the stack, and `build_request_body` here REFUSES an empty mapping.
  2. THE FRAME CAP FIELD IS `max_new_tokens`, not `max_tokens`.
  3. THE CONTEXT IS 4096 AND IT IS HARD-CODED.
     `models/higgs_tts/engine_builder.py:HiggsTtsEngineBuilder.context_length =
     4096`; there is no flag. Prompt tokens + `max_new_tokens` must fit it or the
     request is an HTTP 500. See `frame_cap`, which refuses BY NAME before
     anything is sent.
  4. THE REFERENCE RIDES IN THE BODY, AS BASE64. `CreateSpeechRequest
     .references[]` is a `SpeechReference` with a `data` field (raw base64, no
     `data:` prefix) beside `media_type` and `text`; `speech_service.py
     ._normalize_reference` takes that branch FIRST and never touches the
     server's filesystem, so no `--allowed-local-media-path` is needed and
     `serve_higgs_sgl.sh` still hands the server no directory. (`audio_path`
     is the other branch - a server-local path or a `file://` URL - and this
     module never sends it.) The reference is charged to the context: one
     AUDIO_PLACEHOLDER per DELAYED reference row (`build_prompt(num_ref_tokens=
     delayed.shape[0])`, and `apply_delay_pattern` makes T frames T + 7 rows at
     8 codebooks) plus `ref_text_id`, the transcript's tokens and
     `ref_audio_id` - see `reference_token_bound`. A 30 s clip is ~760 of the
     4,096 positions, which at the zero-shot chunk length (600 chars, the
     measured wall - 900 drops the tail) leaves the frame cap its full 2.0x
     ceiling. Until 2026-09-06 a clips voice was refused on this stack outright,
     on the belief that `audio_path` was the only way in; the `data` branch was
     read off sglang-omni 0.1.4's own `serve/speech_service.py` and
     `models/higgs_tts/utils.py:load_audio_to_24k`.
  5. NO SENTINEL PATCH. That patch is a vllm-omni site-packages fix; SGLang-Omni
     has its own stage processor and `HIGGS_PATCHES` applies only to the other
     stack. There is therefore no `verify_sentinel_filter` here and BookForge's
     doctor does not report patch rows for this stack.
  6. IDENTITY IS NOT IN `/v1/models`. `sglang_omni/serve/openai_api.py`'s
     `_register_models` builds `ModelCard(id=model_name, root=model_name)` - the
     SERVED NAME, twice - so unlike vllm-omni 0.28 it never reports the model
     PATH. `running_checkpoint` therefore reads `HIGGS_MODEL_DIR` out of
     `/proc/<listener pid>/environ`, which is what our own launcher exported into
     it: a fact about the running process rather than a claim by the process
     asking.

THE LAUNCH (`electron/scripts/higgs/serve_higgs_sgl.sh`, transcribed from
`night3/sgl/serve_sgl.sh`):

    sgl-omni serve --model-path <merged dir> --model-name higgs-v3-ds
      --host <host> --port <port> --mem-fraction-static 0.60
      --tts_engine.factory.max_running_requests <N>
      --tts_engine.factory.cuda_graph_max_bs <N>
      --tts_engine.factory.max_new_tokens 7500

in conda env `sglomni` (python 3.12, torch 2.13.0+cu130, sglang 0.5.18,
sglang-omni 0.1.4, flashinfer 0.6.17 + flashinfer-jit-cache cu130), with
`CUDA_HOME=<env>/lib/python3.12/site-packages/nvidia/cu13` and that directory
carrying `lib64 -> lib` and `libcudart.so -> libcudart.so.13`. Healthy in ~110 s,
~19 GB at 16 in flight, CUDA graphs captured on sm_86.

LICENCE is the model's, unchanged: Boson Higgs TTS 3 Research and
Non-Commercial.
"""
import json
import math
import os
import shlex
import shutil
import sys
import urllib.error
import urllib.request

from ..protocol import BackendSpec, ClipsVoice, DefaultVoice
from ..log import log
from . import served_common
from . import v3_served
from .served_common import (CHECKPOINT_ENV, GuestOwnedServer,
                            HiggsServerDown, HiggsServerError, to_wsl)

#: `--model-name` on the launch line, the `model` field of every request, and
#: the id `/v1/models` reports. DELIBERATELY NOT `higgs-v3`: a port is not proof
#: of identity, and the two stacks answer the same shaped endpoints, so a name
#: that differs is one more way a leftover server on the wrong port is caught.
SERVED_MODEL_NAME = 'higgs-v3-ds'

SPEECH_PATH = '/v1/audio/speech'
HEALTH_PATH = '/health'
MODELS_PATH = '/v1/models'

#: Attach to an ALREADY-RUNNING SGLang-Omni server instead of launching one.
BASE_URL_ENV = 'NARRATOR_HIGGS_SGL_URL'
#: Where the launch script lives, in the filesystem the spawn will read it from.
SERVE_SCRIPT_ENV = 'NARRATOR_HIGGS_SGL_SERVE_SCRIPT'
#: The WSL distro to run the launch script in, on Windows. Shared with the
#: vllm-omni arm: one machine, one guest.
WSL_DISTRO_ENV = v3_served.WSL_DISTRO_ENV
#: Where an ATTACHED server's log is, named by the operator. NO DEFAULT - see
#: `v3_served.SERVER_LOG_ENV` for why a guessed path is worse than none.
SERVER_LOG_ENV = 'NARRATOR_HIGGS_SGL_SERVER_LOG'

#: THE LAUNCH SCRIPT'S OWN KNOBS (`serve_higgs_sgl.sh`), exported into the
#: wrapper by narrator at launch exactly as the vllm-omni arm exports its set.
SERVE_HOST_ENV = 'HIGGS_SGL_HOST'
SERVE_PORT_ENV = 'HIGGS_SGL_PORT'
SERVE_MEM_FRACTION_ENV = 'HIGGS_SGL_MEM_FRACTION'
SERVE_MAX_NEW_TOKENS_ENV = 'HIGGS_SGL_MAX_NEW_TOKENS'
SERVE_CUDA_GRAPH_MAX_BS_ENV = 'HIGGS_SGL_CUDA_GRAPH_MAX_BS'
#: THE ONE CONCURRENCY NUMBER, shared with the vllm-omni arm on purpose: it is
#: the server's admission width AND the width of narrator's own batch, and one
#: number stated once is what stops the two disagreeing.
SERVE_MAX_NUM_SEQS_ENV = v3_served.SERVE_MAX_NUM_SEQS_ENV
SERVE_MODEL_DIR_ENV = served_common.SERVE_MODEL_DIR_ENV

#: The launch script's own bind defaults, mirrored so a launch with neither
#: variable set polls the port the script binds. Not a fallback that hides a
#: bug: both sides read the same two literals and narrator EXPORTS the pair it
#: chose into the wrapper. Port 8200 keeps this stack's server unmistakable from
#: vllm-omni's 8095 - a leftover on the wrong port is then a different port, not
#: a subtle identity question.
SERVE_DEFAULT_HOST = '127.0.0.1'
SERVE_DEFAULT_PORT = 8200

#: The log narrator writes a server it LAUNCHED to, inside the session's process
#: dir when there is one. One per SESSION, overwritten per start.
SERVER_LOG_NAME = 'higgs-sgl-server.log'

#: MEASURED COLD START: ~110 s to health on owens-pc with warm weights
#: (`night3/logs/serve_events.log`, 2026-09-05). narrator waits far longer (see
#: `HiggsV3Defaults.READY_TIMEOUT_SECONDS`) because `wait_ready` raises
#: immediately if the process actually died, so patience costs nothing when the
#: server is genuinely coming up.
COLD_START_SECONDS = 110

# ---------------------------------------------------------------------------
# The 4096-token context, which is the whole of what makes this stack different
# to send to
# ---------------------------------------------------------------------------

#: THE HARD CONTEXT. `sglang_omni/models/higgs_tts/engine_builder.py`:
#: `class HiggsTtsEngineBuilder: context_length = 4096`. It is a class attribute
#: with no CLI flag and no config path - the value cannot be raised from here,
#: from the launcher, or from a request.
CONTEXT_TOKENS = 4096

#: Prompt tokens + `max_new_tokens` must be at most this, or the request is an
#: HTTP 500 from inside the scheduler. One position is reserved for the position
#: the last generated token occupies.
MAX_CONTEXT_POSITIONS = CONTEXT_TOKENS - 1

#: THE PROMPT'S FIXED SCAFFOLD, EXACTLY THREE TOKENS, read off
#: `sglang_omni/models/higgs_tts/text_tokenizer.py:HiggsTokenizerAdapter
#: .build_prompt`: for a zero-shot request the ids are
#: `[tts_id] + encode(text) + [text_id] + [audio_id]`. Not an estimate - the
#: three are literal `ids.append(...)` calls with no branch a text-only request
#: can take. The reference branch is bounded separately - see
#: `reference_token_bound`.
PROMPT_SCAFFOLD_TOKENS = 3

#: THE REFERENCE BRANCH'S OWN SCAFFOLD, EXACTLY TWO TOKENS: `ref_text_id` before
#: the transcript and `ref_audio_id` before the placeholders, read off the same
#: `build_prompt` (`if reference_text and num_ref_tokens > 0: ids.append(
#: self.ref_text_id) ...; if num_ref_tokens > 0: ids.append(self.ref_audio_id)`).
REFERENCE_SCAFFOLD_TOKENS = 2

#: THE DELAY PATTERN'S EXTRA ROWS. `num_ref_tokens` is `delayed.shape[0]`
#: (`stages.py`, both the preprocessing and the GPU path), and
#: `utils.apply_delay_pattern` turns `[T, N]` raw codes into `[T + N - 1, N]` -
#: so a clip of T frames costs T + 7 placeholder positions at Higgs's 8
#: codebooks (`codec.py`'s `(batch, seq, 8)`).
REFERENCE_DELAY_ROWS = 7

#: CHARACTERS PER TOKEN, AS A **FLOOR**, so `prompt_token_bound` is an upper
#: bound on the prompt and never an average.
#:
#: MEASURED 2026-09-06 with `ds_ad4lm_prod_ckpt1080/tokenizer.json` (the Qwen3
#: text tokenizer this model family carries) over the 50 packed Fuhrer chunks the
#: whole night-3 comparison was run on, 26 to 1,190 characters:
#:
#:     min chars/token   3.25   (the 26-char chunk: 8 tokens)
#:     >= 250 chars      3.68 and up
#:     the longest       1,190 chars -> 261 tokens (4.56 chars/token)
#:
#: 3.0 sits under every one of those, so the bound is genuinely a ceiling on real
#: book prose. IT IS NOT A GUARANTEE for every possible string - a chunk of dense
#: CJK or of pure punctuation would tokenize below it - and the consequence of
#: being wrong is the HTTP 500 this guard exists to pre-empt, reported as that
#: chunk's failure. That is stated rather than papered over: the alternative,
#: loading the checkpoint's tokenizer here, would make every render depend on a
#: `tokenizers` import inside whichever env the worker happens to be in, and on
#: an attached server naming a checkpoint directory it may not have.
CHARS_PER_TOKEN_FLOOR = 3.0

#: THE MINIMUM SLACK a frame cap must leave over the chunk's EXPECTED length
#: before the cap is worth sending at all.
#:
#: `max_new_tokens` is a CEILING, not a target: `v3_served.cap_frames` asks for
#: 2.0x the expected duration plus 150 frames because a generous ceiling costs
#: nothing on a stack with an 8,192-position window. Here the context is a
#: SECOND, smaller ceiling, and the smaller of two ceilings is the one that
#: applies - so `frame_cap` sends `min(cap_frames, headroom)` rather than a
#: number the server would 500 on.
#:
#: What that `min` must NEVER become is a silent clamp that cuts speech, so the
#: point at which the remaining headroom stops being headroom is refused BY NAME:
#: below 1.2x the expected length the ceiling would start landing inside real
#: audio, and the honest answer is that this chunk does not fit this stack. At
#: the measured book pace (5.82 s per 100 characters, i.e. ~1,455 frames per
#: 1,000 characters) that boundary is around 1,900 characters - well above every
#: certified Higgs targetChars - so a refusal here means a packing decision to
#: revisit, not a routine event.
MIN_CAP_SLACK = 1.2


def reference_token_bound(voice) -> int:
    """An UPPER BOUND on the prompt positions `voice`'s reference costs; 0 for a
    voice with no reference (a DefaultVoice, or None).

    Per `build_prompt`'s reference branch: `REFERENCE_SCAFFOLD_TOKENS`, the
    transcript at `CHARS_PER_TOKEN_FLOOR`, and one placeholder per delayed
    reference row - the clip's DECLARED seconds at the codec's
    `v3_served.FRAMES_PER_SECOND` (25), rounded up, plus `REFERENCE_DELAY_ROWS`.
    The seconds come from the clip's declaration, never from opening the file,
    for the same reason `v3_served.reference_seconds` reads them that way; a
    clip that declares none is refused there BY NAME.
    """
    if not isinstance(voice, ClipsVoice):
        return 0
    seconds = v3_served.reference_seconds(voice)
    transcript_chars = sum(len(clip.transcript or '') for clip in voice.clips)
    rows = int(math.ceil(seconds * v3_served.FRAMES_PER_SECOND)) + REFERENCE_DELAY_ROWS
    return (REFERENCE_SCAFFOLD_TOKENS
            + int(math.ceil(transcript_chars / CHARS_PER_TOKEN_FLOOR))
            + rows)


def prompt_token_bound(text: str, voice=None) -> int:
    """An UPPER BOUND on the prompt tokens SGLang-Omni will build for `text` in
    `voice` (the reference, when the voice carries one - `reference_token_bound`).

    `PROMPT_SCAFFOLD_TOKENS` (exact, read off the builder) plus the text at
    `CHARS_PER_TOKEN_FLOOR` characters per token (a measured floor - see that
    constant). Deliberately one rule with no branch: a bound that is sometimes
    the tokenizer's real count and sometimes an estimate is a bound nobody can
    reason about, and the two would disagree exactly where it matters.
    """
    chars = len(text or '')
    return (PROMPT_SCAFFOLD_TOKENS
            + int(math.ceil(chars / CHARS_PER_TOKEN_FLOOR))
            + reference_token_bound(voice))


def expected_frames(text: str) -> int:
    """How many LM frames this chunk's audio is expected to take, with no slack:
    `v3_served.cap_frames`'s own model of the pace (15 chars/s at 25 fps) without
    its 2.0x ceiling factor and its 150-frame tail."""
    return int(len(text or '') / 15.0 * v3_served.FRAMES_PER_SECOND)


def frame_cap(text: str, voice=None) -> int:
    """`max_new_tokens` for one chunk on this stack, or a refusal BY NAME.
    `voice` is charged for its reference, when it carries one.

    THE TWO CEILINGS. `v3_served.cap_frames(text)` is narrator's own generous one
    (2.0x expected + 150). `MAX_CONTEXT_POSITIONS - prompt_token_bound(text)` is
    the stack's, and it is hard: prompt + `max_new_tokens` over 4,095 is an HTTP
    500 from inside the scheduler, not a shorter render. The smaller applies.

    THE REFUSAL. When what the context leaves is under `MIN_CAP_SLACK` x the
    chunk's expected length, the ceiling would fall inside real speech, and this
    raises instead - naming the chunk length, the numbers, and the lever
    (the voice's `targetChars`). Silently sending the smaller number there would
    be a cut chunk reported as a success, which is the failure mode this whole
    module exists downstream of.
    """
    if not (text or '').strip():
        raise ValueError('Higgs SGLang: no text to size a frame cap for.')
    bound = prompt_token_bound(text, voice)
    headroom = MAX_CONTEXT_POSITIONS - bound
    expected = expected_frames(text)
    if headroom < expected * MIN_CAP_SLACK:
        reference = reference_token_bound(voice)
        raise ValueError(
            f'Higgs SGLang-Omni: a {len(text)}-character chunk does not fit this '
            f"stack's context. SGLang-Omni's Higgs builder hard-codes "
            f'context_length {CONTEXT_TOKENS} (engine_builder.py, no flag), so '
            f'prompt + max_new_tokens must be at most {MAX_CONTEXT_POSITIONS}; '
            f'this prompt is at most {bound} tokens'
            + (f' ({reference} of them the reference clip and its transcript)'
               if reference else '')
            + f', leaving {headroom} frames '
            f'against an expected {expected} - under the {MIN_CAP_SLACK}x slack '
            'below which the cap would land inside real speech and cut the chunk '
            'while the request reported success. Lower this voice\'s targetChars '
            'in electron/data/higgs-models.json, or render it on the vllm-omni '
            'stack, whose window is 8192.')
    return min(v3_served.cap_frames(text), headroom)


# ---------------------------------------------------------------------------
# The reference
# ---------------------------------------------------------------------------

#: The one media type this module declares for a reference. The clip is read as
#: bytes and the server decodes them by THIS label (`load_audio_to_24k` ->
#: `io.load_base64(media_type, data)`), so a clip that is not a wav would be
#: decoded as one - refused by extension instead, see `reference_for`.
REFERENCE_MEDIA_TYPE = 'audio/wav'


def reference_for(voice: ClipsVoice) -> dict:
    """The single `references` entry for `voice`, in `SpeechReference`'s shape:
    `{data, media_type, text}` - raw base64 in `data`, NO `data:` prefix
    (`_normalize_reference` hands it straight to `load_base64`; a prefixed
    string fails its base64 validation).

    The one-clip rule and the 30 s budget are `v3_served.reference_for`'s, and
    they are the same rule here: sglang-omni's own reference ceiling is 100 s
    (`stages._MAX_REF_AUDIO_SEC`), but the measured zero-shot behaviour, the
    catalog's `referenceSecondsCap` and the MLX arm all speak the 30 s number,
    and a stack-specific budget is a voice that renders on one machine and is
    refused on the other.
    """
    if not isinstance(voice, ClipsVoice):
        raise ValueError(
            f'Higgs SGLang reference_for takes a ClipsVoice; got '
            f'{type(voice).__name__}.')
    v3_served.check_reference_budget(voice)
    if len(voice.clips) != 1:
        raise ValueError(
            f"Higgs SGLang voice '{voice.name}' has {len(voice.clips)} reference "
            'clips. One reference per request, the same rule as vllm-omni: '
            'several clips must be pre-joined into one wav (clips separated by '
            f'{v3_served.REFERENCE_JOIN_SECONDS} s of silence) with the '
            'transcripts joined in the same order.')
    clip = voice.clips[0]
    if not os.path.isfile(clip.path):
        raise ValueError(f'Higgs SGLang reference clip does not exist: {clip.path}')
    if os.path.splitext(clip.path)[1].lower() != '.wav':
        raise ValueError(
            f"Higgs SGLang reference clip {clip.path} is not a .wav. The request "
            f'declares the bytes as {REFERENCE_MEDIA_TYPE} and the server decodes '
            'them as that; convert the clip rather than mislabel it.')
    if not (clip.transcript or '').strip():
        raise ValueError(
            f"Higgs SGLang voice '{voice.name}': reference clip {clip.path} has no "
            'transcript. The server frames the clone prompt as <|ref_text|> '
            'transcript <|ref_audio|> clip, and a clip without its book-exact text '
            'conditions every chunk on words it never heard.')
    import base64
    with open(clip.path, 'rb') as handle:
        encoded = base64.b64encode(handle.read()).decode('ascii')
    return {'data': encoded, 'media_type': REFERENCE_MEDIA_TYPE,
            'text': clip.transcript}


# ---------------------------------------------------------------------------
# The request
# ---------------------------------------------------------------------------

#: The sampling fields `CreateSpeechRequest` actually has, at the TOP LEVEL.
#: `seed` is excluded here and passed separately for the same reason it is on the
#: vllm-omni arm: it has exactly one home in the body and a duplicate is refused.
SAMPLING_KEYS = ('temperature', 'top_p', 'top_k', 'repetition_penalty')

_WHY_SAMPLING_IS_REQUIRED = (
    'SGLang-Omni applies NO top_k and NO top_p unless the request carries them: '
    'build_sglang_higgs_request sets them on the SamplingParams only when the '
    'request field is not None, and there is no deploy profile and no '
    'generation_config.json read on this stack. Measured 2026-09-05: without '
    'top_k one chunk ran to the cap with 80 s of silence. So an empty sampling '
    'here is not "the server\'s defaults" - it is the untruncated 1026-way '
    'codebook tail.')


def build_request_body(text: str, voice, max_new_tokens: int, seed=None,
                       sampling=None, model: str = SERVED_MODEL_NAME) -> dict:
    """The POST body for one chunk, as `higgs_ladder.py render` sends it.

    `voice` is a DefaultVoice (the model's own speaker, or a fine-tune whose
    weights ARE the voice - either way no `references` key), a ClipsVoice (one
    `references` entry, base64 in the body - `reference_for`), or None.

    `sampling` is REQUIRED and non-empty. That is the opposite of
    `v3_served.build_request_body`, where an empty mapping correctly means "the
    checkpoint's own generation_config.json decides" - here nothing reads that
    file and an empty mapping means the untruncated tail.
    """
    if not (text or '').strip():
        raise ValueError('Higgs SGLang request: no text')
    v3_served.validate_control_tokens(text)
    if voice is not None and not isinstance(voice, (DefaultVoice, ClipsVoice)):
        raise ValueError(
            f'Higgs SGLang-Omni got a {type(voice).__name__} voice. A voice here '
            'is a DefaultVoice (the merged checkpoint the server was started on, '
            "or the base model's own speaker) or a ClipsVoice (a reference clip "
            'in the request).')
    if not sampling:
        raise ValueError(
            'Higgs SGLang-Omni request carries no sampling. '
            + _WHY_SAMPLING_IS_REQUIRED
            + " HiggsV3Config.served_sampling() is what states it, from the "
            "checkpoint's generation_config.json (which "
            'v3_served.require_generation_config has already proved is there and '
            'carries usable numbers).')
    if 'seed' in sampling:
        raise ValueError(
            "Higgs SGLang sampling carries a seed. The seed is the request's own "
            '`seed` field and only that - pass it as build_request_body(..., '
            'seed=...). Two sources for one number is two renders nobody can '
            'reproduce.')
    stray = sorted(set(sampling) - set(SAMPLING_KEYS))
    if stray:
        raise ValueError(
            f'Higgs SGLang sampling carries key(s) CreateSpeechRequest does not '
            f"have: {', '.join(stray)}. Known: {', '.join(SAMPLING_KEYS)}. A "
            'field pydantic does not know is dropped without a word, and the '
            'render then runs at something nobody chose.')
    missing = [k for k in ('temperature', 'top_p', 'top_k')
               if sampling.get(k) is None]
    if missing:
        raise ValueError(
            f"Higgs SGLang sampling states no {', '.join(missing)}. "
            + _WHY_SAMPLING_IS_REQUIRED)
    body = {
        'model': model,
        'input': text,
        'response_format': 'wav',
        # THE FRAME CAP FIELD IS `max_new_tokens`. `max_tokens` is not a field of
        # CreateSpeechRequest at all, so sending it would be dropped in silence
        # and every chunk would run to the engine's own 7500-frame factory cap.
        'max_new_tokens': int(max_new_tokens),
    }
    if seed is not None:
        body['seed'] = int(seed)
    for key in SAMPLING_KEYS:
        if key in sampling:
            body[key] = sampling[key]
    if isinstance(voice, ClipsVoice):
        # The reference, base64 in the body. A DefaultVoice sends NO
        # `references` key at all - the absence is what "the model's own
        # speaker" / "the checkpoint's speaker" looks like on the wire.
        body['references'] = [reference_for(voice)]
    return body


# ---------------------------------------------------------------------------
# The backend
# ---------------------------------------------------------------------------


def _guest_form(path: str) -> str:
    """A checkpoint path as the GUEST spells it, for comparing what the catalog
    says against what the running server's environ carries. On the Windows arm
    the catalog's `\\\\wsl$\\...` and `/home/...` forms both fold to the guest's
    own; elsewhere the path is already the guest's."""
    value = to_wsl(path or '') if sys.platform == 'win32' else (path or '')
    return value.rstrip('/') or value


class HiggsSglServedBackend(GuestOwnedServer):
    """`narrator.engine.protocol.ServedBackend` for Higgs v3 under SGLang-Omni.

    The lifecycle - ownership marker, /proc listener scan, watchdog, adoption,
    TERM-only teardown - is `served_common.GuestOwnedServer`'s and is byte for
    byte the vllm-omni arm's. What is here is this stack's own: the launch line,
    the request, and an identity that has to be read out of the server's
    environment because `/v1/models` will not say it.
    """

    HEALTH_PATH = HEALTH_PATH
    LOG_TAG = '[HIGGSSGL]'
    SERVER_LOG_ENV = SERVER_LOG_ENV
    READY_FAILURE_HINT = (
        'The usual causes are flashinfer\'s JIT (the env needs CUDA_HOME pointed '
        'at nvidia/cu13 with lib64 -> lib and libcudart.so -> libcudart.so.13, '
        'plus the flashinfer-jit-cache cu130 wheel) and a mem-fraction-static '
        'the card cannot honour. Healthy takes ~110 s on owens-pc.')

    def __init__(self, base_url: str = None, serve_script: str = None,
                 wsl_distro: str = None, checkpoint_dir: str = None,
                 server_log: str = None, concurrency: int = None):
        base_url = (base_url or os.environ.get(BASE_URL_ENV) or '').strip()
        serve_script = (serve_script
                        or os.environ.get(SERVE_SCRIPT_ENV) or '').strip()
        if not base_url and not serve_script:
            raise ValueError(
                f'Higgs SGLang-Omni needs either {BASE_URL_ENV} (attach to a '
                f'running sgl-omni server) or {SERVE_SCRIPT_ENV} (the path to '
                'serve_higgs_sgl.sh, which narrator runs rather than '
                'reimplementing - the CUDA_HOME and flashinfer workarounds live '
                'in it). Neither is set.')
        self.base_url = base_url or launch_base_url()
        self.serve_script = serve_script
        if concurrency is not None and int(concurrency) < 1:
            raise ValueError(
                f'Higgs SGLang: concurrency {concurrency} must be >= 1.')
        if concurrency is None and serve_script:
            concurrency = v3_served.serve_concurrency()
        self.concurrency = int(concurrency) if concurrency else None
        self.wsl_distro = (wsl_distro or os.environ.get(WSL_DISTRO_ENV)
                           or 'Ubuntu')
        self._named_log = (os.environ.get(SERVER_LOG_ENV) or '').strip() or None
        self.launch_log = ((server_log or '').strip()
                           or self.default_launch_log('narrator-higgs-sgl'))
        self._log_is_ours = bool(serve_script)
        self.server_log = self.launch_log if serve_script else self._named_log
        self._log_handle = None
        self.spec = BackendSpec(
            kind='served', name='sglang-omni', version='0.1.4',
            base_url=self.base_url,
            server_log=self.server_log,
            notes=('higgs-audio-v3-tts-4b; no site-packages patches (the '
                   'sentinel filter is vllm-omni\'s); 4096-token context'))
        self.checkpoint_dir = (checkpoint_dir or '').strip() or None
        self._proc = None
        self._guest_pid = None

    # -- launch --------------------------------------------------------------

    def _launch_exports(self) -> str:
        """The `export ...` prefix of the wrapper: every launch-script knob
        narrator has an opinion about, stated explicitly.

        `HIGGS_MODEL_DIR` is exported for a checkpoint voice and explicitly
        UNSET for the base weights - unset, not left alone, because the worker's
        own environment may carry one from a caller and inheriting it would start
        a fine-tune under a request for the base speaker. It is also THE IDENTITY
        SOURCE on this stack (see `running_checkpoint`), so it is exported for
        that reason twice over.
        """
        host_port = self.base_url.split('://', 1)[-1].rstrip('/')
        host, _, port = host_port.rpartition(':')
        exports = [
            f'{SERVE_HOST_ENV}={shlex.quote(host)}',
            f'{SERVE_PORT_ENV}={shlex.quote(port)}',
            f'{SERVE_MAX_NUM_SEQS_ENV}={self.concurrency}',
            f'{served_common.OWNER_ENV}={shlex.quote(self.owner_id())}',
        ]
        if self.checkpoint_dir:
            exports.append(
                f'{SERVE_MODEL_DIR_ENV}={shlex.quote(_guest_form(self.checkpoint_dir))}')
            model = ''
        else:
            model = f'unset {SERVE_MODEL_DIR_ENV}; '
        return f'{model}export {" ".join(exports)}; '

    def _wrapper(self) -> str:
        """The shell the launcher actually runs: the exports, the script detached
        with `setsid` so a signal to the wrapper never reaches the server by
        accident, the guest-side watchdog (POSIX only - see `_watchdog_clause`),
        and `wait`. NO PID IS RECORDED: the listener on our port, found by its
        marker after health answers, is the only pid worth knowing."""
        script = (to_wsl(self.serve_script) if sys.platform == 'win32'
                  else self.serve_script)
        return ''.join([self._launch_exports(),
                        f'setsid bash {shlex.quote(script)} & ',
                        self._watchdog_clause(),
                        'wait'])

    def launch_command(self) -> list:
        """The command `start()` runs. Public so a test and a log line can see it
        without a GPU.

        `--exec` ON THE WINDOWS ARM IS LOAD-BEARING: without it `wsl.exe` hands
        the line to the distro's DEFAULT SHELL, which expands every `$` before
        `bash -c` sees the script. `--` is not a substitute (memory:
        wsl-exe-implicit-shell-trap).
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

    # -- identity ------------------------------------------------------------

    def _models_payload(self) -> list:
        """The rows of `/v1/models`. Raises if it cannot be read."""
        try:
            with urllib.request.urlopen(self.base_url + MODELS_PATH,
                                        timeout=10) as response:
                payload = json.loads(response.read().decode('utf-8'))
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise HiggsServerError(
                f'Higgs SGLang: {self.base_url}{MODELS_PATH} could not be read '
                f'({exc}). Something is listening on that port but it does not '
                'answer the OpenAI model list, so it cannot be identified - '
                'refusing to send a render to it.') from exc
        rows = payload.get('data') if isinstance(payload, dict) else None
        return [row for row in (rows or []) if isinstance(row, dict)]

    def served_models(self) -> list:
        """The model ids `/v1/models` reports."""
        return [row.get('id') for row in self._models_payload()]

    def running_checkpoint(self):
        """`(source, model_dir)` for the server on this port.

        NOT FROM `/v1/models`. `sglang_omni/serve/openai_api.py`'s
        `_register_models` answers `ModelCard(id=model_name, root=model_name)` -
        the SERVED NAME in both fields - so unlike vllm-omni 0.28 this stack
        never reports the model PATH there, and reading `root` would compare a
        checkpoint directory against the string "higgs-v3-ds" forever.

        TWO SOURCES, IN ORDER, AND THEY ARE DIFFERENT KINDS OF THING:

          'environ'   `HIGGS_MODEL_DIR` out of `/proc/<listener pid>/environ` -
                      the variable OUR launcher exported into that process. A
                      FACT about the running server, inherited by every fork and
                      rewritten by nothing. `None` beside this source means the
                      launcher exported none, which is the base weights and is an
                      answer rather than an absence.
          'asserted'  `NARRATOR_HIGGS3_CHECKPOINT`, for an ATTACHED server nobody
                      here launched, which therefore carries no marker to scan.
                      A CLAIM, and only consulted when there is no fact.

        `(None, None)` means neither - "unknown", which every caller treats as a
        refusal and never as "fine".
        """
        rows = self._own_servers_on_port()
        if rows:
            value = (rows[0].get('modelDir') or '').strip()
            return ('environ', value or None)
        asserted = (os.environ.get(CHECKPOINT_ENV) or '').strip()
        if asserted:
            return ('asserted', asserted)
        return (None, None)

    def check_serves_expected_model(self, checkpoint_dir: str = None) -> None:
        """Prove the server on this port is OURS before anything is sent to it.

        Health answering 200 says only that SOMETHING is listening. This checks
        `/v1/models` carries `higgs-v3-ds`, and that the model the server was
        started ON is the one this voice needs. Every Higgs voice is a whole
        merged checkpoint and one server serves exactly one of them, so a
        leftover server from ANOTHER voice answers health and the model list
        identically and would render a whole book in the wrong narrator while
        every log line here named the right one - in either direction.
        """
        checkpoint_dir = checkpoint_dir or self.checkpoint_dir
        models = self.served_models()
        if SERVED_MODEL_NAME not in models:
            raise HiggsServerError(
                f'Higgs SGLang: the server at {self.base_url} serves '
                f"{models or '(none)'}, not '{SERVED_MODEL_NAME}'. That is "
                "somebody else's server, or the vllm-omni stack (which serves "
                "'higgs-v3'), on this port - refusing to render against it.")
        source, running = self.running_checkpoint()
        if source is None:
            raise HiggsServerError(
                f'Higgs SGLang: nothing can say which model the server at '
                f'{self.base_url} was started on. It carries no '
                f'{served_common.OWNER_ENV} (so narrator did not launch it and '
                f'its environ is not ours to read) and {CHECKPOINT_ENV} is not '
                'set. This voice is '
                + (f'the merged checkpoint {checkpoint_dir}' if checkpoint_dir
                   else 'the base weights')
                + ', and an unidentified server would render the whole book in '
                'whatever narrator it happens to hold. If this is your own '
                f'server, state its model directory in {CHECKPOINT_ENV}.')
        if checkpoint_dir:
            want = _guest_form(checkpoint_dir)
            if running is None:
                raise HiggsServerError(
                    f'Higgs SGLang: this voice is the merged checkpoint {want}, '
                    f'but the server at {self.base_url} was started with no '
                    f'{SERVE_MODEL_DIR_ENV} at all ({source}) - it is serving the '
                    'BASE weights, a different speaker at 12 % of the '
                    "fine-tune's ECAPA ceiling. Serving this voice means "
                    'RESTARTING on its checkpoint.')
            if _guest_form(running) != want:
                raise HiggsServerError(
                    f'Higgs SGLang: the server at {self.base_url} is running on '
                    f'{running} ({source}), but this voice is {want}. There is no '
                    'runtime LoRA on this stack either, so serving another voice '
                    'means RESTARTING on that checkpoint.')
            log(f'{self.LOG_TAG} serving checkpoint {want} (from the server\'s own '
                f'{source})', flush=True)
            return
        if running is not None:
            raise HiggsServerError(
                f'Higgs SGLang: this voice is the BASE weights, but the server at '
                f'{self.base_url} was started on {running} ({source}), which is a '
                'merged fine-tune. Serving the base means RESTARTING on the base '
                'snapshot.')
        log(f'{self.LOG_TAG} serving the base weights (the server carries no '
            f'{SERVE_MODEL_DIR_ENV})', flush=True)

    # -- use -----------------------------------------------------------------

    def speak(self, request):
        """One `SpeechRequest` -> (float32 mono, sample rate).

        `request.max_new_tokens` is the caller's frame cap and is checked against
        the 4,096-token context HERE as well as where it was computed, because a
        cap that breaches it is an HTTP 500 and this is the last place before the
        wire.
        """
        self._check_context(request.text, request.max_new_tokens, request.voice)
        body = build_request_body(request.text, request.voice,
                                  request.max_new_tokens, seed=request.seed,
                                  sampling=request.sampling)
        payload, content_type = self.post_speech(body, with_content_type=True)
        return v3_served.decode_response(payload, content_type)

    def _check_context(self, text: str, max_new_tokens: int, voice=None) -> None:
        """prompt + cap <= 4,095, refused by name before the wire. The voice's
        reference, when it has one, is part of the prompt."""
        bound = prompt_token_bound(text, voice)
        total = bound + int(max_new_tokens)
        if total > MAX_CONTEXT_POSITIONS:
            raise ValueError(
                f'Higgs SGLang-Omni: this request would need at most {bound} '
                f'prompt tokens plus a {int(max_new_tokens)}-frame cap = {total} '
                f'positions, over the {MAX_CONTEXT_POSITIONS} SGLang-Omni\'s '
                f'Higgs builder allows (context_length {CONTEXT_TOKENS}, '
                'hard-coded in engine_builder.py). The server answers HTTP 500 '
                'for this, not a shorter render. Size the cap with '
                'sgl_served.frame_cap(), which is what the engine uses.')

    def post_speech(self, body: dict, timeout: float = 1800,
                    with_content_type: bool = False):
        """POST `body` to /v1/audio/speech and return the raw response bytes (or
        `(bytes, content_type)` when asked)."""
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
            if exc.code == 500:
                # The one 5xx whose text does not say what to do about it, and
                # the one this stack actually produces in normal use.
                raise HiggsServerError(
                    f'Higgs SGLang HTTP 500: {detail}\n'
                    'THE USUAL CAUSE IS THE CONTEXT: SGLang-Omni\'s Higgs builder '
                    f'hard-codes context_length {CONTEXT_TOKENS}, and prompt '
                    f'tokens + max_new_tokens over {MAX_CONTEXT_POSITIONS} fail '
                    'inside the scheduler rather than rendering short. '
                    'sgl_served.frame_cap() sizes a request to fit and refuses by '
                    'name when a chunk cannot; a 500 reaching here means the cap '
                    'came from somewhere else, or the prompt tokenized denser '
                    f'than the measured {CHARS_PER_TOKEN_FLOOR} characters per '
                    'token this bound assumes.') from exc
            raise HiggsServerError(
                f'Higgs SGLang HTTP {exc.code}: {detail}') from exc
        except urllib.error.URLError as exc:
            raise HiggsServerDown(
                f'Higgs SGLang-Omni server at {self.base_url} is unreachable: '
                f'{exc.reason}. Is it started (serve_higgs_sgl.sh; ~110 s to '
                'health) and is the sglomni env intact?') from exc


def launch_base_url() -> str:
    """Where a server narrator LAUNCHES will answer: the `HIGGS_SGL_HOST` /
    `HIGGS_SGL_PORT` pair the launch script binds, from the environment when
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
                f'Higgs SGLang: {SERVE_PORT_ENV}={raw_port!r} is not a port '
                'number.') from None
    else:
        port = SERVE_DEFAULT_PORT
    return f'http://{host}:{port}'
