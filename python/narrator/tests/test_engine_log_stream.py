"""The engine's log lines must never land on a host's STRUCTURED stdout.

THE BUG (measured 2026-09-05, Higgs v3 through `python -m narrator.serve` on
the Mac):

    RuntimeError: non-JSON on stdout: '[HIGGS-MLX] loading Higgs v3 from ...'

`narrator.serve`'s stdout IS the JSON-lines protocol. The engine layer had 94
bare `print` calls, every one of which could land between two protocol messages.

AND WHY "MOVE THEM ALL TO STDERR" IS THE WRONG FIX - the half this file exists
to stop anyone undoing. `electron/parallel-tts-bridge.ts` spawns
`narrator.compat.worker` and its worker **stdout** handler runs five parsers its
**stderr** handler does not:

    MODEL_LOAD_START_RE   /Loading Orpheus model with/    the load bar starting
    MODEL_LOAD_DONE_RE    /model loaded!/                 the load bar finishing
    REPAIR_START_RE       /hit the MLX audio-token cap/   the re-split ladder bar
    parseMlxHeartbeat()   "[ORPHEUS] MLX batch generating: ..."   the batch bar
    parseOrpheusGuardEvent()                              the guard-event index

Every one of those strings is printed by `engine/orpheus/`. So the stream is the
HOST's to choose, and the two hosts choose differently. Both directions are
pinned below, because each one silently breaks a different product surface.

NO STRING IS UNDER TEST HERE except as a destination: the rewrite that created
`log()` changed 94 call names and not one character of any message, and
`test_the_bridges_stdout_only_patterns_still_match` proves the exact strings the
bridge greps for are still emitted verbatim.
"""
import ast
import io
import json
import os
import re
import subprocess
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.dirname(os.path.dirname(_HERE))
_ORPHEUS = os.path.join(os.path.dirname(_HERE), 'engine', 'orpheus')


class NoBarePrintsTest(unittest.TestCase):
    """Structural: the engine layer owns no bare `print`.

    An AST walk, not a grep: a grep cannot tell a call from the word `print` in
    a docstring, and this package's docstrings talk about printing a great deal.
    """

    def _print_calls(self, path):
        with io.open(path, encoding='utf-8') as handle:
            tree = ast.parse(handle.read())
        return [n for n in ast.walk(tree)
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                and n.func.id == 'print']

    def test_no_orpheus_module_prints_without_naming_a_stream(self):
        offenders = []
        for name in sorted(os.listdir(_ORPHEUS)):
            if not name.endswith('.py'):
                continue
            path = os.path.join(_ORPHEUS, name)
            for call in self._print_calls(path):
                if not any(kw.arg == 'file' for kw in call.keywords):
                    offenders.append(f'{name}:{call.func.lineno}')
        self.assertEqual(offenders, [],
                         'these print() calls name no stream, so they go to '
                         "stdout - which is narrator.serve's JSON protocol. Use "
                         'narrator.engine.log.log() instead.')

    def test_the_higgs_mlx_backend_has_none_either(self):
        path = os.path.join(os.path.dirname(_HERE), 'engine', 'higgs',
                            'mlx_backend.py')
        offenders = [str(c.func.lineno) for c in self._print_calls(path)
                     if not any(kw.arg == 'file' for kw in c.keywords)]
        # log() itself is the ONE print, and it names its stream.
        self.assertEqual(offenders, [])


class LogStreamTest(unittest.TestCase):
    """The helper itself."""

    def setUp(self):
        from narrator.engine.log import set_log_stream
        self.addCleanup(set_log_stream, None)

    def test_the_default_is_stderr(self):
        """A host that forgets to choose gets the SAFE answer: logs on the log
        stream, never on a structured stdout it never declared."""
        from narrator.engine.log import log_stream, set_log_stream
        set_log_stream(None)
        self.assertIs(log_stream(), sys.stderr)

    def test_the_default_resolves_at_call_time(self):
        """Not a captured reference: a test (or a host) that swaps sys.stderr
        must be honoured, or every log line in a captured run vanishes."""
        from narrator.engine.log import log_stream, set_log_stream
        set_log_stream(None)
        original, sys.stderr = sys.stderr, io.StringIO()
        try:
            self.assertIs(log_stream(), sys.stderr)
        finally:
            sys.stderr = original

    def test_a_host_can_point_it_at_stdout(self):
        from narrator.engine.log import log, set_log_stream
        sink = io.StringIO()
        set_log_stream(sink)
        log('[ORPHEUS] hello')
        self.assertEqual(sink.getvalue(), '[ORPHEUS] hello\n')

    def test_it_forwards_print_kwargs(self):
        """Signature-compatible with the builtin, because the 94 call sites were
        rewritten mechanically and some of them pass `end` / `sep`."""
        from narrator.engine.log import log, set_log_stream
        sink = io.StringIO()
        set_log_stream(sink)
        log('a', 'b', sep='-', end='')
        self.assertEqual(sink.getvalue(), 'a-b')

    def test_a_non_stream_is_refused_by_name(self):
        from narrator.engine.log import set_log_stream
        with self.assertRaises(ValueError):
            set_log_stream('stdout')


