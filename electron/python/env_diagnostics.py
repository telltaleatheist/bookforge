#!/usr/bin/env python3
"""
Standalone TTS-engine environment diagnostic.

BookForge runs this INSIDE a target engine env (a BYO WSL conda env, a managed
relocatable env, or a native conda env) to tell the user whether that env is
complete and functional — and if not, exactly what's wrong (wrong Python, no
CUDA-enabled PyTorch, wrong vLLM version, missing engine package, too little
VRAM, …). It must stay dependency-free: only the stdlib is imported at top
level; every engine library is probed defensively so a missing/broken package
becomes a reported FAIL instead of a traceback.

Usage:
    python env_diagnostics.py --engine orpheus [--min-vram-mb 6000]

Output: a single JSON object on stdout:
    {
      "engine": "orpheus",
      "ok": false,
      "checks": [
        {"name": "...", "status": "ok|warn|fail", "detail": "...", "hint": "..."},
        ...
      ]
    }
Exit code is 0 when every check is ok/warn, 1 when any check failed. (The JSON
is the source of truth; the exit code is a convenience.)
"""

import argparse
import json
import sys

OK, WARN, FAIL = "ok", "warn", "fail"


# Per-engine expectations. `py` is the expected CPython minor; `vllm` is a
# (predicate, human-text) pair; `packages` are import names that MUST succeed.
ENGINES = {
    "orpheus": {
        "py": (3, 11),
        "needs_cuda": True,
        "vllm": (lambda v: v == "0.7.3", "exactly 0.7.3 (Orpheus is pinned to it)"),
        "packages": ["orpheus_tts", "snac"],
    },
    "voxtral": {
        "py": (3, 11),
        "needs_cuda": True,
        "vllm": (lambda v: _ge(v, "0.18.0"), ">= 0.18.0"),
        "packages": ["vllm_omni"],
    },
    "xtts": {
        "py": (3, 11),
        "needs_cuda": False,  # XTTS runs on CPU too; CUDA is a speed bonus
        "vllm": None,
        "packages": ["TTS"],
    },
    "f5": {
        "py": (3, 11),
        "needs_cuda": False,
        "vllm": None,
        "packages": ["f5_tts"],  # f5_tts_mlx on Apple Silicon — handled by caller
    },
}


def _ge(version, floor):
    """version >= floor on dotted numeric components (best-effort)."""
    def parts(s):
        out = []
        for p in s.split("."):
            num = ""
            for ch in p:
                if ch.isdigit():
                    num += ch
                else:
                    break
            out.append(int(num) if num else 0)
        return out
    a, b = parts(version), parts(floor)
    a += [0] * (len(b) - len(a))
    b += [0] * (len(a) - len(b))
    return a >= b


def check(name, status, detail, hint=""):
    return {"name": name, "status": status, "detail": detail, "hint": hint}


def check_python(spec):
    want = spec["py"]
    got = sys.version_info[:2]
    detail = "Python %d.%d.%d" % sys.version_info[:3]
    if got == tuple(want):
        return check("Python version", OK, detail)
    return check(
        "Python version", FAIL, "%s (need %d.%d)" % (detail, *want),
        "Recreate the env with python=%d.%d." % tuple(want),
    )


def check_torch(spec):
    checks = []
    try:
        import torch
    except Exception as e:  # noqa: BLE001 — any import failure is a FAIL
        checks.append(check(
            "PyTorch", FAIL, "import torch failed: %s" % e,
            "Install a CUDA build of PyTorch in this env.",
        ))
        return checks, None
    checks.append(check("PyTorch", OK, "torch %s" % torch.__version__))

    if spec["needs_cuda"]:
        try:
            avail = torch.cuda.is_available()
        except Exception as e:  # noqa: BLE001
            avail = False
            checks.append(check(
                "CUDA available", FAIL, "torch.cuda.is_available() raised: %s" % e,
                "Check the NVIDIA driver and (on WSL) CUDA passthrough.",
            ))
            return checks, torch
        if avail:
            cu = getattr(torch.version, "cuda", None)
            checks.append(check("CUDA available", OK, "yes (CUDA %s)" % (cu or "?")))
        else:
            checks.append(check(
                "CUDA available", FAIL, "torch reports CUDA unavailable",
                "This env has a CPU-only PyTorch, or the driver/WSL CUDA passthrough "
                "is broken. Reinstall a +cuXXX torch build and verify `nvidia-smi`.",
            ))
    return checks, torch


def check_gpu(torch, min_vram_mb):
    if torch is None:
        return None
    try:
        if not torch.cuda.is_available():
            return None
        name = torch.cuda.get_device_name(0)
        total = torch.cuda.get_device_properties(0).total_memory
        mb = total // (1024 * 1024)
        if min_vram_mb and mb < min_vram_mb:
            return check(
                "GPU VRAM", WARN, "%s, %d MB" % (name, mb),
                "This engine wants >= %d MB; rendering may OOM." % min_vram_mb,
            )
        return check("GPU", OK, "%s, %d MB VRAM" % (name, mb))
    except Exception as e:  # noqa: BLE001
        return check("GPU", WARN, "could not query device: %s" % e)


def check_vllm(spec):
    want = spec["vllm"]
    if not want:
        return None
    pred, text = want
    try:
        import vllm
    except Exception as e:  # noqa: BLE001
        return check(
            "vLLM", FAIL, "import vllm failed: %s" % e,
            "This engine needs vLLM %s." % text,
        )
    v = getattr(vllm, "__version__", "?")
    if pred(v):
        return check("vLLM version", OK, "vllm %s" % v)
    return check(
        "vLLM version", FAIL, "vllm %s (need %s)" % (v, text),
        "Reinstall the matching vLLM (and vllm-omni at the same major.minor).",
    )


def check_packages(spec):
    checks = []
    for mod in spec["packages"]:
        try:
            m = __import__(mod)
            ver = getattr(m, "__version__", "")
            checks.append(check(
                "Package: %s" % mod, OK, ("%s %s" % (mod, ver)).strip(),
            ))
        except Exception as e:  # noqa: BLE001
            checks.append(check(
                "Package: %s" % mod, FAIL, "import %s failed: %s" % (mod, e),
                "Install %s into this env." % mod,
            ))
    return checks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--min-vram-mb", type=int, default=0)
    args = ap.parse_args()

    spec = ENGINES.get(args.engine.lower())
    if not spec:
        print(json.dumps({
            "engine": args.engine, "ok": False,
            "checks": [check("Engine", FAIL, "unknown engine '%s'" % args.engine)],
        }))
        return 1

    checks = [check_python(spec)]
    torch_checks, torch = check_torch(spec)
    checks += torch_checks
    gpu = check_gpu(torch, args.min_vram_mb)
    if gpu:
        checks.append(gpu)
    vllm_check = check_vllm(spec)
    if vllm_check:
        checks.append(vllm_check)
    checks += check_packages(spec)

    ok = all(c["status"] != FAIL for c in checks)
    print(json.dumps({"engine": args.engine.lower(), "ok": ok, "checks": checks}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
