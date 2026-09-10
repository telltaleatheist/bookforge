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

## thirdreich — BAND 500-800  (`tr_v3_prod`, measured 2026-09-09)

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

## deathstalker / owen / mistborn

Bands are PREDICTED, not swept — replace them when their ladders run. See HIGGS_FIELD_NOTES 4n.39, 4n.50.
