"""Phase 1: one EPUB -> one prepared session.

Ported from ebook2audiobook@9daab0ba:
  bookforge_ext/parallel/session.py   prep_ebook_info (362), save_session_state (54),
                                      count_real_sentences (31), _SENTENCE_END_RE (28)
  bookforge_ext/parallel/handlers.py  the --prep_only branch (47-76): the argument
                                      normalization that happens BEFORE prep runs
  lib/core.py                         prepare_dirs (221), convert2epub (577)

THE LIVE PREP IS `bookforge_ext/parallel/session.prep_ebook_info`, NOT
`lib/core.prep_ebook_info`. Both exist at 9daab0ba and they differ: only the
bookforge_ext copy writes `total_raw_sentences`, `raw_sentence_count`,
`custom_model*`, `orpheus_*`, `bookforge_metadata`, and only it raises on an
unresolvable language instead of anglicizing to 'en'. `handlers.py:69` calls the
bookforge_ext one, so that is the one ported; core.py's is dead code on this path.

## The two documents prep produces, and why they are not the same document

`prep_ebook_info` RETURNS a result dict that `handlers.py:70` prints as
`json.dumps(result, indent=2, default=str)`, and it CALLS `save_session_state`,
which writes a different dict to `session-state.json`. They are not
interchangeable: the result carries `total_raw_sentences` and
`chapters_dir_sentences`, the state carries the voice/model/metadata keys and
`bookforge_metadata`, and only the state carries `epub_content_hash`. Hence
`PrepOutcome`, which holds both.

WHO READS WHICH: `parallel-tts-bridge.ts:3394-3435` reads `session-state.json` and
NOTHING ELSE. It explicitly skips logging any stdout line starting with `{`
(":3305") and never parses one. So the printed result is a contract with nobody
today; it is reproduced anyway, because that is what the door printed and a
script may still read it.

## What prep does NOT do that e2a's prep did

- **No stanza pipeline.** See `text/sentences.py`.
- **No VRAM detection.** e2a ran `VRAMDetector().detect_vram(device, script_mode)`
  and stored `free_vram_gb` in the session; `save_session_state` never writes it,
  so it reached no file and no later stage. Prep is CPU text work.
- **No models/voices/audiobooks directories.** `prepare_dirs` created seven dirs,
  four of which belong to e2a's own installation layout. narrator creates the
  session dir, the process dir, `chapters/` and `chapters/sentences/` - the four
  the session layout (CONTRACTS.md) actually names.
- **No XTTS settings.** e2a stored `xtts_temperature` and friends on the session
  object; `save_session_state` writes none of them, so they never reached
  `session-state.json`. They are IGNORE in `compat/FLAGS.md` for the same reason.
- **No `--ebooks_dir` batch loop** (`convert_ebook_batch`): REFUSE in FLAGS.md.

All of these are enumerated in `text/PORT_NOTES.md`.
"""
from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime

import regex as re

from . import epub as epub_mod
from .chapters import ChapterContext, get_chapters
from .gaps import classify_gap_seconds
from .lang import default_fine_tuned, default_language_code, default_output_format
from .normalize import (BOOK_EXACT_ENGINES, HIGGS_V3, ORPHEUS,
                        UnsupportedEngine)
from .paragraph_packer import (CHUNKING_E2A, CHUNKING_PARAGRAPH,
                               DEFAULT_FLOOR_CHARS, DEFAULT_WALLS,
                               make_chapter_chunker, orpheus_budget_from_env,
                               resolve_source_kind)

#: A "sentence" in the parallel pipeline is a GENERATION CHUNK, which for Orpheus
#: packs 2-3 real sentences. `total_raw_sentences` reports the true sentence count
#: for analytics while the pipeline keeps scheduling by chunk.
_SENTENCE_END_RE = re.compile(r'[.!?…]+["\'”’)\]]*(?:\s|$)')

