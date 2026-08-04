import { Injectable, computed, inject, signal } from '@angular/core';

import { ElectronService } from '../../../core/services/electron.service';
import { blockCategoryDef } from '@shared/ocr/block-categories';
import { mergeRefusal } from '@shared/document/block-merge';
import type { TextBlock } from '@shared/ocr/text-block';
import type {
  BlockAnnotation,
  DocumentBlocksPayload,
  DocumentPage,
  DocumentPipelineState,
  DocumentRef,
  ResetTarget,
  WorkingDocumentEdit,
} from '@shared/document/pipeline-types';

/**
 * document-blocks — the picker's block layer, read from and written to the
 * working document.
 *
 * This is the whole of the picker's data layer under the document pipeline
 * (docs/DOCUMENT_PIPELINE.md §Curation). The blocks come out of
 * `<Original>.working.pdf` as real PDF annotations and every edit goes back into
 * it as a PDF incremental update. There is no run directory, no edit list, no
 * override map and nothing staged for a later step to "apply": if the user
 * relabelled a block, the annotation in the PDF says so, and opening that PDF in
 * Acrobat shows it.
 *
 * ── Why the blocks do not come through pdf.js ───────────────────────────────
 *
 * pdf.js renders the PAGE and nothing else here. Its `getAnnotations()` parses
 * against a fixed key whitelist and silently drops custom dictionary keys, so
 * every `/FoundryCategory` would come back as nothing at all — a book that reads
 * as "no blocks yet" rather than as an error. Main reads them with pdf-lib and
 * ships them over IPC; the picker hand-draws the overlay, which it already did.
 *
 * ── Frames ──────────────────────────────────────────────────────────────────
 *
 * Annotations arrive in PDF USER SPACE: points, origin bottom-left, y UP, with
 * each page's crop box beside them. The picker places everything in points with
 * the origin TOP-LEFT and y down, which is what its SVG viewBox is. So the
 * conversion is a flip and a crop-box translation, and it happens HERE, once —
 * carrying the crop-box origin, because a page may declare a `/CropBox` smaller
 * than its `/MediaBox` (a trimmed scanner margin is the common case) and every
 * renderer shows the crop box. Dropping that offset puts every box on such a
 * page short by the trim.
 *
 * ── Why edits are batched, and why the batch is not a cache ─────────────────
 *
 * Each incremental update carries a fresh cross-reference section and trailer,
 * so landing a hundred label clicks one at a time appends a hundred of those.
 * They are collected for a moment and landed together, in the order they were
 * made. That is a WRITE SCHEDULE, not pipeline state: the queue is drained
 * before anything reads the document, `flush()` is awaited by every caller that
 * needs the file current, and a failed write surfaces rather than being retried
 * into silence — the picker reloads from the document, which is the authority.
 */
@Injectable({ providedIn: 'root' })
export class DocumentBlocksService {
  private readonly electron = inject(ElectronService);

  /** The documents currently open. Null before a book is loaded. */
  private readonly ref = signal<DocumentRef | null>(null);

  readonly blocks = signal<TextBlock[]>([]);
  readonly pages = signal<DocumentPage[]>([]);
  readonly documentClass = signal<'scanned' | 'text' | null>(null);
  readonly state = signal<DocumentPipelineState | null>(null);

  /** The ids the document flags `/FoundryDeleted`. */
  readonly deletedBlockIds = signal<ReadonlySet<string>>(new Set());
  /** The pages the document flags `/FoundryPageDeleted`. */
  readonly deletedPages = computed<ReadonlySet<number>>(() =>
    new Set(this.pages().filter(p => p.deleted).map(p => p.index)));

  /** Blocks the book will actually be built from. */
  readonly visibleBlocks = computed<TextBlock[]>(() => {
    const gone = this.deletedBlockIds();
    const deadPages = this.deletedPages();
    return this.blocks().filter(b => !gone.has(b.id) && !deadPages.has(b.page));
  });

  /**
   * The chapter blocks, in reading order — which IS the Chapter tab.
   *
   * Derived from the one category field rather than kept as a second list, so
   * relabelling any block to `chapter` makes it appear here and relabelling it
   * away removes it, with nothing to keep in step.
   */
  readonly chapterBlocks = computed<TextBlock[]>(() =>
    this.visibleBlocks().filter(b => b.category_id === 'chapter'));