class BridgePatternsTest(unittest.TestCase):
    """The five stdout-only patterns still have something to match.

    This is the guard on the OTHER half of the fix: if someone later "tidies"
    one of these strings, the audiobook progress bars stop moving and nothing
    fails. The patterns are transcribed from
    `electron/parallel-tts-bridge.ts` (MODEL_LOAD_START_RE, MODEL_LOAD_DONE_RE,
    REPAIR_START_RE, GENERATION_ACTIVITY_RE) and `electron/mlx-batch-progress.ts`.
    """

    #: (name, pattern, a file that must still contain a literal matching it)
    PATTERNS = (
        ('MODEL_LOAD_START_RE',
         r'Loading .*TTS with voice|Loading Orpheus model with|Loading .* model\b',
         'mlx_backend.py'),
        ('MODEL_LOAD_DONE_RE', r'TTS Loaded!|model loaded!', 'mlx_backend.py'),
        ('REPAIR_START_RE',
         r'hit the MLX audio-token cap|produced no audio|audio too short for text',
         'mlx_backend.py'),
        ('GENERATION_ACTIVITY_RE',
         r'audio-token cap|re-rendering split|MLX batch generating',
         'mlx_backend.py'),
        ('parseMlxHeartbeat', r'MLX batch generating', 'mlx_backend.py'),
    )

    def _literals(self, filename):
        """Every string constant in the module - the AST's, so a docstring's
        prose cannot satisfy a pattern that a real message must."""
        path = os.path.join(_ORPHEUS, filename)
        with io.open(path, encoding='utf-8') as handle:
            tree = ast.parse(handle.read())
        out = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                out.append(node.value)
            elif isinstance(node, ast.JoinedStr):
                out.append(''.join(v.value for v in node.values
                                   if isinstance(v, ast.Constant)
                                   and isinstance(v.value, str)))
        return out

    def test_the_bridges_stdout_only_patterns_still_match(self):
        for name, pattern, filename in self.PATTERNS:
            with self.subTest(pattern=name):
                rx = re.compile(pattern, re.I)
                self.assertTrue(
                    any(rx.search(s) for s in self._literals(filename)),
                    f'{name} has nothing left to match in {filename}. The '
                    'audiobook progress bar reads these off the compat worker\'s '
                    'stdout; changing the wording silently stops it moving.')


