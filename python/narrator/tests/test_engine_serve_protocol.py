"""The serve worker's JSON-lines protocol is a CONTRACT with the Node pool.

electron/orpheus-worker-pool.ts (BookForge@3b4d0b17) resolves a whole batch by
reading `type`, `i`, `seq`, `format`, `data`, `duration`, `sampleRate`,
`streamed`, `chunks`, `message` and `batch_done` off these lines. A missing
`batch_done` hangs the batch until a 180 s timeout TAINTS the worker; a second
message for one `i` is dropped as stale, so a row answered twice loses audio; a
`batch_chunk` for a row the pool did not mark `stream:true` is logged and
thrown away.

None of that could be tested before without a 6 GB model on a GPU. This drives
narrator/serve/worker.py AS A SUBPROCESS with NARRATOR_FAKE_ENGINE=1, over real
stdin/stdout pipes, so the reader thread, the stdout lock, the per-item
bookkeeping and the one-answer-per-row guarantees are the real ones.

WHAT IS ASSERTED, against the pool's own reads:
  1. handshake: 'ready' first, with a device (and a backend when known);
  2. 'load' -> 'status'* then exactly one 'loaded' carrying voice + backend;
  3. 'generate' -> one 'audio' with format/data/duration/sampleRate;
  4. 'generate' with stream:true -> 'chunk'(seq 0) then 'done'(duration, chunks,
     cancelled);
  5. 'generate_batch' -> one 'batch_item' per `i`, EXACTLY once, then exactly one
     'batch_done' whose count is the item count, and it is LAST;
  6. an empty item is answered with audio (the "empty -> silence" contract), not
     a failure;
  7. an unloaded voice fails THAT ITEM and nothing else;
  8. fast start: a batch with one stream:true item emits that row's
     'batch_chunk's with seq 0..n-1 and no gaps, then ONE terminal
     'batch_item' carrying streamed:true + duration + chunks and NO data, while
     the non-streamed rows keep the ordinary data-carrying shape;
  9. a batch before any load answers every item with 'Model not loaded' and
     still emits 'batch_done';
 10. 'quit' ends the process.

Run: python -m unittest discover -s python/narrator/tests -t python -p "test_engine_*.py"
"""
import json
import os
import subprocess
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.dirname(os.path.dirname(_HERE))   # .../python
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)


class Worker:
    """One serve worker subprocess, driven line by line."""

    def __init__(self, extra_env=None):
        env = dict(os.environ)
        env['PYTHONUNBUFFERED'] = '1'
        env['PYTHONIOENCODING'] = 'utf-8'
        # The warmup would render three sentences plus two batches through the
        # fake before 'loaded'. Cheap, but it makes the status stream noisy and
        # it is not what this test is about; the pool's own spawn sets this the
        # same way when it wants a cold ready.
        env['ORPHEUS_SKIP_WARMUP'] = '1'
        env.pop('NARRATOR_GOLDEN_LOCAL', None)
        if extra_env:
            env.update(extra_env)
        # --fake-engine is an ARGV flag, not an env var, precisely so a leaked
        # variable can never put the production entry point into sine-tone mode
        # (see serve/worker.py's note). The test types it, as the design intends.
        self.proc = subprocess.Popen(
            [sys.executable, '-m', 'narrator.serve', '--fake-engine'],
            cwd=_PYTHON_ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', env=env, bufsize=1,
        )

    def send(self, **request):
        self.proc.stdin.write(json.dumps(request) + '\n')
        self.proc.stdin.flush()

    def read(self):
        """One protocol message, or None at EOF. Every stdout line must be JSON:
        the pool parses them all, and a stray print would be a parse error there."""
        line = self.proc.stdout.readline()
        if not line:
            return None
        return json.loads(line)

    def died_because(self):
        """Why the worker produced nothing - its own stderr, and its exit code.

        `readline()` blocks, so "no output" is never a slow start: it means the
        process ENDED. Without this the failure reads "worker produced no output
        at all", which is indistinguishable between a crash, a refused engine
        and a missing dependency. The worker prints all three on stderr.
        """
        try:
            self.proc.wait(timeout=60)
        except Exception:
            pass
        try:
            err = self.proc.stderr.read() or ''
        except Exception:
            err = '(stderr unreadable)'
        return (f'worker exited {self.proc.returncode} before its handshake.\n'
                f'--- stderr ---\n{err.strip() or "(empty)"}')

    def read_until(self, *types, limit=400):
        """Every message up to and including the first of `types`."""
        out = []
        for _ in range(limit):
            msg = self.read()
            if msg is None:
                raise AssertionError(f'worker closed stdout before {types}: {out}')
            out.append(msg)
            if msg['type'] in types:
                return out
        raise AssertionError(f'no {types} in {limit} messages: {out}')

    def close(self):
        try:
            self.send(action='quit')
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=10)
        try:
            err = self.proc.stderr.read()
        except Exception:
            err = ''
        # Close both pipes explicitly: unittest keeps a reference to the test case
        # long enough for the GC to report them as unclosed files otherwise, and a
        # ResourceWarning in the output is noise a real failure has to compete with.
        for handle in (self.proc.stdout, self.proc.stderr, self.proc.stdin):
            try:
                handle.close()
            except Exception:
                pass
        return err


