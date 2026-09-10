# Safe bands — the measurements behind `higgs-safe-bands.json`

JSON takes no comments, so the numbers that produced each band live here. One section per voice.
Regenerate with `band.py <run_dir>` (writes `verdict.json` beside the run).

## How to read the curve

| column | meaning |
| --- | --- |
| **rung** | the chunk size being tested, in **characters**. Each rung is a set of real prompts packed from held-out prose of that voice's own book, to about that length. |
| **n** | renders at that rung = prompts × seeds. 8 prompts × 4 seeds = **32**. This is the sample size, and it is why 2 seeds is not enough (see the noise-floor note below). |
| **fail** | share of those n renders that failed **any** check. The point estimate. |
| **95% hi** | the **Wilson 95% upper confidence bound** on that failure rate. `band.py` ranks bands on THIS, not on `fail`, so a narrow window cannot win by luck. With n=32, a 3% observed rate still has a 16% upper bound — that gap is the honesty margin. |
| **modes** | **which kinds** of failure occurred, and how many of each. This is the *shape*, and it is the whole reason the ladder exists — "12% failed" tells you nothing actionable; "12% ran long" and "12% got cut off" call for opposite fixes. One render can trip more than one mode. |

## The four failure modes

| mode | test | what it means in plain terms |
| --- | --- | --- |
| **cov** | ASR **coverage** < 0.90 | *Coverage* = the fraction of the script's words the model actually spoke, measured by transcribing the render with Whisper and aligning it to the source text. Below 0.90 means **more than one word in ten never got said** — a truncation, a dropped clause, or a skipped middle. This is the dominant mode at every rung. |
| **short** | audio ÷ expected < 0.75 | The clip is **more than 25% shorter** than its character count should produce (at 15 chars/sec). It **stopped early** — the classic EOS-too-soon truncation. |
| **long** | audio ÷ expected > 1.30 | The clip is **more than 30% longer** than expected. It **ran on** — repetition, babble, or trailing noise after the text was finished. |
| **error** | the render itself failed | No audio came back at all — a refused or crashed request, not a quality problem. |

`cov` and `short` often fire together (a cut-off render is both shorter and missing words), which is why the
mode counts in a row can exceed the failure count.

---

## thirdreich — BAND 500-700  (`tr_v3_prod`, measured 2026-09-09)

`runs/tr_ladder_full`, seeds 500/501/502/503, 620 scored renders, held-out Third Reich prose.

```
  rung    n    fail   95% hi   modes
   100   32     22%      39%   cov 4, long 3
   200   32     25%      42%   cov 8
   300   32     22%      39%   cov 7
   400   32     16%      32%   cov 5
   500   32      3%      16%   cov 1            <-- floor
   600   32      3%      16%   short 1, cov 1
   700   32     12%      28%   cov 4
   800   32      3%      16%   cov 1            <-- cap
   900   32     16%      32%   cov 5
  1000   32     16%      32%   cov 5, short 2
  1100   32     12%      28%   cov 4
  1200   32     12%      28%   short 2, cov 4
  1300   32     16%      32%   short 3, cov 5
  1400   32     16%      32%   cov 5
  1500   32     34%      52%   cov 11, short 4
  1600   32     44%      61%   long 5, cov 12, short 4
  1700   32     50%      66%   long 5, cov 12, short 5
  1800   32     75%      87%   long 8, cov 16, short 3
  1900   32     91%      97%   cov 28, short 12, long 4
  2000   12     75%      91%   long 2, cov 8, short 3     (partial rung, stopped by choice)

  best bands (ranked by 95% upper bound; ties to the wider):
     500-800    7/128 =  5.5%   95% hi 10.9%   width 300   <-- CHOSEN
     400-800   12/160 =  7.5%   95% hi 12.7%   width 400
     500-900   12/160 =  7.5%   95% hi 12.7%   width 400
     500-700    6/96  =  6.2%   95% hi 13.0%   width 200
```

