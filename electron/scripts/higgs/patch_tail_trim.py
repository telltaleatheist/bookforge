"""Root-cause fix for the audible artifact at the end of every Higgs v3 chunk.

Symptom: every rendered chunk ends with a 100-160 ms burst that ramps from the
-70 dB noise floor up to about -30 dB and is cut off at its peak, after 300-900 ms
of silence. Owen heard it as "a stray syllable or sound after each sentence"
(chunks were ~1-2 sentences).

Cause, in vllm_omni/model_executor/stage_input_processors/higgs_audio_v3.py:
after the delay pattern is reverted, the trailing frames still hold the model's
ramp-down BOC(1024)/EOC(1025) sentinels -- spread over the last num_codebooks-1
= 7 frames, because codebook c is delayed by c positions. The code replaces
every out-of-range value with **0**, and 0 is a perfectly valid codec code, so
those 7 frames decode to real sound. It then trims exactly ONE frame (40 ms),
leaving ~6 frames (240 ms) of garbage audio at the end of every chunk.

The module even defines ``_filter_real_code_frames`` for this and never calls it.

Fix: drop the trailing run of frames that contain any out-of-range code, which
is exactly the ramp-down region -- precise, and it cannot eat real speech the
way a blind 7-frame trim could. Applied to both the sync collector and the
final flush of the async-chunk streaming adapter.

PROVENANCE: copied from
    E:\\training\\_campaigns\\2026-09-01-cod-full-rebuild\\higgs\\work\\patch_tail_trim.py
(owens-pc, 2026-09-04). Every anchor and replacement below is byte-identical to
that original; the only change is that the target path is resolved from the env
prefix (argv[1] or $HIGGS_ENV) instead of being hardcoded to /home/telltale, so
this ships and nothing at run time reads E:\\training.

MEASURED EFFECT on the terminal burst peak, per chunk: -29.8 -> -46.2, -31.9 ->
-43.4, -31.6 -> -52.8, -29.9 -> -49.1 dB. IDEMPOTENT (always patches from the
pristine .orig), and it MUST be re-run after any pip upgrade in the env, which
replaces the file and silently reverts it.
"""
import glob
import os
import shutil
import sys

REL = "vllm_omni/model_executor/stage_input_processors/higgs_audio_v3.py"


def target_path() -> str:
    """The file to patch. See patch_vllm.py's copy for why python* is globbed
    and why the hits are deduped by real path (conda's python3.1 symlink)."""
    prefix = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("HIGGS_ENV", "")).rstrip("/")
    if not prefix:
        raise SystemExit("usage: patch_tail_trim.py <conda-env-prefix>   (or set HIGGS_ENV)")
    hits = sorted({os.path.realpath(p) for p in glob.glob(f"{prefix}/lib/python*/site-packages/{REL}")})
    if not hits:
        raise SystemExit(f"NOT_FOUND: no {REL} under {prefix}/lib/python*/site-packages")
    if len(hits) > 1:
        raise SystemExit(f"AMBIGUOUS: {len(hits)} distinct site-packages trees under {prefix}: {hits}")
    return hits[0]

HELPER = '''

def _trim_trailing_sentinel_frames(codes_qt: "torch.Tensor") -> "torch.Tensor":
    """Drop the trailing run of frames holding ramp-down BOC/EOC sentinels.

    PATCH (bookforge 2026-09-04). Input [Q, T] AFTER delay-pattern reversal.
    Because codebook c is delayed by c positions, the model's end-of-stream
    sentinels smear across the last Q-1 frames. Substituting them with 0 (as
    the callers do) turns them into a VALID codec code that decodes to an
    audible burst, and the original one-frame trim removed only 40 ms of it.
    Trimming by sentinel content removes exactly the contaminated tail and
    never eats real speech.
    """
    if codes_qt.numel() == 0:
        return codes_qt
    bad = ((codes_qt >= _NUM_REAL_CODES) | (codes_qt < 0)).any(dim=0)
    end = int(bad.shape[0])
    while end > 0 and bool(bad[end - 1]):
        end -= 1
    return codes_qt[:, :end]
'''

SYNC_OLD = """        # Step 3: Trim the last frame. After de-delay, the final frame
        # contains residual ramp-down codes (EOC→0 substituted) that
        # decode to a brief noise artifact at the end of the audio.
        if codes_qt.shape[-1] >= 2:
            codes_qt = codes_qt[:, :-1]"""

SYNC_NEW = """        # Step 3: (PATCHED) drop the whole trailing sentinel run, not just one
        # frame. See _trim_trailing_sentinel_frames: the ramp-down sentinels
        # smear over the last Q-1 = 7 frames, so the original [:, :-1] left
        # ~240 ms of audible garbage at the end of every chunk.
        codes_qt = _trim_trailing_sentinel_frames(codes_qt)"""

ASYNC_OLD = """    if finished and window_row_end_exclusive == n_rows and de_delayed.shape[-1] >= 2:
        de_delayed = de_delayed[:, :-1]
        actual_chunk = max(actual_chunk - 1, 0)"""

ASYNC_NEW = """    if finished and window_row_end_exclusive == n_rows and de_delayed.shape[-1] >= 2:
        # PATCHED: trim the full trailing sentinel run rather than one frame.
        _before = de_delayed.shape[-1]
        de_delayed = _trim_trailing_sentinel_frames(de_delayed)
        actual_chunk = max(actual_chunk - (_before - de_delayed.shape[-1]), 0)"""


def main():
    P = target_path()
    if not os.path.exists(P + ".orig"):
        shutil.copy2(P, P + ".orig")
    src = open(P + ".orig").read()

    # NOTE: the sentinel substitution must happen AFTER the trim, otherwise the
    # sentinels are already 0 and invisible. Both call sites substitute first,
    # so insert the trim before their torch.where(...) blocks by replacing the
    # trims and reordering is not needed: torch.where runs before Step 3 in the
    # sync path, so we must instead trim on the PRE-substitution tensor.
    marker = "def talker2code2wav("
    assert marker in src
    src = src.replace(marker, HELPER.strip("\n") + "\n\n\n" + marker, 1)

    for old, new, label in ((SYNC_OLD, SYNC_NEW, "sync"),
                            (ASYNC_OLD, ASYNC_NEW, "async")):
        if old not in src:
            print(f"ANCHOR_NOT_FOUND:{label}", file=sys.stderr)
            sys.exit(2)
        src = src.replace(old, new, 1)

    # Move the sentinel->0 substitution AFTER the trim in both paths so the
    # trim can still see the sentinels.
    sync_sub = """        codes_qt = torch.where(
            (codes_qt >= _NUM_REAL_CODES) | (codes_qt < 0),
            torch.zeros_like(codes_qt),
            codes_qt,
        )"""
    assert sync_sub in src, "sync substitution block not found"
    src = src.replace(sync_sub, "        # (substitution moved below the trim by patch)", 1)
    src = src.replace(SYNC_NEW, SYNC_NEW + "\n\n" + sync_sub, 1)

    async_sub = """    de_delayed = torch.where(
        (de_delayed >= _NUM_REAL_CODES) | (de_delayed < 0),
        torch.zeros_like(de_delayed),
        de_delayed,
    )"""
    assert async_sub in src, "async substitution block not found"
    src = src.replace(async_sub, "    # (substitution moved below the trim by patch)", 1)
    src = src.replace(ASYNC_NEW, ASYNC_NEW + "\n\n" + async_sub, 1)

    open(P, "w").write(src)
    import py_compile
    py_compile.compile(P, doraise=True)
    print("PATCHED " + P)


if __name__ == "__main__":
    main()
