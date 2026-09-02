#!/usr/bin/env python3
r"""bookforge-tts — run TTS (and later other) jobs THROUGH BookForge's built
pipeline, from the command line, without launching the app.

Why this exists: BookForge's Orpheus render path is a "well-oiled machine" — WSL
wedge-proofing (TERM->verify->`wsl -t` kill ladder, wedge latch, never-SIGKILL a
guest GPU proc), vLLM `gpu_memory_utilization` memory tiers + safe GPU sizing, and
custom-model resolution — all living in its compiled TypeScript. Reimplementing any
of that in an outer script would drift from the real thing. So this CLI does NOT
reimplement it: it drives the actual compiled worker pool (via cli/orpheus-render.js
under an electron shim). BookForge must be BUILT (dist/electron present) but need
NOT be running.

    bookforge-tts --tts --engine=orpheus --voice=rohan \
        --input passage.txt --out sample.wav [--tier fast]

Commands are a registry (COMMANDS) so adding e.g. --ai-cleanup later is one entry;
every job-level flag a real TTS job takes is passed straight through to the engine
adapter. Nothing is silently defaulted — a missing required arg fails loudly.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent          # cli/ -> bookforge root
NODE_STUB = REPO_ROOT / "cli" / "electron-stub.js"
ORPHEUS_STREAM = REPO_ROOT / "cli" / "orpheus-stream.js"        # streaming path (Listen/extension)
ORPHEUS_BATCH = REPO_ROOT / "cli" / "orpheus-batch-render.js"   # audiobook/batch path (default)
ORPHEUS_AUDIOBOOK = REPO_ROOT / "cli" / "orpheus-audiobook-render.js"  # full M4B: tts + reassembly
NARRATION_PREP = REPO_ROOT / "cli" / "narration-prep.js"        # narration door: cut + numbers
AI_CLEAN = REPO_ROOT / "cli" / "ai-clean.js"                    # AI cleanup / simplify (ai-bridge)
GEN_SENTENCES = REPO_ROOT / "cli" / "generate-sentences.js"     # audio -> VTT (whisper / epub-align)
RVC_CONVERT = REPO_ROOT / "cli" / "rvc-convert.js"              # whole-file RVC voice conversion
GENERATE_EPUB = REPO_ROOT / "cli" / "generate-epub.js"          # PDF -> EPUB (foundry vlm-convert)


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
                "api_key", "ollama_url", "cleanup_prompt"}
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
    _require(args.engine == "orpheus",
             f"--engine '{args.engine}' not wired yet (only 'orpheus')")
    _require(args.mode in ("tts", "streaming"),
             f"--mode '{args.mode}' invalid (use 'tts' or 'streaming')")
    _require(bool(args.voice), "--voice <id> is required for --tts")
    _require(bool(args.out), "--out <file.wav> is required for --tts")
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
    if input_path:
        cmd += ["--input", input_path]
    if args.text:
        cmd += ["--text", args.text]
    if args.language:
        cmd += ["--language", args.language]
    if args.model_dir:
        cmd += ["--model-dir", args.model_dir]
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
    if args.max_chars:                 # packing cap (tts path; read at prep by core.py)
        env["ORPHEUS_MAX_CHARS"] = str(args.max_chars)
    if args.temperature is not None:   # sampling overrides (worker; orpheus.py defaults
        env["ORPHEUS_TEMPERATURE"] = str(args.temperature)  # 0.6/0.8/1.1 rule otherwise)
    if args.top_p is not None:
        env["ORPHEUS_TOP_P"] = str(args.top_p)
    if args.min_p is not None:
        env["ORPHEUS_MIN_P"] = str(args.min_p)
    if args.rep_penalty is not None:
        env["ORPHEUS_REP_PENALTY"] = str(args.rep_penalty)

    if args.dry_run:
        print(f"[bookforge-tts] DRY RUN — mode={args.mode}, no GPU touched")
        print("  spawn:", " ".join(cmd))
        overrides = {k: env[k] for k in (
            "EBOOK2AUDIOBOOK_PATH", "BOOKFORGE_ORPHEUS_MODELS_DIR",
            "ORPHEUS_MEMORY_TIER", "WSL_ORPHEUS_CONDA_ENV", "ORPHEUS_SENTENCE_GAP",
            "ORPHEUS_MAX_CHARS", "ORPHEUS_TEMPERATURE", "ORPHEUS_TOP_P", "ORPHEUS_REP_PENALTY",
        ) if k in env}
        print("  env overrides:", overrides or "(none)")
        return 0

    print(f"[bookforge-tts] tts/orpheus mode={args.mode} ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=env)


def cmd_audiobook(args):
    """Build a FULL audiobook (M4B) through BookForge's REAL pipeline, headless.

    This is the app-faithful path: it chains the exact two high-level calls the app's
    queue makes for a standard audiobook —
        1. renderRangeHeadless()  (parallel-tts-bridge) — the tts-conversion core
        2. startReassembly()      (reassembly-bridge)   — the reassembly job
    — producing <project>/output/audiobook.m4b (+ audiobook.vtt) with chapters, cover,
    and metadata. Unlike `--tts` (which flat-concats to a bare WAV for quick voice
    tests), this reproduces the shipped pipeline end to end, so it's a real headless
    test of the audiobook path. Input EPUB is resolved from the project like the app's
    "Latest" (translated > cleaned > exported > original); override with --input.
    """
    _require(args.engine == "orpheus",
             f"--engine '{args.engine}' not wired yet (only 'orpheus')")
    _require(bool(args.project), "--project <projectDir> is required for --audiobook")
    _require(bool(args.voice), "--voice <id> is required for --audiobook")
    _require(bool(shutil.which("node")), "node not found on PATH")
    _require(ORPHEUS_AUDIOBOOK.is_file(), f"missing engine adapter {ORPHEUS_AUDIOBOOK}")
    for js in ("parallel-tts-bridge.js", "reassembly-bridge.js", "manifest-service.js"):
        _require((REPO_ROOT / "dist" / "electron" / js).is_file(),
                 f"BookForge is not built — run `npx tsc -p tsconfig.electron.json` first "
                 f"(dist/electron/{js} missing)")

    project_dir = str(Path(args.project).resolve())
    _require((Path(project_dir) / "manifest.json").is_file(),
             f"not a BookForge project (no manifest.json): {project_dir}")

    cmd = ["node", "--require", str(NODE_STUB), str(ORPHEUS_AUDIOBOOK),
           "--project", project_dir, "--voice", args.voice]
    if args.input:
        cmd += ["--input", str(Path(args.input).resolve())]
    if args.language:
        cmd += ["--language", args.language]
    if args.model_dir:
        cmd += ["--model-dir", args.model_dir]
    if args.keep_session:
        cmd += ["--keep-session"]
    if args.fresh:
        cmd += ["--fresh"]

    # Final-audio denoise (BookForge's block-based roformer pass over the rendered
    # sentences — its own step since 2026-08-29, run between generation and assembly;
    # the adapter this argv drives makes the call). Default follows the engine:
    # Orpheus voices are trained on a deliberate
    # faint hiss bed the render reproduces, so denoise is ON for orpheus and OFF for
    # everything else. An explicit flag wins either way. Always pass exactly one flag
    # so the spawn line is self-documenting.
    _require(not (args.final_denoise and args.no_final_denoise),
             "--final-denoise and --no-final-denoise are mutually exclusive")
    if args.no_final_denoise:
        final_denoise = False
    elif args.final_denoise:
        final_denoise = True
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
    # The denoise choice travels as config through startReassembly (argv above), never
    # via env. e2a still honors a FINAL_DENOISE env var as a dormant manual escape
    # hatch (its own afftdn pass) — scrub any inherited value so a shell export can't
    # stack that on top (the assembly spawn env is built from process.env).
    env.pop("FINAL_DENOISE", None)

    if args.dry_run:
        print("[bookforge-tts] DRY RUN — audiobook (tts + reassembly), no GPU touched")
        print("  spawn:", " ".join(cmd))
        overrides = {k: env[k] for k in (
            "EBOOK2AUDIOBOOK_PATH", "BOOKFORGE_ORPHEUS_MODELS_DIR", "ORPHEUS_MEMORY_TIER",
            "WSL_ORPHEUS_CONDA_ENV", "ORPHEUS_SENTENCE_GAP", "ORPHEUS_MAX_CHARS",
            "ORPHEUS_TEMPERATURE", "ORPHEUS_TOP_P", "ORPHEUS_REP_PENALTY",
        ) if k in env}
        print("  env overrides:", overrides or "(none)")
        return 0

    print("[bookforge-tts] audiobook/orpheus ->", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=str(REPO_ROOT), env=env)


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

    if args.dry_run:
        print("[bookforge-tts] DRY RUN — narration prep (cut + numbers), no model loaded")
        print("  spawn:", " ".join(cmd))
        return 0

    if args.input:
        _require(Path(args.input).is_file(), f"input file not found: {args.input}")

    print("[bookforge-tts] narration prep ->", " ".join(cmd), flush=True)
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


# Command registry — one entry per job. Flags are generated from the keys, so adding a
# command is a single line here plus its cmd_* handler.
COMMANDS = {
    "tts": cmd_tts,
    "audiobook": cmd_audiobook,
    # The narration door on its own. Distinct from --ai-cleanup below: that is the
    # OCR/model book-repair pass, this is what the narrator is handed.
    "prep": cmd_prep,
    "ai-cleanup": cmd_ai_cleanup,
    "ai-simplify": cmd_ai_simplify,
    "generate-sentences": cmd_generate_sentences,
    "generate-epub": cmd_generate_epub,
    "rvc": cmd_rvc,
}


def build_parser():
    p = argparse.ArgumentParser(prog="bookforge-tts", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", help="CLI settings file (aliases + defaults). "
                   "Default search: $BOOKFORGE_CLI_CONFIG, cli/bookforge-cli.json, ~/.bookforge-cli.json")
    for name in COMMANDS:                         # command selector flags
        p.add_argument(f"--{name}", action="store_true",
                       help=f"run the '{name}' command")
    p.add_argument("--engine", default="orpheus", help="TTS engine (default orpheus)")
    p.add_argument("--mode", default="tts", choices=["tts", "streaming"],
                   help="render path: 'tts' = audiobook/batch (default, the shipped path), "
                        "'streaming' = Listen (one sentence per vLLM sequence)")
    p.add_argument("--language", default="en", help="language code (default en)")
    p.add_argument("--voice", help="voice id (a BookForge models.json id / model folder)")
    p.add_argument("--voice-token", dest="voice_token", help="prompt token override (tts mode only)")
    p.add_argument("--read-ahead", dest="read_ahead", type=int, default=None,
                   help="streaming: how many following blocks to read ahead "
                        "(default: all of them, as the extension does)")
    p.add_argument("--model-dir", dest="model_dir",
                   help="custom model directory (overrides voice resolution)")
    p.add_argument("--models-dir", dest="models_dir",
                   help="override the Orpheus models directory to discover voices in")
    p.add_argument("--input", help="text file to render (--tts); EPUB override (--audiobook); "
                   "the .epub or .txt to prep (--prep)")
    p.add_argument("--text", help="literal text to render")
    p.add_argument("--out", help="output .wav path")
    p.add_argument("--project", help="BookForge project dir. --audiobook: output lands in "
                   "<project>/output/audiobook.m4b (input EPUB resolved like the app's 'Latest'). "
                   "--generate-epub: the project whose PDF is read into its book. "
                   "--prep: the project whose book is prepped (same 'Latest' resolution)")
    p.add_argument("--tier", choices=["auto", "extreme", "fast", "moderate", "light"],
                   help="GPU memory tier (default: auto — safe-sized to free VRAM)")
    p.add_argument("--sentence-gap", dest="sentence_gap", type=float,
                   help="deterministic inter-clip gap in seconds (tts path; default 0.6)")
    p.add_argument("--temperature", type=float, default=None,
                   help="sampling temperature. TTS: Orpheus (default 0.6; higher = livelier "
                        "prosody, more runaway risk). AI cleanup/simplify: model temperature "
                        "(default 0.1 clamp; 0=deterministic). Consumed by whichever mode runs.")
    p.add_argument("--top-p", dest="top_p", type=float, default=None,
                   help="tts: Orpheus nucleus sampling top_p (default 0.8)")
    p.add_argument("--min-p", dest="min_p", type=float, default=None,
                   help="tts: Orpheus min_p — drop tokens below this fraction of the top "
                        "token's probability (default 0 = off; vLLM + MLX batch paths). "
                        "Cuts the rare-junk tail without flattening variety like lowering top_p")
    p.add_argument("--rep-penalty", dest="rep_penalty", type=float, default=None,
                   help="tts: Orpheus repetition penalty (default 1.1)")
    p.add_argument("--max-chars", dest="max_chars", type=int,
                   help="Orpheus packing cap in chars (tts path; default 350, no sentence "
                        "cap — ear-validated for EOS-safe ≤20s/2048-recipe voices; 450 "
                        "fails everywhere. The packed-runaway was the long-clip TRAINING "
                        "recipe, not packing)")
    p.add_argument("--keep-sentences", dest="keep_sentences", action="store_true",
                   help="tts path: also copy the per-sentence FLACs to <out>.sentences/")
    p.add_argument("--keep-session", dest="keep_session", action="store_true",
                   help="tts path: keep the scratch session dirs (default: cleaned after concat)")
    p.add_argument("--fresh", action="store_true",
                   help="--audiobook: ignore any cached session and re-render from scratch "
                        "(default: resume — skip sentences already rendered in a prior run)")
    p.add_argument("--final-denoise", dest="final_denoise", action="store_true",
                   help="--audiobook: force the final-audio denoise pass ON (block-based "
                        "roformer over the rendered sentences, pre-assembly; strips the "
                        "hiss bed hiss-trained voices reproduce). Default: on for "
                        "--engine orpheus, off for every other engine")
    p.add_argument("--no-final-denoise", dest="no_final_denoise", action="store_true",
                   help="--audiobook: force the final-audio denoise pass OFF")
    p.add_argument("--dry-run", dest="dry_run", action="store_true",
                   help="print the resolved spawn + env overrides and exit (no GPU)")
    p.add_argument("--orpheus-install", dest="orpheus_install",
                   help="override the e2a/Orpheus install path the worker uses")
    p.add_argument("--conda-env", dest="conda_env",
                   help="override the WSL conda env for Orpheus")
    # --- AI cleanup / simplify (--ai-cleanup, --ai-simplify) ---
    p.add_argument("--provider", choices=["claude", "openai", "ollama", "local"],
                   help="AI provider for --ai-cleanup/--ai-simplify")
    p.add_argument("--model", help="AI model name (claude/openai/ollama model; local resolves its own)")
    p.add_argument("--api-key", dest="api_key",
                   help="cloud API key (else ANTHROPIC_API_KEY/OPENAI_API_KEY env). Passed via env, not argv")
    p.add_argument("--output-dir", dest="output_dir",
                   help="AI: output dir for cleaned.epub/simplified.epub (default: alongside input)")
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
                   help="AI: extra instructions appended to the prompt")
    p.add_argument("--detailed-cleanup", dest="detailed_cleanup", action="store_true",
                   help="AI: enable the detailed-cleanup pass (app parity: useDetailedCleanup)")
    p.add_argument("--cleanup-prompt", dest="cleanup_prompt",
                   help="AI: file whose contents REPLACE the default cleanup prompt")
    p.add_argument("--chunk-size", dest="chunk_size", type=int,
                   help="AI: override prose chunk size in chars (testing; default 8000)")
    p.add_argument("--ollama-url", dest="ollama_url",
                   help="AI: Ollama base URL (default http://localhost:11434; env OLLAMA_BASE_URL)")
    # --- PDF -> EPUB conversion (--generate-epub) ---
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
                        "than one (a project with two PDFs and no choice is refused, not guessed)")
    p.add_argument("--source-pdf", dest="source_pdf",
                   help="--generate-epub: the PDF to read, by path. Must be inside the project")
    p.add_argument("--skip-deleted-pages", dest="skip_deleted_pages", action="store_true",
                   help="--generate-epub: leave out the pages the WORKING COPY marks deleted "
                        "(the app's 'Create EPUB' on the working-copy row). Refused by name when "
                        "the project has no working copy")
    p.add_argument("--vlm-endpoint", dest="vlm_endpoint",
                   help="--generate-epub: OpenAI-compatible base URL that reads the pages, e.g. "
                        "http://127.0.0.1:8000/v1. Omitted = this machine's own route (the WSL "
                        "vLLM reader on Windows, MLX on an Apple Silicon Mac)")
    p.add_argument("--vlm-endpoint-model", dest="vlm_endpoint_model",
                   help="--generate-epub: model name to request from --vlm-endpoint "
                        "(default: foundry's own registry entry for it)")
    p.add_argument("--vlm-concurrency", dest="vlm_concurrency", type=int, default=None,
                   help="--generate-epub: pages in flight at the endpoint (default: foundry's own)")
    # --- sentence generation (--generate-sentences) ---
    p.add_argument("--audio", help="generate-sentences: audio file (m4b/mp3/wav)")
    p.add_argument("--epub", help="generate-sentences: epub whose TEXT becomes the transcript "
                                  "(switches to epub-align: WhisperX timing, book-as-truth)")
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
                        "Optional path (default: <out>.coverage.json)")
    p.add_argument("--min-hole", dest="min_hole", type=float, default=None,
                   help="generate-sentences (epub-align only): minimum unmatched-audio duration "
                        "in seconds treated as a hole — drives both the --report entries and "
                        "whisper-fallback cue filling (default 30). 0 = catch EVERY gap and "
                        "fill each with whisper cues")
    p.add_argument("--rough-cache", dest="rough_cache", nargs="?", const="", default=None,
                   help="generate-sentences (epub-align only): cache the rough whisper transcript "
                        "so re-runs skip the ~30-40 min transcribe pass while iterating on the "
                        "align stage. Optional path (default: <out>.roughcache.json next to the VTT). "
                        "Opt-in — omit for no caching")
    p.add_argument("--align-workers", dest="align_workers", type=int, default=None,
                   help="generate-sentences (epub-align only): parallel wav2vec2 align worker "
                        "count. Omit to auto-size (conservative: reserves 12GB headroom for a "
                        "concurrent WSL vLLM lane, so it may pick 1 worker even with RAM free). "
                        "Each worker budgets ~5GB and the pool self-shrinks under memory pressure; "
                        "raise this only when the GPU/WSL lane is known idle")
    p.add_argument("--parallel-workers", dest="parallel_workers", type=int,
                   help="AI (cloud only): concurrent chunk workers (ollama/local are always sequential)")
    p.add_argument("--no-parallel", dest="no_parallel", action="store_true",
                   help="AI: force sequential chunk processing")
    p.add_argument("--test-mode", dest="test_mode", action="store_true",
                   help="AI: process only the first N chunks (default 5)")
    p.add_argument("--test-chunks", dest="test_chunks", type=int,
                   help="AI: N chunks for --test-mode (default 5)")
    # --- RVC voice conversion (--rvc). Reuses --input (audio) and --out (result). ---
    p.add_argument("--rvc-model", dest="rvc_model",
                   help="rvc: voice-model folder name (e.g. deathstalker_rvc_v1)")
    p.add_argument("--index-rate", dest="index_rate", type=float, default=0.0,
                   help="rvc: index influence 0-1 (default 0.0 — same-voice cleanup; the "
                        "app uses 0.5, but the CLI's primary use is reconstruction)")
    p.add_argument("--protect-rate", dest="protect_rate", type=float, default=0.2,
                   help="rvc: consonant/breath protection 0-0.5 (default 0.2 — favors "
                        "cleanup; raise toward 0.33 if sibilants get harsh)")
    p.add_argument("--f0-method", dest="f0_method",
                   choices=["rmvpe", "crepe", "crepe-tiny", "fcpe"], default="rmvpe",
                   help="rvc: pitch extraction (default rmvpe — best for narration; crepe is music)")
    p.add_argument("--chunk-seconds", dest="chunk_seconds", type=float, default=600.0,
                   help="rvc: silence-chunk length for memory-safe conversion (default 600). "
                        "A single convert-dir over a multi-hour file OOMs; chunks are recycled.")
    p.add_argument("--batch-size", dest="batch_size", type=int, default=4,
                   help="rvc: chunks per worker process before it's recycled to free memory "
                        "(default 4 — bounds peak unified-memory).")
    return p


def main():
    args = build_parser().parse_args()
    # Resolve the CLI settings file (aliases + defaults) BEFORE dispatch, so the command
    # handlers see filled-in args. Explicit CLI flags always win.
    settings, _cfg = _load_cli_settings(args.config)
    _apply_cli_settings(args, settings)
    # argparse maps --ai-cleanup -> args.ai_cleanup; normalize dashes to match.
    selected = [n for n in COMMANDS if getattr(args, n.replace("-", "_"))]
    _require(len(selected) == 1,
             "specify exactly one command flag, e.g. --tts")
    sys.exit(COMMANDS[selected[0]](args))


if __name__ == "__main__":
    main()
