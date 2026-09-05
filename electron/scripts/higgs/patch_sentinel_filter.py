"""ROOT FIX for the chunk-tail artifact: filter sentinel frames by TOKEN IDENTITY.

SUPERSEDES patch_tail_trim.py, which was a band-aid and is deleted from this
directory. Both edited the same file; only one may be applied, and this script
refuses to stack on the other.

── The defect ───────────────────────────────────────────────────────────────
Upstream, in ``vllm_omni/model_executor/stage_input_processors/higgs_audio_v3.py``,
after the delay pattern is reverted the code does:

    codes_qt = torch.where((codes_qt >= 1024) | (codes_qt < 0), 0, codes_qt)
    if codes_qt.shape[-1] >= 2:
        codes_qt = codes_qt[:, :-1]          # trim exactly one frame

Both halves are wrong:

* **0 is a valid codec code.** Substituting a BOC(1024)/EOC(1025) sentinel with
  0 does not neutralise it, it *converts it into real sound*. The module's own
  comment says clamping would be wrong because 1025 -> 1023 "decodes to audio
  artifacts" — but 0 is no better, it is simply a different valid code.
* **One frame is the wrong amount.** Codebook c is delayed by c positions, so
  the ramp-down sentinels smear across the last Q-1 = 7 frames. Trimming one
  leaves ~6 frames = 240 ms of garbage.

The module already defines ``_filter_real_code_frames`` for exactly this and
never calls it.

── Why patch_tail_trim.py was still a band-aid ──────────────────────────────
It walked backwards from the end while frames were bad. That is positional
reasoning about where sentinels *usually* sit, and it kept the 0-substitution
for everything that was not in the trailing run. A sentinel anywhere else — a
``-1`` pad from the talker's ``staged_codes`` when a row is not updated, a
window that opens on BOC rows in the streaming path, a truncated generation —
still reached the codec as code 0.

── The fix ──────────────────────────────────────────────────────────────────
Decide by TOKEN IDENTITY, never by position and never by audio content: a frame
is kept iff **all 8 codebooks** are in [0, 1023]. Nothing out of range is ever
handed to the codec, so the substitution disappears entirely.

The two call sites differ, and deliberately:

* **sync** (``talker2code2wav``) has no positional contract downstream, so it
  gets the full filter — leading, interior and trailing.
* **async_chunk** does: Stage 1 trims ``left_context_size * hop`` samples off
  the front and ``right_holdback_size * hop`` off the end, **by frame count**.
  Dropping a leading or interior frame there would desync those trims and cut
  real speech. So the streaming path drops only the trailing run (which lies
  past the emit boundary and is what the band-aid was reaching for) and
  substitutes-with-a-warning anywhere else — the leading region is inside the
  left context Stage 1 discards anyway.

Interior sentinels should never occur. When they do, the filter drops them and
logs a warning rather than splicing silently: a gate is a defect sensor, not a
silent repair.

No fade is added. A fade would be a content-domain fix for a token-domain
defect; add one only if a seam is actually measured.

── KNOWN, AND NOT A DEFECT IN THE AUDIO ─────────────────────────────────────
The async warning at ``higgs_audio_v3.py:403`` ("frame(s) carry a stream
sentinel outside the trailing run") is an INSTRUMENTATION BUG in this patch,
measured by the fine-tuning session 2026-09-05: the out-of-range count is taken
BEFORE the trailing-run trim, so it counts the normal 2-frame EOC ramp and calls
it "elsewhere". Expect exactly "2 frame(s)" per chunk, in sequential renders as
much as concurrent ones. Offline positional classification of every saved talker
matrix puts interior sentinel frames at ZERO on all real shapes, and the
sync-path interior detector has never fired. So a log full of :403 lines is not
a failing render — COUNT them and report the count; the assertions that mean
something are (a) zero SYNC-path interior drops and (b) no one-frame trim code
left in this file. Their one-line fix for the count changes this file's bytes
and therefore lands as a NEW server build with its own certificate — see
docs/HIGGS_ENGINE.md on what a certificate binds.

PROVENANCE: transcribed from
    E:\\training\\_campaigns\\2026-09-01-cod-full-rebuild\\higgs\\work\\patch_sentinel_filter.py
(owens-pc, 2026-09-04). Every anchor, helper and replacement below is
byte-identical to that original — the emitted file must be reproducible, because
its sha256 is what a certificate names. Two things differ and nothing else does:
the target path is resolved from the env prefix (argv[1] or $HIGGS_ENV) instead
of being hardcoded to /home/telltale, so this ships; and the supersession of
patch_tail_trim.py is handled explicitly instead of being assumed (see
`base_source`).

MEASURED on the certifying box, 2026-09-05, vllm-omni 0.28.0:
    pristine higgs_audio_v3.py    sha256 376ca5647773cb191634b266b03bfefe490c080ef9f75aed045f1f31c9a19fb4
    patched by this recipe        sha256 0b36f6507dd11653253bbebb278c3657e5d17a2a52f78018cd0bddd45a7ac210
    `[:, :-1]` occurrences        2 pristine, 0 patched

IDEMPOTENT, and it MUST be re-run after any pip upgrade in the env, which
replaces the file and silently reverts the patch.

  python patch_sentinel_filter.py <conda-env-prefix>            # apply
  python patch_sentinel_filter.py <conda-env-prefix> --revert   # restore .orig
"""
import glob
import os
import py_compile
import shutil
import sys

