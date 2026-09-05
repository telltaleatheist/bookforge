"""The flag universe of ebook2audiobook@9daab0ba's two headless entry points.

One table, three verdicts, so `compat/app.py`, `compat/worker.py`, `FLAGS.md` and
the tests all read the SAME list and cannot drift.

  ACCEPT   narrator honours it and routes on it.
  IGNORE   narrator parses it and does nothing with it, for a stated reason
           (an XTTS knob, a gradio-era switch, a dependency installer). A bridge
           that passes it keeps working; nothing silently changes behaviour.
  REFUSE   narrator raises, BY NAME, with what to do instead. Never silently
           degraded: a refused flag is one whose absence would change the OUTPUT.

Sources:
  app.py:158-166                       the base option list
  bookforge_ext/parallel/args.py:9-17  PARALLEL_OPTIONS
  worker.py:357-427                    the lightweight worker's own parser

Note that the three overlap but none contains the others: `--sentence_indices`,
`--num_takes`, `--take_temperatures` and `--sentence_overrides` exist ONLY on
`worker.py`, while `--worker_mode`, `--prep_only` and `--assemble_only` exist
only on `app.py`. `compat/app.py` accepts the UNION so one door answers both
spawn shapes; see FLAGS.md.
"""
from __future__ import annotations

ACCEPT = 'accept'
IGNORE = 'ignore'
REFUSE = 'refuse'


class FlagRefused(SystemExit):
    """A flag narrator will not honour. Exits like e2a's own argv refusals (1)."""

    def __init__(self, message: str):
        print(f'Error: {message}', flush=True)
        super().__init__(1)