class ServeWorkerStdoutTest(unittest.TestCase):
    """END TO END: drive the REAL worker and assert stdout stays JSON-only.

    `--fake-engine` gives a worker with no model, so this runs anywhere - but it
    is the real `narrator.serve.main`, the real protocol loop and the real
    `set_log_stream` call. The engine log lines are FORCED by a sitecustomize-
    style stub (see `_probe`) that calls `narrator.engine.log.log()` at the
    moments an engine would, so the assertion is about routing rather than about
    whether this particular fake happens to be chatty.
    """

    def _run(self, engine_id, extra_env=None):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith('VLLM_')}
        env.update({'PYTHONUNBUFFERED': '1', 'PYTHONIOENCODING': 'utf-8',
                    'NARRATOR_ENGINE': engine_id})
        env.update(extra_env or {})
        proc = subprocess.Popen(
            [sys.executable, '-m', 'narrator.serve', '--fake-engine'],
            cwd=_PYTHON_ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, env=env)
        script = [{'action': 'load', 'voice': self.VOICE[engine_id],
                   'warm': False},
                  {'action': 'generate', 'text': 'One short line.'},
                  {'action': 'quit'}]
        out, err = proc.communicate(
            '\n'.join(json.dumps(m) for m in script) + '\n', timeout=180)
        return out, err

    VOICE = {'orpheus': 'leah', 'higgs-v3': 'deathstalker'}

    def _assert_json_only(self, out):
        lines = [l for l in out.splitlines() if l.strip()]
        self.assertTrue(lines, 'the worker produced no stdout at all')
        for line in lines:
            try:
                json.loads(line)
            except json.JSONDecodeError:
                self.fail(
                    'non-JSON line on the protocol stream: '
                    f'{line!r}\n\nnarrator.serve\'s stdout IS the JSON-lines '
                    'protocol. Engine logs belong on the stream '
                    'narrator.engine.log chooses.')
        return [json.loads(l) for l in lines]

    def test_the_orpheus_worker_keeps_stdout_json_only(self):
        out, _err = self._run('orpheus')
        messages = self._assert_json_only(out)
        self.assertEqual(messages[0]['type'], 'ready')

    def test_the_higgs_worker_keeps_stdout_json_only(self):
        out, _err = self._run('higgs-v3')
        messages = self._assert_json_only(out)
        self.assertEqual(messages[0]['type'], 'ready')

    def test_an_engine_log_line_lands_on_stderr_and_never_on_stdout(self):
        """THE REGRESSION ITSELF, forced rather than hoped for.

        `FakeEngine.__init__` logs through `narrator.engine.log.log()` at load,
        exactly as a real engine does - so this drives the real worker, the real
        protocol loop and the real routing. If it ever goes back to stdout, this
        fails with the precise symptom the Mac hit.

        BOTH assertions matter. Without the stderr one, a fix that simply
        stopped logging would pass while proving nothing.
        """
        from narrator.serve.fake_engine import FAKE_LOAD_MARKER
        out, err = self._run('orpheus')
        self.assertNotIn(FAKE_LOAD_MARKER, out,
                         'an engine log line reached the JSON protocol stream')
        self.assertIn(FAKE_LOAD_MARKER, err,
                      'the engine never logged at all - this test proves '
                      'nothing unless the line was actually emitted somewhere')
        self._assert_json_only(out)


class HostChoiceTest(unittest.TestCase):
    """The OTHER direction: the compat worker really does put them on stdout.

    parallel-tts-bridge.ts parses that stdout for the model-load bar, the MLX
    batch bar, the repair bar and the guard-event index. A default that quietly
    became stderr would break all four with no error anywhere.
    """

    def test_compat_worker_points_the_engine_log_at_stdout(self):
        probe = (
            'import sys, io\n'
            'import narrator.compat.worker as w\n'
            'import narrator.compat.app as app\n'
            'from narrator.engine.log import log_stream\n'
            'seen = {}\n'
            'app.main = lambda argv, engine_factory=None: seen.setdefault(\n'
            '    "stream", log_stream()) and 0\n'
            'w.main(["--session", "x"])\n'
            'print("STDOUT" if seen["stream"] is sys.stdout else "OTHER")\n')
        out = subprocess.run([sys.executable, '-c', probe], cwd=_PYTHON_ROOT,
                             capture_output=True, text=True)
        self.assertIn('STDOUT', out.stdout,
                      f'compat.worker must keep engine logs on stdout for the '
                      f'bridge to parse.\nstderr:\n{out.stderr}')

    def test_serve_worker_points_the_engine_log_at_stderr(self):
        probe = (
            'import sys\n'
            'import narrator.serve.worker as w\n'
            'from narrator.engine.log import log_stream\n'
            'try:\n'
            '    w.main(["--not-a-flag"])\n'   # exits 2 AFTER set_log_stream
            'except SystemExit:\n'
            '    pass\n'
            'sys.stdout.write("STDERR" if log_stream() is sys.stderr else "OTHER")\n')
        out = subprocess.run([sys.executable, '-c', probe], cwd=_PYTHON_ROOT,
                             capture_output=True, text=True)
        self.assertIn('STDERR', out.stdout,
                      f'serve.worker must keep engine logs OFF its JSON stdout.'
                      f'\nstderr:\n{out.stderr}')


if __name__ == '__main__':
    unittest.main()
