/**
 * WHICH TRANSCRIPT THIS ASSEMBLY SEALS INTO THE M4B — the whole decision, pure.
 *
 * It lives here, away from `electron/reassembly-bridge.ts`, because it is a
 * decision about two directory LISTINGS and nothing else: no disk, no Electron,
 * no ffmpeg. That makes it drivable from a keeper (`tools/test-assembly-
 * transcript-seal.js`), which is what the version that lived inside the finalize
 * never was — and the version that lived inside the finalize is the one that
 * hung a queue row for good.
 *
 * ── The stem is the answer, the count never was ─────────────────────────────
 *
 * narrator's assembly writes the chunk-level `<stem>.vtt` into its `--output_dir`
 * — BookForge's staging directory, which holds exactly what this run built
 * (`assemble/run.py`: `vtt_path = os.path.join(output_dir, stem + ".vtt")`). So
 * the stem in staging IS this run's stem. The sentence-level transcript carries
 * the same stem wherever it came from: `narrator align` writes
 * `<processDir>/<stem>.sentences.vtt` from measured word timings, and assembly
 * writes the estimated one under the same name when no coverage report existed.
 * Both derive it from `assemble/run.final_name`.
 *
 * The rule this replaces refused whenever the process dir held more than one
 * `.sentences.vtt` — "one book has one". A book that is RETITLED between two
 * runs of the same session has two, both valid, and Mutineer's Moon had exactly
 * that on 2026-09-07: an assembly sealed `Mutineers'_Moon….sentences.vtt` at
 * 13:52 and an align wrote `Mutineer's_Moon….sentences.vtt` at 14:10. The
 * refusal was a `throw` from inside a finalize whose rejection nobody held, so
 * the chain's assembly hung at "Renaming to … 70%" forever with the finished
 * audiobook stranded in staging.
 *
 * Two shapes are still refused, and both are "this cannot be identified", never
 * "this is imperfect": a staging directory that does not hold exactly one chunk
 * transcript (there is no stem to key on), and several sentence transcripts of
 * which none is this run's (there is no way to say which describes this audio).
 */

/** The suffix narrator gives the sentence-level transcript. One constant. */
export const SENTENCE_VTT_SUFFIX = '.sentences.vtt';

/** Where the sealed transcript came from, for the line the bridge logs. */
export type SentenceTranscriptSource =
  /** `<stem>.sentences.vtt` — written for THIS run, by align or by assembly. */
  | 'own-stem'
  /**
   * A `.sentences.vtt` under another stem: the same session and the same audio,
   * so its timings are this book's; the book was retitled between the run that
   * wrote it and this one.
   */
  | 'other-stem'
  /** No sentence transcript at all — the chunk-level VTT this run wrote. */
  | 'chunk';

export type SentenceTranscriptChoice =
  | {
    readonly kind: 'seal';
    readonly source: SentenceTranscriptSource;
    /** The file to seal, as a bare NAME. The caller joins it to the right dir. */
    readonly file: string;
    /** True when `file` is in the staging dir; false when it is beside the session. */
    readonly inStaging: boolean;
    /** This run's stem, from the chunk transcript in staging. */
    readonly stem: string;
    /** Sentence transcripts under other stems that were left alone. */
    readonly strays: readonly string[];
  }
  | {
    readonly kind: 'refuse';
    /** A whole sentence, naming what could not be identified and why. */
    readonly reason: string;
  };

const isVtt = (name: string): boolean =>
  name.toLowerCase().endsWith('.vtt') && !name.startsWith('._');

const isSentenceVtt = (name: string): boolean =>
  isVtt(name) && name.toLowerCase().endsWith(SENTENCE_VTT_SUFFIX);

/** The stem of a chunk-level VTT: its name without the `.vtt`. */
function stemOfChunkVtt(name: string): string {
  return name.slice(0, name.length - '.vtt'.length);
}

/**
 * Choose the transcript to seal, from what is on the two directories.
 *
 * `stagingFiles` is every entry of the assembly's staging dir; `processFiles` is
 * every entry beside the session. Both are raw `readdir` output — the filtering
 * (resource forks, the sentence suffix) is this function's, so no caller has to
 * remember which files are not transcripts.
 */
export function chooseSentenceTranscript(
  stagingFiles: readonly string[],
  processFiles: readonly string[],
): SentenceTranscriptChoice {
  const chunkVtts = stagingFiles.filter((f) => isVtt(f) && !isSentenceVtt(f));
  if (chunkVtts.length !== 1) {
    return {
      kind: 'refuse',
      reason: `Assembly wrote ${chunkVtts.length} chunk transcripts into its staging directory `
        + `(${chunkVtts.join(', ') || 'none'}); exactly one is expected, and its name is what `
        + "identifies this run's sentence transcript.",
    };
  }
  const chunk = chunkVtts[0];
  const stem = stemOfChunkVtt(chunk);
  const ownName = `${stem}${SENTENCE_VTT_SUFFIX}`;
  const sentences = processFiles.filter(isSentenceVtt);
  const own = sentences.find((f) => f === ownName);
  const others = sentences.filter((f) => f !== ownName);

  if (own !== undefined) {
    return { kind: 'seal', source: 'own-stem', file: own, inStaging: false, stem, strays: others };
  }
  if (others.length === 1) {
    return {
      kind: 'seal', source: 'other-stem', file: others[0], inStaging: false, stem, strays: [],
    };
  }
  if (others.length === 0) {
    return { kind: 'seal', source: 'chunk', file: chunk, inStaging: true, stem, strays: [] };
  }
  return {
    kind: 'refuse',
    reason: `The session holds ${others.length} sentence transcripts (${others.join(', ')}) and `
      + `none of them is this run's (${ownName}), so there is no way to say which one describes `
      + 'this audiobook.',
  };
}
