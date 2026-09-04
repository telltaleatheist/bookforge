#!/usr/bin/env python
"""
Timing invariants for align_audiobook.py — snapping, the overlap fix, and the
speech-coverage measure.

    python tools/tests/test_align_audiobook_timing.py

Every case is a review finding that shipped once. The overlap test is randomized
because the defect only appears when the monotonic clamp pins two starts EQUAL,
which no hand-written fixture would have found.
"""
import importlib.util, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', '..', 'electron', 'scripts', 'align_audiobook.py')
spec = importlib.util.spec_from_file_location('aa', SCRIPT)
aa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aa)

PASS = FAIL = 0


def check(name, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f'  ok   {name}')
    else:
        FAIL += 1; print(f'  FAIL {name}' + (f' — {detail}' if detail else ''))


# ---------------------------------------------------------------- snapping
print('\nsnap_boundaries — bounded, order-preserving, never destructive')
sb = aa.snap_boundaries

ns, ne, st = sb([0.0, 10.0, 20.0], [10.0, 20.0, 25.0], [(9.8, 10.4), (19.0, 19.2)], 0.6)
check('seam moves to the silence midpoint', abs(ne[0] - 10.1) < 1e-9 and abs(ns[1] - 10.1) < 1e-9,
      f'{ne}')
check('a seam whose silence is out of window is untouched',
      sb([0.0, 10.0], [10.0, 20.0], [(5.0, 5.5)], 0.6)[2]['snapped'] == 0)
_, ne2, _ = sb([0.0, 10.0], [10.0, 60.0], [(9.9, 40.0)], 0.6)
check('a chapter-length silence is clipped to the window, not its own centre',
      9.9 < ne2[0] <= 10.6, f'{ne2[0]}')
check('non-contiguous cues (a gap) are skipped',
      sb([0.0, 12.0], [10.0, 20.0], [(9.8, 10.4)], 0.6)[2]['considered'] == 0)
ns3, ne3, _ = sb([0.0, 10.0, 10.2], [10.0, 10.2, 20.0], [(9.0, 11.0)], 0.6)
check('tight neighbours stay ordered and non-empty',
      ns3 == sorted(ns3) and all(ne3[i] > ns3[i] for i in range(3)), f'{ns3} {ne3}')
check('an empty silence map is a no-op', sb([0.0], [5.0], [], 0.6)[2]['snapped'] == 0)
check('window 0 disables snapping', sb([0.0, 10.0], [10.0, 20.0], [(9.9, 10.1)], 0.0)[2]['snapped'] == 0)

# randomized: a snap must never reorder, empty, or move further than the window
random.seed(7)
bad = 0
for _ in range(2000):
    n = random.randint(2, 8)
    t = 0.0; starts = []; ends = []
    for _i in range(n):
        starts.append(t); t += random.uniform(0.3, 5.0); ends.append(t)
    sil = []
    x = 0.0
    while x < t:
        a = x + random.uniform(0.05, 2.0); b = a + random.uniform(0.05, 1.5)
        sil.append((a, b)); x = b
    w = 0.6
    ns4, ne4, _s = sb(list(starts), list(ends), sil, w)
    for i in range(n):
        if ne4[i] <= ns4[i]: bad += 1; break
        if i + 1 < n and ns4[i + 1] < ne4[i] - 1e-9: bad += 1; break
        if abs(ne4[i] - ends[i]) > w + 1e-9: bad += 1; break
check('2000 randomized snaps: no empty cue, no overlap, no move beyond the window', bad == 0, f'{bad} bad')


# ------------------------------------------------------- the overlap defect
print('\nevent construction — the MIN_CUE_S overlap fix')


def build_events(sent_start, narr, dur=10_000.0, max_cue_s=120.0, min_cue_s=0.4, fixed=True):
    """Mirror of align_audiobook.py's event loop. `fixed=False` reproduces the old
    behaviour so the test proves the fix is what changed the outcome."""
    ss = list(sent_start)
    ev = []
    for x, i in enumerate(narr):
        s = ss[i]; e = ss[narr[x + 1]] if x + 1 < len(narr) else min(s + 4, dur)
        e = min(e, s + max_cue_s)
        if e <= s:
            e = s + min_cue_s
            if fixed and x + 1 < len(narr): ss[narr[x + 1]] = e
        ev.append([s, e])
    return ev


def overlaps(ev):
    return sum(1 for i in range(len(ev) - 1) if ev[i + 1][0] < ev[i][1] - 1e-9)


ev = build_events([5.0, 5.0, 9.0], [0, 1, 2])
check('two cues sharing a start no longer overlap', overlaps(ev) == 0, f'{ev}')
check('the shared-start cue still gets its minimum length', abs(ev[0][1] - ev[0][0] - 0.4) < 1e-9, f'{ev}')
ev = build_events([5.0, 5.0, 5.0, 5.0], [0, 1, 2, 3])
check('a run of four tied starts stays ordered', overlaps(ev) == 0, f'{ev}')
check('ties propagate rather than pile up', all(ev[i + 1][0] >= ev[i][1] - 1e-9 for i in range(3)), f'{ev}')

random.seed(11)
old_bad = new_bad = 0
for _ in range(20_000):
    n = random.randint(2, 10)
    # deliberately tie-heavy: the clamp pins equal starts, which is the trigger
    ss = sorted(random.choice([0.0, 1.0, 2.0, 3.0, 4.0]) + random.choice([0.0, 0.0, 0.0, 0.3])
                for _i in range(n))
    narr = list(range(n))
    old_bad += overlaps(build_events(ss, narr, fixed=False))
    new_bad += overlaps(build_events(ss, narr, fixed=True))
check(f'20k randomized start-sets: overlaps {old_bad} (old) -> {new_bad} (fixed)', new_bad == 0,
      f'{new_bad} remain')
check('the randomized corpus really did exercise the defect', old_bad > 0, f'old_bad={old_bad}')


# ------------------------------------------------------- speech coverage
print('\nspeech_coverage — measured dead air, not a reading-speed guess')
sc = aa.speech_coverage
ev = [(0.0, 10.0, 'a sting with no narration', 'prose'),
      (10.0, 20.0, 'a normally narrated sentence', 'prose'),
      (20.0, 21.0, 'short', 'prose')]
sil = [(0.0, 9.6), (10.2, 10.5), (20.0, 21.0)]
low, total = sc(ev, sil)
check('a mostly-silent cue is flagged', total == 1 and abs(low[0]['audioStart']) < 1e-9, f'{low}')
check('a normally narrated cue is not flagged', all(c['audioStart'] != 10.0 for c in low), f'{low}')
check('cues under the duration floor are ignored', all(c['audioStart'] != 20.0 for c in low), f'{low}')
check('no silence map -> no findings', sc(ev, [])[1] == 0)
check('speechFraction is reported', 'speechFraction' in low[0] and low[0]['speechFraction'] < 0.3, f'{low}')

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