#: flag -> (verdict, reason). The reason is printed for REFUSE and documented for
#: the other two.
FLAGS: dict[str, tuple[str, str]] = {
    # ---- mode selection ----------------------------------------------------
    '--headless': (IGNORE, 'narrator has no GUI, so headless is the only mode'),
    '--prep_only': (ACCEPT, 'routes to narrator.text.prep (migration step 4)'),
    '--worker_mode': (ACCEPT, 'routes to narrator.render.worker'),
    '--assemble_only': (ACCEPT, 'routes to narrator.assemble'),
    '--list_sessions': (ACCEPT, 'routes to narrator.render.session_store'),
    '--resume_session': (ACCEPT, 'routes to narrator.render.session_store'),

    # ---- the session ------------------------------------------------------
    '--session': (ACCEPT, 'the session id, echoed into the result'),
    '--session_dir': (ACCEPT, 'the ebook-<uuid> dir, or the <hash> dir under it'),
    '--sentences_dir': (
        ACCEPT,
        'the authoritative sentence store: written and skip-checked in worker '
        'mode, the sentence SOURCE in assembly'),
    '--encoded_chapters_dir': (ACCEPT, 'pre-encoded <N>.m4a chapters for assembly'),
    '--output_dir': (ACCEPT, 'where assembly writes the m4b and the VTT'),
    # NARRATOR'S OWN, like --higgs_voice: e2a never had it, and an engine
    # guarded by post-render forced alignment cannot be assembled without it
    # (review finding 4).
    '--coverage_report': (
        ACCEPT,
        "narrator's own: the report `narrator align --report` wrote. Required "
        'by an engine whose CoveragePolicy is enforced (higgs-v3); a no-op for '
        'orpheus'),

    # ---- the work range ---------------------------------------------------
    '--sentence_start': (ACCEPT, ''),
    '--sentence_end': (ACCEPT, ''),
    '--chapter_start': (ACCEPT, ''),
    '--chapter_end': (ACCEPT, ''),
    '--chapters': (ACCEPT, 'assembly chapter selection; must be a contiguous run from 1'),

    # ---- retakes (worker.py only) -----------------------------------------
    '--sentence_indices': (ACCEPT, 'routes to narrator.render.retake'),
    '--sentence_overrides': (ACCEPT, 'routes to narrator.render.retake'),
    '--num_takes': (ACCEPT, 'routes to narrator.render.retake'),
    '--take_temperatures': (ACCEPT, 'routes to narrator.render.retake'),

    # ---- the voice --------------------------------------------------------
    '--tts_engine': (
        ACCEPT,
        "SELECTS THE ENGINE: 'orpheus' or 'higgs-v3', checked on the prep, "
        "worker and retake routes and passed through to engine/registry. On "
        "--assemble_only it is engine-agnostic scaffolding that e2a never "
        "consults, and both live assembly spawns pass the literal 'xtts' on an "
        "Orpheus book (reassembly-bridge.ts:1517, "
        "parallel-tts-bridge.ts:5164)"),
    '--higgs_voice': (
        ACCEPT,
        "the Higgs voice, a CATALOG ID rather than a token: Higgs has no "
        "--fine_tuned voice token, so the two flags are not interchangeable. "
        "Recorded in session-state as `higgs_voice` and handed to the engine "
        "config on the worker route"),
    '--fine_tuned': (ACCEPT, 'the Orpheus voice token'),
    '--orpheus_model_dir': (ACCEPT, 'a merged fine-tune'),
    '--orpheus_adapter_dir': (ACCEPT, 'a LoRA voice adapter'),
    '--orpheus_base_dir': (ACCEPT, 'the base the adapter is applied to'),

    # ---- assembly detail ---------------------------------------------------
    '--post_render_filter': (
        ACCEPT,
        'the per-voice ffmpeg -af chain, applied at the FINAL assembly encode '
        'only - never by the worker'),
    '--output_format': (ACCEPT, "assembly's container; 'm4b' is the only one exercised"),
    '--no_split': (
        IGNORE,
        'a whole-book assembly is the only shape narrator produces, and the '
        "bridge ALWAYS passes this flag, so it is already the only behaviour"),

    # ---- accepted and ignored ---------------------------------------------
    '--skip_deps': (
        IGNORE,
        'narrator never installs anything; there is no dependency check to skip'),
    '--device': (
        ACCEPT,
        "PREP normalizes it through e2a's devices table and RECORDS it in "
        "session-state.json's `device`; the worker ignores it, because the "
        'Orpheus backend is chosen by detect_backend(), which reads no session '
        'device (engine/PORT_NOTES.md s1)'),
    '--language': (
        ACCEPT,
        'PREP resolves it to (pt3, pt1) through iso639 and gates the book on it '
        "(Orpheus is English-only); it lands in `language`/`language_iso1`. The "
        'ENGINE has no language-dependent behaviour, so the worker ignores it'),
    '--voice': (
        ACCEPT,
        "PREP records it in session-state.json's `voice`. It is the XTTS "
        'reference-clip path and no Orpheus render reads it - an Orpheus voice '
        'arrives in --fine_tuned'),
    '--speed': (IGNORE, 'XTTS only'),
    '--temperature': (IGNORE, 'XTTS only; Orpheus takes ORPHEUS_TEMPERATURE / caps'),
    '--length_penalty': (IGNORE, 'XTTS only'),
    '--num_beams': (IGNORE, 'XTTS only'),
    '--repetition_penalty': (IGNORE, 'XTTS only; Orpheus takes ORPHEUS_REP_PENALTY'),
    '--top_k': (IGNORE, 'XTTS only'),
    '--top_p': (IGNORE, 'XTTS only; Orpheus takes ORPHEUS_TOP_P'),
    '--enable_text_splitting': (IGNORE, 'XTTS only'),
    '--text_temp': (IGNORE, 'bark only'),
    '--waveform_temp': (IGNORE, 'bark only'),
    '--output_channel': (IGNORE, 'assembly is mono; e2a defaulted it to mono too'),
    '--script_mode': (IGNORE, 'the docker/native switch; narrator has one mode'),
    '--workflow': (IGNORE, 'an e2a test hook that pinned a fixed session id'),
    '--share': (IGNORE, 'a gradio flag'),
    '--custom_model': (
        ACCEPT,
        "PREP records it in session-state.json's `custom_model`. The XTTS "
        'pre-staged voice path; no Orpheus render reads it'),
    '--custom_model_dir': (
        ACCEPT,
        "PREP records it in session-state.json's `custom_model_dir`. The XTTS "
        'pre-staged voice root; no Orpheus render reads it'),
    '--ebook': (
        ACCEPT,
        'PREP parses this EPUB - it is the whole input. Every other route '
        "ignores it: the render reads the session state prep wrote, and e2a's "
        'assembly ignored the flag too although the spawn passes it'),

    # ---- refused ----------------------------------------------------------
    '--ebooks_dir': (
        REFUSE,
        'batch conversion (convert_ebook_batch) is a gradio-era feature no '
        'BookForge spawn has ever used: it loops one prep per file and calls '
        'sys.exit(1) on the first failure. narrator preps ONE book per '
        'invocation; pass --ebook once per book'),
    '--skip_assembly': (
        REFUSE,
        'a dual-voice bilingual hook; bilingual is out of scope (see --bilingual)'),
    '--sentence_per_paragraph': (
        ACCEPT,
        "prep's paragraph mode: filter_chapter splits on [break] before "
        'escape_sml runs, so each paragraph becomes one chunk and the packer is '
        'skipped entirely'),
    '--skip_headings': (
        ACCEPT,
        'prep suppresses the text of real h1-h6 headings (they are still parsed '
        'for chapter detection). NOTE it does NOT suppress a TOC-matched title '
        'recovered from body text, and never did'),
    '--bilingual': (
        REFUSE,
        'bilingual assembly is the one e2a path where assembly inserts silence '
        'of its own, breaking every timing rule narrator rests on. It is out of '
        'scope by name (assemble/README.md section 8); use ebook2audiobook'),
    '--bilingual_pause': (REFUSE, 'see --bilingual'),
    '--bilingual_gap': (REFUSE, 'see --bilingual'),
}