**The curve is U-shaped.** Failure is high at BOTH ends: 22-25% below 400 chars, 3% in the 500-800 valley,
then climbing past 900 to 91% at 1900. A single "max chunk size" cannot express that, which is why the band
has a floor as well as a cap. Owen's production failures at **323, 502 and 634 chars** are the left-hand
wall, not random.

**This band reversed an earlier 800 -> 1000 cap raise** made the same day from a 2-seed sweep (n=16/rung)
that measured 900 and 1000 at 6.2%. At n=32 both measure **16%**. The 6.2% was the noise floor. Doubling
the seeds is what separated a real 3% valley from a lucky 6%.


### Pooled by ACTUAL characters — this is what set the band

`band.py` pools by **rung label**, but a rung is a target ±12%, so its windows smear across boundaries:
its "rung 800" prompts actually span **712-823 chars** and straddle the cliff, which is how it ranked
500-800 first. The packer emits real character counts, so pooling by those is the faithful measure — and
it disagrees:

```
  actual chars     fails      95% hi    modes
   450- 500       0/20  =  0.0%   16.1%
   500- 600       2/24  =  8.3%   25.8%   cov 2, short 1
   600- 700       0/44  =  0.0%    8.0%   <- cleanest segment in the entire sweep
   700- 800       5/40  = 12.5%   26.1%   cov 5
   800- 900       6/32  = 18.8%   35.3%   cov 6, short 1
   900-1000       1/32  =  3.1%   15.7%   short 1, cov 1

  candidate bands
   500-700        2/68  =  2.9%   10.1%   width 200   <-- CHOSEN
   600-800        5/84  =  6.0%   13.2%   width 200
   500-800        7/108 =  6.5%   12.8%   width 300
   500-750        7/92  =  7.6%   14.9%   width 250
```

**The cap is 700 — chunks up to 699.** 700-800 is a genuine 12.5% zone and 800-900 is worse at 18.8%.
Owen spotted this from the rung table before the char-pooling confirmed it.

**Do not read a single rung's spike as real.** Rung 700 showed 4/32 = 12.5% against rung 800's 1/32 = 3.1%,
but z = 1.42 — inside the noise. The 700-800 *character* segment being bad is a separate, better-supported
finding than "rung 700 is bad"; they happen to point the same way here, and that is luck, not method.

## deathstalker / owen / mistborn

Bands are PREDICTED, not swept — replace them when their ladders run. See HIGGS_FIELD_NOTES 4n.39, 4n.50.


### mistborn - ladder chart (512 renders, pace 13.3 chars/s, runs/v7_ladder_mb/mb_v7_704)

```
RUNG CURVE (target size +/-12%; modes = which failures, not just how many)
  rung     n    fail   95% hi   modes
    100    32     31%      49%   cov 3, long 7
    200    32      3%      16%   cov 1
    300    32      3%      16%   long 1
    400    32     12%      28%   cov 1, long 3
    500    32      6%      20%   cov 2, long 1
    600    32      3%      16%   long 1
    700    32      6%      20%   long 2
    800    32     12%      28%   cov 4, long 1, short 1
    900    32      9%      24%   cov 3, short 1
   1000    32     19%      35%   cov 6, short 3
   1100    32     28%      45%   cov 6, long 4, short 1
   1200    32     31%      49%   cov 10, long 3, short 1
   1300    32     38%      55%   cov 12, short 6
   1400    32     78%      89%   cov 25, short 7
   1500    32     59%      74%   cov 19, short 5
   1600    32     72%      84%   cov 23, short 10

CHARACTER SPREAD (actual chars - this is what the packer emits, and what sets the band)
  chars          n    fail   95% hi   modes
      0-100     12   33.3%    60.9%   long 4
    100-200     36   16.7%    31.9%   cov 3, long 3
    200-300     40    5.0%    16.5%   cov 1, long 1
    300-400     36   11.1%    25.3%   cov 1, long 3
    400-500     28    7.1%    22.6%   cov 2, long 1
    500-600     32    3.1%    15.7%   long 1
    600-700     40    5.0%    16.5%   long 2
    700-800     32   15.6%    31.8%   cov 5, long 1
    800-900     32    6.2%    20.1%   cov 2, short 2
    900-1000    48   18.8%    31.9%   cov 8, long 2, short 3
   1000-1100    36   30.6%    46.9%   cov 9, long 3, short 1
   1100-1200    24   41.7%    61.2%   cov 10, long 2, short 5
   1200-1300    40   52.5%    67.1%   cov 21, short 3
   1300-1400    40   72.5%    83.9%   cov 29, short 10
   1400-1500    24   62.5%    78.8%   cov 15, short 6
   1500-1600    12   75.0%    91.1%   cov 9, short 5

CLEANEST UNBROKEN BANDS (contiguous bins, ranked by 95%% upper bound; ties to the wider)
    200-700     11/176  =   6.2%  95% hi  10.8%  width 500
    400-700      5/100  =   5.0%  95% hi  11.2%  width 300
    200-900     18/240  =   7.5%  95% hi  11.5%  width 700
    500-700      3/72   =   4.2%  95% hi  11.5%  width 200
    200-600      9/136  =   6.6%  95% hi  12.1%  width 400
```