REL = "vllm_omni/model_executor/stage_input_processors/higgs_audio_v3.py"

#: What the doctor greps for, and what "patched" MEANS. Kept identical to
#: HIGGS_PATCHES in electron/tool-paths.ts and to the catalog's serving.patches;
#: a keeper asserts this script writes it.
#:
#: It is `_filter_sentinel_frames` and NOT `_trim_trailing_sentinel_frames`,
#: which this patch also writes: the superseded patch_tail_trim.py wrote the
#: trailing-run helper too, so grepping for that one would certify a file
#: carrying only the band-aid as patched. The marker has to be the string only
#: THIS recipe can produce.
MARKER = "_filter_sentinel_frames"

#: What must NOT be in the patched file — upstream's one-frame trim, in both the
#: sync and the async path. This is half (b) of the patch's proof: "the
#: token-identity filter is in AND no trim code remains". Measured on the
#: certifying box: 2 occurrences pristine, 0 after this patch.
ABSENT_MARKER = "[:, :-1]"

#: Written by the SUPERSEDED patch_tail_trim.py as well as by this one, so it
#: identifies a band-aided file only in the absence of MARKER.
SUPERSEDED_MARKER = "_trim_trailing_sentinel_frames"


def target_path() -> str:
    """The file to patch. See patch_vllm.py's copy for why python* is globbed
    and why the hits are deduped by real path (conda's python3.1 symlink)."""
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    prefix = (args[0] if args else os.environ.get("HIGGS_ENV", "")).rstrip("/")
    if not prefix:
        raise SystemExit(
            "usage: patch_sentinel_filter.py <conda-env-prefix> [--revert]   (or set HIGGS_ENV)")
    hits = sorted({os.path.realpath(p) for p in glob.glob(f"{prefix}/lib/python*/site-packages/{REL}")})
    if not hits:
        raise SystemExit(f"NOT_FOUND: no {REL} under {prefix}/lib/python*/site-packages")
    if len(hits) > 1:
        raise SystemExit(f"AMBIGUOUS: {len(hits)} distinct site-packages trees under {prefix}: {hits}")
    return hits[0]


def read(path: str) -> str:
    """UTF-8 and NO newline translation, both stated rather than inherited: the
    anchors below contain a U+2192 arrow, and the emitted file's sha256 is what
    a certificate names, so neither the locale encoding nor the platform's line
    endings may decide what this writes."""
    with open(path, "r", encoding="utf-8", newline="") as handle:
        return handle.read()