  /** A stage is running; the picker disables what would write under it. */
  readonly stageRunning = signal<string | null>(null);
  /** The stage's own most recent line, verbatim. */
  readonly stageMessage = signal<string>('');
  /**
   * What the last stage or edit said when it failed.
   *
   * Surfaced ONCE, where the user asked for the work, and cleared the moment
   * anything is asked for again. There is no persistent error state to attach or
   * trip over later: a failed stage wrote nothing and deleted its own scratch, so
   * the recovery is to run it again.
   */
  readonly lastError = signal<string | null>(null);

  private pending: WorkingDocumentEdit[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();

  /** How long edits collect before they are landed together. */
  private static readonly BATCH_MS = 400;

  // ───────────────────────────────────────────────────────────────────────────
  // Reading
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Point this service at a book and read its block layer.
   *
   * Throws the main process's own message when the working document is not
   * there — which names the stage that casts one, and is the sentence the user
   * needs rather than an empty picker that looks like a book with no blocks.
   */
  async open(ref: DocumentRef): Promise<void> {
    this.ref.set(ref);
    this.lastError.set(null);
    await this.refreshState();
    await this.reload();
  }

  /** Re-read the block layer off the document, discarding nothing but our copy. */
  async reload(): Promise<void> {
    const ref = this.requireRef();
    await this.flush();
    const payload = await this.electron.documentReadBlocks(ref);
    this.adopt(payload);
  }

  async refreshState(): Promise<void> {
    this.state.set(await this.electron.documentState(this.requireRef()));
  }

  private adopt(payload: DocumentBlocksPayload): void {
    const cropByPage = new Map(payload.pages.map(p => [p.index, p.cropBox]));
    this.documentClass.set(payload.documentClass);
    this.pages.set(payload.pages);
    this.blocks.set(payload.blocks.map(b => toTextBlock(b, cropByPage, payload.documentClass)));
    this.deletedBlockIds.set(new Set(payload.blocks.filter(b => b.deleted).map(b => b.id)));
  }

  private requireRef(): DocumentRef {
    const ref = this.ref();
    if (!ref) {
      throw new Error(
        'No book is open in this window, so there is no working document to read or edit.'
      );
    }
    return ref;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Writing
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Relabel a block. Its ONE category field, and everything that displays it.
   *
   * Applied to the local copy immediately and queued for the document. The two
   * cannot diverge for long: the queue is drained on a timer, before every read,
   * and a write that fails reloads from the document rather than leaving the
   * screen showing an edit the file does not have.
   */
  relabel(blockId: string, category: string): void {
    this.blocks.update(list =>
      list.map(b => (b.id === blockId ? { ...b, category_id: category } : b)));
    this.queue({ kind: 'relabel', blockId, category });
  }

  /** A chapter block's `/Contents` IS its title. */
  retitle(blockId: string, text: string): void {
    this.blocks.update(list =>
      list.map(b => (b.id === blockId ? { ...b, text, char_count: text.length } : b)));
    this.queue({ kind: 'retitle', blockId, text });
  }

  setDeleted(blockId: string, deleted: boolean): void {
    this.deletedBlockIds.update(set => {
      const next = new Set(set);
      if (deleted) next.add(blockId); else next.delete(blockId);
      return next;
    });
    this.queue(deleted ? { kind: 'delete', blockId } : { kind: 'restore', blockId });
  }

  setPageDeleted(page: number, deleted: boolean): void {
    this.pages.update(list => list.map(p => (p.index === page ? { ...p, deleted } : p)));
    this.queue(deleted ? { kind: 'delete-page', page } : { kind: 'restore-page', page });
  }

  /**
   * Merge several blocks into the earliest of them in reading order.
   *
   * The local copy mirrors what the writer does to the document — union box,
   * texts joined in reading order, the lead keeping its id, category and place —
   * so the screen after a merge is the document after a merge, rather than an
   * approximation that a reload would silently correct.
   *
   * What it refuses, and why, is `mergeRefusal` — the same rule the Merge button
   * and the block menu are greyed out by, so a refusal here is never news.
   *
   * Returns the id of the block that survived, so the caller can leave the user
   * looking at what they made. Which member that is, is this method's answer to
   * give — a caller that picked one itself would be picking by array order,
   * which is not reading order.
   */
  merge(blockIds: readonly string[]): string {
    const unique = [...new Set(blockIds)];
    const members = this.blocks().filter(b => unique.includes(b.id));
    // A selected id this book's blocks do not carry means the selection and the
    // block layer have come apart. Judging only the blocks that were found
    // would merge FEWER than the user chose, silently, looking like success.
    if (members.length !== unique.length) {
      const found = new Set(members.map(m => m.id));
      const missing = unique.filter(id => !found.has(id));
      throw new Error(
        `The selection names ${missing.length === 1 ? 'a block' : `${missing.length} blocks`} this `
        + `book's block layer does not carry (${missing.join(', ')}). Reload the book before merging.`
      );
    }
    const refusal = mergeRefusal(members);
    if (refusal) throw new Error(refusal);
    members.sort((a, b) => requireSeq(a) - requireSeq(b));
    const lead = members[0];

    const x0 = Math.min(...members.map(m => m.x));
    const y0 = Math.min(...members.map(m => m.y));
    const x1 = Math.max(...members.map(m => m.x + m.width));
    const y1 = Math.max(...members.map(m => m.y + m.height));
    const text = members.map(m => m.text).filter(t => t.length > 0).join(' ').trim();
    const doomed = new Set(members.slice(1).map(m => m.id));

    this.blocks.update(list => list
      .filter(b => !doomed.has(b.id))
      .map(b => (b.id === lead.id
        ? {
          ...b,
          x: x0, y: y0, width: x1 - x0, height: y1 - y0,
          text, char_count: text.length,
          merged_foundry_ids: members.map(m => m.id),
        }
        : b)));
    this.queue({ kind: 'merge', blockIds: members.map(m => m.id) });
    return lead.id;
  }

  private queue(edit: WorkingDocumentEdit): void {
    this.pending.push(edit);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, DocumentBlocksService.BATCH_MS);
  }

  /**
   * Land everything queued, now.
   *
   * Awaited before every read of the document and by anything that runs a stage
   * over it — a Reflow that started while three label clicks were still in a
   * timer would build a book the user could see was wrong.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return this.inFlight;
    const batch = this.pending;
    this.pending = [];
    // Chained rather than parallel: two incremental updates computed against the
    // same base length would have the second overwrite the first.
    this.inFlight = this.inFlight.then(async () => {
      try {
        await this.electron.documentApplyEdits(this.requireRef(), batch);
      } catch (err) {
        this.lastError.set(err instanceof Error ? err.message : String(err));
        // The document is the authority and it did not take these edits, so the
        // screen is now the thing that is wrong. Re-read rather than retry: a
        // retry would land an edit whose target may no longer exist.
        try {
          const payload = await this.electron.documentReadBlocks(this.requireRef());
          this.adopt(payload);
        } catch (reread) {
          // Swallowed deliberately: a rejection here would leave `inFlight`
          // rejected forever, and every later batch would chain onto it and
          // silently never land. The refusal already on screen is the news.
          console.error('[document-blocks] could not re-read after a refused write:', reread);
        }
      }
    });
    return this.inFlight;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Stages
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Detect. There is one, and it REPLACES the annotations.
   *
   * The confirmation belongs to the caller — this is where hand curation is
   * overwritten — and once it has been given, nothing here stages or previews
   * the result: if it ran, the annotations in the PDF are the new truth.
   */
  async detect(): Promise<void> {
    await this.runStage('Detect blocks', () => this.electron.documentDetect(this.requireRef()));
  }

  /** Read the pages again from scratch. Casting REPLACES the working document. */
  async getText(): Promise<void> {
    await this.runStage('Get Text', () => this.electron.documentGetText(this.requireRef()));
  }

  async reflow(excludeCategories: string[] = []): Promise<string> {
    const ref = this.requireRef();
    await this.flush();
    let epubPath = '';
    await this.runStage('Build the book', async () => {
      epubPath = await this.electron.documentReflow(
        ref, excludeCategories.length > 0 ? { excludeCategories } : undefined);
    });
    return epubPath;
  }

  /**
   * Put the working document back to how it stood at the end of a stage.
   *
   * One truncate: zero GPU, no re-run, and the result is not an approximation of
   * that document but that document.
   */
  async resetTo(target: ResetTarget): Promise<void> {
    const ref = this.requireRef();
    // Dropped, not landed: these edits belong to bytes that are about to be cut
    // off the end of the file, and landing them first would append them past the
    // boundary being reset to — so the reset would silently keep them.
    this.pending = [];
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }

    this.lastError.set(null);
    await this.electron.documentResetTo(ref, target);
    await this.refreshState();
    if (target === 'none') {
      this.blocks.set([]);
      this.pages.set([]);
      this.deletedBlockIds.set(new Set());
      this.documentClass.set(null);
      return;
    }
    await this.reload();
  }

