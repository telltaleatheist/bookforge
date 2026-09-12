r"""bookforge-tts — BookForge's own pipeline, headless, from the command line.

WHAT THIS IS. Every command drives the app's OWN compiled code: the exported
functions in dist/electron/ that the queue steps and the IPC handlers call,
reached through a thin adapter in cli/. Nothing is reimplemented, deliberately —
a CLI run inherits every guard unchanged, which is what makes a defect found here
a defect in the app. `tools/test-cli-parity.js` defends that: each adapter must
require the COMPILED module and call the exact symbol the app's own step calls.

    bookforge-tts --tts --voice zac --input book.epub --out sample.wav

HOW TO READ THIS HELP. Below, every flag sits in a group whose title says who
reads it. For ONE command — its flags, what it refuses by name, and examples you
can paste — ASK THAT COMMAND:

    bookforge-tts --tts --help
    bookforge-tts --audiobook --help
    bookforge-tts --pass --help

BUILD FIRST. BookForge must be BUILT; it need not be running.

    npx tsc -p tsconfig.electron.json                       # the code
    cp -R electron/data electron/prompts dist/electron/     # the assets tsc does not copy

(`npm run build:electron` does both. On a tsc-only build, every command that
touches a component — --generate-epub, --rvc, --generate-sentences — dies with
"Failed to load built-in RVC voice assets", because the component system loads
dist/electron/data/*.json at import time.)

THE COMMANDS. Exactly one is required.

  --tts                 render a book, a passage or bare test chunks to a WAV
  --audiobook           the shipped M4B end to end: render -> denoise -> assemble -> register
  --assemble            assemble (and optionally denoise) a session already rendered
  --align               force-align a rendered session; writes coverage.json
  --denoise             the final-denoise step over a session's cached sentences
  --rvc-enhance         the RVC step over a session's cached sentences
  --retake              Correct Sentences: list / retake / commit / revert / cleanup
  --pass                a processing pass on a project: simplify, translate, footnote-refs
  --prep                the narration door alone: captions and notes out, numbers as words
  --narration-text      the narration text cleanup on a book, replacing it in place
  --clean-lines         a file of lines through that same cleanup, written back by position
  --clean               the hosted Foundry window's "Clean text" press, with no window
  --ai-cleanup          ai-bridge.cleanupEpub over a LOOSE epub (repair and/or TTS prep)
  --ai-simplify         the same call with simplifyForChildren + a mode
  --generate-sentences  audio -> a sentence VTT (whisper, or epub-align with the book as truth)
  --generate-epub       read a project's PDF into its book (foundry vlm-convert)
  --rvc                 convert ONE finished audio file through an RVC voice, memory-safely

Commands are a registry (COMMANDS), the flags a second one (COMMAND_FLAGS) that
says which command reads which — and the per-command help is generated from it,
so it cannot describe a flag the parser does not have. Nothing is silently
defaulted: a missing required arg fails loudly, and a flag the chosen door cannot
honour is refused BY NAME rather than accepted and dropped.
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import textwrap
from pathlib import Path

# THIS PROGRAM'S OUTPUT IS UTF-8, AND SAYS SO.
#
# Every help string and every progress line here is written with the punctuation
# the rest of the repo uses — em dashes, arrows, "≤" in the packing-cap help. On
# a default Windows console Python picks cp1252 for stdout, which cannot encode
# any of them, so `--help` died with a UnicodeEncodeError before printing a
# single command (measured 2026-09-05, and true of every build that had the ≤ in
# it). Declaring the encoding is the fix; dropping the characters would be
# rewriting the documentation to suit a codec.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

REPO_ROOT = Path(__file__).resolve().parent.parent          # cli/ -> bookforge root
NODE_STUB = REPO_ROOT / "cli" / "electron-stub.js"
ORPHEUS_STREAM = REPO_ROOT / "cli" / "orpheus-stream.js"        # streaming path (Listen/extension)
ORPHEUS_BATCH = REPO_ROOT / "cli" / "orpheus-batch-render.js"   # audiobook/batch path (default)
ORPHEUS_AUDIOBOOK = REPO_ROOT / "cli" / "orpheus-audiobook-render.js"  # full M4B: tts + reassembly
NARRATION_PREP = REPO_ROOT / "cli" / "narration-prep.js"        # narration door: cut + numbers
NARRATION_TEXT = REPO_ROOT / "cli" / "narration-text.js"        # the persisted text cleanup
CLEAN_LINES = REPO_ROOT / "cli" / "clean-lines.js"              # a file of lines through clean-text, by position
CLEAN_STEP = REPO_ROOT / "cli" / "clean-step.js"                # the hosted Foundry Clean text press, headless
AI_CLEAN = REPO_ROOT / "cli" / "ai-clean.js"                    # AI cleanup / simplify (ai-bridge)
GEN_SENTENCES = REPO_ROOT / "cli" / "generate-sentences.js"     # audio -> VTT (whisper / epub-align)
RVC_CONVERT = REPO_ROOT / "cli" / "rvc-convert.js"              # whole-file RVC voice conversion
GENERATE_EPUB = REPO_ROOT / "cli" / "generate-epub.js"          # PDF -> EPUB (foundry vlm-convert)
FINAL_DENOISE = REPO_ROOT / "cli" / "final-denoise.js"          # the final-denoise STEP (denoise-job)
RVC_ENHANCE = REPO_ROOT / "cli" / "rvc-enhance.js"              # the rvc-enhancement STEP (rvc-job)
CORRECT_SENTENCES = REPO_ROOT / "cli" / "correct-sentences.js"  # retake / commit / revert one sentence
PASS_ADAPTER = REPO_ROOT / "cli" / "pass.js"                    # simplify / translate / footnote-refs
COVERAGE_ALIGN = REPO_ROOT / "cli" / "coverage-align.js"        # the align STEP (coverage-align-job)

# Sibling adapters with argument grammars of their own — named in the epilog so
# `--help` lists every action this CLI can reach, not only the ones argparse owns.
SIBLING_ADAPTERS = {
    "cli/library.js": "library + project verbs (import epub/audiobook, versions, "
                      "set-primary, promote, delete) through library-actions",
    "cli/clipforge-process.js": "ClipForge chains (recipe, speakers, narration, verify, "
                                "merge/split, sentences) through clipforge-chain",
    "cli/serve-bookshelf.js": "the Bookshelf server, standalone",
}


def _require(cond, msg):
    if not cond:
        sys.exit(f"bookforge-tts: {msg}")


def _load_cli_settings(explicit_path):
    """Find + load the CLI settings file (aliases + defaults). First existing wins:
    --config > $BOOKFORGE_CLI_CONFIG > <repo>/cli/bookforge-cli.json > ~/.bookforge-cli.json.
    Returns (settings_dict, path_or_None). A malformed file fails loud (NO FALLBACK)."""
    # An explicitly-named config that doesn't exist is an ERROR *before* the search —
    # otherwise a typo'd --config silently loads a DIFFERENT config (NO FALLBACKS).
    if explicit_path:
        _require(Path(explicit_path).is_file(), f"--config file not found: {explicit_path}")
    env_cfg = os.environ.get("BOOKFORGE_CLI_CONFIG")
    if env_cfg:
        _require(Path(env_cfg).is_file(), f"BOOKFORGE_CLI_CONFIG points at a missing file: {env_cfg}")
    candidates = []
    if explicit_path:
        candidates.append(Path(explicit_path))
    if env_cfg:
        candidates.append(Path(env_cfg))
    candidates.append(REPO_ROOT / "cli" / "bookforge-cli.json")
    candidates.append(Path.home() / ".bookforge-cli.json")
    for c in candidates:
        if c.is_file():
            try:
                return json.loads(c.read_text(encoding="utf-8")), c
            except Exception as e:
                sys.exit(f"bookforge-tts: failed to parse settings file {c}: {e}")
    return {}, None


def _apply_cli_settings(args, settings):
    """Fill unset args from the settings file and expand aliases. Explicit CLI args
    ALWAYS win — nothing here overwrites a value the user actually typed."""
    # 1) defaults: fill any arg the user did NOT pass. Only None-defaulted flags are
    #    fillable (a store_true flag or a flag with a non-None argparse default can't
    #    be distinguished from "user typed it"). Unknown or non-fillable keys are an
    #    ERROR — a typo'd key must not be silently ignored (NO FALLBACKS).
    fillable = {"voice", "provider", "model", "output_dir", "tier", "simplify_mode",
                "model_dir", "models_dir", "voice_token", "input", "text", "out",
                "sentence_gap", "max_chars", "orpheus_install", "conda_env",
                "custom_instructions", "parallel_workers", "test_chunks",
                "api_key", "ollama_url", "cleanup_prompt",
                # The 2026-09-12 model-picking knobs. All None-defaulted, so
                # "the user typed it" is still distinguishable from "fill it in".
                "checkpoint_dir", "top_k", "safe_band", "batch_width",
                "mem_budget_gb", "title", "library"}
    for key, val in (settings.get("defaults") or {}).items():
        if key.startswith("_"):
            continue                      # _comment and friends
        dest = key.replace("-", "_")
        _require(dest in fillable,
                 f"settings 'defaults.{key}' is not a fillable flag (fillable: "
                 f"{', '.join(sorted(k.replace('_','-') for k in fillable))})")
        if getattr(args, dest) is None:
            setattr(args, dest, val)
    # 2) voice alias -> a real voice id (str), or an unregistered model {model_dir, token}.
    voices = settings.get("voices") or {}
    if args.voice in voices:
        va = voices[args.voice]
        if isinstance(va, dict):
            # A model_dir alias MUST carry its prompt token: with an explicit model dir
            # the engine skips its allowlist, so a wrong/absent token renders silently
            # mis-conditioned audio instead of erroring.
            _require(bool(va.get("token")),
                     f"settings voices.{args.voice}: 'token' is required alongside 'model_dir'")
            if not args.model_dir and va.get("model_dir"):
                args.model_dir = va["model_dir"]
            args.voice = va["token"]
        elif isinstance(va, str):
            args.voice = va
    # 3) AI model alias -> real model name (e.g. "sonnet" -> "claude-sonnet-4-5").
    for amap in ((settings.get("ai") or {}).get("model_aliases"),):
        if amap and args.model in amap:
            args.model = amap[args.model]
    # 4) engine location: "type orpheus, look up where orpheus is". Fills install /
    #    conda env / models dir from the named engine, only where the user left them unset.
    eng = (settings.get("engines") or {}).get(args.engine or "")
    if eng:
        if not args.orpheus_install and eng.get("install"):
            args.orpheus_install = eng["install"]
        if not args.conda_env and eng.get("conda_env"):
            args.conda_env = eng["conda_env"]
        if not args.models_dir and eng.get("models_dir"):
            args.models_dir = eng["models_dir"]


# ─────────────────────────────────────────────────────────────────────────────
# PICKING THE MODEL: any checkpoint, any sampling, any band (2026-09-12)
# ─────────────────────────────────────────────────────────────────────────────
#
# Owen, 2026-09-12: *"we should be able to pick any model specifically, including
# a checkpoint we want to test, and it should allow that... it should allow me to
# fully control what goes in and comes out. ... make it so i can run it on the mac
# and itll use the mac's line of logic, or the pc and itll use the pc's line of
# logic (for sglang or mlx, etc)."*
#
# THE ARM IS NOT A FLAG. `renderRangeHeadless` already routes by platform — Mac
# MLX, Windows/WSL SGLang — so the CLI's whole job is to hand every CHOICE to the
# same settings object the app's queue builds, and to refuse nothing the app would
# allow. Nothing here decides which machine reads the tokens.
#
# TWO DELIVERY SEAMS, AND THEY ARE NOT INTERCHANGEABLE:
#   * Orpheus sampling rides the ORPHEUS_* process env, which is where the
#     bridge's worker spawn reads it from.
#   * Higgs sampling rides the VOICE DOCUMENT, so it travels as
#     `ParallelTtsSettings.higgsOverride` — one JSON argument to the adapter
#     (`--higgs-override`), parsed by cli/higgs-override.js.
# An env var set for a Higgs render would be read by nobody, so every Orpheus-only
# flag is refused by name on a Higgs run, and vice versa.


def _default_note():
    """Who ran this and why, when --note was not given: the command as typed, on
    the machine that typed it. `note` is REQUIRED on the override because a
    session whose sampling nobody can account for is worse than no session."""
    return f"bookforge-tts {' '.join(sys.argv[1:])} @ {socket.gethostname()}"


def _higgs_override(args, door):
    """Build `ParallelTtsSettings.higgsOverride` (or None) and refuse every
    cross-engine flag BY NAME.

    `door` is 'tts' or 'audiobook' — the two render doors. Streaming and
    --assemble refuse these flags outright (see their own blocks): a speak binds a
    catalog voice with no per-request checkpoint seam, and an assembly renders
    nothing.

    NOTHING HERE VALIDATES A VALUE. The bridge resolves the base `fineTuned` voice
    from the catalog and refuses a band or a cap it cannot honour, by name. A
    second opinion here would be a second implementation of the thing under test.
    """
    higgs = args.engine == "higgs"

    # ── The checkpoint ───────────────────────────────────────────────────────
    _require(not (args.checkpoint_dir and not higgs),
             "--checkpoint-dir names a Higgs checkpoint under test; Orpheus names a model "
             "directory with --model-dir")
    _require(not (args.model_dir and higgs),
             "--model-dir names an Orpheus model directory; a Higgs checkpoint under test is "
             "named by --checkpoint-dir (it borrows --voice's certificate)")

    # ── Sampling: each knob belongs to exactly one engine ────────────────────
    _require(not (args.rep_penalty is not None and higgs),
             "--rep-penalty is an Orpheus sampling seam (ORPHEUS_REP_PENALTY); narrator's v3 "
             "Higgs engines have no repetition-penalty knob")
    _require(not (args.min_p is not None and higgs),
             "--min-p is an Orpheus sampling seam (ORPHEUS_MIN_P); narrator's v3 Higgs engines "
             "have no min_p knob")
    _require(not (args.top_k is not None and not higgs),
             "--top-k is a Higgs sampling field; Orpheus's worker reads ORPHEUS_TEMPERATURE / "
             "ORPHEUS_TOP_P / ORPHEUS_MIN_P / ORPHEUS_REP_PENALTY and has no top_k seam")

    # ── The band ─────────────────────────────────────────────────────────────
    _require(not (args.safe_band and not higgs),
             "--safe-band is the Higgs chunk band (safeMinChars/safeMaxChars); Orpheus packs "
             "to --max-chars")
    safe_min = safe_max = None
    if args.safe_band:
        parts = str(args.safe_band).split("-")
        _require(len(parts) == 2 and all(p.strip().isdigit() for p in parts),
                 f"--safe-band takes MIN-MAX in characters, e.g. --safe-band 200-700 "
                 f"(got '{args.safe_band}')")
        safe_min, safe_max = int(parts[0]), int(parts[1])
        _require(safe_min < safe_max,
                 f"--safe-band MIN must be below MAX (got {safe_min}-{safe_max})")

    if not higgs:
        return None

    override = {}

    if args.checkpoint_dir:
        # WHERE THE DIRECTORY LIVES IS THE ARM'S QUESTION, NOT OURS.
        #
        # On the Mac (and Linux) the checkpoint is read by THIS machine, so the
        # path is resolved against the user's cwd and must exist — a typo caught
        # here costs a second instead of forty minutes into a render.
        #
        # On Windows the reading happens in the WSL guest, whose filesystem this
        # host cannot stat. So the only thing that can be checked is the shape:
        # a guest-native absolute path. Pretending to verify it would be a
        # fallback dressed as a guard.
        if sys.platform == "win32":
            _require(str(args.checkpoint_dir).startswith("/"),
                     "--checkpoint-dir must be a guest-native path starting with '/' on Windows: "
                     "a Higgs render runs in the WSL guest and this host cannot stat the guest's "
                     f"filesystem (got '{args.checkpoint_dir}')")
            override["checkpointDir"] = str(args.checkpoint_dir)
        else:
            resolved = Path(args.checkpoint_dir).expanduser().resolve()
            _require(resolved.is_dir(),
                     f"--checkpoint-dir is not a directory on this machine: {resolved}")
            override["checkpointDir"] = str(resolved)

    sampling = {}
    if args.temperature is not None:
        sampling["temperature"] = args.temperature
    if args.top_p is not None:
        sampling["topP"] = args.top_p
    if args.top_k is not None:
        sampling["topK"] = args.top_k
    if sampling:
        override["sampling"] = sampling

    if args.max_chars:
        override["maxChars"] = int(args.max_chars)
    if safe_min is not None:
        override["safeMinChars"] = safe_min
        override["safeMaxChars"] = safe_max

    if not override:
        return None
    override["note"] = args.note if args.note else _default_note()
    _ = door          # the door is part of the signature so the refusals can differ later
    return override


def _mlx_tuning_env(args, env):
    """Apply the Mac MLX arm's two per-run knobs to the process env, and answer
    which keys were set (for the dry-run print).

    THESE ARE MAC-ONLY, AND NOT AS AN OMISSION. `higgsMlxBatchEnv` honours
    `process.env.NARRATOR_HIGGS3_MLX_BATCH` / `..._MEM_BUDGET_GB` over the
    catalog's ceiling, which is the seam. On Windows a Higgs render is SERVED, and
    its width is the server's admission width (`HIGGS_MAX_NUM_SEQS`, set from the
    catalog when the server is started) — not something a single run chooses. A
    flag that silently did nothing there would be the worst outcome, so it is
    refused by name.
    """
    keys = []
    if args.batch_width is None and args.mem_budget_gb is None:
        return keys
    _require(args.engine == "higgs",
             "--batch-width/--mem-budget-gb are the Higgs MLX arm's per-run knobs; Orpheus "
             "sizes its batch from --tier")
    _require(sys.platform != "win32",
             "--batch-width/--mem-budget-gb are the Mac MLX arm's knobs; on Windows a Higgs "
             "render is SERVED and the width is the catalog's server admission width "
             "(HIGGS_MAX_NUM_SEQS), not a per-run flag")
    if args.batch_width is not None:
        _require(args.batch_width > 0, "--batch-width must be a positive integer")
        env["NARRATOR_HIGGS3_MLX_BATCH"] = str(args.batch_width)
        keys.append("NARRATOR_HIGGS3_MLX_BATCH")
    if args.mem_budget_gb is not None:
        _require(args.mem_budget_gb > 0, "--mem-budget-gb must be positive")
        # "%g" so a whole number stays whole: `40`, not `40.0`. The reader parses
        # a float either way, but an env line a human reads should say what was typed.
        env["NARRATOR_HIGGS3_MLX_MEM_BUDGET_GB"] = "%g" % args.mem_budget_gb
        keys.append("NARRATOR_HIGGS3_MLX_MEM_BUDGET_GB")
    return keys


def cmd_tts(args):
    """Render text -> wav through BookForge's REAL pipeline.

    --mode tts (default): the audiobook/batch path (parallel-tts-bridge ->
        renderRangeHeadless -> e2a prep packs ~300-char chunks -> worker.py). This is
        the path Owen ships with.
    --mode streaming: the Listen/extension path — the app's tts-api-server driven
    over its own WebSocket protocol, so the run goes through handleSpeak, splitForTts,
    the stream scheduler and the pool's batch ladder exactly as pressing play does.
    Input is BLOCKS (paragraphs separated by blank lines); block 1 is the one played
    and the rest are read ahead. (was: orpheus-worker-pool, one sentence per vLLM
        sequence, no packing).
    """
    # HIGGS IS WIRED FOR --mode tts. The batch adapter hands `ttsEngine` to the
    # SAME `renderRangeHeadless` the app calls, and the bridge routes a Higgs job
    # to narrator (prep -> compat.app --prep_only, worker -> compat.worker,
    # assembly -> compat.app --assemble_only) — so the CLI mirrors the app's code
    # path rather than carrying a second copy of the routing.
    _require(args.engine in ("orpheus", "higgs"),
             f"--engine '{args.engine}' not wired (use 'orpheus' or 'higgs')")
    _require(args.mode in ("tts", "streaming"),
             f"--mode '{args.mode}' invalid (use 'tts' or 'streaming')")
    # HIGGS STREAMS. The refusal that stood here — "v3 is a served endpoint with
    # no windowed decode" — was written before per-row Higgs streaming shipped on
    # 2026-09-05; `tts-api-server.handleSpeak` has bound a Higgs voice ever since,
    # and `streaming-engine`'s ENGINES map offers it to the Settings picker and the
    # extension's engine menu. A CLI that refused the path the app ships was the
    # one door that could not reproduce a Listen defect on it. Lifted 2026-09-12.
    _require(bool(args.voice), "--voice <id> is required for --tts")
    _require(bool(args.out), "--out <file.wav> is required for --tts")
    if args.mode == "tts":
        # ── WHAT A RENDER MAY READ (Owen, 2026-09-12) ────────────────────────
        #
        # It was EPUB-only, by his 2026-09-05 ruling. He OVERRODE that on
        # 2026-09-12: *"it should also let me run renders on anything, up to and
        # including test chunks."* So a `.txt`/`.md` (paragraphs separated by
        # blank lines), a `.jsonl` (one chunk per row) and a `--text` literal are
        # render inputs now — packed into a real one-chapter EPUB by the app's own
        # writer in the adapter, so the render path still reads exactly one format.
        _require(bool(args.input) or bool(args.text),
                 "--tts needs --input <book.epub|passage.txt|chunks.jsonl> or --text <str>")
        _require(not (args.input and args.text),
                 "--input and --text both name what to render; pass one")
        if args.input:
            ext = Path(str(args.input)).suffix.lower()
            _require(ext in (".epub", ".txt", ".md", ".jsonl"),
                     f"--tts reads .epub (a book), .txt/.md (paragraphs separated by blank "
                     f"lines) or .jsonl (one chunk per row); '{ext or args.input}' is none of them")
            _require(not (args.as_chunks and ext == ".epub"),
                     "--as-chunks makes each paragraph ONE generation chunk; an EPUB is chunked "
                     "by the app's own packer, which is what an EPUB render measures. Use a "
                     ".txt/.md/.jsonl input (or --text), or drop --as-chunks.")
    else:
        _require(bool(args.input or args.text), "--input <file> or --text <str> is required")
    _require(bool(shutil.which("node")), "node not found on PATH")

    if args.mode == "tts":
        # Audiobook/batch path: the compiled bridge must expose renderRangeHeadless.
        _require(ORPHEUS_BATCH.is_file(), f"missing engine adapter {ORPHEUS_BATCH}")
        _require((REPO_ROOT / "dist" / "electron" / "parallel-tts-bridge.js").is_file(),
                 "BookForge is not built — run `npx tsc -p tsconfig.electron.json` first "
                 "(dist/electron/parallel-tts-bridge.js missing)")
        adapter = ORPHEUS_BATCH
    else:
        # Streaming path.
        _require(ORPHEUS_STREAM.is_file(), f"missing engine adapter {ORPHEUS_STREAM}")
        _require((REPO_ROOT / "dist" / "electron" / "tts-api-server.js").is_file(),
                 "BookForge is not built — run `npm run build:electron` first "
                 "(dist/electron/tts-api-server.js missing)")
        adapter = ORPHEUS_STREAM

    # Streaming mode has no packing/prep: --model-dir and --language are simply not
    # consumed there. Refuse rather than silently ignore (NO FALLBACKS).
    if args.mode == "streaming":
        _require(not args.model_dir,
                 "--model-dir is not supported in --mode streaming (registered voices only)")
        _require((args.language or "en") == "en",
                 "--language is not supported in --mode streaming")
        # THE OVERRIDE SEAM IS THE RENDER PATH'S. A `speak` names a catalog VOICE
        # and the pool is already resident when it arrives — there is no
        # per-request checkpoint, band or cap to hand it. Each of these is refused
        # by name rather than accepted and dropped.
        _require(not args.checkpoint_dir,
                 "--checkpoint-dir is not supported in --mode streaming: a speak binds a "
                 "catalog voice and there is no per-request checkpoint seam. Use --mode tts.")
        _require(not args.safe_band,
                 "--safe-band is the tts path's chunk band; streaming packs with the voice's "
                 "own cap (splitForTts)")
        _require(not args.as_chunks,
                 "--as-chunks is a generation-chunk choice on the tts path; streaming speaks "
                 "blocks — one block per paragraph already")
        _require(args.max_chunks is None,
                 "--max-chunks caps the tts path's generation; streaming reads blocks — use "
                 "--read-ahead to bound how many")
        _require(args.top_k is None,
                 "--top-k rides the Higgs voice document on the tts path; a streaming speak "
                 "carries no sampling override")
        _require(not (args.engine == "higgs" and any(
                     v is not None for v in (args.temperature, args.top_p,
                                             args.min_p, args.rep_penalty))),
                 "--temperature/--top-p/--min-p/--rep-penalty are Orpheus's env seams; on a "
                 "Higgs run sampling rides the voice document, which a streaming speak does "
                 "not carry. Use --mode tts, or set them in the voice.")
        _require(not args.title,
                 "--title names the book a text input is packed as; streaming speaks blocks "
                 "and packs nothing")
        # Streaming keeps no session on disk — the pool answers sentence by
        # sentence over the socket — so there is no tmp to point at.
        _require(not args.library,
                 "--library names where a RENDER keeps its sessions and narration cuts; "
                 "streaming writes neither. Use --mode tts.")
        # The streaming adapter drives the app's REAL path (tts-api-server -> stream
        # scheduler -> pool), and over that protocol a speak names a VOICE — there is no
        # per-request prompt-token seam to hand this to. Refuse rather than ignore.
        _require(not args.voice_token,
                 "--voice-token is not supported in --mode streaming (the app path binds a "
                 "voice by id; use --voice)")

    # Resolve relative paths against the USER'S cwd — the node adapter runs with
    # cwd=REPO_ROOT, so a bare 'sample.wav' would otherwise land inside the repo (and a
    # relative --input could silently pick up a same-named repo file).
    input_path = str(Path(args.input).resolve()) if args.input else None
    out_path = str(Path(args.out).resolve())

    cmd = ["node", "--require", str(NODE_STUB), str(adapter),
           "--voice", args.voice, "--out", out_path]
    # The batch adapter defaults to orpheus; naming it is what lets --engine higgs
    # reach the bridge. The STREAMING adapter takes it too since 2026-09-12 — not
    # to select an engine (that choice is persisted in tts-engine.json and is the
    # app's to manage) but so a mismatch with the engine actually selected is
    # refused by name instead of speaking in the other one.
    cmd += ["--engine", args.engine]
    if input_path:
        cmd += ["--input", input_path]
    if args.text:
        cmd += ["--text", args.text]
    if args.language:
        cmd += ["--language", args.language]
    if args.model_dir:
        cmd += ["--model-dir", args.model_dir]
    # The Higgs checkpoint/sampling/band override — ONE JSON argument, so both
    # render adapters parse it with the one shared parser (cli/higgs-override.js).
    override = _higgs_override(args, door="tts") if args.mode == "tts" else None
    if override:
        cmd += ["--higgs-override", json.dumps(override, sort_keys=True)]
    if args.mode == "tts" and args.as_chunks:
        cmd += ["--as-chunks"]
    if args.mode == "tts" and args.max_chunks is not None:
        cmd += ["--max-chunks", str(args.max_chunks)]
    if args.mode == "tts" and args.title:
        cmd += ["--title", args.title]
    # WHERE THE SESSIONS GO. The batch adapter has no project to derive a library
    # from, so it resolves the one main recorded (userData/library-root.json) and
    # refuses when there is none; this flag overrides that for one run.
    if args.mode == "tts" and args.library:
        cmd += ["--library", str(Path(args.library).expanduser().resolve())]
    if args.mode == "tts" and args.skip_text_cleanup:
        cmd += ["--skip-text-cleanup"]
    if args.mode == "tts" and args.keep_sentences:
        cmd += ["--keep-sentences"]
    if args.mode == "tts" and args.keep_session:
        cmd += ["--keep-session"]
    # Streaming-only: how many following blocks are read ahead, which is what decides
    # the batch shapes the scheduler forms. Default (omitted) = every remaining block,
    # exactly what the extension does on a page.
    if args.mode == "streaming" and args.read_ahead is not None:
        cmd += ["--read-ahead", str(args.read_ahead)]

    # Customization delivered through the process env — the compiled pipeline reads these
    # seams (mirrors how the app's persisted settings feed the same code paths).
    env = os.environ.copy()
    if args.orpheus_install:          # override the e2a install the worker uses
        env["EBOOK2AUDIOBOOK_PATH"] = args.orpheus_install
    if args.models_dir:               # override where custom models are discovered
        env["BOOKFORGE_ORPHEUS_MODELS_DIR"] = args.models_dir
    if args.tier:                     # force the GPU memory tier (else auto-sized)
        env["ORPHEUS_MEMORY_TIER"] = args.tier
    if args.conda_env:                # override the WSL Orpheus conda env
        env["WSL_ORPHEUS_CONDA_ENV"] = args.conda_env
    if args.sentence_gap is not None:  # deterministic inter-clip gap (tts path)
        env["ORPHEUS_SENTENCE_GAP"] = str(args.sentence_gap)
    # ORPHEUS_* IS ORPHEUS'S. On a Higgs run these are read by nobody — its
    # sampling and its caps ride the voice document (`higgsOverride` above) — so
    # setting them here would be a value that looks honoured and is not.
    if args.engine == "orpheus":
        if args.max_chars:             # packing cap (tts path; read at prep by core.py)
            env["ORPHEUS_MAX_CHARS"] = str(args.max_chars)
        if args.temperature is not None:   # sampling overrides (worker; orpheus.py defaults
            env["ORPHEUS_TEMPERATURE"] = str(args.temperature)  # 0.6/0.8/1.1 rule otherwise)
        if args.top_p is not None:
            env["ORPHEUS_TOP_P"] = str(args.top_p)
        if args.min_p is not None:
            env["ORPHEUS_MIN_P"] = str(args.min_p)
        if args.rep_penalty is not None:
            env["ORPHEUS_REP_PENALTY"] = str(args.rep_penalty)
    mlx_keys = _mlx_tuning_env(args, env)

    if args.dry_run:
        print(f"[bookforge-tts] DRY RUN — mode={args.mode}, no GPU touched")
        print("  spawn:", " ".join(cmd))
        print("  higgs override:", json.dumps(override, sort_keys=True) if override else "(none)")
        overrides = {k: env[k] for k in (
            "EBOOK2AUDIOBOOK_PATH", "BOOKFORGE_ORPHEUS_MODELS_DIR",
            "ORPHEUS_MEMORY_TIER", "WSL_ORPHEUS_CONDA_ENV", "ORPHEUS_SENTENCE_GAP",
            "ORPHEUS_MAX_CHARS", "ORPHEUS_TEMPERATURE", "ORPHEUS_TOP_P", "ORPHEUS_MIN_P",
            "ORPHEUS_REP_PENALTY", *mlx_keys,
        ) if k in env}
        print("  env overrides:", overrides or "(none)")
        # ── THE BATCH DOOR HAS ITS OWN DRY RUN, AND IT ANSWERS MORE ──────────
        #
        # Echoing the argv cannot say what book a text input became or how many
        # chunks that is, and those are the two facts a text/jsonl render turns
        # on. So in `--mode tts` the dry run is handed to the adapter, which packs
        # the input book (CPU, a few kB, content-addressed) and prints the
        # resolved settings, then stops BEFORE the narration door and the bridge —
        # the two steps that load a model or take the card.
        #
        # Streaming gets the printed spawn and nothing else: that adapter's only
        # move is to start (or attach to) the real server, which is not a dry run
        # by any reading.
        if args.mode != "tts":
            return 0
        # FLUSH FIRST. The child inherits this stdout, and python buffers when it
        # is a pipe — so without this the adapter's lines print BEFORE the spawn
        # they came from, which reads as though the order were the other way round.
        sys.stdout.flush()
        return subprocess.call(cmd + ["--dry-run"], cwd=str(REPO_ROOT), env=env)

    print(f"[bookforge-tts] tts/{args.engine} mode={args.mode} ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=env)


def _audiobook_spawn(args, assemble_only):
    """The argv + env for cli/orpheus-audiobook-render.js, shared by --audiobook and
    --assemble.

    ONE ADAPTER, TWO DOORS. `--assemble` is not a second implementation of the
    assembly: it is this same adapter with `--assemble-only`, which skips
    generation and runs the project's CACHED sentences through the very calls the
    full build makes — `denoise-job.runFinalDenoise` then
    `reassembly-bridge.startReassembly`. That is what the app's own "Assemble"
    does with a cached session, so a defect in either shows up from either door.
    """
    # THE ENGINE IS A RENDER CHOICE, AND ONLY A RENDER CHOICE. An assembly
    # resolves it from the session it is assembling
    # (`reassembly-bridge.narratorEngineForSession` reads session-state.json and
    # refuses a session whose two records disagree), so --assemble reads nothing
    # here rather than pretending to decide it.
    # ── FLAG-SHAPE REFUSALS COME FIRST ───────────────────────────────────────
    #
    # These three describe a TEXT input, and neither of this adapter's doors has
    # one: both work on the project's own book. They are refused before the
    # project is even resolved, because making the operator fix a path to be told
    # about a flag that could never have worked is a worse error message.
    #
    # A CAPPED BOOK IS NOT A BOOK, in particular: an M4B built from the first N
    # chunks would be filed in the project's own output/ as THE audiobook, with
    # chapters and metadata claiming to be the whole thing.
    door = "--assemble" if assemble_only else "--audiobook"
    _require(args.max_chunks is None,
             f"--max-chunks caps generation; a capped book is not an audiobook (it would be "
             f"filed as the project's own). Use --tts --max-chunks N, not {door}.")
    _require(not args.as_chunks,
             f"--as-chunks renders each paragraph of a TEXT input as one chunk; {door} works on "
             f"the project's recorded book. Use --tts.")
    _require(not args.title,
             f"--title names the book a text input is packed as; {door} uses the project's "
             f"own title")
    # THE PROJECT DECIDES ITS LIBRARY. `<library>/projects/<slug>` is the layout
    # every manifest path resolves against, so the adapter derives the root from
    # the project dir itself (`path.dirname(path.dirname(projectDir))`). A flag
    # naming a different one would put the sessions in one library while the
    # cover, the metadata and the output landed in another.
    _require(not args.library,
             f"--library names the library a RENDER keeps its sessions in; {door} derives it "
             f"from --project (<library>/projects/<slug>). Drop --library.")
    if not assemble_only:
        # Both narrator engines render a PROJECT through this door. Until
        # 2026-09-06 it refused 'higgs' ("not wired yet") while --tts wanted an
        # EPUB path and a .wav, so a Higgs render of a project had NO headless
        # door at all - found by the training agent running the SGLang
        # validation runbook. The engine rides to the adapter, which puts it
        # in ParallelTtsSettings.ttsEngine exactly as the app's queue does
        # (shared/queue/narration-run.ts); the bridge routes by isHiggsJob.
        _require(args.engine in ("orpheus", "higgs"),
                 f"--engine '{args.engine}' is not a narrator engine (orpheus or higgs)")
    _require(bool(args.project), "--project <projectDir> is required")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(ORPHEUS_AUDIOBOOK.is_file(), f"missing engine adapter {ORPHEUS_AUDIOBOOK}")
    for js in ("parallel-tts-bridge.js", "reassembly-bridge.js", "manifest-service.js",
               "denoise-job.js"):
        _require((REPO_ROOT / "dist" / "electron" / js).is_file(),
                 f"BookForge is not built — run `npx tsc -p tsconfig.electron.json` first "
                 f"(dist/electron/{js} missing)")

    project_dir = str(Path(args.project).resolve())
    _require((Path(project_dir) / "manifest.json").is_file(),
             f"not a BookForge project (no manifest.json): {project_dir}")

    cmd = ["node", "--require", str(NODE_STUB), str(ORPHEUS_AUDIOBOOK),
           "--project", project_dir]
    override = None                   # the Higgs checkpoint/sampling/band, on the render door
    if assemble_only:
        # No generation happens, so a voice would decide nothing — refuse it by
        # name rather than accepting a value that changes nothing about the run.
        _require(not args.voice,
                 "--assemble runs the CACHED sentences; the voice was decided when they "
                 "were rendered. Drop --voice (or use --audiobook to render).")
        _require(not args.input,
                 "--assemble reads no book: --input names the EPUB a RENDER would read")
        _require(not args.fresh, "--fresh is a render choice; --assemble renders nothing")
        _require(not args.skip_text_cleanup,
                 "--skip-text-cleanup is a render choice; --assemble narrates nothing")
        # The 2026-09-12 render knobs are render choices too, every one of them.
        # An assembly reads the cached audio; a checkpoint, a band, a sampling
        # value or a chunk cap decides nothing about it.
        for flag, val in (("--checkpoint-dir", args.checkpoint_dir),
                          ("--safe-band", args.safe_band),
                          ("--top-k", args.top_k),
                          ("--batch-width", args.batch_width),
                          ("--mem-budget-gb", args.mem_budget_gb)):
            _require(val is None or val is False,
                     f"{flag} is a render choice; --assemble runs the CACHED sentences and "
                     f"renders nothing")
        cmd += ["--assemble-only"]
        # ASSEMBLING A DERIVED SET, AND FILING IT AS A SECOND AUDIOBOOK.
        # `--rvc-enhance` writes a durable set inside the session and, until
        # 2026-09-10, the CLI had no way to assemble what it had just produced —
        # a headless enhancement ended at a directory of FLACs. The adapter
        # states every refusal (a set that is not there, a voice it cannot name,
        # a denoise that would derive a different directory); nothing is
        # re-decided here.
        if args.sentences_dir:
            cmd += ["--sentences-dir", str(Path(args.sentences_dir).resolve())]
        if args.as_new_version:
            cmd += ["--as-new-version"]
        if args.version_voice:
            cmd += ["--version-voice", args.version_voice]
    else:
        _require(not args.as_new_version,
                 "--as-new-version files a SECOND audiobook beside the project's; "
                 "--audiobook makes the project's own")
        _require(not args.version_voice,
                 "--version-voice names the voice a second version is called after; "
                 "it means nothing without --as-new-version")
        _require(bool(args.voice), "--voice <id> is required for --audiobook")
        cmd += ["--engine", args.engine, "--voice", args.voice]
        override = _higgs_override(args, door="audiobook")
        if override:
            cmd += ["--higgs-override", json.dumps(override, sort_keys=True)]
        if args.input:
            cmd += ["--input", str(Path(args.input).resolve())]
        if args.fresh:
            cmd += ["--fresh"]
        if args.skip_text_cleanup:
            cmd += ["--skip-text-cleanup"]
    if args.language:
        cmd += ["--language", args.language]
    if args.model_dir and not assemble_only:
        cmd += ["--model-dir", args.model_dir]
    if args.keep_session:
        cmd += ["--keep-session"]
    if args.de_ring:
        cmd += ["--de-ring"]
    # The ASSEMBLY-time gap (the pass in front of assembly re-lays the silence
    # between sentences). Deliberately NOT --sentence-gap, which is the gap the
    # WORKER bakes into each FLAC at render time via ORPHEUS_SENTENCE_GAP: two
    # different passes at two different times, and one flag for both would be a
    # value that means something different depending on which command read it.
    if args.assembly_gap is not None:
        cmd += ["--sentence-gap", str(args.assembly_gap)]

    # Final-audio denoise (BookForge's block-based roformer pass over the rendered
    # sentences — its own step since 2026-08-29, run between generation and assembly;
    # the adapter this argv drives makes the call). Default follows the engine:
    # Orpheus voices are trained on a deliberate
    # faint hiss bed the render reproduces, so denoise is ON for orpheus and OFF for
    # everything else. An explicit flag wins either way. Always pass exactly one flag
    # so the spawn line is self-documenting.
    _require(not (args.final_denoise and args.no_final_denoise),
             "--final-denoise and --no-final-denoise are mutually exclusive")
    _require(not (args.final_denoise and assemble_only and args.sentences_dir),
             "--final-denoise derives a NEW set from the session's raw cache; --sentences-dir "
             "names the set to assemble. Denoise first (--denoise --sentences-dir ...) and "
             "assemble the directory that pass writes.")
    if args.no_final_denoise:
        final_denoise = False
    elif args.final_denoise:
        final_denoise = True
    elif assemble_only and args.sentences_dir:
        # A SUPPLIED SET ANSWERS THE QUESTION. `--sentences-dir` names the audio
        # to assemble; this door derives nothing from the raw cache, so there is
        # no denoise to have run or not run and nothing to guess.
        final_denoise = False
    elif assemble_only:
        # NO DEFAULT ON THIS DOOR. Whether the denoise ran is a fact about the
        # CHAIN that produced the sentences being assembled — its own queue row in
        # the app since 2026-08-29 — not something to infer from an engine flag
        # that an assembly does not read. Inferring it would either re-derive an
        # hour of roformer nobody asked for or silently assemble the raw set.
        _require(False,
                 "--assemble needs --final-denoise or --no-final-denoise: whether the denoise "
                 "ran is a fact about the chain that produced these sentences, and this door "
                 "does not read the engine flag that --audiobook infers it from")
    else:
        final_denoise = (args.engine == "orpheus")
    cmd += ["--final-denoise"] if final_denoise else ["--no-final-denoise"]

    # Same env seams as --tts (the compiled pipeline reads these).
    env = os.environ.copy()
    if args.orpheus_install:
        env["EBOOK2AUDIOBOOK_PATH"] = args.orpheus_install
    if args.models_dir:
        env["BOOKFORGE_ORPHEUS_MODELS_DIR"] = args.models_dir
    if args.tier:
        env["ORPHEUS_MEMORY_TIER"] = args.tier
    if args.conda_env:
        env["WSL_ORPHEUS_CONDA_ENV"] = args.conda_env
    if args.sentence_gap is not None:
        env["ORPHEUS_SENTENCE_GAP"] = str(args.sentence_gap)
    # ORPHEUS_* IS ORPHEUS'S — see cmd_tts. On a Higgs render these ride
    # `higgsOverride` instead, and setting them would look honoured and not be.
    if args.engine == "orpheus":
        if args.max_chars:
            env["ORPHEUS_MAX_CHARS"] = str(args.max_chars)
        if args.temperature is not None:
            env["ORPHEUS_TEMPERATURE"] = str(args.temperature)
        if args.top_p is not None:
            env["ORPHEUS_TOP_P"] = str(args.top_p)
        if args.min_p is not None:
            env["ORPHEUS_MIN_P"] = str(args.min_p)
        if args.rep_penalty is not None:
            env["ORPHEUS_REP_PENALTY"] = str(args.rep_penalty)
    mlx_keys = [] if assemble_only else _mlx_tuning_env(args, env)
    # The denoise choice travels as config through startReassembly (argv above), never
    # via env. e2a still honors a FINAL_DENOISE env var as a dormant manual escape
    # hatch (its own afftdn pass) — scrub any inherited value so a shell export can't
    # stack that on top (the assembly spawn env is built from process.env).
    env.pop("FINAL_DENOISE", None)

    label = "assemble" if assemble_only else "audiobook"
    if args.dry_run:
        print(f"[bookforge-tts] DRY RUN — {label} "
              f"({'denoise + reassembly over the cache' if assemble_only else 'tts + reassembly'}), "
              "no GPU touched")
        print("  spawn:", " ".join(cmd))
        print("  higgs override:", json.dumps(override, sort_keys=True) if override else "(none)")
        overrides = {k: env[k] for k in (
            "EBOOK2AUDIOBOOK_PATH", "BOOKFORGE_ORPHEUS_MODELS_DIR", "ORPHEUS_MEMORY_TIER",
            "WSL_ORPHEUS_CONDA_ENV", "ORPHEUS_SENTENCE_GAP", "ORPHEUS_MAX_CHARS",
            "ORPHEUS_TEMPERATURE", "ORPHEUS_TOP_P", "ORPHEUS_MIN_P", "ORPHEUS_REP_PENALTY",
            *mlx_keys,
        ) if k in env}
        print("  env overrides:", overrides or "(none)")
        return 0

    # The adapter file is named for Orpheus, but --assemble resolves the engine
    # from the session; naming one here (as this line did) was a false claim.
    print(f"[bookforge-tts] {label}{'' if assemble_only else '/' + args.engine} ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=env)


def cmd_audiobook(args):
    """Build a FULL audiobook (M4B) through BookForge's REAL pipeline, headless.

    This is the app-faithful path: it chains the exact high-level calls the app's
    queue makes for a standard audiobook —
        1. renderRangeHeadless()  (parallel-tts-bridge) — the tts-conversion core
        1b. runFinalDenoise()     (denoise-job)         — the final-denoise step
        2. startReassembly()      (reassembly-bridge)   — the reassembly job
    — producing <project>/output/<Title>. <Author>.m4b with chapters, cover, and
    metadata. Unlike `--tts` (which flat-concats to a bare WAV for quick voice
    tests), this reproduces the shipped pipeline end to end. The input EPUB is
    the project's RECORDED book (manifest-service.bookForAct, the door every act
    in the app resolves through); override it with --input.
    """
    return _audiobook_spawn(args, assemble_only=False)


def cmd_assemble(args):
    """ASSEMBLE a project's already-rendered sentences into the M4B — no TTS.

    The app's "Assemble" over a cached session, headless: the SAME
    `denoise-job.runFinalDenoise` then `reassembly-bridge.startReassembly` the
    full build calls, over the project's cached sentence set
    (stages/03-tts/sessions). It is the door for reproducing an assembly defect
    without paying for a nine-hour render first — and, because the denoised set
    is durable, a second run over the same session reuses it and costs minutes.

    NOTE on coverage: narrator's assembly door takes a `--coverage_report`, and
    `reassembly-bridge` passes it whenever `narrator align` has left one beside
    the session. It is an AUDIT and never blocks (Owen, 2026-09-05): assembly
    logs every chunk whose audio did not say its text plus the retake command,
    and assembles the book. Run `--align` first if you want the measurement.
    """
    return _audiobook_spawn(args, assemble_only=True)


def cmd_prep(args):
    """Run the NARRATION DOOR on its own — captions and notes out, numbers as words.

    This is the step every queued audiobook already walks through
    (`prepareNarrationInput` in parallel-tts-bridge), exported so it can be run
    by itself: the caption/footnote cut, then the model pass that reads the
    printed digits as the words a narrator says. It writes a prepared copy and a
    `.edits.json` naming every proposed edit and its disposition, then stops.

    The copy is content-addressed by (input sha, rule version, model), so a later
    --tts or --audiobook on the SAME input finds it and reuses it with no second
    model call. Run one, read the record, then run the other.

    NOT --ai-cleanup, which is the OCR/model book-repair pass over an epub's prose
    (a different job, a different output). This one only decides what the narrator
    is handed.
    """
    _require(bool(args.project or args.input),
             "--prep needs --project <projectDir> or --input <file.epub|file.txt>")
    _require(not (args.project and args.input),
             "--prep: --project and --input both name what to prep; pass one")
    # Checked BEFORE the project is resolved: a flag that could never work on this
    # branch is wrong whether or not the path names a project.
    _require(not (args.project and args.library),
             "--prep --project derives the library from the project path "
             "(<library>/projects/<slug>); --library would name a different one")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(NARRATION_PREP.is_file(), f"missing adapter {NARRATION_PREP}")
    _require((REPO_ROOT / "dist" / "electron" / "parallel-tts-bridge.js").is_file(),
             "BookForge is not built — run `npx tsc -p tsconfig.electron.json` first "
             "(dist/electron/parallel-tts-bridge.js missing)")

    cmd = ["node", "--require", str(NODE_STUB), str(NARRATION_PREP)]
    if args.project:
        project_dir = str(Path(args.project).resolve())
        _require((Path(project_dir) / "manifest.json").is_file(),
                 f"not a BookForge project (no manifest.json): {project_dir}")
        cmd += ["--project", project_dir]
    else:
        # node runs with cwd=REPO_ROOT, so resolve the user's path against THEIR cwd.
        cmd += ["--input", str(Path(args.input).resolve())]
        # A loose file has no project to derive a library from, and the cut and the
        # normalized copy land under <library>/tmp/narration-cuts — where a later
        # app render looks for them. Same door as --tts: the flag wins, else the
        # root main recorded, else the adapter refuses by name.
        if args.library:
            cmd += ["--library", str(Path(args.library).expanduser().resolve())]

    if args.dry_run:
        print("[bookforge-tts] DRY RUN — narration prep (cut + numbers), no model loaded")
        print("  spawn:", " ".join(cmd))
        return 0

    if args.input:
        _require(Path(args.input).is_file(), f"input file not found: {args.input}")

    print("[bookforge-tts] narration prep ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=os.environ.copy())


def cmd_narration_text(args):
    """Run the NARRATION TEXT CLEANUP FAILSAFE on a book, replacing it in place.

    Owen, 2026-09-05: "the cleaning step can be done on an epub because the user
    might forget it should be done at all... it should replace the epub that's
    currently there if one already exists. if the user deletes the epub and
    re-exports, the cleaning job will be lost. that's the cost of doing it to an
    epub... the bookforge clean text action outside of foundry is a failsafe in
    case the user forgets and just wants to get it done immediately. it won't be
    treated as the standard method."

    The pass itself is the ENGINE's since 2026-09-05: this spawns
    `foundry clean-text --epub <book> --out <staging>` and lands the staging on
    the book with one rename. Three stages, in this order: punctuation
    canonicalization (the canonical ellipsis, the quote map, the invisibles),
    then the deterministic number rules, then the model on every block. It writes

        <book>.epub                  the same path, cleaned and STAMPED
        <stem>.narration-text.json   the engine's receipt

    and the STAMP is the point: it is what every consumer downstream reads to
    tell a cleaned book from an uncleaned one.

    THE STANDARD METHOD IS THE HOSTED STEP — Clean text in the Foundry window,
    where the cleanup is a position on the document chain and everything done
    after it carries it along. This door produces a FILE, and a re-export from
    the project loses it.

    NOT --prep, which is the render door (the caption/endnote cut and the copy a
    voice reads, made per render). This edits the book, once.
    """
    _require(bool(args.project or args.input),
             "--narration-text needs --project <projectDir> or --input <file.epub>")
    _require(not (args.project and args.input),
             "--narration-text: --project and --input both name what to clean; pass one")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(NARRATION_TEXT.is_file(), f"missing adapter {NARRATION_TEXT}")
    _require((REPO_ROOT / "dist" / "electron" / "narration-clean-text.js").is_file(),
             "BookForge is not built — run `npx tsc -p tsconfig.electron.json` first "
             "(dist/electron/narration-clean-text.js missing)")

    cmd = ["node", "--require", str(NODE_STUB), str(NARRATION_TEXT)]
    if args.project:
        project_dir = str(Path(args.project).resolve())
        _require((Path(project_dir) / "manifest.json").is_file(),
                 f"not a BookForge project (no manifest.json): {project_dir}")
        cmd += ["--project", project_dir]
    else:
        # node runs with cwd=REPO_ROOT, so resolve the user's path against THEIR cwd.
        cmd += ["--input", str(Path(args.input).resolve())]

    if args.dry_run:
        print("[bookforge-tts] DRY RUN — narration text cleanup, no model loaded")
        print("  spawn:", " ".join(cmd))
        return 0

    if args.input:
        _require(Path(args.input).is_file(), f"input file not found: {args.input}")

    print("[bookforge-tts] narration text cleanup ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=os.environ.copy())


def cmd_clean_lines(args):
    """A FILE OF LINES through the narration text cleanup, written back by position.

    One training transcript per line in, the same lines cleaned out, in ONE process:
    the model loads once, every line is asked at temperature 0, the model unloads
    at the end. Behind it is `foundry clean-text --book` - BookForge writes a book
    file with one block per line and spawns the same binary, model and endpoint the
    hosted Clean text press uses. A killed run keeps its records; the next run asks
    only about the lines with no answer. See cli/clean-lines-step.js.
    """
    _require(bool(args.input), "--clean-lines needs --input <lines.txt>")
    _require(bool(args.language), "--clean-lines needs --language <subtag> (e.g. en)")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(CLEAN_LINES.is_file(), f"missing adapter {CLEAN_LINES}")
    _require((REPO_ROOT / "dist" / "electron" / "narration-clean-text.js").is_file(),
             "BookForge is not built - run `npx tsc -p tsconfig.electron.json` first "
             "(dist/electron/narration-clean-text.js missing)")
    cmd = ["node", "--require", str(NODE_STUB), str(CLEAN_LINES),
           "--input", str(Path(args.input).resolve()), "--language", args.language]
    if args.output:
        cmd += ["--output", str(Path(args.output).resolve())]
    if args.keep_model:
        cmd += ["--keep-model"]

    if args.dry_run:
        print("[bookforge-tts] DRY RUN - clean lines, no model loaded")
        print("  spawn:", " ".join(cmd))
        return 0

    _require(Path(args.input).is_file(), f"input file not found: {args.input}")
    print("[bookforge-tts] clean lines ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=os.environ.copy())


def cmd_clean(args):
    """THE HOSTED FOUNDRY WINDOW'S **Clean text** PRESS, with no window.

    Not a second way of doing what the press does: the adapter calls the same
    compiled functions in the same order - `planCleanup` (workspace:plan-clean),
    the `CleanRequest` the dialog composes field for field, and `runJob`, the seam
    BookForge's own queue calls to run a Foundry job. So it lands the same ledger
    step, writes the same records and stamp, and can be timed.

    The model comes from app-settings `cleanTextModel` unless --model says
    otherwise, the endpoint from `ollamaUrl` unless --ollama does. --concurrency
    is the engine's `--concurrency` (blocks in flight; absent = the engine's own
    4) and changes the speed, never the text. The weights are RELEASED when the
    run ends - `--keep-model` is the opt-in for back-to-back runs.
    """
    _require(bool(args.project or args.foundry_project),
             "--clean needs --project <BookForge project dir> (or --foundry-project <dir>)")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(CLEAN_STEP.is_file(), f"missing adapter {CLEAN_STEP}")
    _require((REPO_ROOT / "dist" / "electron" / "manifest-service.js").is_file(),
             "BookForge is not built - run `npx tsc -p tsconfig.electron.json` first "
             "(dist/electron/manifest-service.js missing)")
    cmd = ["node", "--require", str(NODE_STUB), str(CLEAN_STEP)]
    if args.project:
        cmd += ["--project", str(Path(args.project).resolve())]
    if args.foundry_project:
        cmd += ["--foundry-project", str(Path(args.foundry_project).resolve())]
    if args.model:
        cmd += ["--model", args.model]
    if args.ollama:
        cmd += ["--ollama", args.ollama]
    if args.concurrency is not None:
        cmd += ["--concurrency", str(args.concurrency)]
    if args.keep_model:
        cmd += ["--keep-model"]
    if args.foundry_dist:
        cmd += ["--foundry-dist", str(Path(args.foundry_dist).resolve())]
    if args.dry_run:
        cmd += ["--dry-run"]
        print("[bookforge-tts] DRY RUN - clean text, no model loaded")

    print("[bookforge-tts] clean text ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=os.environ.copy())


def _run_ai(args, simplify):
    """Drive BookForge's REAL AI pipeline (aiBridge.cleanupEpub) headlessly — same
    chunking, prompts, num_ctx/think/keep_alive, safeguards, diff-cache + checkpoint as
    the app. Simplify is the same call with simplifyForChildren + a mode. The API key
    goes through the process env (BOOKFORGE_AI_API_KEY), never argv."""
    _require(bool(args.input), "--input <file.epub> is required for --ai-cleanup/--ai-simplify")
    _require(bool(args.provider), "--provider <claude|openai|ollama|local> is required")
    _require(args.provider in ("claude", "openai", "ollama", "local"),
             f"--provider '{args.provider}' invalid (claude|openai|ollama|local)")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(AI_CLEAN.is_file(), f"missing AI adapter {AI_CLEAN}")
    _require((REPO_ROOT / "dist" / "electron" / "ai-bridge.js").is_file(),
             "BookForge is not built — run `npx tsc -p tsconfig.electron.json` first "
             "(dist/electron/ai-bridge.js missing)")

    # API key for cloud providers: --api-key wins, else the conventional env var. The
    # electron code does NOT read these envs itself — the CLI sources the key and hands
    # it to the pipeline (as the app's renderer does).
    api_key = args.api_key
    if not api_key and args.provider == "claude":
        api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key and args.provider == "openai":
        api_key = os.environ.get("OPENAI_API_KEY")

    _require(not (args.test_chunks and not args.test_mode),
             "--test-chunks requires --test-mode")

    # Resolve relative paths against the USER'S cwd (node runs with cwd=REPO_ROOT).
    input_path = str(Path(args.input).resolve())
    cmd = ["node", "--require", str(NODE_STUB), str(AI_CLEAN),
           "--input", input_path, "--provider", args.provider]
    if args.model:
        cmd += ["--model", args.model]
    if args.output_dir:
        cmd += ["--output-dir", str(Path(args.output_dir).resolve())]
    if args.custom_instructions:
        cmd += ["--custom-instructions", args.custom_instructions]
    if args.detailed_cleanup:
        cmd += ["--detailed-cleanup"]
    if args.cleanup_prompt:
        cp = Path(args.cleanup_prompt).resolve()
        _require(cp.is_file(), f"--cleanup-prompt file not found: {args.cleanup_prompt}")
        cmd += ["--cleanup-prompt", str(cp)]
    # Which cleanup passes to run. Required for a plain cleanup — ai-clean.js refuses
    # without it rather than guessing whether the book came off a scanner.
    if args.stages:
        cmd += ["--stages", args.stages]
    elif not simplify and not args.cleanup_prompt and not args.detailed_cleanup:
        _require(False,
                 "--ai-cleanup needs --stages <ocr|tts|both>: ocr = the per-chunk "
                 "scanner-damage pass (writes repaired.epub and stops); tts = the "
                 "deterministic prep only (footnote markers, quotes, numbers -> "
                 "cleaned.epub, seconds); both = repair then prep")
    if args.chunk_size:
        cmd += ["--chunk-size", str(args.chunk_size)]
    if args.temperature is not None:  # 0.0 is valid (deterministic) — guard on None, not truthiness
        cmd += ["--temperature", str(args.temperature)]
    if args.ollama_url:
        cmd += ["--ollama-url", args.ollama_url]
    if args.no_parallel:
        cmd += ["--no-parallel"]
    elif args.parallel_workers:
        cmd += ["--parallel-workers", str(args.parallel_workers)]
    if args.test_mode:
        cmd += ["--test-mode"]
    if args.test_chunks:
        cmd += ["--test-chunks", str(args.test_chunks)]
    if simplify:
        _require(bool(args.simplify_mode),
                 "--simplify-mode <dejargon|destiffen|learner> is required for --ai-simplify")
        cmd += ["--simplify", "--mode", args.simplify_mode]
        if args.no_cleanup:
            cmd += ["--no-cleanup"]

    env = os.environ.copy()
    if api_key:
        env["BOOKFORGE_AI_API_KEY"] = api_key

    if args.dry_run:
        kind = "simplify" if simplify else "cleanup"
        print(f"[bookforge-tts] DRY RUN — ai {kind}, provider={args.provider}, no job run")
        print("  spawn:", " ".join(cmd))   # api key is in env, not argv
        print("  api key:", "set" if api_key else "(none — required for cloud; ok for ollama/local)")
        return 0

    # Real-run preconditions (a dry-run above skips these).
    _require(Path(args.input).is_file(), f"input epub not found: {args.input}")
    if args.provider in ("claude", "openai"):
        env_name = "ANTHROPIC_API_KEY" if args.provider == "claude" else "OPENAI_API_KEY"
        _require(bool(api_key), f"provider '{args.provider}' needs an API key (--api-key or {env_name})")
        _require(bool(args.model), f"provider '{args.provider}' needs --model (e.g. claude-sonnet-4-5 / gpt-4o)")

    print(f"[bookforge-tts] ai {'simplify' if simplify else 'cleanup'} ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=env)


def cmd_ai_cleanup(args):
    """OCR/formatting cleanup of an epub through the real ai-bridge pipeline."""
    return _run_ai(args, simplify=False)


def cmd_ai_simplify(args):
    """Simplify an epub (de-jargon / de-stiffen / learner) — cleanupEpub with
    simplifyForChildren + a mode. By default ALSO cleans (the app default); --no-cleanup
    makes it simplify-only."""
    return _run_ai(args, simplify=True)


def cmd_generate_sentences(args):
    """Audio -> sentence-level VTT through BookForge's real machinery.

    Default: WHISPER transcription (faster-whisper, the app's Generate-sentences path;
    words inferred from audio). With --epub: EPUB-ALIGN — the ebook text is ground
    truth and WhisperX forced alignment supplies only the timing (the app's
    'epub-align' method). The align bridge passes no device, so align_audiobook.py
    auto-selects it (CUDA -> MPS -> CPU); the wav2vec2 forced-align runs on that
    device, while the rough whisper transcribe pass is always CPU (ctranslate2 has
    no MPS/CUDA-torch backend here).
    """
    _require(bool(args.audio), "--audio <file> is required for --generate-sentences")
    _require(bool(args.out), "--out <file.vtt> is required for --generate-sentences")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(GEN_SENTENCES.is_file(), f"missing adapter {GEN_SENTENCES}")
    _require((REPO_ROOT / "dist" / "electron" / "transcribe-bridge.js").is_file(),
             "BookForge is not built — run `npx tsc -p tsconfig.electron.json` first")
    _require(not (args.whisper_model and args.epub),
             "--whisper-model applies to whisper mode only (epub-align's rough model is fixed)")
    _require(not (args.report is not None and not args.epub),
             "--report requires --epub (coverage compares the ebook against the audio)")
    _require(not (args.min_hole is not None and not args.epub),
             "--min-hole requires --epub (it tunes epub-vs-audio hole detection)")
    _require(not (args.min_hole is not None and args.min_hole < 0),
             f"--min-hole must be >= 0 (got {args.min_hole}); 0 = report every gap")
    _require(not (args.rough_cache is not None and not args.epub),
             "--rough-cache requires --epub (only epub-align has a rough transcribe pass to cache)")
    _require(not (args.align_workers is not None and not args.epub),
             "--align-workers requires --epub (it sizes the epub-align worker pool)")
    _require(not (args.align_workers is not None and args.align_workers < 1),
             f"--align-workers must be >= 1 (got {args.align_workers})")
    _require(not ((args.snap_silence is not None or args.no_snap_silence) and not args.epub),
             "--snap-silence/--no-snap-silence require --epub (whisper mode has no cue seams to snap)")
    _require(not (args.snap_silence is not None and args.no_snap_silence),
             "--snap-silence and --no-snap-silence are mutually exclusive")
    _require(not (args.snap_silence is not None and args.snap_silence < 0),
             f"--snap-silence must be >= 0 seconds (got {args.snap_silence}); 0 = off")
    _require(not (args.no_paragraph_split and not args.epub),
             "--no-paragraph-split requires --epub (it changes ebook segmentation)")
    _require(not (args.report_min_hole is not None and not args.epub),
             "--report-min-hole requires --epub")
    _require(not (args.report_min_hole is not None and args.report_min_hole < 0),
             f"--report-min-hole must be >= 0 (got {args.report_min_hole})")

    audio_path = str(Path(args.audio).resolve())
    out_path = str(Path(args.out).resolve())
    cmd = ["node", "--require", str(NODE_STUB), str(GEN_SENTENCES),
           "--audio", audio_path, "--out", out_path]
    if args.epub:
        cmd += ["--epub", str(Path(args.epub).resolve())]
    if args.report is not None:
        if args.report:
            report_path = str(Path(args.report).resolve())
        else:  # bare --report: derive <out minus .vtt>.coverage.json next to the VTT
            base = out_path[:-4] if out_path.lower().endswith(".vtt") else out_path
            report_path = base + ".coverage.json"
        cmd += ["--report", report_path]
    if args.min_hole is not None:
        cmd += ["--hole-min", str(args.min_hole)]
    if args.rough_cache is not None:
        if args.rough_cache:
            rough_cache_path = str(Path(args.rough_cache).resolve())
        else:  # bare --rough-cache: derive <out minus .vtt>.roughcache.json next to the VTT
            base = out_path[:-4] if out_path.lower().endswith(".vtt") else out_path
            rough_cache_path = base + ".roughcache.json"
        cmd += ["--rough-cache", rough_cache_path]
    if args.align_workers is not None:
        cmd += ["--align-workers", str(args.align_workers)]
    if args.no_snap_silence:
        cmd += ["--no-snap-silence"]
    elif args.snap_silence is not None:
        cmd += ["--snap-silence", str(args.snap_silence)]
    if args.no_paragraph_split:
        cmd += ["--no-paragraph-split"]
    if args.report_min_hole is not None:
        cmd += ["--report-hole-min", str(args.report_min_hole)]
    if args.whisper_model:
        cmd += ["--whisper-model", args.whisper_model]
    if args.language and args.language != "en":
        cmd += ["--language", args.language]
    if args.device:
        cmd += ["--device", args.device]
    if args.embed:
        cmd += ["--embed"]

    if args.dry_run:
        mode = "epub-align" if args.epub else "whisper"
        print(f"[bookforge-tts] DRY RUN — generate-sentences mode={mode}")
        print("  spawn:", " ".join(cmd))
        return 0

    _require(Path(audio_path).is_file(), f"audio file not found: {args.audio}")
    if args.epub:
        _require(Path(args.epub).resolve().is_file(), f"epub file not found: {args.epub}")
    _require(not (args.embed and not audio_path.lower().endswith(".m4b")),
             "--embed requires the audio to be an .m4b")

    mode = "epub-align" if args.epub else "whisper"
    print(f"[bookforge-tts] generate-sentences mode={mode} ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=os.environ.copy())


def cmd_generate_epub(args):
    """Read a project's PDF into its book — the app's Convert to EPUB, headless.

    Drives vlm-convert.runVlmConversion, which is the SAME function the app's
    `vlm:convert` IPC handler calls. So this gets all of it: the route resolution
    (a configured OpenAI-compatible server, MLX on Apple silicon, or this machine's
    GPU through the WSL vLLM reader from Settings -> Add-ons), the banked-readings
    decision and its foundry >= 0.9.0 gate, `foundry vlm-convert`, the staged EPUB
    moved onto source/<archive basename>.generated.epub, the manifest records
    (outputs.generatedEpub + a freshly minted working copy) and the vlm-convert
    provenance entry. Nothing about a converted project says it was done from here.

    WHICH MACHINE reads the pages: with no --vlm-endpoint this machine's own route
    is used, exactly as an unset Settings -> AI -> Reading pages means in the app
    (WSL on Windows, MLX on an Apple Silicon Mac). The endpoint setting lives in
    the renderer's settings bundle, which no headless process can read, so it is
    passed here the same way --ollama-url passes the AI provider's URL.
    """
    _require(bool(args.project), "--project <project dir> is required for --generate-epub")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(GENERATE_EPUB.is_file(), f"missing adapter {GENERATE_EPUB}")
    _require((REPO_ROOT / "dist" / "electron" / "vlm-convert.js").is_file(),
             "BookForge is not built — run `npx tsc -p tsconfig.electron.json` first "
             "(dist/electron/vlm-convert.js missing)")
    _require(Path(args.project).is_dir(), f"project directory not found: {args.project}")
    _require(not (args.source_pdf and args.variant_id),
             "--source-pdf and --variant-id both name the PDF to read; pass one")

    project_dir = str(Path(args.project).resolve())
    cmd = ["node", "--require", str(NODE_STUB), str(GENERATE_EPUB), "--project", project_dir]
    if args.readings:
        cmd += ["--readings", args.readings]
    if args.destination:
        cmd += ["--destination", args.destination]
    if args.variant_id:
        cmd += ["--variant-id", args.variant_id]
    if args.source_pdf:
        cmd += ["--source-pdf", str(Path(args.source_pdf).resolve())]
    if args.skip_deleted_pages:
        cmd += ["--skip-deleted-pages"]
    if args.vlm_endpoint:
        cmd += ["--vlm-endpoint", args.vlm_endpoint]
    if args.vlm_endpoint_model:
        cmd += ["--vlm-endpoint-model", args.vlm_endpoint_model]
    if args.vlm_concurrency is not None:
        cmd += ["--vlm-concurrency", str(args.vlm_concurrency)]
    if args.dry_run:
        cmd += ["--dry-run"]

    print("[bookforge-tts] generate-epub ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=os.environ.copy())


def cmd_rvc(args):
    """Clean/convert a WHOLE audio file through an RVC voice model — memory-safe.

    Drives rvc-bridge.convertFileRvcChunked: silence-chunks the file, converts each
    chunk in a RECYCLED worker process (each exits between batches so unified memory
    is reclaimed — a full audiobook never balloons into swap the way one long
    convert-dir does), then stitches the chunks back. Primary use is same-voice
    reconstruction (index 0): background/scratchiness removed, re-rendered at 48 kHz.
    """
    _require(bool(args.input), "--input <audio> is required for --rvc")
    _require(bool(args.out), "--out <file> is required for --rvc")
    _require(bool(args.rvc_model), "--rvc-model <folder> is required for --rvc "
             "(the voice-model folder name, e.g. deathstalker_rvc_v1)")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(RVC_CONVERT.is_file(), f"missing adapter {RVC_CONVERT}")
    _require((REPO_ROOT / "dist" / "electron" / "rvc-bridge.js").is_file(),
             "BookForge is not built — run `npx tsc -p tsconfig.electron.json` first "
             "(dist/electron/rvc-bridge.js missing)")

    # node runs with cwd=REPO_ROOT, so resolve user paths against their cwd first.
    input_path = str(Path(args.input).resolve())
    out_path = str(Path(args.out).resolve())
    cmd = ["node", "--require", str(NODE_STUB), str(RVC_CONVERT),
           "--input", input_path, "--out", out_path, "--model", args.rvc_model,
           "--index-rate", str(args.index_rate), "--protect-rate", str(args.protect_rate),
           "--f0-method", args.f0_method, "--chunk-seconds", str(args.chunk_seconds),
           "--batch-size", str(args.batch_size)]

    if args.dry_run:
        print("[bookforge-tts] DRY RUN — rvc (silence-chunk -> recycled convert -> stitch), no GPU touched")
        print("  spawn:", " ".join(cmd))
        return 0

    _require(Path(input_path).is_file(), f"input audio not found: {args.input}")
    print("[bookforge-tts] rvc ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=os.environ.copy())


def _session_target_argv(args, flag_owner):
    """`--project` or `--process-dir`, for the two enhancement passes. One of them
    is required and both together are refused, exactly as the adapter refuses
    them — stated here too so the error arrives before node is spawned."""
    _require(bool(args.project) or bool(args.process_dir),
             f"{flag_owner} needs --project <projectDir> or --process-dir <dir>")
    _require(not (args.project and args.process_dir),
             f"{flag_owner}: --project and --process-dir both name the session; pass one")
    if args.project:
        project_dir = str(Path(args.project).resolve())
        _require((Path(project_dir) / "manifest.json").is_file(),
                 f"not a BookForge project (no manifest.json): {project_dir}")
        return ["--project", project_dir]
    return ["--process-dir", str(Path(args.process_dir).resolve())]


def cmd_denoise(args):
    """Run the FINAL-DENOISE step on a rendered session — its own row in the app.

    Drives `denoise-job.runFinalDenoise`, the one function
    `electron/queue-steps/final-denoise.ts` calls, with the null window the queue
    itself passes headlessly. Gap-normalize the raw cached sentences, then the
    block-based roformer, into the session's DURABLE
    chapters/sentences-denoised/. A second run over the same session reuses that
    set and says so.

    `--sentences-dir` is the denoise reading ANOTHER pass's output ("convert
    first, then denoise"); the job refuses it alongside --sentence-gap rather
    than ignoring one, because the gap can only be applied to raw audio.
    """
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(FINAL_DENOISE.is_file(), f"missing adapter {FINAL_DENOISE}")
    _require((REPO_ROOT / "dist" / "electron" / "denoise-job.js").is_file(),
             "BookForge is not built — run `npx tsc -p tsconfig.electron.json` first "
             "(dist/electron/denoise-job.js missing)")

    cmd = ["node", "--require", str(NODE_STUB), str(FINAL_DENOISE)]
    cmd += _session_target_argv(args, "--denoise")
    if args.sentences_dir:
        cmd += ["--sentences-dir", str(Path(args.sentences_dir).resolve())]
    if args.sentence_gap is not None:
        cmd += ["--sentence-gap", str(args.sentence_gap)]

    if args.dry_run:
        print("[bookforge-tts] DRY RUN — final denoise (gap + roformer), no GPU touched")
        print("  spawn:", " ".join(cmd))
        return 0

    print("[bookforge-tts] final denoise ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=os.environ.copy())


def cmd_align(args):
    """Run the ALIGN step over a rendered session — the coverage guard's own row.

    Drives `coverage-align-job.runCoverageAlign`, the one function
    `electron/queue-steps/align.ts` calls. It force-aligns each rendered chunk and
    writes `<processDir>/coverage.json`, which is where BOTH assembly spawns look
    for it — so an alignment run from here satisfies an assembly run from
    anywhere. For an engine whose coverage policy is ENFORCED (higgs-v3),
    assembly refuses the book outright without it.

    The spawn lives in the compiled job (buildNarratorSpawn + the whisperx-env
    interpreter); nothing about `narrator align`'s command line is rebuilt here.

    `--align-language` is separate from `--language`, and required, for the
    reason the app's step states: the aligner loads a per-language wav2vec2
    checkpoint, and one pointed at the wrong language scores every word badly —
    which the guard reads as "the audio did not say the text" and uses to refuse
    a book that was read correctly. `--language` carries a render default; this
    one must not.
    """
    _require(bool(args.align_language),
             "--align-language <code> is required for --align: the aligner loads a different "
             "acoustic model for each language, and a guess would refuse a book that was read "
             "correctly. (--language carries a render default; this one deliberately does not.)")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(COVERAGE_ALIGN.is_file(), f"missing adapter {COVERAGE_ALIGN}")
    _require((REPO_ROOT / "dist" / "electron" / "coverage-align-job.js").is_file(),
             "BookForge is not built — run `npx tsc -p tsconfig.electron.json` first "
             "(dist/electron/coverage-align-job.js missing)")

    cmd = ["node", "--require", str(NODE_STUB), str(COVERAGE_ALIGN),
           "--language", args.align_language]
    cmd += _session_target_argv(args, "--align")

    if args.dry_run:
        print("[bookforge-tts] DRY RUN — coverage align (forced alignment per chunk), CPU only")
        print("  spawn:", " ".join(cmd))
        return 0

    print("[bookforge-tts] coverage align ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=os.environ.copy())


def cmd_rvc_enhance(args):
    """Run the RVC-ENHANCEMENT step over a session's PER-SENTENCE cache.

    Drives `rvc-job.runRvcEnhancement`, the one function
    `electron/queue-steps/rvc-enhancement.ts` calls. It writes a durable derived
    sentence set that assembly then reads via `--sentences_dir`.

    NOT --rvc, which is `rvc-bridge.convertFileRvcChunked` over ONE FINISHED
    AUDIO FILE (the memory-safe whole-book reconstruction). Two different jobs
    with two different outputs; both are named rather than one standing in for
    the other.
    """
    _require(bool(args.rvc_voice_id), "--rvc-voice-id <asset id> is required for --rvc-enhance")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(RVC_ENHANCE.is_file(), f"missing adapter {RVC_ENHANCE}")
    _require((REPO_ROOT / "dist" / "electron" / "rvc-job.js").is_file(),
             "BookForge is not built — run `npx tsc -p tsconfig.electron.json` first "
             "(dist/electron/rvc-job.js missing)")

    cmd = ["node", "--require", str(NODE_STUB), str(RVC_ENHANCE),
           "--voice-id", args.rvc_voice_id]
    cmd += _session_target_argv(args, "--rvc-enhance")
    # These four are left ABSENT when unset so urvc's own defaults apply — which
    # is what the app's step does. `--index-rate`/`--protect-rate` carry argparse
    # defaults for the whole-file --rvc command, so this reads the enhance-only
    # spellings instead of inheriting a value the user never chose.
    if args.enhance_index_rate is not None:
        cmd += ["--index-rate", str(args.enhance_index_rate)]
    if args.enhance_protect_rate is not None:
        cmd += ["--protect-rate", str(args.enhance_protect_rate)]
    if args.n_semitones is not None:
        cmd += ["--n-semitones", str(args.n_semitones)]
    if args.hop_length is not None:
        cmd += ["--hop-length", str(args.hop_length)]
    if args.enhance_f0_method:
        cmd += ["--f0-method", args.enhance_f0_method]
    if args.sentences_dir:
        cmd += ["--sentences-dir", str(Path(args.sentences_dir).resolve())]
    if args.sentence_gap is not None:
        cmd += ["--sentence-gap", str(args.sentence_gap)]

    if args.dry_run:
        print("[bookforge-tts] DRY RUN — rvc enhancement over a session's sentences, no GPU touched")
        print("  spawn:", " ".join(cmd))
        return 0

    print("[bookforge-tts] rvc enhancement ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=os.environ.copy())


def cmd_retake(args):
    """CORRECT SENTENCES — list, retake, approve, revert, headless.

    The app's Correct Sentences panel is five exported functions in
    `correct-sentences-bridge` behind five IPC handlers; this drives the same
    five. `--retake-action` picks one:

        list     what the cache holds, cue by cue (getCorrectSentencesSession)
        retake   render fresh takes for --indices        (generateCandidates)
        commit   approve one take by path                (commitSentence)
        revert   restore the original from .orig-backup/ (revertSentence)
        cleanup  drop the candidate scratch              (cleanupCandidates)
    """
    _require(bool(args.project), "--project <projectDir> is required for --retake")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(CORRECT_SENTENCES.is_file(), f"missing adapter {CORRECT_SENTENCES}")
    _require((REPO_ROOT / "dist" / "electron" / "correct-sentences-bridge.js").is_file(),
             "BookForge is not built — run `npx tsc -p tsconfig.electron.json` first "
             "(dist/electron/correct-sentences-bridge.js missing)")
    project_dir = str(Path(args.project).resolve())
    _require((Path(project_dir) / "manifest.json").is_file(),
             f"not a BookForge project (no manifest.json): {project_dir}")

    action = args.retake_action
    cmd = ["node", "--require", str(NODE_STUB), str(CORRECT_SENTENCES),
           "--project", project_dir, f"--{action}"]
    if action == "retake":
        _require(bool(args.indices), "--retake-action retake needs --indices <n[,n...]>")
        cmd += ["--indices", args.indices]
        if args.takes is not None:
            cmd += ["--takes", str(args.takes)]
        if args.sentence_text:
            cmd += ["--text", args.sentence_text]
    elif action in ("commit", "revert"):
        _require(args.index is not None, f"--retake-action {action} needs --index <n>")
        cmd += ["--index", str(args.index)]
        if action == "commit":
            _require(bool(args.take), "--retake-action commit needs --take <path to the .flac>")
            cmd += ["--take", str(Path(args.take).resolve())]
            if args.sentence_text:
                cmd += ["--text", args.sentence_text]
    elif action == "list":
        if args.index is not None:
            cmd += ["--from", str(args.index)]
        if args.count is not None:
            cmd += ["--count", str(args.count)]

    if args.dry_run:
        print(f"[bookforge-tts] DRY RUN — correct-sentences {action}, no GPU touched")
        print("  spawn:", " ".join(cmd))
        return 0

    print(f"[bookforge-tts] correct-sentences {action} ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=os.environ.copy())


def cmd_pass(args):
    """Run ONE of the app's PROCESSING PASSES on a project: simplify, translate,
    footnote-refs.

    These are queue rows in the app, and every one is `queue-steps/pass.ts`
    calling `processing-passes.runProcessingPass` over a config
    `processing-chain.planProcessingChain` laid out. This drives that pair, so
    the run stages, records its ledger row and promotes a working copy exactly as
    the button does.

    NOT --ai-cleanup/--ai-simplify, which are `ai-bridge.cleanupEpub` over a
    LOOSE epub (file in, file out, no project record). NOT Foundry's "Clean
    text", which is ordered inside the hosted Foundry window — see
    docs/CLI_PARITY_AUDIT.md. narration-text is the fourth kind and has its own
    command, --narration-text.
    """
    _require(bool(args.project), "--project <projectDir> is required for --pass")
    _require(args.kind in ("simplify", "translate", "footnote-refs"),
             "--kind must be simplify|translate|footnote-refs "
             "(narration-text has its own command: --narration-text)")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(PASS_ADAPTER.is_file(), f"missing adapter {PASS_ADAPTER}")
    for js in ("processing-chain.js", "processing-passes.js"):
        _require((REPO_ROOT / "dist" / "electron" / js).is_file(),
                 f"BookForge is not built — run `npx tsc -p tsconfig.electron.json` first "
                 f"(dist/electron/{js} missing)")
    project_dir = str(Path(args.project).resolve())
    _require((Path(project_dir) / "manifest.json").is_file(),
             f"not a BookForge project (no manifest.json): {project_dir}")

    cmd = ["node", "--require", str(NODE_STUB), str(PASS_ADAPTER),
           "--project", project_dir, "--kind", args.kind]
    if args.family:
        cmd += ["--family", args.family]

    api_key = args.api_key
    if args.kind in ("simplify", "translate"):
        _require(bool(args.provider), f"--kind {args.kind} needs --provider")
        _require(bool(args.model), f"--kind {args.kind} needs --model")
        cmd += ["--provider", args.provider, "--model", args.model]
        if args.ollama_url:
            cmd += ["--ollama-url", args.ollama_url]
        if args.custom_instructions:
            cmd += ["--custom-instructions", args.custom_instructions]
        if not api_key and args.provider == "claude":
            api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key and args.provider == "openai":
            api_key = os.environ.get("OPENAI_API_KEY")
    if args.kind == "simplify":
        _require(bool(args.simplify_mode),
                 "--kind simplify needs --simplify-mode <dejargon|destiffen|learner>")
        cmd += ["--mode", args.simplify_mode]
        if args.test_mode:
            cmd += ["--test-mode"]
            if args.test_chunks:
                cmd += ["--test-chunks", str(args.test_chunks)]
    if args.kind == "translate":
        _require(bool(args.source_lang), "--kind translate needs --source-lang <code>")
        _require(bool(args.target_lang), "--kind translate needs --target-lang <code>")
        cmd += ["--source-lang", args.source_lang, "--target-lang", args.target_lang]
        if args.translation_prompt:
            tp = Path(args.translation_prompt).resolve()
            _require(tp.is_file(), f"--translation-prompt file not found: {args.translation_prompt}")
            cmd += ["--translation-prompt", str(tp)]

    # The key goes through the process env, never argv — same rule as --ai-cleanup.
    env = os.environ.copy()
    if api_key:
        env["BOOKFORGE_AI_API_KEY"] = api_key

    if args.dry_run:
        print(f"[bookforge-tts] DRY RUN — {args.kind} pass, no job run")
        print("  spawn:", " ".join(cmd))
        # footnote-refs calls no model at all, so an api-key line there would be
        # a fact about a thing this pass does not have.
        if args.kind in ("simplify", "translate"):
            print("  api key:", "set" if api_key
                  else "(none — required for cloud; ok for ollama/local)")
        return 0

    if args.kind in ("simplify", "translate") and args.provider in ("claude", "openai"):
        env_name = "ANTHROPIC_API_KEY" if args.provider == "claude" else "OPENAI_API_KEY"
        _require(bool(api_key),
                 f"provider '{args.provider}' needs an API key (--api-key or {env_name})")

    print(f"[bookforge-tts] {args.kind} pass ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=env)


# Command registry — one entry per job. Flags are generated from the keys, so adding a
# command is a single line here plus its cmd_* handler.
COMMANDS = {
    "tts": cmd_tts,
    "audiobook": cmd_audiobook,
    # The assembly on its own — the app's "Assemble" over a cached session. Same
    # adapter as --audiobook, with --assemble-only, so there is one code path.
    "assemble": cmd_assemble,
    # The coverage guard's own row, between render and assembly.
    "align": cmd_align,
    # The two enhancement passes the app runs as their own queue rows between
    # generation and assembly.
    "denoise": cmd_denoise,
    "rvc-enhance": cmd_rvc_enhance,
    # Correct Sentences: list / retake / commit / revert / cleanup.
    "retake": cmd_retake,
    # The project processing passes: simplify, translate, footnote-refs.
    "pass": cmd_pass,
    # The narration door on its own. Distinct from --ai-cleanup below: that is the
    # OCR/model book-repair pass, this is what the narrator is handed.
    "prep": cmd_prep,
    # The persisted text cleanup, on the document chain. --tts and --audiobook
    # run it themselves when a book has not been through it; this is the door for
    # running it deliberately, on its own.
    "narration-text": cmd_narration_text,
    # A corpus of lines through the same cleanup, by position (cli/clean-lines.js).
    "clean-lines": cmd_clean_lines,
    # The hosted Foundry window's Clean text press, headless (cli/clean-step.js).
    "clean": cmd_clean,
    "ai-cleanup": cmd_ai_cleanup,
    "ai-simplify": cmd_ai_simplify,
    "generate-sentences": cmd_generate_sentences,
    "generate-epub": cmd_generate_epub,
    "rvc": cmd_rvc,
}

# ─────────────────────────────────────────────────────────────────────────────
# WHO READS WHICH FLAG — the data the help is GENERATED from (2026-09-12)
# ─────────────────────────────────────────────────────────────────────────────
#
# Owen, 2026-09-12: *"ideally the bookforge cli would make it pretty
# straightforward how to use it by its flags and such."* Until this pass `--help`
# was 529 lines of ONE flat usage line mixing 17 command selectors with ~130
# option flags. Every flag's own help text was good; nothing said which command
# could read it, so the only way to learn that a `--voice` means nothing to
# `--assemble` was to run it and read the refusal.
#
# So ownership is DATA, and `--<command> --help` is rendered from it plus the
# SAME add_argument calls the real parser is built from (see _FlagRegistry). A
# second parser written by hand for that view would drift, and a help page that
# names a flag the parser does not have is worse than no help page.
#
#   reads     — what this command's cmd_* function, and the helpers it calls
#               (_audiobook_spawn, _higgs_override, _mlx_tuning_env,
#               _session_target_argv, _run_ai), puts on the adapter's argv or into
#               the spawn env. Derived from the code, not from intent.
#   refuses   — the flags it fails on BY NAME, each with the reason it gives.
#               Conditional refusals state the condition ("on --engine higgs:").
#   doc       — which app door this drives, from the cmd_* docstring.
#   usage     — the one line a reader copies.
#   examples  — every one of them dry-run first; an example a dry run refuses is
#               a bug in the example.
#
# A flag in NEITHER list is accepted and decides nothing. Three exist, and they
# are named in cli/README.md rather than quietly removed: --voice-token (never
# reaches an adapter on the render door), --family on --narration-text (read only
# by --pass), and the ORPHEUS_* env seams on --assemble (which renders nothing).
COMMAND_FLAGS = {
    "tts": {
        "usage": "bookforge-tts --tts --voice ID (--input FILE | --text STR) --out FILE [options]",
        "doc": """Render a book, a passage, or bare test chunks to a WAV — the app's own render path.

