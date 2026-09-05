"""narrator's text layer: EPUB -> chapters -> rows -> generation chunks.

This is migration step 4 of `docs/NARRATOR_PLAN.md`: the port of ebook2audiobook's
prep path (`--prep_only`). It is the ONE piece the plan calls "partly a judgment"
(2026-08-27 headings, 2026-08-29 list items, the min-chars floor), so every module
here is a transcription of an e2a function, named in its docstring, with the
behaviour differences enumerated in `text/PORT_NOTES.md`.

Modules, and the e2a seam each one mirrors:

  sml.py        conf_models.py's SML tables + core.py's escape/restore/marker tests
  lang.py       the conf_lang tables the prep path reads
  normalize.py  core.normalize_text + core.foreign2latin
  epub.py       core.convert2epub (EPUB branch), get_cover, normalize_doc_key,
                flatten_toc, get_ebook_title, the DC metadata read, the content hash
  chapters.py   core.get_chapters + core.filter_chapter + _heading_text + provenance
  sentences.py  the stanza seam - and the MEASUREMENT that nothing on the Orpheus
                path ever consults it
  packer.py     core.get_sentences and its five merge/split passes
  prep.py       bookforge_ext/parallel/session.prep_ebook_info + save_session_state

ORPHEUS-ONLY, BY REFUSAL. narrator renders Orpheus and nothing else
(`compat/FLAGS.md` refuses 18 engine names), and e2a's own Orpheus branch refuses
any language but English. So every module here ports the Orpheus/English branch of
its source function EXACTLY and REFUSES the others by name rather than porting a
second behaviour nothing exercises. `text/PORT_NOTES.md` lists each refusal under
"Unexercised e2a paths".
"""