  async cancelStage(): Promise<void> {
    const ref = this.ref();
    if (ref) await this.electron.documentCancelStage(ref.projectDir);
  }

  private async runStage(label: string, run: () => Promise<unknown>): Promise<void> {
    await this.flush();
    this.lastError.set(null);
    this.stageRunning.set(label);
    this.stageMessage.set('');
    try {
      await run();
      await this.refreshState();
      await this.reload();
    } catch (err) {
      // Surfaced once, here, where the work was asked for. Nothing is written to
      // disk about it: the stage left the document untouched and deleted its own
      // scratch, so running it again is the whole recovery.
      this.lastError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.stageRunning.set(null);
    }
  }

  /** Subscribe to stage progress for the open book. Returns the unsubscribe. */
  watchProgress(): () => void {
    return this.electron.onDocumentStageProgress(event => {
      if (event.projectDir !== this.ref()?.projectDir) return;
      this.stageMessage.set(event.message);
    });
  }
}

/**
 * A block's place in reading order, or the refusal naming it.
 *
 * Every block that came out of a working document has one — the annotation
 * states it — so a block here without one did not come from the document this
 * merge is about, and picking a lead by array position instead would merge into
 * whichever the renderer happened to hold first.
 */
function requireSeq(block: TextBlock): number {
  if (block.seq === undefined) {
    throw new Error(
      `Block ${block.id} has no place in the book's reading order, so it did not come from this `
      + "book's working document. Reload the book before merging."
    );
  }
  return block.seq;
}