--mode tts (default) is the AUDIOBOOK/BATCH path: parallel-tts-bridge ->
renderRangeHeadless -> the prep packs the chunks -> the worker. --mode streaming is
the LISTEN path: the app's real tts-api-server driven over the protocol in
docs/TTS_API.md, so the run goes through handleSpeak, splitForTts and the pool's
batch ladder exactly as pressing play does.

The narration prep runs first, automatically (see --prep). The per-sentence FLACs
are flat-concatenated into a BARE WAV — no chapters, cover or metadata; for the
book the app ships, use --audiobook.""",
        "reads": [
            "--config", "--dry-run", "--engine", "--mode", "--voice", "--input", "--text",
            "--out", "--title", "--library", "--language", "--model-dir", "--checkpoint-dir",
            "--note", "--models-dir", "--tier", "--sentence-gap", "--temperature", "--top-p",
            "--min-p", "--top-k", "--rep-penalty", "--safe-band", "--max-chars",
            "--batch-width", "--mem-budget-gb", "--as-chunks", "--max-chunks",
            "--keep-sentences", "--keep-session", "--read-ahead", "--skip-text-cleanup",
            "--orpheus-install", "--conda-env",
        ],
        "refuses": [
            ("--model-dir", "on --engine higgs: a Higgs checkpoint is --checkpoint-dir"),
            ("--checkpoint-dir", "orpheus names --model-dir; streaming has no per-request seam"),
            ("--top-k", "on --engine orpheus: its worker has no top_k seam"),
            ("--min-p", "on --engine higgs: narrator's v3 engines have no min_p knob"),
            ("--rep-penalty", "on --engine higgs: no repetition-penalty knob"),
            ("--safe-band", "orpheus packs to --max-chars; streaming packs to the voice's cap"),
            ("--batch-width", "orpheus sizes its batch from --tier; Windows uses HIGGS_MAX_NUM_SEQS"),
            ("--mem-budget-gb", "same as --batch-width: Higgs on the Mac only"),
            ("--as-chunks", "with an .epub the app's packer chunks it; a stream block is a paragraph"),
            ("--max-chunks", "in --mode streaming: bound the blocks with --read-ahead"),
            ("--title", "in --mode streaming: it names a packed book, and streaming packs nothing"),
            ("--library", "in --mode streaming: no session and no narration cut is written"),
            ("--language", "in --mode streaming: only 'en' (that path packs and preps nothing)"),
            ("--voice-token", "streaming binds a voice by id; in tts mode it reaches NO adapter"),
        ],
        "examples": [
            'bookforge-tts --tts --voice zac --input book.epub --out sample.wav',
            '# one chunk per line, narrated as printed, capped at the first 20:\n'
            'bookforge-tts --tts --engine higgs --voice mistborn --input chunks.jsonl \\\n'
            '    --as-chunks --max-chunks 20 --out chunks.wav',
            '# a checkpoint under test, on the MAC (MLX reads it here, so the path must exist here):\n'
            'bookforge-tts --tts --engine higgs --voice mistborn --input chunks.jsonl --as-chunks \\\n'
            '    --out mb440.wav --checkpoint-dir \\\n'
            '    "$HOME/Library/Application Support/BookForge/runtime/higgs-models/mb_v7_440_prod"',
            '# the same on the PC: the reading happens in the WSL guest, so the path is\n'
            '# GUEST-native and is NOT stat\'d here:\n'
            'bookforge-tts --tts --engine higgs --voice mistborn --input chunks.jsonl --as-chunks \\\n'
            '    --out mb616.wav --checkpoint-dir /home/telltale/higgs_v3_merged/mb_v7_616',
            '# the Listen path, reading only two blocks ahead:\n'
            'bookforge-tts --tts --mode streaming --voice deathstalker --input article.txt \\\n'
            '    --out listen.wav --read-ahead 2',
        ],
    },
    "audiobook": {
        "usage": "bookforge-tts --audiobook --project DIR --voice ID [options]",
        "doc": """Build the FULL audiobook (M4B) the app ships, headless.