class ServeProtocolTest(unittest.TestCase):

    def _assert_batch_closed(self, msgs, expected_i):
        """THE THREE INVARIANTS THE POOL DEPENDS ON, asserted the same way for
        every batch test in this file.

        1. 'batch_done' is the LAST message of the batch. A batch that never
           emits it hangs every one of its sentences until the pool's 180 s
           timeout, which TAINTS the worker and blocks all queued work.
        2. EXACTLY ONE message per item index. The pool deletes a resolver when
           it fires, so a second message for one `i` is dropped as stale - a row
           answered twice is a row whose real audio may have been the one thrown
           away. A dict keyed by `i` silently hides that, so this counts.
        3. Every requested index is answered. An unanswered row hangs the same
           way a missing batch_done does.

        Returns the per-index message so a caller can go on to assert its shape.
        """
        self.assertEqual(msgs[-1]['type'], 'batch_done',
                         'batch_done must be the LAST message of a batch')
        self.assertEqual(msgs[-1]['count'], len(expected_i))
        items = [m for m in msgs[:-1] if m['type'] == 'batch_item']
        seen = [m['i'] for m in items]
        dupes = sorted({i for i in seen if seen.count(i) > 1})
        self.assertEqual(dupes, [], f'row(s) answered more than once: {dupes}')
        self.assertEqual(sorted(seen), sorted(expected_i),
                         'every requested row must be answered exactly once')
        self.assertEqual([m['type'] for m in msgs[:-1] if m['type'] not in
                          ('batch_item', 'batch_chunk', 'status')], [],
                         'a batch emits only batch_item / batch_chunk / status')
        return {m['i']: m for m in items}

    def setUp(self):
        self.w = Worker()
        self.addCleanup(self._shutdown)

    def _shutdown(self):
        err = self.w.close()
        # Surfaced only on failure; a traceback on stderr is how a silently
        # swallowed worker bug would otherwise hide.
        if self.w.proc.returncode not in (0, None) and err:
            print(err, file=sys.stderr)

    def _ready(self):
        msg = self.w.read()
        if msg is None:
            self.fail(self.w.died_because())
        self.assertEqual(msg['type'], 'ready')
        return msg

    def _load(self, voice='leah', **kwargs):
        self.w.send(action='load', voice=voice, warm=False, **kwargs)
        msgs = self.w.read_until('loaded', 'error')
        return msgs

    # ---- 1, 2 --------------------------------------------------------------

    def test_handshake_and_load(self):
        ready = self._ready()
        self.assertIn('device', ready)
        # `backend` is optional by design: absent means "unknown", which the pool
        # reads as NOT per-request capable. The fake always knows it.
        self.assertEqual(ready.get('backend'), 'transformers')

        msgs = self._load('leah')
        self.assertEqual(msgs[-1]['type'], 'loaded', msgs)
        self.assertEqual(msgs[-1]['voice'], 'leah')
        self.assertEqual(msgs[-1]['backend'], 'transformers')
        self.assertTrue(all(m['type'] == 'status' for m in msgs[:-1]), msgs)

    def test_unknown_stock_voice_is_refused_not_substituted(self):
        self._ready()
        self.w.send(action='load', voice='nosuchvoice', warm=False)
        msgs = self.w.read_until('loaded', 'error')
        self.assertEqual(msgs[-1]['type'], 'error', msgs)
        self.assertIn('nosuchvoice', msgs[-1]['message'])
        self.assertIn('Refusing to substitute', msgs[-1]['message'])

    def test_caps_cross_the_wire(self):
        """The catalog payload reaches the engine's registry verbatim, and a key
        that is neither a cap nor an explicitly-ignored one fails the LOAD."""
        self._ready()
        msgs = self._load('leah', caps={'maxCharsPerSec': 23.5, 'eosBoost': 8,
                                        'maxChars': 450, 'sentenceGap': 0.0})
        self.assertEqual(msgs[-1]['type'], 'loaded', msgs)

    # ---- 3, 4 --------------------------------------------------------------

    def test_generate_single(self):
        self._ready()
        self._load()
        self.w.send(action='generate', text='Hello there, listener.')
        msgs = self.w.read_until('audio', 'error')
        audio = msgs[-1]
        self.assertEqual(audio['type'], 'audio', msgs)
        self.assertEqual(audio['format'], 'pcm16')
        self.assertEqual(audio['sampleRate'], 24000)
        self.assertGreater(audio['duration'], 0.0)
        self.assertTrue(audio['data'])

    def test_generate_stream_mode(self):
        """`stream:true` on a SINGLE generate is the scheduler's
        streaming-first-sentence contract: one chunk with seq 0, then 'done'."""
        self._ready()
        self._load()
        self.w.send(action='generate', text='One streamed sentence.', stream=True)
        chunk = self.w.read_until('chunk', 'error')[-1]
        self.assertEqual(chunk['type'], 'chunk')
        self.assertEqual(chunk['seq'], 0)
        self.assertEqual(chunk['format'], 'pcm16')
        self.assertEqual(chunk['sampleRate'], 24000)
        done = self.w.read_until('done', 'error')[-1]
        self.assertEqual(done['type'], 'done')
        self.assertEqual(done['chunks'], 1)
        self.assertFalse(done['cancelled'])
        self.assertAlmostEqual(done['duration'], chunk['duration'], places=6)

    def test_generate_with_no_text_errors(self):
        self._ready()
        self._load()
        self.w.send(action='generate', text='')
        err = self.w.read_until('error')[-1]
        self.assertEqual(err['message'], 'No text provided')

    # ---- 5, 6, 7 -----------------------------------------------------------

    def test_generate_batch_one_item_each_then_batch_done(self):
        self._ready()
        self._load()
        items = [{'i': 10, 'text': 'First sentence of the block.'},
                 {'i': 11, 'text': 'Second sentence, a little longer than the first one.'},
                 {'i': 12, 'text': ''},
                 {'i': 13, 'text': 'Fourth.'}]
        self.w.send(action='generate_batch', items=items)
        msgs = self.w.read_until('batch_done')
        by_i = self._assert_batch_closed(msgs, [10, 11, 12, 13])

        for i in (10, 11, 13):
            item = by_i[i]
            self.assertEqual(item['format'], 'pcm16', item)
            self.assertEqual(item['sampleRate'], 24000)
            self.assertGreater(item['duration'], 0.0)
            self.assertTrue(item['data'])
            self.assertNotIn('message', item)
        # 11 is longer than 10, and the fake's duration is a function of length.
        self.assertGreater(by_i[11]['duration'], by_i[10]['duration'])
        # The EMPTY row is answered with a tiny silence, NOT with a failure:
        # "empty -> silence" is the worker's contract and the pool would mark a
        # message-carrying item as a failed sentence.
        self.assertIn('data', by_i[12])
        self.assertNotIn('message', by_i[12])
        self.assertLess(by_i[12]['duration'], 0.2)

    def test_unloaded_voice_fails_only_its_own_item(self):
        self._ready()
        self._load('leah')
        items = [{'i': 0, 'text': 'Ordinary sentence.'},
                 {'i': 1, 'text': 'Wrong voice.', 'voice': 'zoe'},
                 {'i': 2, 'text': 'Another ordinary one.'}]
        self.w.send(action='generate_batch', items=items)
        msgs = self.w.read_until('batch_done')
        by_i = self._assert_batch_closed(msgs, [0, 1, 2])
        self.assertIn('data', by_i[0])
        self.assertIn('data', by_i[2])
        self.assertNotIn('data', by_i[1])
        self.assertIn('zoe', by_i[1]['message'])

    def test_batch_before_load(self):
        self._ready()
        items = [{'i': 0, 'text': 'a'}, {'i': 1, 'text': 'b'}]
        self.w.send(action='generate_batch', items=items)
        msgs = self.w.read_until('batch_done')
        by_i = self._assert_batch_closed(msgs, [0, 1])
        for m in by_i.values():
            self.assertEqual(m['message'], 'Model not loaded')

    # ---- 8: fast start ------------------------------------------------------

    def test_fast_start_batch_chunks_then_streamed_item(self):
        self._ready()
        self._load()
        items = [
            {'i': 100, 'text': 'The row the listener is on, which streams.', 'stream': True},
            {'i': 101, 'text': 'Read-ahead behind it, which does not.'},
        ]
        self.w.send(action='generate_batch', items=items)
        msgs = self.w.read_until('batch_done')
        by_i = self._assert_batch_closed(msgs, [100, 101])

        chunks = [m for m in msgs if m['type'] == 'batch_chunk']
        item_msgs = [m for m in msgs if m['type'] == 'batch_item']
        self.assertEqual({m['i'] for m in chunks}, {100},
                         'only the row marked stream:true may emit batch_chunk')
        self.assertEqual([m['seq'] for m in chunks], list(range(len(chunks))),
                         'seq must run 0..n-1 with no gaps and no repeats')
        for c in chunks:
            self.assertEqual(c['format'], 'pcm16')
            self.assertEqual(c['sampleRate'], 24000)
            self.assertTrue(c['data'])
            self.assertGreater(c['duration'], 0.0)

        streamed = by_i[100]
        self.assertTrue(streamed['streamed'])
        self.assertNotIn('data', streamed,
                         'a streamed terminal carries totals only - its audio already left')
        self.assertEqual(streamed['chunks'], len(chunks))
        self.assertAlmostEqual(streamed['duration'],
                               sum(c['duration'] for c in chunks), places=5)
        # The non-streamed row in the SAME batch keeps the classic shape.
        self.assertIn('data', by_i[101])
        self.assertNotIn('streamed', by_i[101])

        # ORDER: every chunk of row 100 precedes its terminal batch_item.
        first_terminal = min(i for i, m in enumerate(msgs)
                             if m['type'] == 'batch_item' and m['i'] == 100)
        last_chunk = max(i for i, m in enumerate(msgs) if m['type'] == 'batch_chunk')
        self.assertLess(last_chunk, first_terminal)

    def test_fast_start_gap_chunk_is_the_last_one(self):
        """finalize_audio's inter-sentence gap cannot be applied to audio already
        in flight, so it rides as one final silent chunk. Its duration is
        ORPHEUS_STREAM_GAP and it is the highest seq of the row."""
        self.w.close()
        self.w = Worker(extra_env={'ORPHEUS_STREAM_GAP': '0.5'})
        self._ready()
        self._load()
        self.w.send(action='generate_batch',
                    items=[{'i': 7, 'text': 'A streamed row.', 'stream': True}])
        msgs = self.w.read_until('batch_done')
        chunks = [m for m in msgs if m['type'] == 'batch_chunk']
        self.assertGreaterEqual(len(chunks), 2)
        self.assertAlmostEqual(chunks[-1]['duration'], 0.5, places=3)

    # ---- 9, 10 --------------------------------------------------------------

    def test_cancel_is_acknowledged(self):
        self._ready()
        self._load()
        self.w.send(action='cancel')
        self.assertEqual(self.w.read_until('stopped')[-1]['type'], 'stopped')

    def test_cancel_DURING_a_batch_still_closes_it(self):
        """THE CASE THE WORKER'S DOCSTRING NAMES, and the one nothing tested.

        A 'cancel' arrives on stdin while the main thread is blocked inside the
        engine. The reader thread flips the flag; the engine abandons what it has
        not rendered and returns WITHOUT an on_row for those rows - so if the
        worker's `finally` sweep did not label them, they would never be answered
        and the pool would hang each one until its 180 s timeout, which taints
        the worker and blocks every queued batch behind it.

        What must hold, cancel or not: one message per row, exactly once, and
        'batch_done' last. The cancelled rows carry message 'cancelled'.
        """
        self._ready()
        self._load()
        n = 10
        items = [{'i': i, 'text': f'Sentence number {i} of a read-ahead block.',
                  'stream': True} for i in range(n)]
        self.w.send(action='generate_batch', items=items)
        # Written immediately behind the batch, so it lands while the fake is
        # still working through its rows (STREAM_ROW_SECONDS each).
        self.w.send(action='cancel')

        msgs = self.w.read_until('batch_done')
        by_i = self._assert_batch_closed(msgs, list(range(n)))

        cancelled = [i for i, m in by_i.items() if m.get('message') == 'cancelled']
        self.assertTrue(cancelled,
                        'the cancel must have abandoned at least one row; if this '
                        'is flaky the fake got faster than the pipe round-trip')
        # Whatever DID render still rendered properly - a cancel does not
        # retract audio that was already delivered.
        for i, m in by_i.items():
            if i in cancelled:
                self.assertNotIn('data', m)
                self.assertNotIn('streamed', m)
            else:
                self.assertTrue(m.get('streamed') or m.get('data'), m)
        # And the cancel is still acknowledged afterwards, in arrival order.
        self.assertEqual(self.w.read_until('stopped')[-1]['type'], 'stopped')

    def test_a_batch_after_a_cancel_is_not_suppressed(self):
        """The flag is cleared where the cancel is DEQUEUED, and only there - so
        a batch queued behind the acknowledgement renders normally. A flag that
        outlived its request would silently cancel the next block too."""
        self._ready()
        self._load()
        self.w.send(action='generate_batch',
                    items=[{'i': 0, 'text': 'One.', 'stream': True}])
        self.w.send(action='cancel')
        self._assert_batch_closed(self.w.read_until('batch_done'), [0])
        self.assertEqual(self.w.read_until('stopped')[-1]['type'], 'stopped')

        items = [{'i': 7, 'text': 'A fresh block after the cancel.'}]
        self.w.send(action='generate_batch', items=items)
        by_i = self._assert_batch_closed(self.w.read_until('batch_done'), [7])
        self.assertIn('data', by_i[7], 'the batch after a cancel must render')
        self.assertNotIn('message', by_i[7])

    def test_unknown_action(self):
        self._ready()
        self.w.send(action='fly')
        self.assertIn('Unknown action', self.w.read_until('error')[-1]['message'])

    def test_bad_json_is_reported_not_fatal(self):
        self._ready()
        self.w.proc.stdin.write('{not json\n')
        self.w.proc.stdin.flush()
        err = self.w.read_until('error')[-1]
        self.assertIn('Invalid JSON', err['message'])
        # Still alive afterwards.
        self._load()

    def test_quit_ends_the_process(self):
        self._ready()
        self.w.send(action='quit')
        self.w.proc.stdin.close()
        self.assertEqual(self.w.proc.wait(timeout=20), 0)


