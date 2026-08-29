#!/usr/bin/env python
"""Resident audio-separator worker — ONE process, ONE model load, many files.

Why this exists
---------------
`run_audio_separator.py` (the CLI launcher next to this file) is a one-shot: every
invocation pays a fresh Python start, `import torch`, CUDA context creation and a
checkpoint load before it separates a single thing. The final-denoise pass feeds the
roformer ~20-minute blocks — a 15-hour book is ~44 of them — so that fixed cost was
being paid 44 times (10-25 s each) for ~85 s of real work per block.

This worker pays it ONCE. It builds the `Separator` and calls `load_model()` at
startup, then sits in a blocking readline loop serving one block at a time.

Identical output, by construction
---------------------------------
`audio_separator.utils.cli:main` does exactly what this does: construct `Separator`
with the parsed args, `load_model(model_filename=...)`, then loop `separate()` over
every input file with the SAME instance (the library's own sanctioned multi-file
usage — it clears the file-specific paths and the GPU cache between files). Every
separation parameter this worker leaves alone is an argparse default that is
byte-identical to the constructor default it replaces (normalization 0.9,
amplification 0.0, sample_rate 44100, and the mdx/vr/demucs/mdxc param blocks —
verified against audio-separator 0.31.1's cli.py). Nothing about the maths changes;
only the number of times the checkpoint is read off disk does.

Per-request output dir
----------------------
`Separator.load_model()` bakes `output_dir` into the architecture instance's common
config, and `common_separator.write_audio_pydub` is the ONLY place it is read
(`os.path.join(self.output_dir, stem_path)`), at write time. So a per-request output
directory is just re-pointing that one attribute before each `separate()`. The
worker asserts the attribute exists at startup rather than discovering it missing
mid-book.

Protocol (line-delimited JSON over stdin/stdout)
------------------------------------------------
Every line this worker means to be READ is prefixed with `@@BFSEP@@ ` — the
audio-separator logger writes to stderr and tqdm draws there too, but a stray
library `print()` must never be mistaken for a response.

  stdout  @@BFSEP@@ {"event":"loading","model":"..."}      (before any heavy import)
  stdout  @@BFSEP@@ {"event":"ready","loadSeconds":12.4}   (model resident)
  stdin   {"input":"C:/…/block_00.wav","outputDir":"C:/…/dn_00"}
  stdout  @@BFSEP@@ {"event":"result","ok":true,"outputs":[…],"seconds":83.1}
       or @@BFSEP@@ {"event":"result","ok":false,"error":"…traceback…"}
  stdin   EOF (parent closed the pipe / died)  →  clean exit 0
  stdout  @@BFSEP@@ {"event":"fatal","error":"…"}  →  exit 1 (startup failure)

Windows note: stdin is read with a BLOCKING readline on the MAIN thread, after the
model is loaded. It is never read from a background thread — a thread parked in a
stdin pipe read deadlocks any later DLL-loading import on Windows (see
`xtts_stream.py` and the windows-stdin-thread-dll-deadlock note). Here every DLL is
already loaded by the time the first read happens, and only one thread ever reads.
"""
import argparse
import json
import os
import sys
import time
import traceback

SENTINEL = "@@BFSEP@@"


def emit(obj):
    """Write one protocol line to stdout and flush it (the parent blocks on these)."""
    sys.stdout.write(SENTINEL + " " + json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser(description="Resident audio-separator worker")
    ap.add_argument("--model_filename", required=True)
    ap.add_argument("--model_file_dir", required=True)
    ap.add_argument("--output_dir", required=True, help="Initial output dir; each request overrides it.")
    ap.add_argument("--output_format", default="WAV")
    args = ap.parse_args()

    emit({"event": "loading", "model": args.model_filename})

    started = time.perf_counter()
    # Imported here, not at module scope, so the "loading" line is already on the wire
    # before torch spends 10+ seconds pulling in CUDA.
    from audio_separator.separator import Separator

    separator = Separator(
        model_file_dir=args.model_file_dir,
        output_dir=args.output_dir,
        output_format=args.output_format,
    )
    separator.load_model(model_filename=args.model_filename)

    # The per-request output dir rides on this attribute. If a future audio-separator
    # moves it, fail HERE — loudly, at startup — rather than silently writing every
    # block's stems into the wrong directory.
    model_instance = getattr(separator, "model_instance", None)
    if model_instance is None:
        raise RuntimeError("audio-separator loaded no model_instance — cannot separate.")
    if not hasattr(model_instance, "output_dir"):
        raise RuntimeError(
            "audio-separator's model instance has no output_dir attribute — this worker's "
            "per-request output directory mechanism no longer applies to this version."
        )

    emit({"event": "ready", "loadSeconds": round(time.perf_counter() - started, 2)})

    while True:
        line = sys.stdin.readline()
        if not line:
            break  # EOF: the parent closed our stdin (shutdown, or the parent died).
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError as exc:
            emit({"event": "result", "ok": False, "error": "unreadable request JSON: %s" % exc})
            continue
        if request.get("cmd") == "shutdown":
            break
        try:
            input_path = request["input"]
            output_dir = request["outputDir"]
            os.makedirs(output_dir, exist_ok=True)
            separator.output_dir = output_dir
            model_instance.output_dir = output_dir
            begun = time.perf_counter()
            outputs = separator.separate(input_path)
            emit({
                "event": "result",
                "ok": True,
                "outputs": list(outputs or []),
                "seconds": round(time.perf_counter() - begun, 2),
            })
        except Exception:  # noqa: BLE001 - the parent decides what a failure means
            emit({"event": "result", "ok": False, "error": traceback.format_exc()[-4000:]})


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        emit({"event": "fatal", "error": traceback.format_exc()[-4000:]})
        sys.exit(1)
    sys.exit(0)