It chains the exact high-level calls the app's queue makes: prepareNarrationInput
(the narration door), renderRangeHeadless (the tts-conversion core),
runFinalDenoise when the denoise is on, then startReassembly — producing
<project>/output/<Title>. <Author>.m4b with chapters, cover and metadata, and
registering it in the manifest.

The input EPUB is the project's RECORDED book (manifest-service.bookForAct, the
door every act in the app resolves through); --input overrides it. Output lands in
its canonical project location, so there is no --out. It RESUMES by default —
--fresh re-renders from scratch.""",
        "reads": [
            "--config", "--dry-run", "--project", "--engine", "--voice", "--input",
            "--language", "--model-dir", "--checkpoint-dir", "--note", "--models-dir",
            "--tier", "--sentence-gap", "--temperature", "--top-p", "--min-p", "--top-k",
            "--rep-penalty", "--safe-band", "--max-chars", "--batch-width", "--mem-budget-gb",
            "--fresh", "--skip-text-cleanup", "--keep-session", "--de-ring", "--assembly-gap",
            "--final-denoise", "--no-final-denoise", "--orpheus-install", "--conda-env",
        ],
        "refuses": [
            ("--max-chunks", "a capped book is not an audiobook: it would be filed in the "
                             "project's own output/ as THE audiobook, with chapters and metadata "
                             "claiming to be the whole thing. Use --tts --max-chunks N"),
            ("--as-chunks", "that renders each paragraph of a TEXT input as one chunk; this door "
                            "narrates the project's recorded book"),
            ("--title", "the project's own title names the book"),
            ("--library", "the project decides its library: <library>/projects/<slug>"),
            ("--as-new-version", "that files a SECOND audiobook beside the project's; "
                                 "--audiobook makes the project's own"),
            ("--version-voice", "it means nothing without --as-new-version"),
            ("--model-dir", "on --engine higgs: name the checkpoint under test with --checkpoint-dir"),
            ("--checkpoint-dir", "on --engine orpheus: name the model directory with --model-dir"),
            ("--top-k", "on --engine orpheus: its worker has no top_k seam"),
            ("--min-p", "on --engine higgs: no min_p knob"),
            ("--rep-penalty", "on --engine higgs: no repetition-penalty knob"),
            ("--safe-band", "on --engine orpheus: it packs to --max-chars"),
            ("--batch-width", "Higgs on the Mac only (on Windows the width is the server's "
                              "admission width, HIGGS_MAX_NUM_SEQS)"),
            ("--mem-budget-gb", "Higgs on the Mac only, as above"),
        ],
        "examples": [
            'bookforge-tts --audiobook --project "<library>/projects/<slug>" --voice deathstalker',
            'bookforge-tts --audiobook --project "<library>/projects/<slug>" --engine higgs \\\n'
            '    --voice mistborn --de-ring --assembly-gap 0.7',
            '# MAC: a checkpoint under test, as a whole book\n'
            'bookforge-tts --audiobook --project "<library>/projects/<slug>" --engine higgs \\\n'
            '    --voice mistborn --checkpoint-dir \\\n'
            '    "$HOME/Library/Application Support/BookForge/runtime/higgs-models/mb_v7_440_prod"',
            '# PC: the same checkpoint, guest-native path\n'
            'bookforge-tts --audiobook --project "<library>/projects/<slug>" --engine higgs \\\n'
            '    --voice mistborn --checkpoint-dir /home/telltale/higgs_v3_merged/mb_v7_616',
            '# ignore the cached session and re-render from scratch, tier forced:\n'
            'bookforge-tts --audiobook --project "<library>/projects/<slug>" --voice deathstalker \\\n'
            '    --fresh --tier light --dry-run',
        ],
    },
    "assemble": {
        "usage": "bookforge-tts --assemble --project DIR (--final-denoise | --no-final-denoise) [options]",
        "doc": """Assemble a project's ALREADY-RENDERED sentences into the M4B — no TTS.