HELPER = '''

def _filter_sentinel_frames(codes_qt: "torch.Tensor", where: str = "") -> "torch.Tensor":
    """Keep only frames whose codebooks are ALL real codes. [Q, T] -> [Q, T'].

    PATCH (bookforge 2026-09-04, patch_sentinel_filter.py). Decides by TOKEN
    IDENTITY after delay-pattern reversal: a frame survives iff every one of the
    Q codebooks is in [0, _NUM_REAL_CODES). Out-of-range values are the stream
    sentinels BOC=1024 / EOC=1025 and the talker's -1 pad; substituting them
    with 0 (as upstream does) turns them into a VALID codec code that decodes to
    an audible burst, which is the whole defect.

    Interior sentinel frames are not expected. If any appear they are dropped
    and logged, so the condition surfaces instead of being silently spliced.
    """
    if codes_qt.numel() == 0:
        return codes_qt
    valid = ((codes_qt >= 0) & (codes_qt < _NUM_REAL_CODES)).all(dim=0)
    total = int(valid.numel())
    kept = int(valid.sum())
    if kept == total:
        return codes_qt
    if kept == 0:
        logger.warning("higgs_audio_v3%s: every frame carried a stream sentinel; "
                       "emitting no audio for this chunk", where)
        return codes_qt[:, :0]
    idx = valid.nonzero(as_tuple=True)[0]
    lo, hi = int(idx[0]), int(idx[-1])
    interior = int((~valid[lo:hi + 1]).sum())
    if interior:
        logger.warning("higgs_audio_v3%s: %d interior sentinel frame(s) dropped "
                       "(%d/%d frames kept) -- this is not an expected shape",
                       where, interior, kept, total)
    return codes_qt[:, valid]


def _trim_trailing_sentinel_frames(codes_qt: "torch.Tensor") -> "torch.Tensor":
    """Trailing-only variant for the streaming path, where Stage 1 trims by
    FRAME COUNT (left_context_size / right_holdback_size) and dropping a leading
    or interior frame would desync those trims and cut real speech."""
    if codes_qt.numel() == 0:
        return codes_qt
    bad = ((codes_qt >= _NUM_REAL_CODES) | (codes_qt < 0)).any(dim=0)
    end = int(bad.shape[0])
    while end > 0 and bool(bad[end - 1]):
        end -= 1
    return codes_qt[:, :end]
'''

# ---- sync path: replace the substitution AND the one-frame trim ------------
SYNC_OLD = """        # Step 2: Replace out-of-range codes (BOC=1024, EOC=1025, -1) with 0.
        # Must use torch.where, NOT clamp: clamp(max=1023) turns 1025→1023
        # which is a valid codec code and decodes to audio artifacts.
        # Matches sglang's: torch.where(codes >= codec_vocab, 0, codes)
        codes_qt = torch.where(
            (codes_qt >= _NUM_REAL_CODES) | (codes_qt < 0),
            torch.zeros_like(codes_qt),
            codes_qt,
        )

        # Step 3: Trim the last frame. After de-delay, the final frame
        # contains residual ramp-down codes (EOC→0 substituted) that
        # decode to a brief noise artifact at the end of the audio.
        if codes_qt.shape[-1] >= 2:
            codes_qt = codes_qt[:, :-1]"""

SYNC_NEW = """        # Step 2+3 (PATCHED, patch_sentinel_filter.py): decide by TOKEN
        # IDENTITY. Upstream substituted every out-of-range code with 0 and
        # then trimmed one frame; 0 is a VALID codec code, so the substitution
        # converted the ramp-down sentinels into real sound, and one frame was
        # the wrong amount because the sentinels smear over the last Q-1 = 7
        # frames. Nothing out of range now reaches the codec at all.
        codes_qt = _filter_sentinel_frames(codes_qt, " (sync)")"""

# ---- async path: trailing-only, and keep the count bookkeeping -------------
ASYNC_OLD = """    if finished and window_row_end_exclusive == n_rows and de_delayed.shape[-1] >= 2:
        de_delayed = de_delayed[:, :-1]
        actual_chunk = max(actual_chunk - 1, 0)"""

ASYNC_NEW = """    if finished and window_row_end_exclusive == n_rows and de_delayed.shape[-1] >= 2:
        # PATCHED: drop the WHOLE trailing sentinel run, not one frame. Only the
        # trailing run: Stage 1 trims left_context_size/right_holdback_size by
        # FRAME COUNT, so removing a leading or interior frame here would desync
        # those trims and cut real speech.
        _before = de_delayed.shape[-1]
        de_delayed = _trim_trailing_sentinel_frames(de_delayed)
        actual_chunk = max(actual_chunk - (_before - de_delayed.shape[-1]), 0)"""

ASYNC_SUB_OLD = """    de_delayed = torch.where(
        (de_delayed >= _NUM_REAL_CODES) | (de_delayed < 0),
        torch.zeros_like(de_delayed),
        de_delayed,
    )"""

ASYNC_SUB_NEW = """    # PATCHED: the trailing run is removed below by token identity. Any
    # remaining out-of-range value sits in the left-context region Stage 1
    # discards, so substituting is harmless there -- but it is logged, because
    # a sentinel outside the trailing run is not an expected shape.
    _oor = int(((de_delayed >= _NUM_REAL_CODES) | (de_delayed < 0)).any(dim=0).sum())
    if _oor:
        logger.warning("higgs_audio_v3 (async): %d frame(s) carry a stream "
                       "sentinel outside the trailing run", _oor)
    de_delayed = torch.where(
        (de_delayed >= _NUM_REAL_CODES) | (de_delayed < 0),
        torch.zeros_like(de_delayed),
        de_delayed,
    )"""