#: `conf.devices` -> the `proc` string prep records. `handlers.py:59-62` maps
#: `--device` through this and falls back to CPU for an unknown name.
DEVICE_PROC = {
    'CPU': 'cpu',
    'CUDA': 'cuda',
    'MPS': 'mps',
    'ROCM': 'rocm',
    'XPU': 'xpu',
    'JETSON': 'jetson',
}
DEFAULT_DEVICE = DEVICE_PROC['CPU']

#: The status prep stamps. Nothing ever changes it - see
#: `render/session_store.py`'s note that this file is written exactly once.
PREPARED_STATUS = 'prepared'

#: Where the gap file goes when the engine needs one, relative to `process_dir`.
#: Beside the audio it describes, and NOT in the process dir root, because the
#: derived sets (`sentences-denoised`, `sentences-rvc-<voice>`) are copies of
#: this directory's chunks and inherit its gaps with it.
GAPS_FILENAME = 'gaps.json'

#: The schema version of that file. One number, so a reader can refuse a shape
#: it does not know rather than mis-read it.
GAPS_VERSION = 1


def write_gaps_file(process_dir: str, sentences_dir: str, engine_id: str,
                    chapters: list) -> str | None:
    """Write `chapters/sentences/gaps.json` when - and only when - the engine
    does not bake its inter-chunk silence into its own audio.

    ## Who needs this file, and who must not have one

    `assemble/engine_profiles.py` is THE table, and it is read here rather than
    copied: `orpheus` is `pads=True` (the engine bakes each chunk's silence into
    that chunk's FLAC, so the audio is already the complete unit and a gap file
    would be a second, contradictory source of truth), and `higgs-v3` is
    `pads=False` (bare speech; the silence exists nowhere until the assembler
    puts it there). So an Orpheus prep writes NO file at all, and that absence is
    the signal, not an omission.

    An engine the table does not know raises through `profile_for`. NO FALLBACK:
    guessing `pads=True` ships an audiobook with every gap missing, and guessing
    `pads=False` re-spaces audio that was already correct.

    ## What is in it

        {"version": 1,
         "engine": "higgs-v3",
         "gaps": {"0": {"before": 0.0, "after": 0.6}, ...}}

    A key for EVERY chunk, `0 .. total_sentences-1` as strings (JSON has no
    integer keys), in GLOBAL index order - the same index that names the FLAC,
    so a reader joins the two by name and never by position. Seconds, as floats.

    ## Where the numbers come from

    `text/gaps.classify_gap`, which IS `engine/orpheus/prompt.py`'s
    `_classify_gap` - the function moved down to `text/` unchanged so both
    callers use one implementation. Whatever silence Orpheus would have baked
    into a chunk is what this file asks the assembler to insert around the same
    chunk rendered by an engine that bakes nothing.

    A READER SHOULD EXPECT ONE REPEATED VALUE. At 9daab0ba the paragraph and
    section tiers are gone (2026-07-17: measured as purely additive dead air),
    so a heading, a `[break]`, an `[item]` and a plain sentence end all classify
    to `(0.0, 0.6)`. Only an explicit `[pause:X]` differs. `ORPHEUS_SENTENCE_GAP`
    still moves the floor, and it is read at PREP time here rather than at render
    time - which is the one behavioural difference from the Orpheus path and is
    recorded in `text/PORT_NOTES.md`.

    Returns the path written, or None when the engine pads its own audio.
    """
    from ..assemble.engine_profiles import profile_for

    if profile_for(engine_id).pads:
        return None

    gaps = {}
    index = 0
    for chapter in chapters:
        for chunk in chapter:
            before, after = classify_gap_seconds(chunk)
            gaps[str(index)] = {'before': before, 'after': after}
            index += 1

    os.makedirs(sentences_dir, exist_ok=True)
    path = os.path.join(sentences_dir, GAPS_FILENAME)
    payload = json.dumps({'version': GAPS_VERSION, 'engine': engine_id,
                          'gaps': gaps}, indent=2)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(payload)
    print(f'[gaps] {engine_id} does not pad its own audio: wrote {index} gap(s) '
          f'to {path}')
    return path

STATE_VERSION = 2


def count_real_sentences(chunk: str) -> int:
    """A chunk with no terminal punctuation (a heading) still counts as one."""
    return max(1, len(_SENTENCE_END_RE.findall(chunk or '')))