The app's Assemble over a cached session: the same denoise-job.runFinalDenoise
then reassembly-bridge.startReassembly the full build calls, over the project's
cached set in stages/03-tts/sessions/. It is the SAME adapter as --audiobook run
with --assemble-only; there is no second assembly implementation.

--final-denoise or --no-final-denoise is REQUIRED. Whether the denoise ran is a
fact about the CHAIN that produced these sentences — its own queue row in the app
— and this door reads no engine flag to infer it from. The engine comes from the
session's own session-state.json.""",
        "reads": [
            "--config", "--dry-run", "--project", "--sentences-dir", "--as-new-version",
            "--version-voice", "--final-denoise", "--no-final-denoise", "--de-ring",
            "--assembly-gap", "--keep-session", "--language",
        ],
        "refuses": [
            ("--voice", "the voice was decided when the sentences were rendered"),
            ("--input", "--assemble reads no book: --input names the EPUB a RENDER would read"),
            ("--fresh", "a render choice; --assemble renders nothing"),
            ("--skip-text-cleanup", "a narration choice; --assemble narrates nothing"),
            ("--checkpoint-dir", "a render choice; the cached audio is already rendered"),
            ("--safe-band", "a render choice, as above"),
            ("--top-k", "a render choice, as above"),
            ("--batch-width", "a render choice, as above"),
            ("--mem-budget-gb", "a render choice, as above"),
            ("--max-chunks", "generation is already done"),
            ("--as-chunks", "generation is already done"),
            ("--title", "the project's own title names the book"),
            ("--library", "the project decides its library"),
            ("--final-denoise", "alongside --sentences-dir: the denoise DERIVES a new set from "
                                "the raw cache, while --sentences-dir names the set to assemble. "
                                "Denoise first, then assemble the directory that pass wrote"),
        ],
        "examples": [
            'bookforge-tts --assemble --project "<library>/projects/<slug>" --final-denoise',
            'bookforge-tts --assemble --project "<library>/projects/<slug>" --no-final-denoise \\\n'
            '    --de-ring --assembly-gap 0.7',
            '# file an enhancement pass\'s output BESIDE the project\'s audiobook:\n'
            'bookforge-tts --assemble --project "<library>/projects/<slug>" --as-new-version \\\n'
            '    --sentences-dir "<session>/chapters/sentences-rvc-rvc-voice-sigma"',
            'bookforge-tts --assemble --project "<library>/projects/<slug>" --no-final-denoise --dry-run',
        ],
    },
    "align": {
        "usage": "bookforge-tts --align (--project DIR | --process-dir DIR) --align-language CODE",
        "doc": """Force-align a rendered session and write its coverage report.

Drives coverage-align-job.runCoverageAlign — the one function
electron/queue-steps/align.ts calls. Every rendered chunk is force-aligned and
<processDir>/coverage.json is written: text with no aligned audio is a truncation,
audio with no text an insertion. It audits the WHOLE book, always writes both
outputs, and exits 0 whenever the run happened.

Since 2026-09-08 this is the ONLY door that queues an align row — the app's
narration run no longer composes one. The report lands where coverageReportPath()
says, which is where both assembly spawns look, so an align from here satisfies an
assembly from anywhere: run --align, then --assemble, with no extra flag.

--align-language is required and deliberately separate from --language (which
carries a render default of en): the aligner loads a per-language wav2vec2
checkpoint, and one pointed at the wrong language scores every word badly — which
the guard reads as "the audio did not say the text".""",
        "reads": ["--config", "--dry-run", "--project", "--process-dir", "--align-language"],
        "refuses": [],
        "examples": [
            'bookforge-tts --align --project "<library>/projects/<slug>" --align-language en',
            'bookforge-tts --align --process-dir "<session>" --align-language de',
            'bookforge-tts --align --project "<library>/projects/<slug>" --align-language en --dry-run',
        ],
    },
    "denoise": {
        "usage": "bookforge-tts --denoise (--project DIR | --process-dir DIR) [options]",
        "doc": """Run the FINAL-DENOISE step over a rendered session — its own row in the app.

Drives denoise-job.runFinalDenoise, the one function
electron/queue-steps/final-denoise.ts calls, with the null window the queue passes
headlessly: gap-normalize the raw cached sentences, then the block roformer, into
the session's DURABLE chapters/sentences-denoised/. A second run over the same
session reuses that set and says so.

--sentences-dir is this pass reading ANOTHER pass's output ("convert first, then
denoise"). The job refuses it alongside --sentence-gap rather than ignoring one of
them: a gap can only be applied to raw audio, so a call stating both is a
composition bug.""",
        "reads": ["--config", "--dry-run", "--project", "--process-dir", "--sentences-dir",
                  "--sentence-gap"],
        "refuses": [],
        "examples": [
            'bookforge-tts --denoise --project "<library>/projects/<slug>"',
            'bookforge-tts --denoise --project "<library>/projects/<slug>" --sentence-gap 0.6',
            '# denoise what the RVC pass wrote, instead of the raw cache:\n'
            'bookforge-tts --denoise --process-dir "<session>" \\\n'
            '    --sentences-dir "<session>/chapters/sentences-rvc-rvc-voice-sigma"',
        ],
    },
    "rvc-enhance": {
        "usage": "bookforge-tts --rvc-enhance (--project DIR | --process-dir DIR) --rvc-voice-id ID [options]",
        "doc": """Run the RVC-ENHANCEMENT step over a session's PER-SENTENCE cache.

Drives rvc-job.runRvcEnhancement, the one function
electron/queue-steps/rvc-enhancement.ts calls. It writes a durable derived set,
chapters/sentences-rvc-<voice>/, which assembly then reads via --sentences_dir —
so the recipe is --rvc-enhance, then --assemble --as-new-version --sentences-dir.

NOT --rvc, which is rvc-bridge.convertFileRvcChunked over ONE FINISHED AUDIO FILE.
Two different jobs with two different outputs, and the tuning flags are spelled
--enhance-* here so an unset value stays unset and urvc's own default applies,
exactly as in the app.""",
        "reads": ["--config", "--dry-run", "--project", "--process-dir", "--rvc-voice-id",
                  "--enhance-index-rate", "--enhance-protect-rate", "--enhance-f0-method",
                  "--n-semitones", "--hop-length", "--sentences-dir", "--sentence-gap"],
        "refuses": [],
        "examples": [
            'bookforge-tts --rvc-enhance --project "<library>/projects/<slug>" \\\n'
            '    --rvc-voice-id builtin:deathstalker-sigma',
            'bookforge-tts --rvc-enhance --project "<library>/projects/<slug>" \\\n'
            '    --rvc-voice-id rvc-voice-sigma --enhance-index-rate 0.3 --enhance-protect-rate 0.1',
            'bookforge-tts --rvc-enhance --process-dir "<session>" \\\n'
            '    --rvc-voice-id rvc-voice-sigma --dry-run',
        ],
    },
    "retake": {
        "usage": "bookforge-tts --retake --project DIR [--retake-action ACTION] [options]",
        "doc": """CORRECT SENTENCES — list, retake, approve, revert, headless.

The app's Correct Sentences panel is five exported functions in
correct-sentences-bridge behind five IPC handlers; this drives the same five, and
--retake-action picks one:

  list     what the cache holds, cue by cue      (getCorrectSentencesSession)
  retake   render fresh takes for --indices      (generateCandidates)
  commit   approve one take by path              (commitSentence)
  revert   restore from .orig-backup/            (revertSentence)
  cleanup  drop the candidate scratch            (cleanupCandidates)

Every take is sample_fmt-matched to the book's existing FLACs, so it drops into
the cache without breaking the concat. Ctrl+C aborts through the CLI's own
AbortController, as the app's IPC layer does.""",
        "reads": ["--config", "--dry-run", "--project", "--retake-action", "--indices",
                  "--takes", "--index", "--count", "--take", "--sentence-text"],
        "refuses": [],
        "examples": [
            'bookforge-tts --retake --project "<library>/projects/<slug>"',
            'bookforge-tts --retake --project "<library>/projects/<slug>" --index 120 --count 40',
            'bookforge-tts --retake --project "<library>/projects/<slug>" --retake-action retake \\\n'
            '    --indices 12,40 --takes 3',
            'bookforge-tts --retake --project "<library>/projects/<slug>" --retake-action commit \\\n'
            '    --index 12 --take "<scratch>/take2/12.flac"',
            'bookforge-tts --retake --project "<library>/projects/<slug>" --retake-action revert --index 12',
        ],
    },
    "pass": {
        "usage": "bookforge-tts --pass --project DIR --kind simplify|translate|footnote-refs [options]",
        "doc": """Run ONE of the app's PROCESSING PASSES on a project.

Every pass is a queue row in the app, and every row is queue-steps/pass.ts calling
processing-passes.runProcessingPass over a config
processing-chain.planProcessingChain laid out. This drives that pair, so the run
stages, records its ledger row, writes provenance and promotes a working copy
exactly as pressing the button does.

NOT --ai-cleanup/--ai-simplify, which are ai-bridge.cleanupEpub over a LOOSE epub
(file in, file out, no project record). NOT Foundry's "Clean text", which is
--clean. The fourth pass kind, narration-text, has its own command because it also
has a bare-EPUB door. The API key travels in the process env, never argv.""",
        "reads": ["--config", "--dry-run", "--project", "--kind", "--family", "--provider",
                  "--model", "--api-key", "--ollama-url", "--custom-instructions",
                  "--simplify-mode", "--test-mode", "--test-chunks", "--source-lang",
                  "--target-lang", "--translation-prompt"],
        "refuses": [],
        "examples": [
            'bookforge-tts --pass --project "<library>/projects/<slug>" --kind footnote-refs',
            'bookforge-tts --pass --project "<library>/projects/<slug>" --kind simplify \\\n'
            '    --simplify-mode learner --provider ollama --model gemma3:12b',
            'bookforge-tts --pass --project "<library>/projects/<slug>" --kind translate \\\n'
            '    --source-lang en --target-lang de --provider claude --model claude-sonnet-4-5',
            '# a project holding two book chains needs to be told which one:\n'
            'bookforge-tts --pass --project "<library>/projects/<slug>" --kind footnote-refs \\\n'
            '    --family "<stem of the file the chain was minted from>" --dry-run',
        ],
    },
    "prep": {
        "usage": "bookforge-tts --prep (--project DIR | --input FILE) [--library DIR] [--dry-run]",
        "doc": """The NARRATION DOOR on its own — captions and notes out, numbers as words.

Drives prepareNarrationInput (parallel-tts-bridge), the SAME export the app's queue
calls before every render, so you can prep now and render later (Owen, 2026-09-02).
Two passes: the cut (.epub only — photo captions, the endnote apparatus and <sup>
reference numbers, through writeNarrationEpub), then the numbers (every passage
with a digit goes to the model Settings names, and every edit is checked against
the validator's 13 dispositions).

It writes a prepared copy and the .edits.json beside it, then stops. The copy is
content-addressed by (input sha, rule version, model), so a later --tts or
--audiobook on the same input reuses it with NO second model call.

NOT --ai-cleanup, which repairs an epub's prose. This repairs nothing; it only
decides what the narrator is handed.""",
        "reads": ["--config", "--dry-run", "--project", "--input", "--library"],
        "refuses": [
            ("--library", "with --project: the project path decides the library "
                          "(<library>/projects/<slug>), so a second one would name a different "
                          "place than the render will look in"),
        ],
        "examples": [
            'bookforge-tts --prep --project "<library>/projects/<slug>"',
            'bookforge-tts --prep --input book.epub',
            'bookforge-tts --prep --input passage.txt --library "<library>"',
            'bookforge-tts --prep --input book.epub --dry-run',
        ],
    },
    "narration-text": {
        "usage": "bookforge-tts --narration-text (--project DIR | --input FILE) [--dry-run]",
        "doc": """The NARRATION TEXT CLEANUP on a book, replacing it in place — the failsafe.

Owen, 2026-09-05: *"the bookforge clean text action outside of foundry is a
failsafe in case the user forgets and just wants to get it done immediately. it
won't be treated as the standard method."*

The pass itself is the ENGINE's: this spawns `foundry clean-text --epub <book>
--out <staging>` and lands the staging on the book with one rename. Three stages,
in order: punctuation canonicalization, the deterministic number rules, then the
model on every block. It writes the book back, STAMPED, plus
<stem>.narration-text.json — and the stamp is the point, because it is what every
consumer downstream reads to tell a cleaned book from an uncleaned one.

THE STANDARD METHOD IS THE HOSTED STEP (--clean), where the cleanup is a position
on the document chain. This door produces a FILE, and a re-export loses it.""",
        "reads": ["--config", "--dry-run", "--project", "--input"],
        "refuses": [],
        "examples": [
            'bookforge-tts --narration-text --project "<library>/projects/<slug>"',
            'bookforge-tts --narration-text --input book.epub',
            'bookforge-tts --narration-text --input book.epub --dry-run',
        ],
    },
    "clean-lines": {
        "usage": "bookforge-tts --clean-lines --input FILE --language CODE [--output FILE] [--keep-model]",
        "doc": """A FILE OF LINES through the narration text cleanup, written back BY POSITION.

One training transcript per line in, the same lines cleaned out, in ONE process:
the model loads once, the context window is pinned from the longest line, every
line is asked at temperature 0, and the model unloads at the end (Owen,
2026-09-07). Behind it is `foundry clean-text --book` — BookForge writes a book
file with one paragraph block per line and spawns the same binary, model and
endpoint the hosted Clean text press uses.

Line N out is line N in, blanks stay blank, so a caller can zip it against an
audio list by position. A killed run keeps its records
(<stem>.clean-lines/lines.records.jsonl) and the next run asks only about the
lines with no answer. A line the engine never answered is NEVER copied through as
if it had been cleaned.""",
        "reads": ["--config", "--dry-run", "--input", "--output", "--language", "--keep-model"],
        "refuses": [],
        "examples": [
            'bookforge-tts --clean-lines --input lines.txt --language en',
            'bookforge-tts --clean-lines --input lines.txt --output cleaned.txt --language en',
            '# leave the model loaded for several runs back to back:\n'
            'bookforge-tts --clean-lines --input lines.txt --language en --keep-model',
        ],
    },
    "clean": {
        "usage": "bookforge-tts --clean (--project DIR | --foundry-project DIR) [options]",
        "doc": """THE HOSTED FOUNDRY WINDOW'S "Clean text" PRESS, with no window.

Not a headless re-implementation of it: the adapter calls the same compiled
functions in the same order the button walks through — planCleanup
(workspace:plan-clean, which materialises the position's own book and mints the
records, stamp and step id), the CleanRequest clean-dialog.add() composes field for
field, and runJob, the seam queue-steps/foundry-job.ts hands a Foundry row to. So
it LANDS A LEDGER STEP, writes the same records and stamp, and can be timed
against the app it is a run of.

Where it stands is where the project stands: the step is positionOf the project's
ledger and canCleanFrom is asked about it, so a position the dialog would not offer
the button from refuses here too. The engine is the locally-BUILT foundry
(--foundry-dist), because --concurrency arrived in 1.2.0 and the installed
component can be months older.""",
        "reads": ["--config", "--dry-run", "--project", "--foundry-project", "--model",
                  "--ollama", "--concurrency", "--keep-model", "--foundry-dist"],
        "refuses": [],
        "examples": [
            'bookforge-tts --clean --project "<library>/projects/<slug>"',
            'bookforge-tts --clean --project "<library>/projects/<slug>" \\\n'
            '    --model qwen3.5:9b-mlx-bf16 --concurrency 8',
            '# the Foundry project directly, when the mapping is not the question:\n'
            'bookforge-tts --clean --foundry-project "<library>/foundry/projects/<key>"',
            'bookforge-tts --clean --project "<library>/projects/<slug>" --dry-run',
        ],
    },
    "ai-cleanup": {
        "usage": "bookforge-tts --ai-cleanup --input FILE --provider NAME --stages ocr|tts|both [options]",
        "doc": """OCR/formatting cleanup of a LOOSE epub through the real ai-bridge pipeline.

Drives aiBridge.cleanupEpub: the same 8000-char chunking, the per-provider prompts,
num_ctx / think:false / keep_alive / temperature, the [SKIP] / truncation /
copyright / repetition safeguards, and the cleaned.diff.json +
cleanup-progress.json checkpoint outputs. File in, file out — no project record.

--stages is REQUIRED and the pipeline refuses to guess: ocr is the per-chunk
scanner-damage pass and stops at repaired.epub; tts is the deterministic prep only
(footnote markers, quotes, numbers) and writes cleaned.epub in seconds — the right
choice for a born-digital EPUB; both does repair then prep.

Cloud providers (claude, openai) run OFF-GPU, so they are safe alongside a render.
The key travels in the process env, never argv.""",
        "reads": ["--config", "--dry-run", "--input", "--provider", "--model", "--api-key",
                  "--output-dir", "--stages", "--custom-instructions", "--detailed-cleanup",
                  "--cleanup-prompt", "--chunk-size", "--temperature", "--ollama-url",
                  "--parallel-workers", "--no-parallel", "--test-mode", "--test-chunks"],
        "refuses": [
            ("--test-chunks", "without --test-mode: a cap that looked set and was not is the "
                              "failure this rule exists to end"),
        ],
        "examples": [
            '# a SCANNED book with a cloud provider (key from ANTHROPIC_API_KEY):\n'
            'bookforge-tts --ai-cleanup --input book.epub --provider claude \\\n'
            '    --model claude-sonnet-4-5 --stages both --output-dir ./out',
            '# a born-digital epub — the deterministic prep only, seconds, no model pass:\n'
            'bookforge-tts --ai-cleanup --input book.epub --provider ollama \\\n'
            '    --model cogito:14b --stages tts --output-dir ./out',
            '# repair scanner damage and STOP (repaired.epub), first 3 chunks as a test:\n'
            'bookforge-tts --ai-cleanup --input book.epub --provider ollama --model cogito:14b \\\n'
            '    --stages ocr --test-mode --test-chunks 3',
        ],
    },
    "ai-simplify": {
        "usage": "bookforge-tts --ai-simplify --input FILE --provider NAME --simplify-mode MODE [options]",
        "doc": """Simplify a LOOSE epub — cleanupEpub with simplifyForChildren + a mode.

The SAME call as --ai-cleanup, with the simplify flag and one of three modes:
dejargon (academic prose), destiffen (translated prose), learner (a B1-B2 rewrite).
By default it ALSO cleans, which is the app's default; --no-cleanup makes it
simplify-only.

Output is simplified.epub in --output-dir (default: alongside the input). File in,
file out — for the PROJECT act, with its ledger row and provenance, use
--pass --kind simplify.""",
        "reads": ["--config", "--dry-run", "--input", "--provider", "--model", "--api-key",
                  "--output-dir", "--simplify-mode", "--no-cleanup", "--stages",
                  "--custom-instructions", "--detailed-cleanup", "--cleanup-prompt",
                  "--chunk-size", "--temperature", "--ollama-url", "--parallel-workers",
                  "--no-parallel", "--test-mode", "--test-chunks"],
        "refuses": [
            ("--test-chunks", "without --test-mode: a cap that looked set and was not is the "
                              "failure this rule exists to end"),
        ],
        "examples": [
            'bookforge-tts --ai-simplify --input book.epub --provider ollama \\\n'
            '    --model cogito:14b --simplify-mode learner',
            '# simplify ONLY (skip the cleanup pass), first 3 chunks:\n'
            'bookforge-tts --ai-simplify --input book.epub --provider claude \\\n'
            '    --model claude-sonnet-4-5 --simplify-mode dejargon --no-cleanup \\\n'
            '    --test-mode --test-chunks 3',
            'bookforge-tts --ai-simplify --input book.epub --provider ollama \\\n'
            '    --model cogito:14b --simplify-mode destiffen --output-dir ./out --dry-run',
        ],
    },
    "generate-sentences": {
        "usage": "bookforge-tts --generate-sentences --audio FILE --out FILE [--epub FILE] [options]",
        "doc": """Audio -> a sentence-level VTT, through the app's real machinery. Two modes.

WHISPER (default): faster-whisper transcription (transcribe_audiobook.py in the
bundled e2a env, GPU-arbitrated) — the words are inferred from the audio, so ASR
spelling errors are possible.

EPUB-ALIGN (--epub given): the ebook text is GROUND TRUTH and WhisperX forced
alignment supplies only the timing (align_audiobook.py). The book's own words with
real audio timings — what a training dataset or a read-along wants.

Everything below --epub in the flag list is epub-align only and refused without
it. --embed also seals the VTT into the m4b as a verified mov_text subtitle track,
which is the app's embed-only model.""",
        "reads": ["--config", "--dry-run", "--audio", "--out", "--epub", "--whisper-model",
                  "--device", "--embed", "--language", "--report", "--min-hole",
                  "--rough-cache", "--align-workers", "--snap-silence", "--no-snap-silence",
                  "--no-paragraph-split", "--report-min-hole"],
        "refuses": [
            ("--whisper-model", "with --epub: epub-align's rough model is fixed"),
            ("--report", "without --epub: coverage compares the ebook against the audio"),
            ("--min-hole", "without --epub: it tunes epub-vs-audio hole detection"),
            ("--rough-cache", "without --epub: only epub-align has a rough transcribe pass to cache"),
            ("--align-workers", "without --epub: it sizes the epub-align worker pool"),
            ("--snap-silence", "without --epub: whisper mode has no cue seams to snap "
                               "(and it is mutually exclusive with --no-snap-silence)"),
            ("--no-snap-silence", "without --epub, as above"),
            ("--no-paragraph-split", "without --epub: it changes ebook segmentation"),
            ("--report-min-hole", "without --epub, as above"),
        ],
        "examples": [
            'bookforge-tts --generate-sentences --audio book.m4b --out book.vtt --whisper-model small',
            '# the book as truth, WhisperX for timing:\n'
            'bookforge-tts --generate-sentences --audio book.m4b --epub book.epub --out book.vtt',
            '# also seal the VTT into the m4b, and write the coverage report:\n'
            'bookforge-tts --generate-sentences --audio book.m4b --epub book.epub --out book.vtt \\\n'
            '    --embed --report',
            '# keep it off a busy GPU and cache the rough pass while iterating:\n'
            'bookforge-tts --generate-sentences --audio part2.mp3 --epub book.epub --out part2.vtt \\\n'
            '    --device cpu --rough-cache --dry-run',
        ],
    },
    "generate-epub": {
        "usage": "bookforge-tts --generate-epub --project DIR [options]",
        "doc": """Read a project's PDF into its book — the app's Convert to EPUB, headless.

Drives vlm-convert.runVlmConversion, the SAME function the vlm:convert IPC handler
calls, so one call gets all of it: the route resolution, the banked-readings
decision and its foundry >= 0.9.0 gate, `foundry vlm-convert`, the staged EPUB
moved onto source/<archive basename>.generated.epub, the manifest records
(outputs.generatedEpub plus a freshly minted working copy) and the vlm-convert
provenance entry. Nothing about a converted project says it was done from here.

WHICH MACHINE reads the pages: with no --vlm-endpoint, this machine's own route,
exactly as an unset Settings -> AI -> Reading pages means in the app (WSL on
Windows, MLX on an Apple Silicon Mac). That setting lives in the renderer's
bundle, which no headless process can read, so it is passed here.""",
        "reads": ["--config", "--dry-run", "--project", "--readings", "--destination",
                  "--variant-id", "--source-pdf", "--skip-deleted-pages", "--vlm-endpoint",
                  "--vlm-endpoint-model", "--vlm-concurrency"],
        "refuses": [
            ("--source-pdf", "with --variant-id: both name the PDF to read; pass one"),
        ],
        "examples": [
            'bookforge-tts --generate-epub --project "<library>/projects/<slug>" --readings fresh',
            '# read the pages on somebody else\'s server instead of this machine\'s route:\n'
            'bookforge-tts --generate-epub --project "<library>/projects/<slug>" \\\n'
            '    --vlm-endpoint http://192.168.68.83:8000/v1 --vlm-endpoint-model rednote-hilab/dots.ocr',
            '# add the reading BESIDE the book this project already has:\n'
            'bookforge-tts --generate-epub --project "<library>/projects/<slug>" --destination new-copy',
            'bookforge-tts --generate-epub --project "<library>/projects/<slug>" --readings fresh --dry-run',
        ],
    },
    "rvc": {
        "usage": "bookforge-tts --rvc --input FILE --out FILE --rvc-model NAME [options]",
        "doc": """Convert a WHOLE audio file through an RVC voice model — memory-safely.

Drives rvc-bridge.convertFileRvcChunked: it silence-chunks the file, converts each
chunk in a RECYCLED worker process (each exits between batches so unified memory is
reclaimed — a full audiobook never balloons into swap the way one long convert-dir
does), then stitches the chunks back.

The primary use is same-voice RECONSTRUCTION at --index-rate 0: background hum and
scratchiness removed, re-rendered at 48 kHz. NOT --rvc-enhance, which is the pass
over a session's per-sentence cache.""",
        "reads": ["--config", "--dry-run", "--input", "--out", "--rvc-model", "--index-rate",
                  "--protect-rate", "--f0-method", "--chunk-seconds", "--batch-size"],
        "refuses": [],
        "examples": [
            '# reconstruct an audiobook through your own voice model (48 kHz, background gone):\n'
            'bookforge-tts --rvc --input "Marked Man.m4a" --out "Marked Man RVC.flac" \\\n'
            '    --rvc-model deathstalker_rvc_v1 --index-rate 0 --protect-rate 0.2',
            'bookforge-tts --rvc --input book.m4a --out book.flac --rvc-model my_rvc \\\n'
            '    --f0-method rmvpe --chunk-seconds 600 --batch-size 4',
            'bookforge-tts --rvc --input book.m4a --out book.flac --rvc-model my_rvc --dry-run',
        ],
    },
}


