#!/usr/bin/env python
"""Install a raise-only `deepspeed` stub into THIS interpreter's site-packages.

Resemble Enhance imports deepspeed at module load (utils/engine.py,
enhancer/train.py, denoiser/train.py — reached transitively from the inference
entry point via train.py), but only ever *calls* it during training, which the
BookForge Enhance tab never does. Real deepspeed does not pip-install cleanly on
native Windows and is a heavy build on Apple Silicon, so we satisfy the import
with a stub whose every entry point raises immediately. If that RuntimeError ever
fires, something is genuinely trying to train — replace the stub with real
deepspeed on Linux/WSL and train there.

Run it WITH the target env's python so it lands in the right site-packages:
    conda run -n resemble-enhance python install_deepspeed_stub.py
Refuses to overwrite a real deepspeed install.
"""
import sys
import sysconfig
from pathlib import Path

FILES = {
    '__init__.py': (
        '"""STUB deepspeed — BookForge resemble-enhance env (inference-only)."""\n'
        "__version__ = '0.0.0+bookforge-inference-stub'\n"
        "_MSG = ('deepspeed stub (BookForge): this env is inference-only; training '\n"
        "        'requires real deepspeed, unavailable here')\n\n"
        'def _refuse(*_a, **_k):\n'
        '    raise RuntimeError(_MSG)\n\n'
        'class DeepSpeedConfig:\n'
        '    def __init__(self, *a, **k):\n'
        '        _refuse()\n\n'
        'def init_distributed(*a, **k):\n'
        '    _refuse()\n\n'
        'def initialize(*a, **k):\n'
        '    _refuse()\n'
    ),
    'accelerator/__init__.py': (
        '"""STUB deepspeed.accelerator."""\n'
        'from .. import _refuse\n\n'
        'def get_accelerator(*a, **k):\n'
        '    _refuse()\n'
    ),
    'runtime/__init__.py': '"""STUB deepspeed.runtime."""\n',
    'runtime/engine.py': (
        '"""STUB deepspeed.runtime.engine."""\n'
        'from .. import _refuse\n\n'
        'class DeepSpeedEngine:\n'
        '    def __init__(self, *a, **k):\n'
        '        _refuse()\n'
    ),
    'runtime/utils.py': (
        '"""STUB deepspeed.runtime.utils."""\n'
        'from .. import _refuse\n\n'
        'def clip_grad_norm_(*a, **k):\n'
        '    _refuse()\n'
    ),
}


def main():
    site = Path(sysconfig.get_paths()['purelib'])
    target = site / 'deepspeed'
    if target.exists():
        init = (target / '__init__.py').read_text(encoding='utf-8', errors='ignore')
        if 'bookforge-inference-stub' not in init:
            sys.exit(f'ERROR: real deepspeed already present at {target} — refusing to overwrite')
        print(f'stub already installed at {target}')
        return
    for rel, content in FILES.items():
        f = target / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(content, encoding='utf-8')
    print(f'installed deepspeed inference stub at {target}')


if __name__ == '__main__':
    main()