@dataclass
class PrepOptions:
    """Everything the `--prep_only` command line carries into prep.

    Defaults are e2a's: `default_fine_tuned` is the literal 'internal', which the
    Orpheus engine KeyErrors on - which is why every live spawn passes a real
    voice in `--fine_tuned` (CLAUDE.md). Preserved rather than "fixed": inventing
    a default voice here would render a book in the wrong voice instead of
    failing.
    """
    session: str | None = None
    language: str = default_language_code
    tts_engine: str = ORPHEUS
    fine_tuned: str = default_fine_tuned
    voice: str | None = None
    device: str | None = None
    output_format: str = default_output_format
    audiobooks_dir: str | None = None
    custom_model: str | None = None
    custom_model_dir: str | None = None
    #: HIGGS HAS NO VOICE TOKEN. Orpheus's `--fine_tuned` is a token baked
    #: into the model; a Higgs voice is a CATALOG ID naming either a fine-tuned
    #: adapter or a set of reference clips. The two are not interchangeable and
    #: are stored under different keys, so a session can never be read as naming
    #: a voice the engine cannot resolve.
    higgs_voice: str | None = None
    orpheus_model_dir: str | None = None
    orpheus_adapter_dir: str | None = None
    orpheus_base_dir: str | None = None
    sentence_per_paragraph: bool = False
    skip_headings: bool = False
    #: e2a wrote `args.get('bookforge_metadata', {})` and NO CLI flag ever set it,
    #: so prep always wrote `{}`; BookForge fills it in later
    #: (`reassembly-bridge.ts:1121-1141`). Kept as a parameter because the key is
    #: in the state and a caller with the data should be able to seed it.
    bookforge_metadata: dict = field(default_factory=dict)
    #: WHICH CHUNKING POLICY BUILDS THE CHUNKS.
    #:
    #:   'e2a'       `text/packer.py`, the ported parity packer. THE DEFAULT, so
    #:               nothing about today's renders changes by this field existing.
    #:   'paragraph' `text/paragraph_packer.py`, Owen's rule (2026-09-04): a
    #:               chunk is a paragraph, short prose paragraphs merge to a
    #:               floor, headings/items/scene breaks are walls.
    #:
    #: The choice is recorded in `session-state.json` under `bookforge_chunking`
    #: so a resume, a retake and the manifest all know how the chunks were made -
    #: two policies over one session dir would otherwise be indistinguishable.
    chunking: str = CHUNKING_E2A
    #: Paragraph policy only: the merge floor for consecutive short PROSE
    #: paragraphs. Never applies to items or headings.
    chunking_floor_chars: int = DEFAULT_FLOOR_CHARS
    #: Paragraph policy only: 'epub-native' | 'pdf-derived' | None to read the
    #: book's own `data-bf-*` stamp (`paragraph_packer.resolve_source_kind`).
    source_kind: str | None = None
    #: Paragraph policy only: the `Budget`. None means "build it from the
    #: catalog values BookForge exports" (`orpheus_budget_from_env`).
    budget: object = None


@dataclass
class PrepOutcome:
    """What prep produced: the printed result, the written state, and where."""
    result: dict
    state: dict
    state_path: str
    process_dir: str
    session_dir: str


class PrepError(RuntimeError):
    """Prep could not produce a usable session."""


def resolve_language(language: str) -> tuple[str, str]:
    """`(pt3, pt1)` for a 2- or 3-letter code.

    e2a's bookforge_ext copy RAISES on an unresolvable code with the comment
    "Never silently anglicize"; core.py's dead copy defaulted to 'en'. The loud
    one is ported. A code that is neither 2 nor 3 characters is passed through
    with its first two characters as the ISO-1 form, exactly as e2a does.
    """
    from iso639 import Lang

    lang = language
    lang_iso1 = None
    try:
        if len(lang) in (2, 3):
            lang_dict = Lang(lang)
            if lang_dict:
                lang = lang_dict.pt3
                lang_iso1 = lang_dict.pt1
        if not lang_iso1:
            lang_iso1 = lang[:2] if len(lang) >= 2 else 'en'
    except Exception as e:
        raise PrepError(
            f"Could not resolve ISO-639-1 code for language '{language}': {e}"
        ) from e
    return lang, lang_iso1