def _brief(text):
    """A flag's help cut to its first sentence, for the per-command view.

    DERIVED, never a second string. A hand-written short help would drift from the
    long one, and the drift would land in the page a reader trusts most — the one
    printed by `--tts --help`, which is where they went to find out what a flag
    does. The full text is one `--help` away, and the footer says so.
    """
    flat = " ".join(str(text).split())
    cut = len(flat)
    for i in range(len(flat) - 2):
        if flat[i] != "." or flat[i + 1] != " ":
            continue
        if not (flat[i + 2].isupper() or flat[i + 2] == "-"):
            continue
        if flat[max(0, i - 3):i + 1].lower() in ("e.g.", "i.e."):
            continue            # "e.g. Foo" is not the end of a sentence
        cut = i + 1
        break
    if cut > 118:
        space = flat.rfind(" ", 0, 118)
        return flat[:space if space > 0 else 118] + " …"
    return flat[:cut]


class _FlagRegistry:
    """An ArgumentParser's `add_argument` surface — remembered, and re-emittable.

    Every flag is registered ONCE, into the group whose title says who reads it,
    and the registration is KEPT, so `bookforge-tts --tts --help` can re-emit the
    subset --tts reads from the very calls the real parser is built from.

    WHY NOT A SECOND PARSER. A hand-maintained per-command parser would drift from
    the one the run is actually parsed by, and then the help would name a flag
    argparse does not have — a worse failure than no per-command help, because a
    reader cannot tell a stale page from a true one. This object quacks like a
    parser on purpose (`add_argument`, same kwargs) so the registrations below read
    as registrations and nothing has to be spelled twice.
    """

    def __init__(self):
        self._groups = []                  # [(title, description)] — in help order
        self._specs = []                   # [(title, flags, kwargs)]

    def group(self, title, description=None):
        self._groups.append((title, description))

    def add_argument(self, *flags, **kwargs):
        _require(self._groups,
                 f"{flags[0]} is registered before any group() — every flag belongs to exactly "
                 f"one group whose title says who reads it")
        self._specs.append((self._groups[-1][0], flags, kwargs))

    def flag_groups(self):
        """{group title: [primary flag, ...]} — what tools/test-cli-flags.js checks."""
        out = {}
        for title, flags, _kwargs in self._specs:
            out.setdefault(title, []).append(flags[0])
        return out

    def parser(self, description, epilog, keep=None, usage=None, brief=False, width=None):
        """Build a real ArgumentParser from the registrations.

        `keep` is a set of primary flags — the per-command view; None means all of
        them. `brief` cuts each help to its first sentence and drops the group
        descriptions, which is what keeps a command's page short enough to read.
        """
        p = argparse.ArgumentParser(
            prog="bookforge-tts", description=description, epilog=epilog, usage=usage,
            formatter_class=_formatter_class(width))
        for title, desc in self._groups:
            rows = [(flags, kwargs) for (t, flags, kwargs) in self._specs
                    if t == title and (keep is None or flags[0] in keep)]
            if not rows:
                continue
            grp = p.add_argument_group(title, None if brief else desc)
            for flags, kwargs in rows:
                grp.add_argument(*flags, **(dict(kwargs, help=_brief(kwargs["help"]))
                                            if brief and kwargs.get("help") else kwargs))
        return p


