import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { askRowStates, planUndo, retypeSaid, reviewOf, structureSaid, type AskMark } from '@owen/foundry-core/shared/ask';
import type { ReplayedRow } from '@owen/foundry-core/shared/ops';
import { wordDiff, type ChangeRange } from '@owen/foundry-core/shared/word-diff';

import { AskService } from '../../core/ask.service';
import { BookStacksService, type BookStack } from '../../core/book-stacks.service';
import { NoticeService } from '../../core/notice.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';

/**
 * WHAT ASK DID — every mark of the book's latest run, grouped by reason, each
 * one kept or taken back.
 *
 * Owen, 2026-10-29: *"the modal should show a list of all the strikes so i can
 * pick which to keep and which not to keep. we already have a modal that does
 * this kind of [thing], but its deterministic and not very good... the sweep. we
 * dont need sweep. ive never used it... we could repurpose the modal for this."*
 *
 * So this is the sweep's card — its grid rows, its travel button, its quotation
 * and its pill, its footer — over a different list. The sweep found matches and
 * landed them; this is handed a run that has ALREADY landed (as one undo, by
 * AskService) and lands the opposite of whatever the person sets to Undo.
 *
 * ── KEEP IS THE DEFAULT, AND UNDO IS ONE GESTURE ───────────────────────────
 *
 * The model's work is already on the book, so a row left alone is a decision
 * already made. "Undo selected" pushes `restore` for each strike and the
 * `before` text for each revision (a correction on a translated pass), and the
 * old kind and chapter for each retyping, as ONE
 * gesture on the pane's stack, so the undo itself can be taken back with one
 * press too.
 *
 * ── A BLOCK THAT HAS MOVED IS NOT TOUCHED ──────────────────────────────────
 *
 * A row whose block is no longer what the run left — unstruck by hand, retyped,
 * gone — is drawn faded with the reason, and is skipped by the undo with a
 * sentence saying how many and why (`planUndo`, shared/ask.ts). Writing a
 * revision's `before` over a paragraph the person has edited since would undo
 * their edit as well as the model's.
 */