def normalize_device(device: str | None) -> str:
    """`handlers.py:59-62`: `devices.get(device.upper(), {}).get('proc') or 'cpu'`.
    An absent or unknown device is CPU, which is what prep is."""
    if not device:
        return DEFAULT_DEVICE
    return DEVICE_PROC.get(device.upper(), DEFAULT_DEVICE) or DEFAULT_DEVICE


def _chunking(options: PrepOptions, epub_book) -> tuple:
    """`(chapter_chunker, the record for session-state)` for the chosen policy.

    The e2a policy passes `None`, which is `get_chapters`' default and therefore
    the byte-identical parity path: no budget is built, no provenance is read,
    and nothing about a default prep touches this module.
    """
    if options.chunking == CHUNKING_E2A:
        return None, {'policy': CHUNKING_E2A}
    if options.chunking != CHUNKING_PARAGRAPH:
        raise PrepError(
            f"chunking must be {CHUNKING_E2A!r} or {CHUNKING_PARAGRAPH!r}, got "
            f"{options.chunking!r}")

    if options.budget is not None:
        budget = options.budget
    elif options.tts_engine == HIGGS_V3:
        # It used to fall through to the Orpheus env budget, and ORPHEUS_MAX_CHARS
        # is a variable a Higgs spawn deliberately never carries - so e2a's 350
        # default packed every Higgs book in ~220-char chunks against a voice
        # document saying 900/1200 (measured 2026-09-05, both arms). The route
        # builds the Higgs budget from the voice document
        # (`engine.higgs.v3_engine.higgs_v3_prep_budget`); a caller that did not
        # is refused here, by name, rather than answered with another engine's
        # number.
        raise PrepError(
            'A Higgs v3 prep was given no Budget. The chunk cap is the VOICE\'s '
            'measured maxChars from NARRATOR_HIGGS_VOICES (route_prep builds it via '
            'higgs_v3_prep_budget); refusing to pack the book at Orpheus\'s '
            'ORPHEUS_MAX_CHARS / 350-char default.')
    else:
        budget = orpheus_budget_from_env()
    source_kind = options.source_kind or resolve_source_kind(epub_book)
    # The Budget is keyed on (engine, voice), and the two engines name a voice
    # differently: Orpheus by token, Higgs by catalog id.
    voice = (options.higgs_voice if options.tts_engine == HIGGS_V3
             else options.fine_tuned)
    record = {
        'policy': CHUNKING_PARAGRAPH,
        'engine': options.tts_engine,
        'floor_chars': options.chunking_floor_chars,
        'source_kind': source_kind,
        'walls': sorted(DEFAULT_WALLS),
        'budget': {
            'voice': voice,
            'max_chars': int(budget.max_chars(voice)),
            'max_chars_per_sec': float(budget.max_chars_per_sec(voice)),
        },
    }
    print(f'[chunking] paragraph policy: floor={options.chunking_floor_chars} '
          f'chars, cap={record["budget"]["max_chars"]} chars, '
          f'source={source_kind}')
    return make_chapter_chunker(
        budget, source_kind=source_kind,
        floor_chars=options.chunking_floor_chars, voice=voice), record


