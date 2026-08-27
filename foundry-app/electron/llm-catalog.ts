/**
 * llm-catalog — the Qwen 3.5 lineup, and which of it this machine can run.
 *
 * ── WHY THERE IS A TABLE AT ALL ──────────────────────────────────────────────
 *
 * `qwen3.8:27b` is the standing default for every language task (Owen,
 * 2026-08-22: *"27b is the standard we'll use for every task"*), and it will not
 * run on an ordinary computer. Seventeen gigabytes of weights need a card most
 * people do not have; the concrete machine this was written for has eight. A
 * default nobody's hardware can honour is not a high standard, it is an app
 * that appears broken on the first translation somebody tries.
 *
 * So setup measures the machine and offers the LARGEST QWEN 3.5 THAT ACTUALLY
 * FITS. The lineup is the shipping-model line — not the coding variants, not
 * the MLX or BF16 conversions, which are the same weights in formats chosen for
 * a different runtime — because every row here is something a person is going
 * to run through ollama for prose.
 *
 * ── THE ONE EDITABLE CONST ───────────────────────────────────────────────────
 *
 * `QWEN_LINEUP` is the whole table. Sizes are ollama's own published download
 * figures (ollama.com/library/qwen3.5/tags, read 2026-08-26). When a tag is
 * added, retired or requantised, this array is the only thing that changes and
 * every fits/doesn't-fit line on screen follows.
 *
 * ── THE HEADROOM IS DELIBERATELY GENEROUS, AND ERRS SMALL ────────────────────
 *
 * `needsGB` is the download plus `OVERHEAD_GB`. The overhead is not a fudge: a
 * loaded model also holds a KV cache sized by the context, the runner's own
 * buffers, and whatever the desktop compositor has already taken off the card.
 * 1.5 GB is roughly what that costs at an ordinary context on an ordinary
 * machine, and being wrong in this direction costs somebody a smaller model
 * than they could have had — which they can change in one field — while being
 * wrong in the other direction costs them an hour of a translation running at a
 * word a second, or an out-of-memory failure after a seventeen-gigabyte
 * download. Those two mistakes are not the same size and the number reflects it.
 *
 * A CONSEQUENCE, STATED SO IT IS NOT MISTAKEN FOR A BUG: an 8 GB card is
 * offered `qwen3.5:4b`, not `qwen3.5:9b`. 6.6 + 1.5 is 8.1, and 8.1 does not
 * fit in 8.0. The row is still there, still installable, and still says why it
 * is marked as not fitting.
 *
 * ── AND ONE PLACE THE RULE INVERTS: A MACHINE WITH NO GPU ───────────────────
 *
 * "Largest that fits" is the right rule only while memory is what binds. With
 * no GPU it is not — see the argument at the branch in `lineupFor` — so a
 * processor-only machine is recommended the SMALLEST model, not the largest its
 * RAM could hold.
 */
import type { LlmModelOption, SystemProfile } from '../shared/types';

/** Weights plus working room. See the header — erring small is the point. */
export const OVERHEAD_GB = 1.5;

interface LineupEntry {
  tag: string;
  label: string;
  /** ollama's published download size for the tag. */
  downloadGB: number;
  description: string;
}

/**
 * ★ THE LINEUP ★ — smallest first, because that is the order the screen reads
 * in and because `recommend` walks it forward looking for the last one that fits.
 */