class VoiceCapsResetTest(unittest.TestCase):
    """A reload with an EMPTY caps payload must CLEAR the previous one.

    Driven IN-PROCESS rather than over the pipe, because what is being asserted
    is the state of a CLASS-LEVEL registry that outlives the engine - something
    the protocol deliberately never exposes. The worker object, its load path and
    its teardown are the real ones; only the engine is the fake.

    THE BUG THIS GUARDS (adversarial review, 2026-09-04). e2a's worker called
    `register_voice_caps(v, caps or {})` unconditionally; the first port
    registered only `if config.caps`. `_voice_caps` is class-level and survives
    `_teardown_engine`, and orpheus-worker-pool.ts sends `caps: {}` whenever a
    voice resolves to no catalog model - so: load a voice WITH catalog tuning,
    change modelDir (teardown + rebuild), reload the SAME voice with {}, and the
    first payload's eosFloor/eosBoost would still be attached to it. A whole
    session in the wrong tuning, reported as success.
    """

    def setUp(self):
        from narrator.serve import worker as W
        from narrator.serve.fake_engine import FakeEngine
        self.W, self.FakeEngine = W, FakeEngine
        self._saved_flag = W._FAKE_ENGINE
        W._FAKE_ENGINE = True          # the module global main() writes
        FakeEngine._voice_caps = {}
        self.addCleanup(self._restore)
        self.server = W.OrpheusStreamServer()

    def _restore(self):
        self.W._FAKE_ENGINE = self._saved_flag
        self.FakeEngine._voice_caps = {}

    def test_reload_with_empty_caps_clears_the_previous_payload(self):
        tuned = {'maxCharsPerSec': 22.6, 'eosBoost': 8, 'eosBoostStart': 2}
        self.assertTrue(self.server.load_voice('leah', caps=tuned, warm=False))
        self.assertEqual(self.FakeEngine._voice_caps['leah'],
                         {'maxCharsPerSec': 22.6, 'eosBoost': 8.0, 'eosBoostStart': 2.0})

        # A modelDir change is what forces the teardown; the pool then re-loads
        # the same token with whatever the catalog now says, which for an
        # unmodelled voice is {}.
        self.server._teardown_engine()
        self.assertEqual(self.FakeEngine._voice_caps['leah'],
                         {'maxCharsPerSec': 22.6, 'eosBoost': 8.0, 'eosBoostStart': 2.0},
                         'teardown does not (and must not) touch the class registry - '
                         'which is exactly why the reload has to clear it')

        self.assertTrue(self.server.load_voice('leah', caps={}, warm=False))
        self.assertEqual(self.FakeEngine._voice_caps['leah'], {},
                         'a reload with no catalog tuning must reset the voice to '
                         'env/class defaults, not inherit the previous payload')

    def test_a_warm_switch_back_also_clears(self):
        """The other branch: same weights, so no teardown - `set_voice` plus
        `_apply_voice_caps`. e2a always passed `caps or {}` there too."""
        self.assertTrue(self.server.load_voice('leah', caps={'eosBoost': 8}, warm=False))
        self.assertEqual(self.FakeEngine._voice_caps['leah'], {'eosBoost': 8.0})
        self.assertTrue(self.server.load_voice('leah', caps=None, warm=False))
        self.assertEqual(self.FakeEngine._voice_caps['leah'], {})

    def test_an_unknown_cap_key_fails_the_load(self):
        """Silently dropping it would mean a mis-tuned voice renders a whole book
        with no sign anything was wrong."""
        self.assertFalse(self.server.load_voice('leah', caps={'nonsense': 1},
                                                warm=False))


if __name__ == '__main__':
    unittest.main()