def _formatter_class(width):
    """RawDescriptionHelpFormatter, optionally at a stated width.

    The width matters for the per-command pages: argparse reads the terminal, and
    a piped `--tts --help` falls back to 80 columns, which wraps every one-line
    flag onto two and pushes the page past what anyone reads in one screen.
    """
    if width is None:
        return argparse.RawDescriptionHelpFormatter

    class _Fixed(argparse.RawDescriptionHelpFormatter):
        def __init__(self, prog):
            super().__init__(prog, max_help_position=30, width=width)

    return _Fixed


def _flag_registry():
    """Every flag, registered once, into the group whose title says who reads it.

    THE ORDER AND THE GROUPING ARE THE DOCUMENTATION. Before 2026-09-12 these were
    one flat list, so `--help` opened with a single usage line carrying 17 command
    selectors and ~130 options and no way to tell which went with which. The flags
    themselves are UNCHANGED — same dest, same default, same choices, same
    behaviour; this is a re-registration, defended by tools/test-cli-flags.js and
    tools/tests/test-cli-flag-parity.sh.
    """
    p = _FlagRegistry()          # quacks like an ArgumentParser; see the class

    p.group("Commands (pick one)",
            "Exactly one is required. `--<command> --help` prints only that command's flags,\n"
            "what it refuses by name, and copy-pasteable examples.")
    for name in COMMANDS:                         # command selector flags
        p.add_argument(f"--{name}", action="store_true",
                       help=COMMAND_FLAGS[name]["doc"].split("\n")[0])

    p.group("Render input and output (--tts, --audiobook)",
            "What goes in, what comes out, and which project or file it is. --project is also\n"
            "the target of --assemble, --align, --denoise, --rvc-enhance, --retake, --pass,\n"
            "--prep, --narration-text, --clean and --generate-epub.")
    p.add_argument("--input", help="what to render (--tts): an .epub (a book), a .txt/.md "
                   "(paragraphs separated by blank lines) or a .jsonl (one chunk per row) — the "
                   "last two are packed into a one-chapter EPUB by the app's own writer; "
                   "text file to stream (--tts --mode streaming); EPUB override (--audiobook); "
                   "the .epub or .txt to prep (--prep)", metavar="FILE")
    p.add_argument("--text", help="literal text to render (--tts: packed into a one-chapter "
                   "EPUB, paragraphs separated by blank lines) or to stream (--mode streaming)",
                   metavar="STR")
    p.add_argument("--title", dest="title",
                   help="--tts with a text/jsonl input: the title the packed one-chapter EPUB "
                        "carries (default: the input's basename, or 'CLI passage' for --text)",
                   metavar="STR")
    p.add_argument("--out", help="output .wav path", metavar="FILE")
    p.add_argument("--project", help="BookForge project dir. --audiobook: output lands in "
                   "<project>/output/audiobook.m4b (input EPUB resolved like the app's 'Latest'). "
                   "--generate-epub: the project whose PDF is read into its book. "
                   "--prep: the project whose book is prepped (same 'Latest' resolution)",
                   metavar="DIR")
    p.add_argument("--mode", default="tts", choices=["tts", "streaming"],
                   help="render path: 'tts' = audiobook/batch (default, the shipped path), "
                        "'streaming' = Listen (one sentence per vLLM sequence)")
    p.add_argument("--read-ahead", dest="read_ahead", type=int, default=None,
                   help="streaming: how many following blocks to read ahead "
                        "(default: all of them, as the extension does)", metavar="N")
    p.add_argument("--as-chunks", dest="as_chunks", action="store_true",
                   help="--tts with a .txt/.md/.jsonl (or --text) input: render each paragraph/row "
                        "as exactly ONE generation chunk (settings.sentencePerParagraph → "
                        "narrator's --sentence_per_paragraph), narrated as printed. Refused with "
                        "an EPUB, which the app's own packer chunks")
    p.add_argument("--max-chunks", dest="max_chunks", type=int, default=None,
                   help="--tts only: cap generation at N chunks (settings.testMode + "
                        "testSentences, the pair the app's own settings carry). Refused with "
                        "--audiobook: a capped book is not an audiobook", metavar="N")
    p.add_argument("--library", dest="library",
                   help="--tts / --prep --input: the library root whose tmp/ holds the sessions "
                        "and the narration cuts (the app's <library>/tmp, unless Settings states "
                        "a narrator scratch folder). Default: the root this machine chose in "
                        "BookForge (userData/library-root.json). Refused wherever a --project "
                        "already decides the library (--audiobook, --assemble, --prep --project)",
                   metavar="DIR")
    p.add_argument("--keep-sentences", dest="keep_sentences", action="store_true",
                   help="tts path: also copy the per-sentence FLACs to <out>.sentences/")
    p.add_argument("--keep-session", dest="keep_session", action="store_true",
                   help="tts path: keep the scratch session dirs (default: cleaned after concat)")
    p.add_argument("--fresh", action="store_true",
                   help="--audiobook: ignore any cached session and re-render from scratch "
                        "(default: resume — skip sentences already rendered in a prior run)")
    p.add_argument("--skip-text-cleanup", dest="skip_text_cleanup", action="store_true",
                   help="--audiobook: do NOT run the narration text cleanup, and tell the render "
                        "door so — the book is read exactly as printed. The app's \"No, narrate "
                        "as printed\" button, headless")

    p.group("Model choice (--tts, --audiobook): engine, voice, checkpoint under test",
            "The ARM is never a flag: renderRangeHeadless routes by platform (Mac MLX,\n"
            "Windows/WSL SGLang). These say WHICH model reads the tokens, not which machine.")
    p.add_argument("--engine", default="orpheus",
                   help="TTS engine: orpheus or higgs (default orpheus). Both render (--mode tts) "
                        "and both stream (--mode streaming, since 2026-09-05); the ARM is chosen "
                        "by the platform inside the bridge — Mac MLX, Windows/WSL SGLang — never "
                        "by a flag here.", metavar="NAME")
    p.add_argument("--voice", help="voice id (a BookForge models.json id / model folder)",
                   metavar="ID")
    p.add_argument("--voice-token", dest="voice_token", help="prompt token override (tts mode only)",
                   metavar="TOKEN")
    p.add_argument("--model-dir", dest="model_dir",
                   help="ORPHEUS custom model directory (overrides voice resolution). A Higgs "
                        "checkpoint under test is --checkpoint-dir", metavar="DIR")
    p.add_argument("--checkpoint-dir", dest="checkpoint_dir",
                   help="--engine higgs: a checkpoint directory to render THIS run with, "
                        "instead of the catalog's. --voice stays required and is the base voice "
                        "whose certificate (caps, pace, band) the checkpoint borrows — which is "
                        "what makes the two comparable. On the Mac it must exist here; on "
                        "Windows it must be a guest-native /home/... path (the WSL arm)",
                   metavar="DIR")
    p.add_argument("--models-dir", dest="models_dir",
                   help="override the Orpheus models directory to discover voices in",
                   metavar="DIR")

    p.group("Higgs sampling and caps (--engine higgs)",
            "Higgs sampling rides the VOICE DOCUMENT (ParallelTtsSettings.higgsOverride), never\n"
            "the process env. --temperature and --top-p are shared with Orpheus and listed under\n"
            "their own groups; on a Higgs run they ride the override instead of ORPHEUS_*.")
    p.add_argument("--top-k", dest="top_k", type=int, default=None,
                   help="tts: HIGGS top_k — rides the voice document as "
                        "higgsOverride.sampling.topK. Orpheus has no top_k seam and refuses it "
                        "by name", metavar="N")
    p.add_argument("--safe-band", dest="safe_band",
                   help="--engine higgs: the chunk band as MIN-MAX characters, e.g. 200-700 "
                        "(higgsOverride.safeMinChars/safeMaxChars). The band's WIDTH decides the "
                        "in-band rate; Orpheus packs to --max-chars instead", metavar="MIN-MAX")
    p.add_argument("--max-chars", dest="max_chars", type=int,
                   help="the packing cap in chars. --engine higgs: higgsOverride.maxChars, held "
                        "against the base voice's certificate. --engine orpheus: env "
                        "ORPHEUS_MAX_CHARS (tts path; default 350, no sentence "
                        "cap — ear-validated for EOS-safe ≤20s/2048-recipe voices; 450 "
                        "fails everywhere. The packed-runaway was the long-clip TRAINING "
                        "recipe, not packing)", metavar="N")
    p.add_argument("--note", dest="note",
                   help="why this render was run, stamped onto the Higgs override. Default: the "
                        "command as typed plus this machine's hostname", metavar="TEXT")

    p.group("Orpheus sampling (--engine orpheus)",
            "Orpheus sampling rides the ORPHEUS_* process env, which is where the bridge's worker\n"
            "spawn reads it. --min-p and --rep-penalty are refused by name on a Higgs run, which\n"
            "has no such knob. --temperature is under Settings and environment (the AI doors read\n"
            "it too).")
    p.add_argument("--top-p", dest="top_p", type=float, default=None,
                   help="tts: Orpheus nucleus sampling top_p (default 0.8)", metavar="P")
    p.add_argument("--min-p", dest="min_p", type=float, default=None,
                   help="tts: Orpheus min_p — drop tokens below this fraction of the top "
                        "token's probability (default 0 = off; vLLM + MLX batch paths). "
                        "Cuts the rare-junk tail without flattening variety like lowering top_p",
                   metavar="M")
    p.add_argument("--rep-penalty", dest="rep_penalty", type=float, default=None,
                   help="tts: Orpheus repetition penalty (default 1.1). narrator's v3 Higgs "
                        "engines have no such knob and refuse it by name", metavar="R")

    p.group("Mac MLX tuning",
            "Mac-only, and not as an omission: higgsMlxBatchEnv honours these over the catalog's\n"
            "ceiling. On Windows a Higgs render is SERVED and the width is the server's admission\n"
            "width (HIGGS_MAX_NUM_SEQS), so both are refused by name there.")
    p.add_argument("--batch-width", dest="batch_width", type=int, default=None,
                   help="--engine higgs on the MAC: the MLX arm's per-run group width "
                        "(env NARRATOR_HIGGS3_MLX_BATCH). On Windows the width is the catalog's "
                        "server admission width (HIGGS_MAX_NUM_SEQS) and this is refused by name",
                   metavar="N")
    p.add_argument("--mem-budget-gb", dest="mem_budget_gb", type=float, default=None,
                   help="--engine higgs on the MAC: the MLX arm's memory budget in GB "
                        "(env NARRATOR_HIGGS3_MLX_MEM_BUDGET_GB). Windows: refused, see above",
                   metavar="GB")

    p.group("Assembly (--assemble, --audiobook)",
            "The two calls the app's Assemble makes over a session: runFinalDenoise, then\n"
            "startReassembly. --assemble REQUIRES --final-denoise or --no-final-denoise.")
    p.add_argument("--final-denoise", dest="final_denoise", action="store_true",
                   help="--audiobook/--assemble: force the final-audio denoise pass ON "
                        "(block-based "
                        "roformer over the rendered sentences, pre-assembly; strips the "
                        "hiss bed hiss-trained voices reproduce). Default: on for "
                        "--engine orpheus, off for every other engine")
    p.add_argument("--no-final-denoise", dest="no_final_denoise", action="store_true",
                   help="--audiobook/--assemble: force the final-audio denoise pass OFF. "
                        "REQUIRED on --assemble (with its twin above): whether the denoise ran "
                        "is a fact about the chain that produced those sentences")
    p.add_argument("--de-ring", dest="de_ring", action="store_true",
                   help="--audiobook/--assemble: apply the voice's per-voice post-render "
                        "notch/comb (the filter that strips SNAC tonal ringing) at the final "
                        "encode. OPT-IN, same as the app's assemble step")
    p.add_argument("--assembly-gap", dest="assembly_gap", type=float, default=None,
                   help="--audiobook/--assemble: the inter-sentence gap in seconds re-laid by "
                        "the pass in FRONT of assembly. Distinct from --sentence-gap, which is "
                        "the gap the worker bakes into each FLAC at render time. Omit to let the "
                        "voice's models.json value decide (or no gap step, if it declares none)",
                   metavar="SEC")
    p.add_argument("--as-new-version", dest="as_new_version", action="store_true",
                   help="--assemble: file the result BESIDE the project's audiobook instead of "
                        "replacing it — a manifest variant under a filename carrying the voice. "
                        "What the app does for a run that converted sentences it did not render")
    p.add_argument("--version-voice", dest="version_voice",
                   help="--assemble: the RVC voice id the second version is NAMED after. Read off "
                        "a `sentences-rvc-<voice>` directory name when --sentences-dir names one; "
                        "required for any other set", metavar="ID")

    p.group("Alignment (--align)",
            "coverage-align-job.runCoverageAlign over a rendered session. Its language is its own\n"
            "flag on purpose - see the help below.")
    p.add_argument("--align-language", dest="align_language",
                   help="--align: the language the wav2vec2 checkpoint is loaded for. REQUIRED "
                        "and deliberately separate from --language, which carries a render "
                        "default: an aligner pointed at the wrong language scores every word "
                        "badly, and the coverage guard reads that as a book that was not read",
                   metavar="CODE")

    p.group("Denoise / RVC (--denoise, --rvc-enhance, --rvc)",
            "Two session passes (--denoise, --rvc-enhance) and one whole-file conversion (--rvc).\n"
            "The enhance flags are spelled --enhance-* so an unset value stays unset and urvc's\n"
            "own default applies, exactly as in the app.")
    p.add_argument("--process-dir", dest="process_dir",
                   help="--denoise/--rvc-enhance/--align: the session's process dir, named "
                        "directly instead of resolved from --project's cached session (all three "
                        "resolve it through the one rule the app's own steps use)", metavar="DIR")
    p.add_argument("--sentences-dir", dest="sentences_dir",
                   help="--denoise/--rvc-enhance: the set this pass reads, when an EARLIER pass "
                        "produced it (the 'convert first, then denoise' order and its mirror). "
                        "The job refuses it alongside --sentence-gap rather than ignoring one. "
                        "--assemble: the set to ASSEMBLE — an enhancement pass's durable output, "
                        "e.g. <session>/chapters/sentences-rvc-<voice>/. Nothing is derived: the "
                        "set is assembled as it is, so --final-denoise is refused alongside it",
                   metavar="DIR")
    p.add_argument("--rvc-voice-id", dest="rvc_voice_id",
                   help="--rvc-enhance: the RVC asset id (e.g. builtin:deathstalker-sigma). "
                        "Not --rvc-model, which is the urvc FOLDER name the whole-file --rvc takes",
                   metavar="ID")
    p.add_argument("--enhance-index-rate", dest="enhance_index_rate", type=float, default=None,
                   help="--rvc-enhance: index influence 0-1. Omit to leave urvc on its own "
                        "default, which is what the app's step does", metavar="R")
    p.add_argument("--enhance-protect-rate", dest="enhance_protect_rate", type=float, default=None,
                   help="--rvc-enhance: consonant/breath protection (INVERTED — lower protects "
                        "more, 0.5 is off). Omit for urvc's own default", metavar="R")
    p.add_argument("--n-semitones", dest="n_semitones", type=float, default=None,
                   help="--rvc-enhance: pitch shift in semitones. Omit for urvc's own default",
                   metavar="N")
    p.add_argument("--hop-length", dest="hop_length", type=int, default=None,
                   help="--rvc-enhance: f0 analysis hop (crepe-family only). Omit for urvc's own",
                   metavar="N")
    p.add_argument("--enhance-f0-method", dest="enhance_f0_method",
                   choices=["rmvpe", "crepe", "crepe-tiny", "fcpe"],
                   help="--rvc-enhance: pitch extraction. Omit for urvc's own default")
    p.add_argument("--rvc-model", dest="rvc_model",
                   help="rvc: voice-model folder name (e.g. deathstalker_rvc_v1)", metavar="NAME")
    p.add_argument("--index-rate", dest="index_rate", type=float, default=0.0,
                   help="rvc: index influence 0-1 (default 0.0 — same-voice cleanup; the "
                        "app uses 0.5, but the CLI's primary use is reconstruction)", metavar="R")
    p.add_argument("--protect-rate", dest="protect_rate", type=float, default=0.2,
                   help="rvc: consonant/breath protection 0-0.5 (default 0.2 — favors "
                        "cleanup; raise toward 0.33 if sibilants get harsh)", metavar="R")
    p.add_argument("--f0-method", dest="f0_method",
                   choices=["rmvpe", "crepe", "crepe-tiny", "fcpe"], default="rmvpe",
                   help="rvc: pitch extraction (default rmvpe — best for narration; crepe is music)")
    p.add_argument("--chunk-seconds", dest="chunk_seconds", type=float, default=600.0,
                   help="rvc: silence-chunk length for memory-safe conversion (default 600). "
                        "A single convert-dir over a multi-hour file OOMs; chunks are recycled.",
                   metavar="SEC")
    p.add_argument("--batch-size", dest="batch_size", type=int, default=4,
                   help="rvc: chunks per worker process before it's recycled to free memory "
                        "(default 4 — bounds peak unified-memory).", metavar="N")

    p.group("Correct sentences (--retake)",
            "The app's Correct Sentences panel: five exported functions, one per --retake-action.")
    p.add_argument("--retake-action", dest="retake_action", default="list",
                   choices=["list", "retake", "commit", "revert", "cleanup"],
                   help="--retake: which of the panel's five doors to open (default list)")
    p.add_argument("--indices", help="--retake-action retake: sentence indices, e.g. 12,40",
                   metavar="LIST")
    p.add_argument("--takes", type=int, default=None,
                   help="--retake-action retake: how many fresh takes per sentence (default 3)",
                   metavar="N")
    p.add_argument("--index", type=int, default=None,
                   help="--retake-action commit/revert: the sentence index. "
                        "--retake-action list: the index to start listing from", metavar="N")
    p.add_argument("--count", type=int, default=None,
                   help="--retake-action list: how many cues to print (default 20)", metavar="N")
    p.add_argument("--take", help="--retake-action commit: the approved take's .flac path",
                   metavar="FILE")
    p.add_argument("--sentence-text", dest="sentence_text",
                   help="--retake: the DISPLAY text to render/commit instead of the book's "
                        "words. Absent means the words did not change, which is a different act "
                        "from changing them to the same string", metavar="STR")

    p.group("Processing passes (--pass)",
            "processing-chain.planProcessingChain + processing-passes.runProcessingPass - the pair\n"
            "queue-steps/pass.ts calls. The provider/model flags are under Settings and environment.")
    p.add_argument("--kind", choices=["simplify", "translate", "footnote-refs"],
                   help="--pass: which processing pass to run over the project's book")
    p.add_argument("--family", help="--pass/--narration-text: which book chain, by id or by the "
                                    "stem of the file it was minted from. Required only when the "
                                    "project holds more than one", metavar="ID")
    p.add_argument("--source-lang", dest="source_lang",
                   help="--pass --kind translate: the language the book is in", metavar="CODE")
    p.add_argument("--target-lang", dest="target_lang",
                   help="--pass --kind translate: the language to translate it into",
                   metavar="CODE")
    p.add_argument("--translation-prompt", dest="translation_prompt",
                   help="--pass --kind translate: file whose contents REPLACE the default "
                        "translation prompt", metavar="FILE")

    p.group("AI cleanup / simplify",
            "ai-bridge.cleanupEpub over a LOOSE epub: file in, file out, no project record. The\n"
            "provider, model, key and Ollama URL are under Settings and environment; --temperature\n"
            "is the model temperature here.")
    p.add_argument("--output-dir", dest="output_dir",
                   help="AI: output dir for cleaned.epub/simplified.epub (default: alongside input)",
                   metavar="DIR")
    p.add_argument("--simplify-mode", dest="simplify_mode",
                   choices=["dejargon", "destiffen", "learner"],
                   help="--ai-simplify mode: dejargon (academic) / destiffen (translated) / learner (B1-B2)")
    p.add_argument("--no-cleanup", dest="no_cleanup", action="store_true",
                   help="--ai-simplify: simplify ONLY, skip the OCR-cleanup pass (default: also clean)")
    p.add_argument("--stages", dest="stages", choices=["ocr", "tts", "both"],
                   help="--ai-cleanup: which passes to run. ocr = scanner-damage repair only "
                        "(-> repaired.epub); tts = footnote/quote/number prep only "
                        "(-> cleaned.epub, seconds); both = repair then prep. REQUIRED")
    p.add_argument("--custom-instructions", dest="custom_instructions",
                   help="AI: extra instructions appended to the prompt", metavar="STR")
    p.add_argument("--detailed-cleanup", dest="detailed_cleanup", action="store_true",
                   help="AI: enable the detailed-cleanup pass (app parity: useDetailedCleanup)")
    p.add_argument("--cleanup-prompt", dest="cleanup_prompt",
                   help="AI: file whose contents REPLACE the default cleanup prompt",
                   metavar="FILE")
    p.add_argument("--chunk-size", dest="chunk_size", type=int,
                   help="AI: override prose chunk size in chars (testing; default 8000)",
                   metavar="N")
    p.add_argument("--parallel-workers", dest="parallel_workers", type=int,
                   help="AI (cloud only): concurrent chunk workers (ollama/local are always sequential)",
                   metavar="N")
    p.add_argument("--no-parallel", dest="no_parallel", action="store_true",
                   help="AI: force sequential chunk processing")
    p.add_argument("--test-mode", dest="test_mode", action="store_true",
                   help="AI: process only the first N chunks (default 5)")
    p.add_argument("--test-chunks", dest="test_chunks", type=int,
                   help="AI: N chunks for --test-mode (default 5)", metavar="N")

    p.group("Foundry (--generate-epub, --clean)",
            "foundry vlm-convert (--generate-epub) and the hosted window's Clean text press\n"
            "(--clean, --clean-lines). --model/--ollama override what the dialog seeds itself from.")
    p.add_argument("--readings", choices=["fresh", "reuse"],
                   help="--generate-epub: what to do with the page answers already banked for "
                        "this PDF. fresh = archive them and read the whole book again; reuse = "
                        "answer out of the bank (resume an interrupted run, or rebuild a finished "
                        "one). Omitted means reuse, which is what a job carrying no choice means "
                        "in the app (shared/vlm/readings-bank.ts)")
    p.add_argument("--destination", choices=["replace", "new-copy"],
                   help="--generate-epub: where the book lands. replace (default) makes the "
                        "reading this project's book and mints a fresh working copy from it; "
                        "new-copy adds it as another archive file with a working chain of its "
                        "own and leaves the existing book untouched")
    p.add_argument("--variant-id", dest="variant_id",
                   help="--generate-epub: which PDF version to read, for a project holding more "
                        "than one (a project with two PDFs and no choice is refused, not guessed)",
                   metavar="ID")
    p.add_argument("--source-pdf", dest="source_pdf",
                   help="--generate-epub: the PDF to read, by path. Must be inside the project",
                   metavar="FILE")
    p.add_argument("--skip-deleted-pages", dest="skip_deleted_pages", action="store_true",
                   help="--generate-epub: leave out the pages the WORKING COPY marks deleted "
                        "(the app's 'Create EPUB' on the working-copy row). Refused by name when "
                        "the project has no working copy")
    p.add_argument("--vlm-endpoint", dest="vlm_endpoint",
                   help="--generate-epub: OpenAI-compatible base URL that reads the pages, e.g. "
                        "http://127.0.0.1:8000/v1. Omitted = this machine's own route (the WSL "
                        "vLLM reader on Windows, MLX on an Apple Silicon Mac)", metavar="URL")
    p.add_argument("--vlm-endpoint-model", dest="vlm_endpoint_model",
                   help="--generate-epub: model name to request from --vlm-endpoint "
                        "(default: foundry's own registry entry for it)", metavar="NAME")
    p.add_argument("--vlm-concurrency", dest="vlm_concurrency", type=int, default=None,
                   help="--generate-epub: pages in flight at the endpoint (default: foundry's own)",
                   metavar="N")
    p.add_argument("--foundry-project", dest="foundry_project",
                   help="--clean: the Foundry project dir directly, instead of resolving it "
                        "from --project's manifest", metavar="DIR")
    p.add_argument("--foundry-dist", dest="foundry_dist",
                   help="--clean: which built Foundry to drive (default: foundry-app/dist, "
                        "the build the running app executes)", metavar="DIR")
    p.add_argument("--concurrency", type=int, default=None,
                   help="--clean: blocks in flight at once (default: the engine's own, 4). "
                        "Changes the speed, never the text.", metavar="N")
    p.add_argument("--ollama", help="--clean: the Ollama endpoint (default: app-settings ollamaUrl)",
                   metavar="URL")
    p.add_argument("--keep-model", dest="keep_model", action="store_true",
                   help="--clean-lines / --clean: leave the model loaded when the run ends "
                        "(default: the weights are released)")
    p.add_argument("--output", help="--clean-lines: where the cleaned lines go (default: <input>.cleaned.txt beside it)",
                   metavar="FILE")

    p.group("Sentences (--generate-sentences)",
            "Audio -> a sentence VTT. Everything below --epub is epub-align only and refused\n"
            "without it, because whisper mode has no ebook to be truth.")
    p.add_argument("--audio", help="generate-sentences: audio file (m4b/mp3/wav)", metavar="FILE")
    p.add_argument("--epub", help="generate-sentences: epub whose TEXT becomes the transcript "
                                  "(switches to epub-align: WhisperX timing, book-as-truth)",
                   metavar="FILE")
    p.add_argument("--whisper-model", dest="whisper_model",
                   choices=["tiny", "base", "small", "medium", "large-v3", "distil-large-v3"],
                   help="generate-sentences (whisper mode): model size (default small)")
    p.add_argument("--device", choices=["auto", "cpu", "mps", "cuda"],
                   help="generate-sentences: compute device (default auto, both modes). "
                        "whisper mode picks the faster-whisper device directly. epub-align "
                        "forwards it to align_audiobook.py (auto -> CUDA/MPS/CPU); the "
                        "wav2vec2 forced-align runs there, the rough transcribe stays CPU. "
                        "Use --device cpu to keep epub-align off a busy GPU.")
    p.add_argument("--embed", action="store_true",
                   help="generate-sentences: also seal the VTT into the m4b as a subtitle "
                        "track (mov_text, verified read-back) — the app's embed-only model")
    p.add_argument("--report", nargs="?", const="", default=None,
                   help="generate-sentences (epub-align only): also write a coverage JSON — "
                        "epub sentence runs the narrator never read, and audio ranges with no "
                        "epub match (ads/intros), each with text + timestamp anchors. "
                        "Optional path (default: <out>.coverage.json)", metavar="FILE")
    p.add_argument("--min-hole", dest="min_hole", type=float, default=None,
                   help="generate-sentences (epub-align only): minimum unmatched-audio duration "
                        "in seconds treated as a hole — drives both the --report entries and "
                        "whisper-fallback cue filling (default 30). 0 = catch EVERY gap and "
                        "fill each with whisper cues", metavar="SEC")
    p.add_argument("--rough-cache", dest="rough_cache", nargs="?", const="", default=None,
                   help="generate-sentences (epub-align only): cache the rough whisper transcript "
                        "so re-runs skip the ~30-40 min transcribe pass while iterating on the "
                        "align stage. Optional path (default: <out>.roughcache.json next to the VTT). "
                        "Opt-in — omit for no caching",
                   metavar="FILE")
    p.add_argument("--align-workers", dest="align_workers", type=int, default=None,
                   help="generate-sentences (epub-align only): parallel wav2vec2 align worker "
                        "count. Omit to auto-size (conservative: reserves 12GB headroom for a "
                        "concurrent WSL vLLM lane, so it may pick 1 worker even with RAM free). "
                        "Each worker budgets ~5GB and the pool self-shrinks under memory pressure; "
                        "raise this only when the GPU/WSL lane is known idle",
                   metavar="N")
    p.add_argument("--snap-silence", dest="snap_silence", type=float, default=None,
                   help="generate-sentences (epub-align only): pull each cue seam onto the middle "
                        "of the nearest detected silence within this many seconds (default 0.6). "
                        "Bounded, so a snap can correct a CTC-frame boundary but can never create "
                        "drift", metavar="SEC")
    p.add_argument("--no-snap-silence", dest="no_snap_silence", action="store_true",
                   help="generate-sentences (epub-align only): keep the raw forced-alignment cue "
                        "times (pre-2026-09-03 behavior)")
    p.add_argument("--no-paragraph-split", dest="no_paragraph_split", action="store_true",
                   help="generate-sentences (epub-align only): segment the ebook on punctuation "
                        "only (pre-2026-09-03). The default also splits on block boundaries, so an "
                        "unpunctuated heading gets its own NOTE-tagged cue instead of being glued "
                        "onto the prose that follows it")
    p.add_argument("--report-min-hole", dest="report_min_hole", type=float, default=None,
                   help="generate-sentences (epub-align only): list unmatched-audio ranges this "
                        "long in the coverage report. Defaults to --min-hole, i.e. changes nothing "
                        "unless you ask. Report-only — --min-hole still governs whisper-fallback "
                        "cues in the VTT. NOTE it measures 'cue longer than a slow reading of its "
                        "text', not literal unmatched audio, so low values fire on brisk "
                        "narration; for measured dead air read lowSpeechCues in the report",
                   metavar="SEC")

    p.group("Settings and environment (all commands)",
            "The flags several commands share, and the process-env seams the compiled pipeline\n"
            "reads. --config names the settings file whose aliases and defaults fill anything\n"
            "not typed (explicit flags always win).")
    p.add_argument("--config", help="CLI settings file (aliases + defaults). "
                   "Default search: $BOOKFORGE_CLI_CONFIG, cli/bookforge-cli.json, ~/.bookforge-cli.json",
                   metavar="FILE")
    p.add_argument("--dry-run", dest="dry_run", action="store_true",
                   help="print the resolved spawn + env overrides and exit (no GPU)")
    p.add_argument("--language", default="en", help="language code (default en)", metavar="CODE")
    p.add_argument("--tier", choices=["auto", "extreme", "fast", "moderate", "light"],
                   help="GPU memory tier (default: auto — safe-sized to free VRAM)")
    p.add_argument("--sentence-gap", dest="sentence_gap", type=float,
                   help="deterministic inter-clip gap in seconds (tts path; default 0.6)",
                   metavar="SEC")
    p.add_argument("--temperature", type=float, default=None,
                   help="sampling temperature. TTS: Orpheus (default 0.6; higher = livelier "
                        "prosody, more runaway risk). AI cleanup/simplify: model temperature "
                        "(default 0.1 clamp; 0=deterministic). Consumed by whichever mode runs.",
                   metavar="T")
    p.add_argument("--orpheus-install", dest="orpheus_install",
                   help="override the e2a/Orpheus install path the worker uses", metavar="PATH")
    p.add_argument("--conda-env", dest="conda_env",
                   help="override the WSL conda env for Orpheus", metavar="NAME")
    p.add_argument("--provider", choices=["claude", "openai", "ollama", "local"],
                   help="AI provider for --ai-cleanup/--ai-simplify")
    p.add_argument("--model", help="AI model name (claude/openai/ollama model; local resolves its own)",
                   metavar="NAME")
    p.add_argument("--api-key", dest="api_key",
                   help="cloud API key (else ANTHROPIC_API_KEY/OPENAI_API_KEY env). Passed via env, not argv",
                   metavar="KEY")
    p.add_argument("--ollama-url", dest="ollama_url",
                   help="AI: Ollama base URL (default http://localhost:11434; env OLLAMA_BASE_URL)",
                   metavar="URL")

    return p


