#!/usr/bin/env python3
"""
Patch the bundled `ultimate_rvc` env so its GPU cache-free calls are MPS-aware.

WHY: ultimate_rvc frees GPU memory only under `if torch.cuda.is_available():
torch.cuda.empty_cache()`. On Apple Silicon there is no CUDA, so those calls are
no-ops and the MPS (Metal) buffers are never released. Across a long batch (e.g.
a full audiobook = 1000s of sentences via `urvc generate convert-dir`) the
unified-memory allocation balloons (observed: ~50 GB), overflows RAM into swap,
and the machine thrashes — RVC slows from ~4 s/sentence to ~20 s and climbing.

FIX: after each existing `torch.cuda.empty_cache()`, also free the MPS cache when
running on Metal. Keeps GPU speed AND bounds memory (strictly better than pinning
RVC to CPU). Mirrors the XTTS/voice-conversion MPS fixes elsewhere in the stack.

Idempotent. Run during urvc-env build (before conda-pack) and/or against an
installed env:  python patch-urvc-mps-memory.py [<site-packages-dir>]
"""
import re
import sys
import os
import shutil
import glob

PAT = re.compile(
    r'(?P<ind>[ \t]*)if torch\.cuda\.is_available\(\):\n'
    r'(?P=ind)    torch\.cuda\.empty_cache\(\)'
)


def _repl(m: "re.Match[str]") -> str:
    ind = m.group('ind')
    return (
        f"{ind}if torch.cuda.is_available():\n"
        f"{ind}    torch.cuda.empty_cache()\n"
        f"{ind}elif torch.backends.mps.is_available():\n"
        f"{ind}    torch.mps.empty_cache()"
    )


def find_pkg(site_packages: str | None) -> str:
    if site_packages and os.path.isdir(os.path.join(site_packages, 'ultimate_rvc')):
        return os.path.join(site_packages, 'ultimate_rvc')
    # else: try the importing interpreter
    import importlib.util
    spec = importlib.util.find_spec('ultimate_rvc')
    if spec and spec.submodule_search_locations:
        return spec.submodule_search_locations[0]
    raise SystemExit('Could not locate the ultimate_rvc package.')


def main() -> int:
    pkg = find_pkg(sys.argv[1] if len(sys.argv) > 1 else None)
    targets = [
        os.path.join(pkg, 'rvc', 'infer', 'pipeline.py'),
        os.path.join(pkg, 'rvc', 'infer', 'infer.py'),
    ]
    total = 0
    for f in targets:
        if not os.path.exists(f):
            print(f'skip (missing): {f}')
            continue
        src = open(f, encoding='utf-8').read()
        if 'torch.mps.empty_cache()' in src:
            print(f'already patched: {os.path.relpath(f, pkg)}')
            continue
        new, n = PAT.subn(_repl, src)
        if n:
            shutil.copy2(f, f + '.bak')
            open(f, 'w', encoding='utf-8').write(new)
            total += n
        print(f'patched {os.path.relpath(f, pkg)}: {n} site(s)')
    print(f'total sites patched: {total}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
