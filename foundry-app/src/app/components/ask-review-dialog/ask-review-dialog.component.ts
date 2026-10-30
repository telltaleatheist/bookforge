import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { groupByReason, planUndo, type AskMark } from '@shared/ask';
import type { ReplayedRow } from '@shared/ops';
import { wordDiff, type ChangeRange } from '@shared/word-diff';

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
 * `before` text for each revision (a correction on a translated pass) as ONE
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
  template: `
    <div class="scrim" (click)="ui.closeAskReview()"></div>

    <div class="card" role="dialog" aria-modal="true" aria-label="What Ask did">
      <header class="head">
        <span class="title">What Ask did</span>
        <button class="x" (click)="ui.closeAskReview()" title="Close">✕</button>
      </header>

      @if (pane(); as book) {
        @if (session(); as kept) {
          @if (working()) {
            <div class="body working">
              <p class="progress">Undoing…</p>
              <p class="note">
                On a translated pass the words of a block are a record, not a change waiting to be
                applied — so each one is written on its own, in order.
              </p>
            </div>
          } @else {
            <div class="bar">
              <span class="asked">"{{ kept.request }}"</span>
              <span class="tally">{{ kept.model }} · {{ kept.items.length }} {{ kept.items.length === 1 ? 'change' : 'changes' }}</span>
            </div>
            @if (kept.skipped > 0) {
              <p class="problem">
                {{ kept.skipped }} of the model's marks were never put on the book, because their
                blocks changed while it worked.
              </p>
            }

            <div class="list">
              @for (group of groups(); track group.reason) {
                <div class="group">
                  <span class="reason">{{ group.reason }}</span>
                  <span class="group-count">{{ group.items.length }} · {{ undoingIn(group.items) }} to undo</span>
                  <button class="hit group-hit" (click)="flipGroup(group.items)">
                    <span class="verdict" [class.keep]="allUndone(group.items)">
                      {{ allUndone(group.items) ? 'KEEP ALL' : 'UNDO ALL' }}
                    </span>
                  </button>
                </div>
                @for (item of group.items; track item.id) {
                  @let moved = movedWhy().get(item.id);
                  @let undoing = isUndoing(item);
                  <div class="row" [class.ghost]="moved !== undefined" [class.open]="opened().has(item.id)">
                    <button class="at" (click)="travel(book, item.id)">
                      <span class="at-id">{{ item.id }}</span>
                      @if (pageOf(item.id) > 0) {
                        <span class="at-page">≈ {{ pageOf(item.id) }}</span>
                      }
                    </button>

                    <div class="quote" (click)="toggleOpen(item.id)">
                      @if (item.kind === 'strike') {
                        <p class="q-line" [class.struck]="!undoing">{{ shown(item.id, item.before) }}</p>
                      } @else {
                        <p class="q-line">
                          @for (part of partsOf(item.before, 'removed', item.id); track $index) {
                            <span [class.q-gone]="part.changed">{{ part.text }}</span>
                          }
                        </p>
                        <p class="q-line q-after" [class.undoing]="undoing">
                          <span class="arrow">→ </span>
                          @for (part of partsOf(item.after, 'added', item.id); track $index) {
                            <span [class.q-new]="part.changed">{{ part.text }}</span>
                          }
                        </p>
                      }
                      @if (moved !== undefined) {
                        <p class="moved">Left alone: {{ moved }}.</p>
                      }
                    </div>

                    @if (moved !== undefined) {
                      <span class="hit still"><span class="verdict gone">moved</span></span>
                    } @else {
                      <button class="hit" (click)="flip(item.id)">
                        <span class="verdict" [class.keep]="!undoing">{{ undoing ? 'UNDO' : 'KEEP' }}</span>
                      </button>
                    }
                  </div>
                }
              } @empty {
                <p class="none">The model marked nothing.</p>
              }
            </div>

            <footer class="foot">
              <span class="counts">
                <span class="keep-count">{{ keptCount() }} kept</span>
                <span class="cut-count">{{ chosen().length }} to undo</span>
              </span>
              <button class="ghost" [disabled]="undoable().length === 0" (click)="keepAll()">Keep all</button>
              <button class="ghost" [disabled]="undoable().length === 0" (click)="undoAll()">Undo all</button>
              <button class="primary" [disabled]="chosen().length === 0" (click)="undoSelected(book)">
                Undo selected ({{ chosen().length }})
              </button>
            </footer>
          }
        } @else {
          <div class="body empty"><p>Nothing has been asked of this book yet.</p></div>
          <footer class="foot">
            <span class="counts"></span>
            <button class="ghost" (click)="ui.closeAskReview()">Close</button>
          </footer>
        }
      } @else {
        <div class="body empty"><p>{{ shut() }}</p></div>
        <footer class="foot">
          <span class="counts"></span>
          <button class="ghost" (click)="ui.closeAskReview()">Close</button>
        </footer>
      }
    </div>
  `,
  styles: [`
    /* The sweep's card, kept: the host is inert and only its children are not. */
    :host {
      position: fixed; inset: 0; z-index: 1200; display: block; pointer-events: none;
      /* The chrome's two roles for a verdict: a removal in the refusal colour, a
         kept decision in the warning one (the sweep's own argument). */
      --ask-cut: var(--error);
      --ask-keep: var(--warn);
      --ask-new: var(--ok);
    }

    .scrim {
      pointer-events: auto;
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }

    .card {
      pointer-events: auto;
      position: relative;
      margin: 6vh auto 0;
      width: 860px;
      max-width: calc(100vw - 32px);
      max-height: 86vh;
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow:
        0 10px 15px -3px rgba(0, 0, 0, 0.2),
        0 20px 40px -10px rgba(0, 0, 0, 0.35);
      overflow: hidden;
      animation: rise 140ms cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes rise {
      from { opacity: 0; transform: scale(0.94); }
      to { opacity: 1; transform: scale(1); }
    }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .title { flex: 1; font-family: var(--font-display); font-weight: 600; font-size: 16px; }
    .x {
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 13px;
      padding: 3px 5px; border-radius: var(--radius-sm);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    .bar {
      display: flex; align-items: baseline; gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .asked {
      flex: 1; min-width: 0;
      font-size: 12px; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .tally { flex: 0 0 auto; font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

    .problem {
      margin: 0; padding: 10px 14px;
      font-size: 12px; color: var(--warn);
      border-bottom: 1px solid var(--border-subtle);
    }

    .list { flex: 1; overflow-y: auto; padding: 4px 0; }
    .none {
      margin: 0; padding: 28px 16px;
      text-align: center;
      font-size: 12px; color: var(--text-tertiary);
    }

    /* A reason's header row: the label, its count, and the group's own verdict. */
    .group {
      position: sticky; top: 0; z-index: 1;
      display: grid;
      grid-template-columns: 1fr auto 96px;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-default);
    }
    .reason { font-size: 12px; font-weight: 600; color: var(--text-primary); }
    .group-count { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

    .row {
      display: grid;
      grid-template-columns: 120px 1fr 62px;
      align-items: start;
      gap: 10px;
      padding: 7px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .row:hover { background: var(--bg-hover); }
    .row.open .q-line { color: var(--text-primary); }
    .row.ghost { opacity: 0.5; }

    .at {
      display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
      background: transparent; border: none; cursor: pointer;
      padding: 1px 3px; border-radius: var(--radius-sm);
      text-align: left;
    }
    .at:hover { background: var(--bg-active); }
    .at-id {
      font-family: var(--font-mono); font-size: 10px;
      color: var(--text-secondary);
      max-width: 112px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .at-page { font-size: 9px; color: var(--text-tertiary); }

    .quote { cursor: pointer; min-width: 0; }
    .q-line {
      margin: 0;
      font-size: 12px; line-height: 1.55;
      color: var(--text-secondary);
      overflow-wrap: anywhere;
    }
    /* A strike that stays is drawn struck, the way the paper draws it. */
    .q-line.struck {
      color: var(--ask-cut);
      text-decoration: line-through;
      text-decoration-thickness: 1px;
      opacity: 0.85;
    }
    .q-gone {
      background: color-mix(in srgb, var(--ask-cut) 20%, transparent);
      color: var(--ask-cut);
      text-decoration: line-through;
      text-decoration-thickness: 1px;
      border-radius: 2px;
    }
    .q-new {
      background: color-mix(in srgb, var(--ask-new) 22%, transparent);
      color: var(--text-primary);
      border-radius: 2px;
    }
    .q-after { margin-top: 2px; }
    /* A revision set to Undo: its after is what goes, so it wears the cancel. */
    .q-after.undoing { text-decoration: line-through; opacity: 0.6; }
    .arrow { color: var(--text-tertiary); }
    .moved { margin: 3px 0 0; font-size: 11px; color: var(--warn); }

    /* The whole cell is the button and the pill is its face (the sweep's ruling). */
    .hit {
      justify-self: stretch; align-self: stretch;
      display: flex; align-items: flex-start; justify-content: flex-end;
      margin: -7px -14px -7px -10px;
      padding: 7px 14px 7px 10px;
      background: transparent; border: none;
      cursor: pointer;
    }
    .group-hit { margin: -8px -14px -8px -10px; padding: 8px 14px 8px 10px; align-items: center; }
    .hit.still { cursor: default; }
    .hit:not(.still):hover .verdict { filter: brightness(1.15); }

    .verdict {
      display: inline-flex; align-items: center; justify-content: center;
      height: 22px; min-width: 52px; padding: 0 8px;
      border-radius: var(--radius-sm);
      border: 1px solid color-mix(in srgb, var(--ask-cut) 45%, transparent);
      background: color-mix(in srgb, var(--ask-cut) 12%, transparent);
      color: var(--ask-cut);
      font-size: 10px; font-weight: 600; letter-spacing: 0.06em; line-height: 1;
      white-space: nowrap;
    }
    .verdict.keep {
      border-color: color-mix(in srgb, var(--ask-keep) 45%, transparent);
      background: color-mix(in srgb, var(--ask-keep) 12%, transparent);
      color: var(--ask-keep);
    }
    .verdict.gone {
      border-color: var(--border-subtle);
      background: transparent;
      color: var(--text-tertiary);
      font-weight: 400; letter-spacing: 0;
    }

    .body { padding: 16px; color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
    .body p { margin: 0 0 8px; }
    .body.working { padding: 40px 16px; text-align: center; }
    .progress { font-family: var(--font-display); font-size: 15px; color: var(--text-primary); }
    .note { margin: 0; font-size: 11px; color: var(--text-tertiary); line-height: 1.5; }

    .foot {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px;
      border-top: 1px solid var(--border-subtle);
    }
    .counts { flex: 1; display: flex; gap: 12px; font-size: 11px; font-variant-numeric: tabular-nums; }
    .cut-count { color: var(--ask-cut); }
    .keep-count { color: var(--ask-keep); }

    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border-radius: var(--radius-md);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
    }
    .primary {
      border: none;
      background: var(--accent); color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
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

  /** The latest kept run for the book in front. */
  protected readonly session = computed(() => {
    const tab = this.stage.activeDocument();
    if (tab === null || tab.kind !== 'book') return null;
    return this.asks.latest().get(tab.path) ?? null;
  });

  protected readonly groups = computed(() => groupByReason(this.session()?.items ?? []));

  /** The rows as the sheet draws them, by id. */
  private readonly rows = computed<ReadonlyMap<string, ReplayedRow>>(() =>
    new Map((this.pane()?.view()?.rows ?? []).map((row) => [row.id, row])));

  /**
   * WHICH MARKS CAN NO LONGER BE TAKEN BACK, and why — `planUndo` asked about
   * every mark at once, so the faded rows and the undo's own skips are one rule.
   */
  protected readonly movedWhy = computed<ReadonlyMap<string, string>>(() => {
    const items = this.session()?.items ?? [];
    const states = new Map([...this.rows()].map(([id, row]) => [id, { text: row.text, struck: row.struck === true }]));
    const plan = planUndo(items, states, this.pane()?.translated() === true);
    return new Map(plan.skipped.map((skip) => [skip.item.id, skip.why]));
  });

  /** The marks a verdict can be passed on. */
  protected readonly undoable = computed<readonly AskMark[]>(() =>
    (this.session()?.items ?? []).filter((item) => !this.movedWhy().has(item.id)));

  /** The ids set to Undo. Empty is every row kept, which is the default. */
  private readonly undoing = signal<ReadonlySet<string>>(new Set());
  /** The rows somebody opened for the block's whole text. */
  protected readonly opened = signal<ReadonlySet<string>>(new Set());
  protected readonly working = signal(false);

  protected readonly chosen = computed<readonly AskMark[]>(() =>
    this.undoable().filter((item) => this.undoing().has(item.id)));
  protected readonly keptCount = computed(() => this.undoable().length - this.chosen().length);

  protected isUndoing(item: AskMark): boolean {
    return this.undoing().has(item.id) && !this.movedWhy().has(item.id);
  }

  protected undoingIn(items: readonly AskMark[]): number {
    return items.filter((item) => this.isUndoing(item)).length;
  }

  protected allUndone(items: readonly AskMark[]): boolean {
    const live = items.filter((item) => !this.movedWhy().has(item.id));
    return live.length > 0 && live.every((item) => this.undoing().has(item.id));
  }

  protected pageOf(id: string): number {
    return this.rows().get(id)?.page ?? 0;
  }

  /** A strike's quotation: clipped until the row is opened. */
  protected shown(id: string, text: string): string {
    return this.opened().has(id) || text.length <= CLIP ? text : `${text.slice(0, CLIP)}…`;
  }

  /**
   * One side of a revision, cut into runs so the changed words can be lit:
   * `removed` ranges of the before, `added` ranges of the after.
   */
  protected partsOf(text: string, side: ChangeRange['kind'], id: string): readonly { text: string; changed: boolean }[] {
    const item = this.session()?.items.find((one) => one.id === id);
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

  protected flip(id: string): void {
    this.undoing.update((held) => {
      const next = new Set(held);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected flipGroup(items: readonly AskMark[]): void {
    const undo = !this.allUndone(items);
    this.undoing.update((held) => {
      const next = new Set(held);
      for (const item of items) {
        if (this.movedWhy().has(item.id)) continue;
        if (undo) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  }

  protected keepAll(): void {
    this.undoing.set(new Set());
  }

  protected undoAll(): void {
    this.undoing.set(new Set(this.undoable().map((item) => item.id)));
  }

  protected toggleOpen(id: string): void {
    this.opened.update((held) => {
      const next = new Set(held);
      if (!next.delete(id)) next.add(id);
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