export const QWEN_LINEUP: readonly LineupEntry[] = [
  {
    tag: 'qwen3.5:0.8b',
    label: 'Qwen 3.5 · 0.8B',
    downloadGB: 1.0,
    description: 'The smallest one. Runs on anything, including on the processor alone — use it when there is no GPU.',
  },
  {
    tag: 'qwen3.5:2b',
    label: 'Qwen 3.5 · 2B',
    downloadGB: 2.7,
    description: 'Small and quick. Fine for simplifying and for short passages; noticeably rougher on long translation.',
  },
  {
    tag: 'qwen3.5:4b',
    label: 'Qwen 3.5 · 4B',
    downloadGB: 3.4,
    description: 'The sweet spot for a laptop or an 8 GB card. Good prose, fast enough to watch.',
  },
  {
    tag: 'qwen3.5:9b',
    label: 'Qwen 3.5 · 9B',
    downloadGB: 6.6,
    description: 'Qwen 3.5\'s own default. Clearly better on long-form translation; wants a 12 GB card or more.',
  },
  {
    tag: 'qwen3.5:27b',
    label: 'Qwen 3.5 · 27B',
    downloadGB: 17,
    description: 'The 27B standard, in this generation. What a 24 GB card is for.',
  },
  {
    tag: 'qwen3.5:35b-a3b',
    label: 'Qwen 3.5 · 35B-A3B',
    downloadGB: 24,
    description: 'Mixture-of-experts: 35B of weights, about 3B active per token, so it is faster than its size — but all 35B must be resident.',
  },
  {
    tag: 'qwen3.5:122b-a10b',
    label: 'Qwen 3.5 · 122B-A10B',
    downloadGB: 81,
    description: 'A workstation model. Listed so a machine that can run it is not quietly offered something smaller.',
  },
];

function needsGB(entry: LineupEntry): number {
  return Math.round((entry.downloadGB + OVERHEAD_GB) * 10) / 10;
}

/**
 * The lineup as this machine sees it: what fits, what is already pulled, and
 * the one row that carries the badge.
 *
 * EXACTLY ONE `recommended`, AND ONLY IF SOMETHING FITS. On a machine where
 * nothing does — no GPU and eight gigabytes of RAM, say — no row is badged, and
 * the caller's `suggested` falls to the smallest with the sentence about the
 * processor. Badging a row that does not fit would be recommending a model this
 * file has just said will not run.
 *
 * `installed` MATCHES ON THE BARE NAME TOO. `ollama list` reports `qwen3.5:4b`,
 * but somebody who ran `ollama pull qwen3.5` has the same weights under
 * `qwen3.5:latest`, and offering to download six and a half gigabytes they
 * already have would be the app not looking.
 */
export function lineupFor(profile: SystemProfile, held: readonly string[]): LlmModelOption[] {
  const memoryGB = profile.modelMemoryMB / 1024;
  const heldSet = new Set(held.map((name) => name.trim().toLowerCase()));

  const fitting = QWEN_LINEUP.filter((entry) => needsGB(entry) <= memoryGB);

  /*
   * ── WITH NO GPU, "FITS" AND "IS USABLE" COME APART ────────────────────────
   *
   * Everywhere else the recommendation is the largest thing that fits, because
   * memory is the binding constraint and a model that fits a card runs at that
   * card's speed. On a machine with no GPU at all, memory stops being the
   * binding constraint: sixteen gigabytes of system RAM will hold `qwen3.5:9b`
   * perfectly well and then generate at a word or two a second, which for a
   * three-hundred-page translation is not slow, it is not going to finish. The
   * largest that fits would be a recommendation nobody could use.
   *
   * So the CPU machine is recommended the SMALLEST, and the whole lineup is
   * still listed with its real fits/doesn't-fit against RAM, so somebody who
   * knows what they are doing and is willing to leave it running overnight can
   * pick a bigger one on purpose. The screen says the machine has no GPU in the
   * line above (`SystemProfile.detail`), which is the sentence that explains
   * why this row and not a larger one.
   */
  const best = profile.memoryBasis === 'ram'
    ? fitting[0] ?? null
    : fitting[fitting.length - 1] ?? null;

  return QWEN_LINEUP.map((entry) => ({
    tag: entry.tag,
    label: entry.label,
    downloadGB: entry.downloadGB,
    needsGB: needsGB(entry),
    description: entry.description,
    fits: needsGB(entry) <= memoryGB,
    recommended: best !== null && entry.tag === best.tag,
    installed: heldSet.has(entry.tag.toLowerCase()),
  }));
}

/**
 * The tag the wizard preselects.
 *
 * The recommendation when there is one; the smallest model otherwise. The
 * second branch is not a fallback that hides a problem — the screen says in as
 * many words that nothing here fits and that this one will run on the
 * processor — it is the answer to "which of these is least bad on this
 * machine", which is a question with an answer even when none of them is good.
 */
export function suggestedTag(options: readonly LlmModelOption[]): string {
  const recommended = options.find((option) => option.recommended);
  if (recommended) return recommended.tag;
  return options[0]?.tag ?? QWEN_LINEUP[0]!.tag;
}
