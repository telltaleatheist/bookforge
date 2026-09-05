/**
 * The words BookForge says about a job type — one table per question, and one
 * authority for every process that has to name a run.
 *
 * ── Why they live here and not beside the chip that draws them ──────────────
 *
 * They were QueueTrayService's own constants, because the title-bar chip was the
 * only surface that had to say what a run is doing. It is not the only one any
 * more: the hosted Foundry window draws a chip of its own out of a value MAIN
 * pushes (electron/foundry-host-status.ts), and main cannot import a renderer
 * service. A second table of gerunds in main would be two vocabularies for one
 * queue — identical the day they were written and drifting the first time a job
 * type is added — so the words moved to where both halves already read the
 * queue's shapes from.
 *
 * ── Exhaustive by construction, which is the whole reason they are tables ────
 *
 * `Record<JobType, string>` refuses to compile when a job type arrives without a
 * word for it. A default here would put "Processing" in the title bar of an app
 * whose entire readout is supposed to say what is actually happening, and the
 * omission would never be noticed, because a default is indistinguishable from
 * an answer.
 */
import type { JobType } from './engine-types';

/**
 * What each job type is DOING while it runs, as a sentence fragment.
 *
 * The verb half of "Narrating <book>" — the one line BookForge's title-bar chip
 * says and, since the host-status chip, the one line Foundry's chrome says too.
 * Both compose it the same way, from this table and the job's own title, because
 * a person looking at two windows of the same application must not be told two
 * different things about one run.
 */
export const JOB_GERUND: Record<JobType, string> = {
  'tts-conversion': 'Narrating',
  'translation': 'Translating',
  'rvc-enhancement': 'Enhancing',
  'final-denoise': 'Denoising',
  // NOT "Checking". The act is a forced alignment of every rendered chunk
  // against its own text, and the word a person can act on when it fails is the
  // one the failure will use.
  'align': 'Aligning',
  'reassembly': 'Assembling',
  'bilingual-cleanup': 'Cleaning',
  'bilingual-translation': 'Translating',
  'bilingual-assembly': 'Assembling',
  'video-assembly': 'Rendering',
  'book-analysis': 'Analysing',
  'generate-sentences': 'Transcribing',
  'simplify': 'Simplifying',
  'translate-pass': 'Translating',
  'footnote-refs': 'Cleaning',
  'narration-text': 'Cleaning',
  'vlm-convert': 'Reading',
  // Work ordered in the hosted Foundry window. One word for read, render and
  // translate, because the chip says it while the row is RUNNING and what the
  // engine is doing at that moment is making the book — the row's own title
  // carries which act it is.
  'foundry-job': 'Making',
};

/** What a finished job of this type produced — the tray card's kicker. */
export const JOB_PRODUCT: Record<JobType, string> = {
  'tts-conversion': 'Narration',
  'translation': 'Translation',
  'rvc-enhancement': 'Voice enhancement',
  'final-denoise': 'Denoised sentences',
  // The report, because that is the thing that outlives the step and the thing
  // assembly reads. The sentence VTT it also writes is a by-product of the same
  // alignment, not what the row was queued for.
  'align': 'Coverage report',
  'reassembly': 'Audiobook',
  'bilingual-cleanup': 'Bilingual cleanup',
  'bilingual-translation': 'Bilingual translation',
  'bilingual-assembly': 'Bilingual audiobook',
  'video-assembly': 'Video',
  'book-analysis': 'Book analysis',
  'generate-sentences': 'Sentences',
  'simplify': 'Simplified text',
  'translate-pass': 'Translated text',
  'footnote-refs': 'Footnote clean-up',
  'narration-text': 'Narration text',
  'vlm-convert': 'EPUB conversion',
  // What a Foundry job leaves behind, said in the one word true of all three: a
  // read leaves the bank, a rendering leaves the file, a translate leaves the
  // records. Each is a page of the book the window is making.
  'foundry-job': 'Foundry work',
};