def _epilog():
    """The siblings, then one canonical line per command.

    The sibling adapters keep argument grammars of their own (verbs, repeated
    --file), so they are run directly rather than wrapped in this flat flag
    namespace — which would mean inventing a second spelling for every option they
    already have. Naming them here is what makes `--help` list every action this
    CLI can reach, not only the ones argparse owns.
    """
    siblings = "Sibling adapters (their own grammars — run them directly):\n" + "".join(
        f"  node {name}\n      {what}\n" for name, what in SIBLING_ADAPTERS.items())
    lines = ["", "Examples (one per command; `--<command> --help` has more):"]
    for name in COMMANDS:
        first = COMMAND_FLAGS[name]["examples"][0].split("\n")
        lines += [f"  {row}" for row in first if not row.lstrip().startswith("#")]
    return siblings + "\n".join(lines) + (
        "\n\nOne command's flags, refusals and examples on their own:"
        "\n  bookforge-tts --<command> --help\n")


def build_parser():
    """The parser a run is parsed by — every flag, grouped by who reads it.

    THE USAGE LINE IS STATED, not generated. Argparse's own ran 72 lines — every
    selector and every option, run together — which is the artefact Owen was
    looking at on 2026-09-12 when he asked for a CLI that says how to use it. It
    was also reprinted in front of every error message. One line naming the shape,
    pointing at the groups below, carries everything it did.
    """
    return _flag_registry().parser(
        description=__doc__, epilog=_epilog(),
        usage="bookforge-tts --<command> [options]\n"
              "       exactly one command is required — they are listed first, under\n"
              "       \"Commands (pick one)\". For one command on its own:\n"
              "       bookforge-tts --<command> --help")