#: Engines e2a could run and narrator cannot. Refused BY NAME so the message says
#: what happened rather than "no module named ...".
REFUSED_ENGINES = {
    'xtts': 'XTTSv2',
    'XTTSv2': 'XTTSv2',
    'bark': 'BARK',
    'BARK': 'BARK',
    'vits': 'VITS',
    'VITS': 'VITS',
    'tortoise': 'TORTOISE',
    'TORTOISE': 'TORTOISE',
    'fairseq': 'FAIRSEQ',
    'FAIRSEQ': 'FAIRSEQ',
    'tacotron': 'TACOTRON',
    'TACOTRON': 'TACOTRON',
    'yourtts': 'YOURTTS',
    'YOURTTS': 'YOURTTS',
    'f5': 'F5',
    'F5': 'F5',
    'voxtral': 'VOXTRAL',
    'VOXTRAL': 'VOXTRAL',
}

#: The engine ids narrator renders, EXACTLY. `higgs` and `higgs-v2` are not
#: `higgs-v3`: `higgs-v2` is scaffolding that is never shipped (Owen's ruling,
#: 2026-09-04, "basically just Orpheus and we know Orpheus better"), and a bare
#: `higgs` names no registry id at all. Both are refused by name rather than
#: helpfully resolved, because guessing which Higgs a caller meant is how a book
#: gets rendered by the wrong model.
ACCEPTED_ENGINES = ('orpheus', 'higgs-v3')

#: Kept as the single-engine spelling the older call sites used.
ACCEPTED_ENGINE = ACCEPTED_ENGINES[0]

#: Names that LOOK like an accepted engine and are not.
ENGINE_NEAR_MISSES = {
    'higgs': "'higgs' is not a registry id - narrator renders 'higgs-v3'",
    'higgs-v2': "Higgs v2 is dropped (Owen, 2026-09-04); only the v3 served "
                "backend ships. 'higgs-v2-scaffold' exists in the registry as "
                "interface scaffolding and is never rendered with",
    'higgs-v2-scaffold': "interface scaffolding only, never a render engine",
    'higgs_v3': "narrator spells it 'higgs-v3', with a hyphen",
}

#: The environment variable a spawn may use to name the engine instead of the
#: flag. When BOTH are present they must AGREE - see `check_engine`.
ENGINE_ENV = 'NARRATOR_ENGINE'