def prep_session(epub_path: str, session_dir: str,
                 options: PrepOptions) -> PrepOutcome:
    """Prepare one book into `session_dir` (the `ebook-<uuid>` directory).

    e2a derived `session_dir` itself as `<tmp_dir>/ebook-<session_id>`, where
    `tmp_dir` is `$E2A_TMP_DIR`. narrator takes the directory it is GIVEN, exactly
    as every other narrator reader does ("the reader takes the directory it was
    given and derives everything from it" - CONTRACTS.md); `compat/app.py` builds
    it from `session_store.sessions_root()` when a caller does not pass
    `--session_dir`, which is what reproduces e2a's own placement.

    The process dir under it is `md5(<epub_path>)`, and `epub_content_hash` is
    `md5(<the copy inside the process dir>)`. Both hash PATH STRINGS - see
    `text/epub.py`.
    """
    if options.tts_engine not in BOOK_EXACT_ENGINES:
        raise UnsupportedEngine(
            f"narrator preps for {sorted(BOOK_EXACT_ENGINES)}, not "
            f"'{options.tts_engine}'. See narrator/compat/FLAGS.md.")
    if (options.tts_engine == HIGGS_V3
            and options.chunking != CHUNKING_PARAGRAPH):
        # The e2a packer's caps, floors and merge passes were every one of them
        # calibrated on Orpheus voices, and it has no Higgs branch to fall into.
        # Refused rather than silently packed to an Orpheus cap.
        raise UnsupportedEngine(
            f"tts_engine {HIGGS_V3!r} requires chunking="
            f"{CHUNKING_PARAGRAPH!r}: the ported e2a packer "
            f"(chunking={CHUNKING_E2A!r}) is Orpheus-only, and Higgs chunks by "
            f"paragraph against its own Budget "
            f"(docs/NARRATOR_PLAN.md, 'Chunking rule').")

    epub_path = os.path.abspath(epub_path)
    epub_mod.accept_epub(epub_path)

    session_id = options.session or str(uuid.uuid4())
    language, language_iso1 = resolve_language(options.language)
    device = normalize_device(options.device)

    print(f'[PREP] fine_tuned={options.fine_tuned}, voice={options.voice}, '
          f'tts_engine={options.tts_engine}, '
          f'sentence_per_paragraph={options.sentence_per_paragraph}, '
          f'skip_headings={options.skip_headings}')

    process_dir = epub_mod.process_dir_for(session_dir, epub_path)
    chapters_dir = os.path.join(process_dir, 'chapters')
    sentences_dir = os.path.join(chapters_dir, 'sentences')
    os.makedirs(session_dir, exist_ok=True)
    os.makedirs(process_dir, exist_ok=True)
    os.makedirs(chapters_dir, exist_ok=True)
    os.makedirs(sentences_dir, exist_ok=True)

    # prepare_dirs' one act that matters here.
    internal_epub = epub_mod.stage_into_process_dir(epub_path, process_dir)
    filename_noext = os.path.splitext(os.path.basename(internal_epub))[0]

    from ..assemble.run import get_sanitized

    final_name = get_sanitized(filename_noext + '.' + options.output_format)

    # convert2epub's EPUB branch: "the book already IS an EPUB, so its spine and
    # TOC ARE the chapter structure and they are the authority" - the file is used
    # directly and `epub_path` becomes the copy.
    print(f'Input is already an EPUB - using it directly, no Calibre pass: '
          f'{internal_epub}')

    epub_book = epub_mod.read_epub(internal_epub)
    metadata = epub_mod.read_metadata(epub_book, filename_noext)

    try:
        cover = epub_mod.get_cover(epub_book, process_dir, filename_noext)
    except Exception as cover_err:
        print(f'Warning: Could not get cover: {cover_err}')
        cover = None

    ctx = ChapterContext(
        language=language,
        language_iso1=language_iso1,
        tts_engine=options.tts_engine,
        process_dir=process_dir,
        skip_headings=options.skip_headings,
        sentence_per_paragraph=options.sentence_per_paragraph,
    )
    chunker, chunking_record = _chunking(options, epub_book)
    chapters = get_chapters(epub_book, ctx, chapter_chunker=chunker)
    if not chapters:
        # e2a returned None from prep_ebook_info here and handlers printed
        # {'success': False, 'error': 'prep_ebook_info failed'}. narrator raises,
        # and `compat/app.py` turns the exception into that same result dict, so
        # the door's output is unchanged while a direct caller gets the reason.
        raise PrepError(
            f'No chapters produced from {internal_epub}. get_chapters() printed '
            f'the reason above (no spine documents, an extraction failure on one '
            f'document, or every document skipped as front/back matter).')

    total_chapters = len(chapters)
    # total_sentences is the number of GENERATION CHUNKS (the scheduling unit).
    total_sentences = sum(len(chapter) for chapter in chapters)
    total_raw_sentences = sum(count_real_sentences(c)
                              for chapter in chapters for c in chapter)

    chapter_info = []
    sentence_offset = 0
    for i, chapter in enumerate(chapters):
        chapter_info.append({
            'chapter_num': i + 1,
            'sentence_count': len(chapter),
            'raw_sentence_count': sum(count_real_sentences(c) for c in chapter),
            'sentence_start': sentence_offset,
            'sentence_end': sentence_offset + len(chapter) - 1,
        })
        sentence_offset += len(chapter)

    result = {
        'session_id': session_id,
        'session_dir': session_dir,
        'process_dir': process_dir,
        'chapters_dir': chapters_dir,
        'chapters_dir_sentences': sentences_dir,
        'total_chapters': total_chapters,
        'total_sentences': total_sentences,
        'total_raw_sentences': total_raw_sentences,
        'chapters': chapter_info,
        'chapter_sentences': list(chapters),
        'metadata': {
            'title': metadata.get('title'),
            'creator': metadata.get('creator'),
            'language': metadata.get('language'),
        },
    }

    now = datetime.now().isoformat()
    state = {
        'version': STATE_VERSION,
        'session_id': session_id,
        'epub_path': internal_epub,
        'source_epub_path': epub_path,
        'epub_content_hash': epub_mod.path_md5(internal_epub),
        'total_sentences': total_sentences,
        'total_chapters': total_chapters,
        'chapters': chapter_info,
        'chapter_sentences': list(chapters),
        'language': language,
        'language_iso1': language_iso1,
        'voice': options.voice,
        'fine_tuned': options.fine_tuned,
        'custom_model': options.custom_model,
        'custom_model_dir': options.custom_model_dir,
        'higgs_voice': options.higgs_voice,
        'orpheus_model_dir': options.orpheus_model_dir,
        'orpheus_adapter_dir': options.orpheus_adapter_dir,
        'orpheus_base_dir': options.orpheus_base_dir,
        'tts_engine': options.tts_engine,
        'device': device,
        'output_format': options.output_format,
        'audiobooks_dir': options.audiobooks_dir,
        # e2a stamps created_at and updated_at from the SAME datetime.now() call
        # and never restamps either one.
        'created_at': now,
        'updated_at': now,
        'status': PREPARED_STATUS,
        'metadata': result['metadata'],
        'session_dir': session_dir,
        'process_dir': process_dir,
        'chapters_dir': chapters_dir,
        'chapters_dir_sentences': sentences_dir,
        'epub_path_internal': internal_epub,
        'filename_noext': filename_noext,
        'cover': cover,
        'final_name': final_name,
        'chapter_titles': list(ctx.chapter_titles),
        # chapter_docs[i] names the spine document that produced chapters[i], and
        # chapter_titles_by_doc maps that document to its TOC title. Assembly
        # binds marker titles through these two - NEVER by position.
        'chapter_docs': list(ctx.chapter_docs),
        'chapter_titles_by_doc': dict(ctx.chapter_titles_by_doc),
        'bookforge_metadata': dict(options.bookforge_metadata),
        # ADDITIVE, and last: how these chunks were made. Every existing reader
        # of this file ignores an unknown key (they read named fields), and
        # `render/session_store.STATE_KEY_ORDER` puts unlisted keys after the
        # ones it names in insertion order, so a state written by the default
        # policy is byte-identical to one written before this key existed except
        # for this one trailing entry.
        'bookforge_chunking': chunking_record,
    }

    # BEFORE the state is written, so a session dir is never left with a state
    # promising an engine whose gap file failed to appear.
    write_gaps_file(process_dir, sentences_dir, options.tts_engine, chapters)

    from ..render import session_store

    state_path = session_store.save_session_state(process_dir, state)
    print(f'Session state saved to {state_path}')

    return PrepOutcome(result=result, state=state, state_path=state_path,
                       process_dir=process_dir, session_dir=session_dir)