/**
 * One annotation, in the picker's frame.
 *
 * PDF user space is points with the origin bottom-left and y UP; the picker's is
 * points with the origin top-left and y down, relative to the crop box. So the
 * top edge of the box is `cropBox.y1 - rect.y1`, and the left edge is
 * `rect.x0 - cropBox.x0`. This is foundry's `ptRectToPxBox` with the dpi scaling
 * left out, because the picker never leaves points.
 */
function toTextBlock(
  annotation: BlockAnnotation,
  cropByPage: ReadonlyMap<number, [number, number, number, number]>,
  documentClass: 'scanned' | 'text',
): TextBlock {
  const crop = cropByPage.get(annotation.page);
  if (!crop) {
    throw new Error(
      `Block ${annotation.id} is on page ${annotation.page + 1}, and the working document reported `
      + 'no such page. The block layer and the document have come apart — re-run Detect blocks.'
    );
  }
  const [cx0, , , cy1] = crop;
  const [x0, y0, x1, y1] = annotation.rect;
  const def = blockCategoryDef(annotation.category);
  return {
    id: annotation.id,
    page: annotation.page,
    seq: annotation.seq,
    x: x0 - cx0,
    y: cy1 - y1,
    width: x1 - x0,
    height: y1 - y0,
    text: annotation.text,
    char_count: annotation.text.length,
    category_id: annotation.category,
    // The annotation carries no type size — it is a box round a block, not a run
    // of glyphs — so the category's nominal size is the display hint, and a
    // category outside the contract simply has none.
    font_size: def?.fontSize ?? 0,
    font_name: '',
    region: def?.region ?? 'body',
    is_ocr: documentClass === 'scanned',
    ...(annotation.merged.length > 0 ? { merged_foundry_ids: annotation.merged } : {}),
  };
}