**BAND 200-700** - 11/176 = 6.2% (95% hi 10.8%), the cleanest unbroken run of bins.


### deathstalker - ladder chart (512 renders, pace 15.2 chars/s, runs/v7_ladder_ds/ds_v7_744)

```
RUNG CURVE (target size +/-12%; modes = which failures, not just how many)
  rung     n    fail   95% hi   modes
    100    32      3%      16%   cov 1
    200    32     19%      35%   cov 6, long 2
    300    32      9%      24%   cov 2, long 2, short 1
    400    32      0%      11%   -
    500    32      0%      11%   -
    600    32      6%      20%   cov 2, long 1
    700    32      3%      16%   long 1
    800    32      6%      20%   cov 1, long 1
    900    32      3%      16%   cov 1
   1000    32      3%      16%   cov 1
   1100    32     16%      32%   cov 2, long 3
   1200    32      6%      20%   cov 2, long 1
   1300    32     22%      39%   cov 6, long 2, short 2
   1400    32     50%      66%   cov 14, long 4, short 2
   1500    32     22%      39%   cov 5, long 4, short 2
   1600    32     22%      39%   cov 7, short 1

CHARACTER SPREAD (actual chars - this is what the packer emits, and what sets the band)
  chars          n    fail   95% hi   modes
      0-100     16    6.2%    28.3%   cov 1
    100-200     32    6.2%    20.1%   cov 2, long 2
    200-300     32   15.6%    31.8%   cov 4, long 1
    300-400     32    6.2%    20.1%   cov 2, long 1, short 1
    400-500     32    0.0%    10.7%   -
    500-600     40    5.0%    16.5%   cov 2, long 1
    600-700     20    0.0%    16.1%   -
    700-800     60    5.0%    13.7%   cov 1, long 2
    800-900     20   10.0%    30.1%   cov 2
    900-1000    48    2.1%    10.9%   cov 1
   1000-1100    36   11.1%    25.3%   cov 1, long 3
   1100-1200    28   14.3%    31.5%   cov 3, long 3
   1200-1300    36   41.7%    57.8%   cov 13, long 3, short 4
   1300-1400    40   22.5%    37.5%   cov 7, long 5, short 2
   1400-1500    36   30.6%    46.9%   cov 11, short 1
   1500-1600     4    0.0%    49.0%   -

CLEANEST UNBROKEN BANDS (contiguous bins, ranked by 95%% upper bound; ties to the wider)
    400-1000     8/220  =   3.6%  95% hi   7.0%  width 600
    300-1000    10/252  =   4.0%  95% hi   7.1%  width 700
    400-800      5/152  =   3.3%  95% hi   7.5%  width 400
    400-700      2/92   =   2.2%  95% hi   7.6%  width 300
    300-800      7/184  =   3.8%  95% hi   7.6%  width 500
```

**BAND 400-1000** - 8/220 = 3.6% (95% hi 7.0%), the cleanest unbroken run of bins.

CLIFF MARGIN:
  - the bin ABOVE the cap (1000) fails 11.1% - expected, that is the cap doing its job