def refuse_flag(flag: str) -> None:
    """Raise `FlagRefused` for a REFUSE flag, with its reason."""
    verdict, reason = FLAGS[flag]
    assert verdict == REFUSE
    raise FlagRefused(f'{flag} is not supported by narrator: {reason}.')


def resolve_engine(engine: str | None) -> str | None:
    """The engine id to render with: the flag, cross-checked against the env.

    `NARRATOR_ENGINE` exists so a spawn can name the engine without touching the
    argv, and BOTH may be present. When they DISAGREE the run is refused by name
    rather than one silently winning: a book rendered by the engine the caller
    did not ask for is indistinguishable from a book rendered correctly until
    somebody listens to it.
    """
    import os

    env = (os.environ.get(ENGINE_ENV) or '').strip()
    if engine and env and engine != env:
        raise FlagRefused(
            f"--tts_engine {engine} disagrees with {ENGINE_ENV}={env}. "
            f"narrator will not pick one: pass the same engine both ways, or "
            f"unset {ENGINE_ENV}.")
    chosen = engine or env or None
    if chosen:
        check_engine(chosen)
    return chosen


def check_engine(engine: str | None) -> None:
    """Refuse an engine narrator does not render, BY NAME.

    CALLED FROM THE PREP, WORKER AND RETAKE ROUTES. `--tts_engine` decides which
    model RENDERS and, since migration step 4, which text layer PARSES; on
    assembly it decides nothing, and BookForge passes `'xtts'` there on Orpheus
    books deliberately. See `compat/app.py:dispatch`.

    A SECOND GATE STILL LIVES IN `text/`: `text.prep.prep_session` and
    `text.chapters.get_chapters` raise `UnsupportedEngine` for an engine whose
    text branch is not implemented. The two refusals answer different questions -
    this one names the 18 deleted ENGINES, that one names the branch narrator
    does not have - and a library caller of `text/` must be refused whether or
    not it came through this door.
    """
    if engine is None:
        return
    if engine in ACCEPTED_ENGINES:
        return
    if engine in ENGINE_NEAR_MISSES:
        raise FlagRefused(
            f"--tts_engine {engine}: {ENGINE_NEAR_MISSES[engine]}. narrator "
            f"accepts {', '.join(repr(e) for e in ACCEPTED_ENGINES)}.")
    if engine in REFUSED_ENGINES:
        raise FlagRefused(
            f"--tts_engine {engine}: narrator renders "
            f"{', '.join(repr(e) for e in ACCEPTED_ENGINES)}. "
            f"{REFUSED_ENGINES[engine]} was deleted with the rest of the e2a "
            f"engine set (docs/NARRATOR_PLAN.md 'What is deleted'); use "
            f"ebook2audiobook if you need it.")
    raise FlagRefused(
        f"--tts_engine {engine}: unknown engine. narrator accepts "
        f"{', '.join(repr(e) for e in ACCEPTED_ENGINES)}.")


def engine_factory_for(engine_id: str):
    """`(engine_class, config_factory)` from `engine/registry.py`, LAZILY.

    Imported inside the function on purpose: `narrator.engine` is another
    builder's column and is being refactored, and `compat/flags.py` is imported
    by every door including `--list_sessions`, which loads no model at all. A
    test can pass its own factory instead and never touch the registry.
    """
    from ..engine import registry

    return registry.engine_class(engine_id), registry.engine_config


def known_flags() -> list[str]:
    return sorted(FLAGS)


def accepted_flags() -> list[str]:
    return sorted(f for f, (v, _) in FLAGS.items() if v == ACCEPT)


def reject_unknown(argv: list[str]) -> None:
    """e2a's own pre-parse loop (app.py:226-230), with narrator's flag set.

    Runs BEFORE argparse for the same reason e2a ran it there: a typo in a flag
    name must be an error naming the flag, not a silently-ignored argument.
    """
    for arg in argv:
        if not arg.startswith('--'):
            continue
        name = arg.split('=', 1)[0]
        if name in ('--help', '--version'):
            continue
        if name in FLAGS:
            continue
        accepted = ', '.join(known_flags())
        raise FlagRefused(
            f'Unrecognized option "{name}". narrator accepts: {accepted}')
