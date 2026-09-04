# text/ — what was ported, from where, and everything that differs

Migration step 4 of `docs/NARRATOR_PLAN.md`: ebook2audiobook's `--prep_only` path,
ported into `python/narrator/text/`. Source of truth for every line here:
**ebook2audiobook@9daab0ba** (`C:\Users\tellt\Projects\ebook2audiobook`, branch
`bookforge`), read-only.

Everything below was measured on 2026-09-04 against the three golden sessions in
`C:\tmp\narrator-golden\` and the committed fixtures in
`python/narrator/tests/golden/<slug>/session-state.json`.

---

## 1. Dependency table — which e2a symbol each function used, and what replaced it

| narrator | e2a source | e2a symbols it used | what replaced them |
|---|---|---|---|
| `sml.py` | `conf_models.py:26-170`, `core.py:3446-3541`, `core.py:1861-2108` | `TTS_SML`, `SML_TAG_PATTERN`, `SML_UNSPOKEN_PATTERN`, `SML_HEADING_PATTERN`, `sml_escape_tag`, `normalize_sml_tags`, `escape_sml`, `restore_sml`, `sml_token/heading/item`, `_strip_escaped_sml`, `_split_sml_edges`, `_has_escaped_sml`, `_marker_row_test`, `_heading_row_test` | copied verbatim; `regex as re` kept (see §2) |
| `lang.py` | `conf_lang.py`, `conf.py`, `conf_models.py` | `punctuation_switch`, `punctuation_split_hard/soft(_set)`, `chars_remove`, `emojis_list`, `abbreviations_mapping['eng']`, `language_mapping['eng']`, `year_to_decades_languages`, `default_language_code`, `default_output_format`, `default_fine_tuned` | copied verbatim and **asserted equal to e2a's live tables** by `tests/test_text_packer.py::LanguageTableTest` when the e2a checkout is present |
| `normalize.py` | `core.py:3366` (`foreign2latin`), `core.py:3543` (`normalize_text`) | `emojis_list`, `punctuation_switch`, `chars_remove`, `language_mapping[lang]['script']`, `SML_TAG_PATTERN`, `sml_token`, `unidecode`, `phonemizer`, `pypinyin`, `pykakasi` | Orpheus branch only; the six non-Orpheus transforms are refused, not reimplemented (§4) |
| `epub.py` | `core.py:221` (`prepare_dirs`), `:577` (`convert2epub`, EPUB branch), `:751` (`get_ebook_title`), `:772` (`get_cover`), `:803` (`normalize_doc_key`), `:823` (`flatten_toc`), `:176` (the metadata template), `session.py:466` (the md5 derivations) | `ebooklib`, `ebooklib.epub`, `PIL.Image`, `urllib.parse`, `hashlib`, `shutil`, `BeautifulSoup` | same libraries; Calibre refused by name (§4) |
| `chapters.py` | `core.py:496-575` (provenance), `:837` (`get_chapters`), `:976-1090` (`_edge_chars`/`_heading_text`/`_collapse_glue`), `:1092` (`filter_chapter`) | the global `context` session dict, `stanza`, `DependencyError`, `show_alert`, `bs4`, `num2words`, `get_num2words_compat` | `ChapterContext` dataclass replaces the session dict; stanza dropped (§3.1); `_dependency_error()` reproduces `DependencyError`'s print+traceback; `show_alert` dropped (gradio); num2words unreachable on the Orpheus branch |
| `sentences.py` | `core.py:920-941` | `stanza.Pipeline`, `DownloadMethod.REUSE_RESOURCES`, `STANZA_RESOURCES_DIR` | nothing — the module records the measurement that the pipeline is never consulted (§3.1) |
| `packer.py` | `core.py:1725-2276` (the passes) + `:2277` (`get_sentences`) | `difflib`, `regex`, `os.environ`, `language_mapping`, `abbreviations_mapping`, `punctuation_split_*_set`, the session dict | `language`/`tts_engine` passed as arguments; everything else verbatim |
| `prep.py` | `bookforge_ext/parallel/session.py:362` (`prep_ebook_info`), `:54` (`save_session_state`), `:28-32` (`count_real_sentences`), `handlers.py:47-76` | `context`/`context_tracker`, `iso639.Lang`, `VRAMDetector`, `conf.tmp_dir/models_dir/voices_dir/audiobooks_cli_dir`, `conf.devices`, `get_compatible_tts_engines`, `get_sanitized` | `PrepOptions`/`PrepOutcome`; `session_dir` passed in; `render/session_store.save_session_state` writes the file; `assemble/run.get_sanitized` reused (one copy in narrator); VRAM detection dropped (§3.4) |

### The live prep is NOT `lib/core.prep_ebook_info`

Both `lib/core.py:5364` and `bookforge_ext/parallel/session.py:362` define
`prep_ebook_info`. `handlers.py:69` calls the **bookforge_ext** one, and only it
writes `total_raw_sentences`, `raw_sentence_count`, `custom_model*`, `orpheus_*`
and `bookforge_metadata`, and only it raises on an unresolvable language instead
of silently anglicizing. core.py's copy is dead on the BookForge path. narrator
ports the bookforge_ext one.

### New third-party dependencies of `text/`, and why

`CONTRACTS.md` says pure stdlib + numpy + soundfile outside `engine/`, and any new
dependency must say why. `text/` needs six, all of them already installed in BOTH
Orpheus environments (verified 2026-09-04), and all of them are what e2a itself
used for this work:

| package | why | Windows `python_env` | WSL `orpheus_tts` |
|---|---|---|---|
| `regex` | e2a's `core.py:12` is `import regex as re`; the packer's patterns were compiled by it and `normalize_text` uses `\p{L}`/`\p{N}` classes the stdlib cannot compile | 2026.1.15 | 2026.1.15 |
| `ebooklib` | reads the EPUB, its spine and its TOC | present | present |
| `beautifulsoup4` | the markup walk IS a bs4 walk (`NavigableString`/`Tag` identity is load-bearing) | 4.14.3 | 4.14.3 |
| `Pillow` | cover extraction (`Image.open` -> JPEG) | 11.3.0 | 12.1.0 |
| `iso639` (`iso639-lang`) | `Lang(code).pt3/.pt1`, the exact language resolution prep records | present | present |
| `Unidecode` | `foreign2latin`'s fallback romanizer — imported LAZILY, only for a non-Latin word | present | present |

`phonemizer`, `pypinyin` and `pykakasi` are imported lazily inside `_romanize`
exactly as e2a imports the last two; `pykakasi` is ABSENT from both envs, which is
e2a's situation too (its `except Exception: return unidecode(word)` covers it).

`stanza` is NOT a dependency of `text/`. See §3.1.

---

## 2. The stanza facts, per machine (measured 2026-09-04)

| machine | interpreter | stanza | `STANZA_RESOURCES_DIR` | models on disk |
|---|---|---|---|---|
| Windows | `ebook2audiobook\python_env\python.exe` (3.12.12) | **1.10.1** | `<e2a>\models\stanza`, set by `lib/conf.py:78`; unset in the ambient env | **NONE** — the directory does not exist |
| WSL Ubuntu | `/home/telltale/anaconda3/envs/orpheus_tts/bin/python` (3.11.14) | **1.11.0** | `/home/telltale/ebook2audiobook/models/stanza`, same line | `en`, `de`, `resources.json` — **591 MB** |

`STANZA_RESOURCES_DIR` is absent from both ambient environments (checked in WSL
through a login shell, which is how `spawnWithWslSupport` runs Orpheus); e2a sets
it itself at import from `models_dir`.

**The version difference cannot affect a single chunk, because stanza is never
called on the Orpheus path.** `get_chapters` constructs a pipeline for every book
whose language is in `year_to_decades_languages` (English is), and the ONLY
consumer is `filter_chapter`'s `elif stanza_nlp:` branch — unreachable for
Orpheus, whose branch comes first. The processors are `tokenize,ner,mwt` and what
was wanted from it was NER date spans; e2a's sentence segmentation is
`get_sentences`' PASS 1 regex, not stanza.

Proven, not argued: `tests/test_text_prep_golden.py` produces byte-identical chunk
lists under BOTH interpreters with no stanza model on either path.

Side note worth an operator's attention: **e2a's English prep cannot run natively
on Windows today** — there are no stanza models under `<e2a>\models\stanza`, so
`stanza.Pipeline(...)` must download ~591 MB or raise, and if it raises
`get_chapters` returns `[]` and the whole prep fails. narrator's prep runs on both
machines.

---

## 3. Behaviour differences (exhaustive)

The design target is zero. Five remain; each is stated with what it costs.

### 3.1 No stanza pipeline is constructed — REMOVES a load and a failure mode

e2a builds `stanza.Pipeline('en', processors='tokenize,ner,mwt', ...)` inside
`get_chapters` for every English book and never consults it (§2). narrator does
not build it.

- **Output difference: none, and it is not an argument — it is what §2's
  two-interpreter parity run measures.**
- **Failure-mode difference: e2a's prep FAILS (`get_chapters` returns `[]`) when
  the stanza models are missing; narrator's does not.** That is a removed failure
  mode, which the ground rules allow ("do not ADD failure modes e2a lacks").
- Cost: ~600 MB and a pipeline load per prep, both gone.
- If a future engine needs the date/NER transform, `text/sentences.py` names the
  seam and the exact constructor to put back.

### 3.2 `foreign2latin`'s romanizers are imported lazily

e2a imports `unidecode` and `phonemizer` at the top of `core.py`; narrator imports
them inside `_romanize`, beside the `pypinyin`/`pykakasi` imports e2a already
defers. Reached only for a NON-LATIN word, so for every book narrator will prep
(Orpheus is English-only) the imports never happen. Output identical; the failure
for a missing `unidecode` moves from import time to the first non-Latin word.

### 3.3 Two state keys are `null` where e2a wrote an install-relative path

Both for the same reason, and both are the NO-FALLBACKS rule applied rather than
an oversight: narrator has no ebook2audiobook installation to be relative to, and
will not invent one.

| key | e2a wrote | narrator writes | who reads it |
|---|---|---|---|
| `audiobooks_dir` | `conf.audiobooks_cli_dir` = `<e2a_root>/audiobooks/cli` when `--output_dir` is absent (`handlers.py:53-57`) | `null` | nobody - assembly takes `--output_dir` |
| `custom_model_dir` | `<models_dir>/__sessions/model-<session id>` when `--custom_model_dir` is absent (`session.py:477`) | `null` | nobody on the Orpheus path - it is the XTTS zip-extraction staging root, and BookForge passes the flag itself when it stages a custom voice |

When the flag IS passed, both keys hold exactly what e2a would have held.
`tests/test_text_prep_golden.py` lists both under `EXCLUDED_KEYS` with these
reasons and asserts that the excluded set plus the compared set is the WHOLE key
set on both sides, so a key can never be dropped from the comparison silently.

### 3.4 Prep makes four directories, not seven; and no VRAM probe

`prepare_dirs` created `models/tts`, the session dir, the process dir,
`models/__sessions/model-<id>`, `voices/__sessions/voice-<id>/<lang>`,
`audiobooks/cli`, `chapters/` and `chapters/sentences/`. narrator makes the
session dir, the process dir, `chapters/` and `chapters/sentences/` — the four the
session layout in `CONTRACTS.md` names. The other three belong to e2a's own
installation layout. Likewise `VRAMDetector().detect_vram(...)` is not run:
`free_vram_gb` lived on the session object and `save_session_state` never wrote
it, so it reached no file and no later stage. Prep is CPU text work.

### 3.5 Log lines are ASCII

Four e2a prep log strings end in a Unicode ellipsis (`Parsing xhtml markers…`,
`Flattening as raw text…`, `Normalize text…`, `Get sentences…`, plus the Orpheus
book-exact line). narrator writes `...`. Required by `CONTRACTS.md` ("ASCII only
in anything that reaches a console or a log line"); safe because
`parallel-tts-bridge.ts` only LOGS prep stdout — it parses nothing from it
(`:3305-3320`), and it explicitly skips any line starting with `{`. CHUNK TEXT is
data and is never touched.

Also dropped: e2a's 8-line all-caps banner about "Character xx not found in the
vocabulary" printed at the top of `get_chapters` (an XTTS-era notice), and the
`show_alert()` gradio popups on a TOC-extraction warning and a malformed-SML
chapter. Both are UI, not behaviour.

### 3.6 (not a difference, recorded so nobody re-adds it) `session-state.json` is written atomically, LF, `ensure_ascii=False`

Inherited from `render/session_store.save_session_state`, whose docstring states
and justifies all three. Not re-litigated here.

`chapter-provenance.json` is written here, not there,
and takes the same LF-on-every-platform treatment for the same reason: e2a's text
mode already writes CRLF on Windows and LF in WSL, so its own bytes depend on the
machine, and every reader is a JSON parser. `ensure_ascii=False` and `indent=2`
are e2a's own arguments on that file (`core.py:509-513`), unchanged.

---

## 4. Unexercised e2a paths — implemented as a named refusal, not a second behaviour

Every one of these is a branch of a function ported here that BookForge's live
spawn cannot reach. Each raises with the flag/name and what to do instead.

| e2a path | where | why it is unreachable | narrator |
|---|---|---|---|
| Calibre conversion of `.txt`/`.pdf`/images/anything non-EPUB (`convert2epub`, 4 of its 5 branches) | `epub.accept_epub` | Foundry produces an EPUB for every book; e2a's own EPUB branch refuses to Calibre-convert an EPUB because it was destructive (78 spine docs out of a 7-chapter book; smart-quote rewriting of the very text the fine-tunes train on) | `UnsupportedInput`, naming the extension |
| every non-Orpheus engine (`normalize_text`'s six gated transforms, `filter_chapter`'s stanza/date branch, `get_sentences`' Voxtral packer and the default XTTS-class tail) | `normalize._refuse_engine`, called from `normalize_text`, `get_sentences`, `filter_chapter`, `prep_session` | `compat/FLAGS.md` refuses 18 engine names; `render/worker.py` refuses a session whose `tts_engine` is not `orpheus` | `UnsupportedEngine` |
| every language but English (`get_sentences`' ideogram tail; `language_mapping`'s other ~100 rows) | `lang.language_entry`, plus e2a's own `lang != 'eng'` refusal inside `filter_chapter`, ported verbatim | e2a's Orpheus branch refuses a non-English book by name before any of it runs | `UnsupportedLanguage` / e2a's own printed refusal + `None` |
| `--ebooks_dir` batch prep (`convert_ebook_batch`, core.py:4949) | `compat/flags.py` | no BookForge spawn has ever passed it; it loops one prep per file and `sys.exit(1)`s on the first failure | REFUSE, unchanged |
| `ORPHEUS_MAX_SENTENCES` (PASS 5's sentence-count cap and `_split_to_cap`) | ported and live in `packer.py` | OFF by default since 2026-07-12 and no spawn sets it | ported, not refused — it is one env var away |
| `SENTENCE_MIN_CHARS` / `HEADING_MIN_WORDS` overrides | ported and live | no spawn sets them; the defaults (25 / 3) are what every book was packed with | ported |
| `--sentence_per_paragraph` | ported and live in `chapters.filter_chapter` | `settings.sentencePerParagraph` is a real BookForge toggle (language-learning mode) but no golden used it | ported; covered by a unit test, not by a golden |
| `--skip_headings` | ported and live | same | ported; covered by a unit test |
| `get_ebook_title` | `epub.py` | e2a computes it inside `get_chapters` and never reads the result | ported anyway (a call with a side-effect-free body is still a call) |
| `load_json_chapters` / `save_json_chapters` (the resume chapters cache) | `chapters.py` | the parallel path resumes from `session-state.json`, not from this cache; nothing in `bookforge_ext` calls either | ported, unused |
| `load_chapter_provenance` | `chapters.py` | read by e2a's assembly, which narrator's `assemble/` replaces | ported, returning the payload instead of mutating a session |

---

## 5. Suspected bugs preserved

1. **`epub_content_hash` does not hash the EPUB.** It is
   `md5(<the copy's absolute PATH string>)`
   (`session.py:66`), and the process-dir name is `md5(<the --ebook path string>)`
   (`session.py:466`). Neither changes when the book's bytes change, and the two
   differ because `prepare_dirs` rebinds `session['ebook']` to the copy between
   them. Verified on kershaw: `md5('/home/telltale/ebook2audiobook/tmp/staged-
   ccd14111-....epub') == '645fe70686...'` (the process-dir name) and
   `md5('<that dir>/staged-ccd14111-....epub') == '6d302f8c08...'` (the stored
   hash). Preserved with its name, because `render/SESSION_READERS.md` enumerates
   its readers.

2. **`'...' -> '…'` in `punctuation_switch` can never fire.** `normalize_text`
   applies the table as a CHARACTER CLASS (`f"[{...keys...}]"`), so the only
   multi-character key contributes three `.` characters to the class and matches a
   single `.`, for which the table has no entry. Every single-character key works.
   For Orpheus the bug and the intent agree (book-exact text keeps `...`), so it
   is preserved rather than fixed.

3. **`_tuple_row`'s error path truncates a document silently.** Its
   `except -> return None` sits inside a GENERATOR, where `return` is a bare stop:
   the error is printed and the row stream simply ends, so a document that fails
   mid-walk yields a SHORT chapter rather than an error. Preserved; the caller's
   "no tuples_list" branch is the only thing that ever turns it into a failure.

4. **`session['metadata']`'s template carries two keys DC can never supply.**
   `'Source'` and `'Modified'` are capitalized, and Dublin Core names are
   lowercase, so `get_metadata('DC', 'Source')` matches nothing, forever.
   Preserved (they never reach `session-state.json` anyway — only title, creator
   and language do).

5. **A book with two `dc:creator`s keeps the LAST one.** `for value, attributes
   in data: metadata[key] = value` overwrites. Preserved.

6. **`cover: true` does not mean a cover was written.** `get_cover` returns the
   written path when it found an image and the bare `True` when it found none. All
   three goldens say `true` and none of them has a cover extracted by e2a — the
   `cover.jpg` in a live process_dir is BookForge's own
   (`reassembly-bridge.ts:948`). Assembly must test for the FILE. Preserved, and
   documented on the function.

7. **`filter_chapter` reads `ORPHEUS_MAX_CHARS` and throws the value away.** The
   `max_chars` it computes after the walk is never used again in that function;
   the only surviving effect is that an invalid value raises there rather than one
   call later. Preserved (the `del` makes the deadness explicit).

8. **An edited sentence's TEXT is still never written back.** Recorded in
   `render/PORT_NOTES.md` §9.8 as "not fixable in this column — the fix is for the
   edit to land in whatever owns the chunk text, which is prep's manifest,
   migration step 4". **Step 4 did not fix it either.** narrator's prep writes
   `chapter_sentences` exactly as e2a did; nothing in the retake path writes back
   into it. Fixing it means the retake route rewriting `session-state.json`, which
   is a change to a file `render/PORT_NOTES.md` §4 documents as written exactly
   once, by prep — a decision for the orchestrator, not a side effect of this port.

---

## 6. Golden parity — the result, and the one book that cannot match

`ORPHEUS_MAX_CHARS` is the packing cap and BookForge injects it per voice from
`electron/data/orpheus-models.json` (`parallel-tts-bridge.ts:3300-3306`). The
catalog moves, so the value each golden was prepped with is a FIXTURE FACT, taken
from the catalog commit that was current at the session's `created_at`:

| slug | prepped | voice | catalog commit in force | `ORPHEUS_MAX_CHARS` |
|---|---|---|---|---|
| kershaw | 2026-09-03 17:52 | mistborn | `f429050c` (09-02 21:09) | **430** |
| blacksun | 2026-08-31 18:26 | thirdreich | `9d9687b9` (08-28 22:39) | **500** |
| mutineer | 2026-09-04 11:37 | deathstalker | `c1dbda5f` (09-04 11:28) | **520** |

**kershaw and mutineer are byte-identical**, chapter by chapter, plus identical
`chapters[]` ranges, `chapter_titles`, `chapter_docs`, `chapter_titles_by_doc`,
`total_sentences`, `total_chapters`, `cover`, `final_name`, `filename_noext`.

**blacksun is not, and the reason is measured, not assumed.** Its session was
prepped 2026-08-31, before e2a commit `b33f2f78` (2026-09-02, "the engine reads
its text as printed"). Until that commit the packer's `clean_len` measured an
Orpheus row THROUGH the number transform:

```python
if tts_engine == 'orpheus' and orpheus_text_transform_enabled():
    def tts_form(s): return orpheus_expand_digits(orpheus_normalize_scripture(s))
```

so `'in 1959.'` counted as `'in nineteen fifty-nine.'` — 16 chars longer — and the
cap bounded the EXPANDED length. THE EXPERIMENT (2026-09-04, builder T): with that
one function restored and nothing else changed, narrator reproduces blacksun
**exactly — 2358 chunks, all 18 chapters byte-identical**. With 9daab0ba's
identity `tts_form` it produces 2310. So the port is faithful to 9daab0ba and the
blacksun fixture is a pre-9daab0ba artifact.

What is identical for blacksun even so: **the SPOKEN TEXT of every chapter**
(markers stripped, whitespace collapsed) matches the golden for all 18 chapters.
Only chunk BOUNDARIES moved. `tests/test_text_prep_golden.py` asserts exactly
that, and asserts strict byte parity for the other two.

`epub_content_hash` is compared BY RULE rather than by value for all three, and
this is the honest thing to compare: the value is `md5` of an absolute POSIX path
on the WSL machine that prepped the book (§5.1), which a run under any other root
cannot reproduce and should not fake. The test asserts (a) that narrator's hash is
`md5` of the internal EPUB path narrator itself wrote, and (b) that the GOLDEN's
stored hash is `md5` of the golden's stored `epub_path_internal` — the same rule,
proven on both sides.

Not compared, because prep does not write them: `metadata`'s `published` key and
the whole of `bookforge_metadata`. Both are written AFTER prep by
`reassembly-bridge.ts:1117-1159`; prep writes `metadata` as exactly
`{title, creator, language}` read from the EPUB's Dublin Core and
`bookforge_metadata` as `{}` (no CLI flag has ever set it). Measured: kershaw's
EPUB declares `dc:title` = `'Working Towards The Fuhrer. Kershaw, Ian. (nineteen
ninety-three) (en)'` and NO `dc:creator`, while the golden state says
`{'title': 'Working Towards The Fuhrer', 'creator': 'Ian Kershaw', 'published':
'1993-01-01T00:00:00.000Z'}` — which is BookForge's project metadata, not the
book's. blacksun, which never went through that path, still carries
`bookforge_metadata: {}`.


---

## 7. What in this column is NOT a port

Two things, both added after step 4 landed and both deliberately outside the
parity story. They are named here so a reader of this file does not take
everything in `text/` for a transcription of ebook2audiobook.

### 7.1 `text/paragraph_packer.py` - the SECOND chunking policy

Owen's rule (`docs/NARRATOR_PLAN.md`, "Chunking rule", 2026-09-04): a chunk is a
PARAGRAPH, consecutive short PROSE paragraphs merge up to a ~300-char floor,
headings / list items / scene breaks / chapter starts are walls, PDF-derived
blocks have their provisional fragments joined first, and an over-budget
paragraph is split at SENTENCE boundaries and never mid-sentence. It asks
`engine/protocol.py`'s `Budget` for every number, so Orpheus (430-520 chars) and
Higgs v3 (600 zero-shot placeholder; the fine-tune's value is MEASURED and read
from the catalog) get different chunk lists from one implementation.

`text/packer.py` is untouched and is still THE PARITY PACKER: every session on
disk was rendered with it and a resume of one depends on it.
`prep_session(chunking=...)` selects, the default is `'e2a'`, and the choice is
recorded in `session-state.json` under `bookforge_chunking` (additive, sorts
last) so a session always says how its chunks were made.

`get_chapters` gained ONE optional argument for this - `chapter_chunker`,
defaulting to `filter_chapter` - so the spine walk, the TOC identity mapping and
the provenance sidecar have one implementation rather than two that drift. A
default prep does not construct a budget, read a provenance stamp or import the
paragraph module at all.

### 7.2 Higgs v3 in the text layer

`normalize.BOOK_EXACT_ENGINES` is `{orpheus, higgs-v3}`, and that is a DECISION,
not a port: e2a had no Higgs branch because Higgs did not exist in it. The
reasoning is on the constant. `text/packer.py` and `chapters.filter_chapter`
stay Orpheus-only - their caps and floors were calibrated on Orpheus voices - so
`prep_session` refuses a Higgs book that asks for `chunking='e2a'` by name.

`--higgs_voice` is the one flag in `compat/FLAGS.md` that ebook2audiobook never
declared. A Higgs PREP works end to end today; a Higgs RENDER is refused by name
because `render/worker.py` (another column) carries no Higgs voice yet.
