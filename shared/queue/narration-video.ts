/**
 * THE VIDEO A NARRATION RUN CAN ALSO PRODUCE — the step, on its own.
 *
 * ── Why it is beside the narration description and not inside it ────────────
 *
 * `narration-run.ts` describes what a narration RUN consists of: read, convert,
 * assemble. Three processes read that description — this window's dialog, main's
 * door for Foundry's press, and the queue that runs the result — and widening it
 * to carry a fourth step only one of them can ask for would make every reader
 * carry a field it has no question for.
 *
 * A video is not one of those steps. It is a second RENDERING of the audiobook
 * the run has already made: it reads the finished M4B and its subtitles, and
 * without an assembly there is nothing for it to read. So it is composed here,
 * appended after the run by whoever asked for it, and the run description stays
 * the three acts it has always been.
 *
 * ── Why it is in shared/ at all ─────────────────────────────────────────────
 *
 * It is the one capability the Process wizard had that lived nowhere else, and
 * when that page was erased (2026-08-27) its composition had to go somewhere
 * that is not a template. Here it is reachable by a harness that can run it and
 * print what it built, which is how the port was checked against the wizard's
 * fields — and reachable by main, should Foundry's door ever ask for one.
 *
 * ── NO m4bPath / vttPath, deliberately ──────────────────────────────────────
 *
 * This step is queued BESIDE the assembly that produces those files, so at
 * compose time they do not exist and cannot be named. The renderer used to
 * invent them as `<projectDir>/output/audiobook.m4b|.vtt`, which the monolingual
 * assembler never writes — it names the file after the book — so the pair was a
 * fiction the bridge worked around every time.
 * `video-assembly-bridge.resolveOutputPaths` resolves both from the project's
 * output/ when the job RUNS, and throws naming that directory when they are not
 * there.
 */
import type { NarrationRunBook } from './narration-run';

/** The sizes `VideoAssemblyJobConfig.resolution` accepts. */
export type VideoResolution = '480p' | '720p' | '1080p';

/**
 * The video step, in the shape both doors wrap for their own queue.
 *
 * `projectId` and `bfpPath` are both the project directory and that is not a
 * duplication: the bridge resolves the audiobook from one and the queue files
 * this job's analytics under the other.
 */
export interface NarrationVideoPlan {
  readonly type: 'video-assembly';
  readonly bfpPath: string;
  readonly metadata: { readonly title: string };
  readonly config: {
    readonly type: 'video-assembly';
    readonly projectId: string;
    readonly bfpPath: string;
    /**
     * 'monolingual' always. The bilingual arm belonged to the wizard's
     * sentence-aligned half, which had been unreachable code for some time
     * before the page was deleted; reviving it here would be inventing a
     * capability rather than porting one.
     */
    readonly mode: 'monolingual';
    readonly title: string;
    readonly sourceLang: string;
    readonly resolution: VideoResolution;
    readonly outputFilename: string;
  };
}

/**
 * Compose the video step for this book.
 *
 * `sourceLang` is the caller's because it must be the SAME answer the narration
 * settings carry — the subtitles are that narration's — and a language decided
 * twice is two chances for a run and its video to disagree.
 *
 * Refuses on an unnamed project directory rather than composing a job pointed at
 * nothing: this step reads the assembled audiobook from under that directory, so
 * an empty one queues a job that fails at run time naming a path the user cannot
 * place, long after the click that made it.
 */
export function narrationVideoStep(
  book: NarrationRunBook,
  resolution: VideoResolution,
  sourceLang: string,
): NarrationVideoPlan {
  if (!book.projectDir) {
    throw new Error(
      'Cannot queue the video job: this project has no project directory, so there is nowhere '
      + 'to read the assembled audiobook from.',
    );
  }
  return {
    type: 'video-assembly',
    bfpPath: book.projectDir,
    metadata: { title: 'Video' },
    config: {
      type: 'video-assembly',
      projectId: book.projectDir,
      bfpPath: book.projectDir,
      mode: 'monolingual',
      title: book.title,
      sourceLang,
      resolution,
      outputFilename: videoOutputFilename(book),
    },
  };
}

/**
 * What the MP4 is called: the title, then the author when the title does not
 * already carry it.
 *
 * The wizard's rule, kept verbatim — including its treatment of 'Unknown' as an
 * absent author, which is the spelling the metadata editor leaves behind when
 * nobody has said who wrote the book.
 */
function videoOutputFilename(book: NarrationRunBook): string {
  let name = book.title || 'audiobook';
  const author = book.author;
  if (author && author !== 'Unknown' && !name.includes(author)) {
    name += `. ${author}`;
  }
  return name;
}