@Component({
  selector: 'app-ask-review-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ask-review-dialog.component.html',
  styleUrl: './ask-review-dialog.component.scss',
})
export class AskReviewDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly stage = inject(StageService);
  private readonly stacks = inject(BookStacksService);
  private readonly notices = inject(NoticeService);
  private readonly asks = inject(AskService);

  /** The book pane in front, or null with a sentence beside it (`shut`). */
  protected readonly pane = computed<BookStack | null>(() => {
    const tab = this.stage.activeDocument();
    if (tab === null || tab.kind !== 'book' || tab.viewOnly === true) return null;
    return this.stacks.bookStackFor(tab.id);
  });

  protected readonly shut = computed<string>(() => {
    const tab = this.stage.activeDocument();
    if (tab === null || tab.kind !== 'book') {
      return 'This lists what Ask did to the book in front of you, and there is no book in front of you.';
    }
    if (tab.viewOnly === true) return 'This tab shows a finished export, which Ask does not change.';
    return 'This book is still opening.';
  });

  /**
   * The latest kept run for the book in front — or, when it was a step of a
   * with its name (`reviewOf`, shared/ask.ts).
   * with its name (, shared/ask.ts).
   */
  protected readonly session = computed(() => {
    const tab = this.stage.activeDocument();
    if (tab === null || tab.kind !== 'book') return null;
    const all = this.asks.history().get(tab.path) ?? [];
    const asked = this.asks.reviewing();
    const latest = (asked === null ? null : all.find((one) => one.id === asked) ?? null) ?? this.asks.latest().get(tab.path) ?? null;
    return latest === null ? null : reviewOf(all.length > 0 ? all : [latest], latest);
  });

  protected readonly groups = computed(() => this.session()?.groups ?? []);

  /** The rows as the sheet draws them, by id. */
  private readonly rows = computed<ReadonlyMap<string, ReplayedRow>>(() =>
    new Map((this.pane()?.view()?.rows ?? []).map((row) => [row.id, row])));

  /**
   * WHICH MARKS CAN NO LONGER BE TAKEN BACK, and why — `planUndo` asked about
   * every mark at once, so the faded rows and the undo's own skips are one rule.
   */
  protected readonly movedWhy = computed<ReadonlyMap<string, string>>(() => {
    const items = this.session()?.items ?? [];
    const states = askRowStates([...this.rows().values()], this.pane()?.view()?.chapters ?? []);
    const plan = planUndo(items, states, this.pane()?.translated() === true);
    return new Map(plan.skipped.map((skip) => [this.key(skip.item), skip.why]));
  });

  /** The marks a verdict can be passed on. */
  protected readonly undoable = computed<readonly AskMark[]>(() =>
    (this.session()?.items ?? []).filter((item) => !this.movedWhy().has(this.key(item))));

  /** The marks set to Undo, by row key (`reviewOf`'s `keyOf`). Empty is every row kept, which is the default. */
  private readonly undoing = signal<ReadonlySet<string>>(new Set());
  /** The rows somebody opened for the block's whole text. */
  protected readonly opened = signal<ReadonlySet<string>>(new Set());
  protected readonly working = signal(false);

  protected readonly chosen = computed<readonly AskMark[]>(() =>
    this.undoable().filter((item) => this.undoing().has(this.key(item))));
  protected readonly keptCount = computed(() => this.undoable().length - this.chosen().length);

  protected isUndoing(item: AskMark): boolean {
    return this.undoing().has(this.key(item)) && !this.movedWhy().has(this.key(item));
  }

  /** A mark's row identity: a block's retyping and its revision are two rows. */
  protected key(item: AskMark): string {
    return this.session()?.keyOf(item) ?? '';
  }

  /**
   * WHERE A MARK'S BLOCK IS NOW, for its row's jump: a joined block lives in
   * the one it went into, and a split block in its first half.
   */
  protected goesTo(item: AskMark): string {
    if (item.kind === 'join') return item.into;
    if (item.kind === 'split') return `${item.id}/1`;
    // A revert of a join brings the block back as the survivor's second half; it is found from the survivor.
    if (item.kind === 'revert') return item.original.kind === 'join' ? item.original.into : item.original.id;
    return item.id;
  }

  /** What a join, a split, a restore or a link does, said for its row. */
  protected structure(item: Extract<AskMark, { kind: 'join' | 'split' | 'restore' | 'link' | 'unlink' | 'revert' }>): string {
    return structureSaid(item);
  }

  /** The one thing undoing a join or a split cannot give back: the blocks' names. */
  protected renamedOnUndo(item: AskMark): string {
    if (item.kind === 'join' || item.kind === 'split') {
      return 'Undo puts the words, kinds and chapter back exactly; the blocks come back under new names (…/1, …/2).';
    }
    if (item.kind === 'revert' && (item.original.kind === 'join' || item.original.kind === 'split')) {
      return 'Taking back a join or a split puts the words, kinds and chapter back exactly; the blocks come back under new names (…/1, …/2).';
    }
    return '';
  }

  /** What a retyping does, said for its row. */
  protected retyped(item: Extract<AskMark, { kind: 'category' }>): string {
    return retypeSaid(item);
  }

  protected undoingIn(items: readonly AskMark[]): number {
    return items.filter((item) => this.isUndoing(item)).length;
  }

  protected allUndone(items: readonly AskMark[]): boolean {
    const live = items.filter((item) => !this.movedWhy().has(this.key(item)));
    return live.length > 0 && live.every((item) => this.undoing().has(this.key(item)));
  }

  protected pageOf(id: string): number {
    return this.rows().get(id)?.page ?? 0;
  }

  /** A strike's or a retyping's quotation: clipped until the row is opened. */
  protected shown(key: string, text: string): string {
    return this.opened().has(key) || text.length <= CLIP ? text : `${text.slice(0, CLIP)}…`;
  }

  /**
   * One side of a revision, cut into runs so the changed words can be lit:
   * `removed` ranges of the before, `added` ranges of the after.
   */
  protected partsOf(text: string, side: ChangeRange['kind'], id: string): readonly { text: string; changed: boolean }[] {
    const item = this.session()?.items.find((one) => one.id === id && one.kind === 'text');
    if (item === undefined || item.kind !== 'text') return [{ text, changed: false }];
    const diff = wordDiff(item.before, item.after);
    const ranges = side === 'removed' ? diff.removed : diff.added;
    const out: { text: string; changed: boolean }[] = [];
    let at = 0;
    for (const range of ranges) {
      if (range.start > at) out.push({ text: text.slice(at, range.start), changed: false });
      out.push({ text: text.slice(range.start, range.end), changed: true });
      at = range.end;
    }
    if (at < text.length) out.push({ text: text.slice(at), changed: false });
    return out;
  }

  protected flip(key: string): void {
    this.undoing.update((held) => {
      const next = new Set(held);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  protected flipGroup(items: readonly AskMark[]): void {
    const undo = !this.allUndone(items);
    this.undoing.update((held) => {
      const next = new Set(held);
      for (const item of items) {
        const key = this.key(item);
        if (this.movedWhy().has(key)) continue;
        if (undo) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }

  protected keepAll(): void {
    this.undoing.set(new Set());
  }

  protected undoAll(): void {
    this.undoing.set(new Set(this.undoable().map((item) => this.key(item))));
  }

  protected toggleOpen(key: string): void {
    this.opened.update((held) => {
      const next = new Set(held);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** A row travels: the card closes so the paragraph can be seen, and the pane pulses it. */
  protected travel(pane: BookStack, id: string): void {
    this.ui.closeAskReview();
    pane.reveal(id);
  }

  protected async undoSelected(pane: BookStack): Promise<void> {
    const tab = this.stage.activeDocument();
    const chosen = this.chosen();
    if (tab === null || chosen.length === 0) return;
    this.working.set(true);
    const said = await this.asks.undo(tab.path, pane, chosen);
    this.working.set(false);
    this.undoing.set(new Set());
    this.ui.closeAskReview();
    this.notices.notice.set(said);
  }
}

/** How much of a struck block a closed row quotes. */
const CLIP = 320;
