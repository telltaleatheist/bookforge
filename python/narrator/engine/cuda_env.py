"""The platform CUDA / vLLM environment block, applied at backend import.

Ported from ebook2audiobook@9daab0ba lib/conf.py (the CUDA/graph/allocator block,
lines 80-96) and lib/classes/tts_engines/orpheus.py (the module-scope
"Platform-specific vLLM configuration" block, lines 56-75).

WHY IT IS HERE AND NOT AT PACKAGE IMPORT. In e2a these two blocks ran at import
of `lib.conf` (pulled in by the engine's `headers` import) and at import of
`orpheus.py` respectively - in both cases BEFORE `import torch`. narrator keeps
that ordering by calling `apply()` at the top of every backend module, each of
which imports torch/vLLM/mlx only LAZILY, inside its functions. So the variables
are set at least as early as they were, and a machine with no torch can still
import `narrator.engine`.

Everything else lib/conf.py set (HF cache dirs, calibre, gradio, stanza, espeak,
TMPDIR) is deliberately NOT here - see PORT_NOTES.md "Dropped from lib/conf.py".

`apply()` is idempotent and safe to call from several modules.
"""
import os
import sys

_APPLIED = False
_VLLM_APPLIED = False


def apply() -> None:
    """The lib/conf.py CUDA block, same platform conditions, same values."""
    global _APPLIED
    if _APPLIED:
        return
    _APPLIED = True
    # PYTORCH_NO_CUDA_MEMORY_CACHING breaks CUDA graph capture on Linux
    # Only disable caching on Windows where CUDA graphs are disabled anyway
    if sys.platform == 'win32':
        os.environ['PYTORCH_NO_CUDA_MEMORY_CACHING'] = '1'
        os.environ['PYTORCH_CUDA_ALLOC_CONF'] = (
            'max_split_size_mb:128,garbage_collection_threshold:0.6,expandable_segments:True')
    os.environ['CUDA_DEVICE_ORDER'] = 'PCI_BUS_ID'
    # CUDA graph settings - only disable on Windows where they cause issues
    # On Linux/WSL, keep CUDA graphs enabled for vLLM performance
    if sys.platform == 'win32':
        os.environ['TORCH_CUDA_ENABLE_CUDA_GRAPH'] = '0'
        os.environ['CUDA_LAUNCH_BLOCKING'] = '1'
    else:
        os.environ['TORCH_CUDA_ENABLE_CUDA_GRAPH'] = '1'
        os.environ['CUDA_LAUNCH_BLOCKING'] = '0'
    os.environ['CUDA_CACHE_MAXSIZE'] = '2147483648'
    # e2a set these in lib/conf.py for every engine; they are the two that
    # matter to a torch process and cost nothing.
    os.environ['PYTHONUTF8'] = '1'
    os.environ['PYTHONIOENCODING'] = 'utf-8'
    os.environ['TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD'] = '1'
    os.environ['PYTORCH_ENABLE_MPS_FALLBACK'] = '1'


def apply_vllm_platform() -> None:
    """orpheus.py's own module-scope block, MINUS the cudart lookup.

    Everything here is pure environment: no torch, no vLLM, nothing that can be
    imported by accident. That is what lets vllm_backend.py call it at module
    import - which is where orpheus.py ran the same statements - while
    `import narrator.engine` still costs no backend import at all.

    The Windows cudart lookup that used to live here is `resolve_vllm_cudart()`
    below; see its docstring for why it moved.
    """
    global _VLLM_APPLIED
    if _VLLM_APPLIED:
        return
    _VLLM_APPLIED = True
    import platform
    if platform.system() == 'Windows':
        # Required for vLLM on Windows
        # See: https://github.com/SystemPanic/vllm-windows
        os.environ['USE_LIBUV'] = '0'
    else:
        # On Linux/WSL, enable CUDA graphs for vLLM performance
        # Override conf.py settings that disable CUDA graphs globally
        os.environ['TORCH_CUDA_ENABLE_CUDA_GRAPH'] = '1'
        os.environ['CUDA_LAUNCH_BLOCKING'] = '0'


def resolve_vllm_cudart() -> None:
    """Point vLLM at torch's bundled cudart DLL. Windows only, once per process.

    WHY THIS IS NOT IN apply_vllm_platform(). It is the one statement of
    orpheus.py's module-scope block that IMPORTS TORCH, and orpheus.py could
    afford that because it imported torch two lines later anyway. narrator
    cannot: `apply_vllm_platform()` runs at import of vllm_backend, and pulling
    torch in there would make `import narrator.engine` cost a multi-second torch
    load on every Windows process that only wanted the caps registry or the
    frame arithmetic - and would break the lazy-import contract
    tests/test_engine_lazy_imports.py exists to hold.

    So it is called from `_load_vllm_engine` instead: AFTER torch has been
    deliberately imported and BEFORE `from vllm import LLM`, which is the only
    ordering vLLM actually requires (it reads VLLM_CUDART_SO_PATH when it loads).
    An explicit VLLM_CUDART_SO_PATH in the environment still wins, exactly as
    before.
    """
    import platform
    if platform.system() != 'Windows':
        return
    # vLLM needs the path to cudart DLL - find it in torch installation
    if 'VLLM_CUDART_SO_PATH' not in os.environ:
        try:
            import torch
            torch_lib = os.path.dirname(torch.__file__)
            cudart_path = os.path.join(torch_lib, 'lib', 'cudart64_12.dll')
            if os.path.exists(cudart_path):
                os.environ['VLLM_CUDART_SO_PATH'] = cudart_path
        except Exception:
            pass  # Let vLLM handle the error if cudart not found