def base_source(path: str, orig: str) -> str:
    """The PRISTINE text to patch, and the one place supersession is decided.

    Three states, all of them named:

      live is pristine        patch it, and snapshot it to `.orig` first. The
                              snapshot is taken HERE rather than trusted from an
                              earlier run, because a pip upgrade replaces the
                              site-packages file and an old `.orig` would then
                              hold the PREVIOUS version's source — writing that
                              back is how a stale file gets certified as patched.
      live carries the        the superseded patch_tail_trim.py is applied. Its
      band-aid                anchors are gone, so patching the live text would
                              fail on ANCHOR_NOT_FOUND with nothing saying why.
                              Restore from `.orig`, which that patch wrote from
                              the live file immediately before editing it and is
                              therefore the same pip generation by construction.
      live carries the        ALREADY_PATCHED, handled by the caller.
      filter

    Anything else — a band-aided file with no `.orig`, or an `.orig` that is
    itself patched — is REFUSED by name. Guessing here means writing unknown
    bytes into the file whose sha256 a certificate names.
    """
    live = read(path)
    if SUPERSEDED_MARKER not in live:
        shutil.copy2(path, orig)
        return live
    if not os.path.exists(orig):
        raise SystemExit(
            f"SUPERSEDED_NO_ORIG: {path} carries the retired patch_tail_trim.py "
            f"({SUPERSEDED_MARKER}) and there is no {os.path.basename(orig)} beside it to "
            "restore from. The two patches must never stack. Reinstall the package "
            "(pip install --force-reinstall vllm-omni==0.28.0) and re-run this script.")
    pristine = read(orig)
    if MARKER in pristine or SUPERSEDED_MARKER in pristine:
        raise SystemExit(
            f"ORIG_NOT_PRISTINE: {orig} is itself patched, so it cannot be used to "
            "undo the retired patch_tail_trim.py. Reinstall the package "
            "(pip install --force-reinstall vllm-omni==0.28.0) and re-run this script.")
    print(f"SUPERSEDING patch_tail_trim.py: restoring {path} from {orig}")
    return pristine


def main():
    path = target_path()
    orig = path + ".orig"

    if "--revert" in sys.argv:
        if not os.path.exists(orig):
            raise SystemExit(f"NO_ORIG: nothing to revert to at {orig}")
        shutil.copy2(orig, path)
        print("REVERTED to " + orig)
        return

    live = read(path)
    if MARKER in live:
        print("ALREADY_PATCHED " + path)
        return

    src = base_source(path, orig)

    marker = "def talker2code2wav("
    if marker not in src:
        print("ANCHOR_NOT_FOUND:talker2code2wav", file=sys.stderr)
        sys.exit(2)
    src = src.replace(marker, HELPER.strip("\n") + "\n\n\n" + marker, 1)

    for old, new, label in ((SYNC_OLD, SYNC_NEW, "sync"),
                            (ASYNC_SUB_OLD, ASYNC_SUB_NEW, "async-sub"),
                            (ASYNC_OLD, ASYNC_NEW, "async-trim")):
        if old not in src:
            print("ANCHOR_NOT_FOUND:" + label, file=sys.stderr)
            sys.exit(2)
        src = src.replace(old, new, 1)

    # the async substitution must run BEFORE the trailing trim it now precedes;
    # verify the resulting order rather than trusting the anchors.
    if src.index(ASYNC_SUB_NEW) > src.index(ASYNC_NEW):
        print("ORDER_ERROR: async substitution ended up after the trim",
              file=sys.stderr)
        sys.exit(3)

    # Half (b) of the patch's own proof, checked on the bytes about to be
    # written rather than left to the doctor: the token-identity filter is in
    # AND upstream's one-frame trim is gone from both paths.
    if ABSENT_MARKER in src:
        print("TRIM_SURVIVED: " + ABSENT_MARKER + " is still in the patched source",
              file=sys.stderr)
        sys.exit(4)

    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(src)
    py_compile.compile(path, doraise=True)
    print("PATCHED " + path)
    print("  sync  : full token-identity filter (_filter_sentinel_frames)")
    print("  async : trailing-run filter + warning on any other sentinel")
    print("  revert: python patch_sentinel_filter.py <env-prefix> --revert")


if __name__ == "__main__":
    main()
