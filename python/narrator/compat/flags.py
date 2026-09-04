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
    '--prep_only': (
        REFUSE,
        'prep is migration step 4; use ebook2audiobook for prep until then '
        '(docs/NARRATOR_PLAN.md). narrator reads the session-state.json e2a prep '
        'writes and renders from it'),
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
        "checked ONLY on the worker route, where it must be 'orpheus'. On "
        "--assemble_only it is engine-agnostic scaffolding that e2a never "
        "consults, and both live assembly spawns pass the literal 'xtts' on an "
        "Orpheus book (reassembly-bridge.ts:1517, parallel-tts-bridge.ts:5164)"),
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
        IGNORE,
        'reported in the worker log; the Orpheus backend is chosen by '
        'detect_backend(), which reads no session device (engine/PORT_NOTES.md s1)'),
    '--language': (IGNORE, 'the engine has no language-dependent behaviour'),
    '--voice': (
        IGNORE,
        'the XTTS reference-clip path; an Orpheus voice arrives in --fine_tuned'),
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
    '--custom_model': (IGNORE, 'the XTTS pre-staged voice path'),
    '--custom_model_dir': (IGNORE, 'the XTTS pre-staged voice root'),
    '--ebook': (
        IGNORE,
        'prep parses the EPUB; narrator renders from the session state prep '
        'already wrote. Passed by the assembly spawn and unused there too'),

    # ---- refused ----------------------------------------------------------
    '--ebooks_dir': (
        REFUSE,
        'batch conversion is a prep-era feature and prep is not ported '
        '(migration step 4)'),
    '--skip_assembly': (
        REFUSE,
        'a dual-voice bilingual hook; bilingual is out of scope (see --bilingual)'),
    '--sentence_per_paragraph': (
        REFUSE,
        'a prep/packer flag; the packer is migration step 4'),
    '--skip_headings': (
        REFUSE,
        'a prep/packer flag; the packer is migration step 4'),
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

ACCEPTED_ENGINE = 'orpheus'


def refuse_flag(flag: str) -> None:
    """Raise `FlagRefused` for a REFUSE flag, with its reason."""
    verdict, reason = FLAGS[flag]
    assert verdict == REFUSE
    raise FlagRefused(f'{flag} is not supported by narrator: {reason}.')


def check_engine(engine: str | None) -> None:
    """Refuse a non-Orpheus engine BY NAME.

    CALLED ONLY FROM THE WORKER ROUTE. `--tts_engine` decides which model
    RENDERS; on assembly it decides nothing, and BookForge passes `'xtts'` there
    on Orpheus books deliberately. See `compat/app.py:dispatch`.
    """
    if engine is None:
        return
    if engine == ACCEPTED_ENGINE:
        return
    if engine in REFUSED_ENGINES:
        raise FlagRefused(
            f"--tts_engine {engine}: narrator renders Orpheus only. "
            f"{REFUSED_ENGINES[engine]} was deleted with the rest of the e2a "
            f"engine set (docs/NARRATOR_PLAN.md 'What is deleted'); use "
            f"ebook2audiobook if you need it.")
    raise FlagRefused(
        f"--tts_engine {engine}: unknown engine. narrator accepts "
        f"'{ACCEPTED_ENGINE}'.")


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