def _command_help(name):
    """Print ONE command's page: usage, what it drives, its flags, its refusals,
    its examples. Generated from COMMAND_FLAGS + the same registrations."""
    spec = COMMAND_FLAGS[name]
    # Wrapped at the page's own width, with a hanging indent, so one long reason
    # cannot push the flag list off the screen it was meant to fit on.
    refused = "".join(
        textwrap.fill(f"refused: {flag} — {why}", width=98,
                      initial_indent="  ", subsequent_indent="           ") + "\n"
        for flag, why in spec["refuses"])
    epilog = ""
    if refused:
        epilog += "\nRefused by name (the flag is wrong for this door, not ignored):\n" + refused
    epilog += "\nExamples:\n" + "\n".join(
        "\n".join(f"  {row}" for row in ex.split("\n")) for ex in spec["examples"])
    epilog += ("\n\nEvery flag's full help, and every other command:  bookforge-tts --help\n"
               "Nothing here is reimplemented — these drive the app's own compiled code\n"
               "(the contract is tools/test-cli-parity.js).\n")
    parser = _flag_registry().parser(
        description=spec["doc"], epilog=epilog, usage=spec["usage"],
        # The command's own selector is NOT in the list: the usage line above
        # already carries it, and a one-row "Commands (pick one)" group repeating
        # the description three lines higher is the padding this page exists to cut.
        keep=set(spec["reads"]), brief=True, width=100)
    parser.print_help()


def _per_command_help(argv):
    """`bookforge-tts --tts --help` — in either order — is --tts's own page.

    TWO selectors plus --help is the ordinary full help: naming two commands is
    already an error this CLI states, and picking one of them to explain would
    answer a question nobody asked.
    """
    if not any(a in ("-h", "--help") for a in argv):
        return False
    picked = [n for n in COMMANDS if f"--{n}" in argv]
    if len(picked) != 1:
        return False
    _command_help(picked[0])
    return True


def main():
    # `bookforge-tts --tts --help` is --tts's OWN page, and is answered before
    # argparse sees the line: argparse's --help is the whole flat list, which is
    # exactly the page a reader asking about one command did not want.
    if _per_command_help(sys.argv[1:]):
        return 0
    args = build_parser().parse_args()
    # Resolve the CLI settings file (aliases + defaults) BEFORE dispatch, so the command
    # handlers see filled-in args. Explicit CLI flags always win.
    settings, _cfg = _load_cli_settings(args.config)
    _apply_cli_settings(args, settings)
    # argparse maps --ai-cleanup -> args.ai_cleanup; normalize dashes to match.
    selected = [n for n in COMMANDS if getattr(args, n.replace("-", "_"))]
    _require(len(selected) == 1,
             f"specify exactly one command flag, e.g. --tts "
             f"(got {len(selected)}: {' '.join('--' + n for n in selected) or 'none'}). "
             f"`bookforge-tts --help` lists all {len(COMMANDS)}; "
             f"`bookforge-tts --<command> --help` explains one")
    sys.exit(COMMANDS[selected[0]](args))


if __name__ == "__main__":
    main()
