import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import type { ReplayedRow } from '@shared/ops';

import { BookStacksService, type BookStack } from '../../core/book-stacks.service';
import { NoticeService } from '../../core/notice.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import {
  BRACKETS, PARENTHESES, compile, opsFor, plan, scan, widen,
  type SweepEdit, type SweepMatch, type SweepPreset, type SweepQuote, type SweepVerdict,
} from '../../core/sweep';

/**
 * THE SWEEP — one pattern, every match it finds, a verdict on each, landed once.
 *
 * Wave 45, and the contract is docs/SWEEP.md. Owen's ask in his own words:
 * *"give me the ability to detect things in parentheses, light them up, and
 * strike them selectively… theres a lot of (see sandoval p. 170), etc. stuck in
 * this one book."*
 *
 * ── IT IS A FASTER HAND AND NOT A SECOND EDITOR ─────────────────────────────
 *
 * Every landing this card makes is a landing the double-click editor or the
 * Delete key could have made by hand, through the same doors: a span cut out of a
 * block is a `text` op carrying that block's whole source string with the span
 * sewn out, a block emptied by its matches is a `strike`, and both go onto the
 * viewer's own stack through `BookStack.push` in ONE variadic call — exactly as
 * the paper's own "strike every block of this kind" pushes its forty strikes. The
 * pending sidecar, the tray's waiting count, Apply, Discard and the guard card in
 * front of them all see what this leaves behind as what it is: ordinary pending
 * edits. Not one of them needed changing for this card to exist, and that is the
 * measure of whether it was built right.
 *
 * NO NEW OP VERB. A first-class "cut this range" op was drawn and cut: `text`
 * already says it, replays it, and every downstream consumer survives it
 * unchanged. Two spellings of one edit is this house's oldest defect.
 *
 * ── AND NO UNAPPLIED GUARD IN FRONT OF IT ───────────────────────────────────
 *
 * Export, Translate, Simplify and Metadata each ask `UnappliedService` about
 * waiting work before they open, because each consumes the ledger and would
 * otherwise run against a book missing the very edits the person is looking at.
 * This card consumes nothing and moves nothing: it stages MORE pending ops onto
 * the same viewer at the same position. Asking somebody to apply their edits
 * before making more edits of the same kind would be a card that has misread its
 * own act.
 *
 * ── THE VERDICTS ARE A SITTING, NOT A DOCUMENT ──────────────────────────────
 *
 * `verdicts` below lives for as long as this component is mounted and no longer.
 * Nothing about a sweep is written down until the landing verb is pressed, which
 * is also the whole of why undo takes the result back ONE OP AT A TIME rather
 * than in a gesture: the modal itself is the retreat. Nothing lands until the
 * verdicts have been seen, counted and pressed, and the canvas's *"one Undo takes
 * all of it back"* is amended out loud in §2.6 to match the stack this app has.
 */
@Component({
  selector: 'app-sweep-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="ui.closeSweep()"></div>

    <div class="card" role="dialog" aria-modal="true" aria-label="Sweep">
      <header class="head">
        <span class="title">Sweep</span>
        <button class="x" (click)="ui.closeSweep()" title="Close">✕</button>
      </header>

      @if (pane(); as book) {
        @if (landing()) {
          <!--
            THE TRANSLATED PASS, MID-FLIGHT. The list is deliberately not drawn
            here: each correction answers with the whole book, which moves the
            replay under the census, and a list re-sorting itself under somebody's
            pointer while fifty records are written is motion that says nothing.
            The count says everything there is to say.
          -->
          <div class="body working">
            <p class="progress">Cutting… {{ done() }} of {{ total() }} blocks</p>
            <p class="note">
              On a translated pass the words of a block are a record, not a change waiting to be
              applied — so each one is written on its own, in order.
            </p>
          </div>
        } @else {
          <div class="bar">
            <div class="chips">
              <button
                class="chip"
                [class.on]="preset() === 'parentheses'"
                title="Everything between round brackets — innermost pairs only"
                (click)="usePreset('parentheses')"
              >( parentheses )</button>
              <button
                class="chip"
                [class.on]="preset() === 'brackets'"
                title="Everything between square brackets — innermost pairs only"
                (click)="usePreset('brackets')"
              >[ brackets ]</button>
            </div>
            <input
              #box
              class="pattern"
              [class.on]="preset() === 'custom'"
              type="text"
              spellcheck="false"
              placeholder="your own pattern — &gt;\\d+&lt; finds a misread footnote number"
              aria-label="Your own pattern"
              [value]="custom()"
              (input)="typed(box.value)"
            >
            <label class="case" title="Off, a letter matches in either case">
              <input type="checkbox" [checked]="matchCase()" (change)="useCase(caseBox.checked)" #caseBox>
              <span>Match case</span>
            </label>
            <span class="tally">{{ tally() }}</span>
          </div>

          @if (refusal(); as reason) {
            <p class="problem">{{ reason }}</p>
          }

          <!--
            NOTHING HAPPENS ON HOVER IN THIS LIST — no tooltip, no floating
            glance (user ruling, 2026-09-07: "there shouldnt be a tool tip that
            pops up on hover in the sweep. i can see it already"). The fuller
            context is a CLICK on the quotation, which swaps the block's wider
            text into the row and swaps it back on the next click. The row
            grows when it is opened, which is the one case the 2026-08-24
            ruling about rows moving under the pointer does not cover: an
            opened row is a row somebody asked to grow.
          -->
          <div class="list">
            @for (found of matches(); track found.key) {
              <div class="row" [class.ghost]="found.struck" [class.open]="opened().has(found.key)">
                <button class="at" (click)="travel(book, found.id)">
                  <span class="at-id">{{ found.id }}</span>
                  @if (found.page > 0) {
                    <span class="at-page">≈ {{ found.page }}</span>
                  }
                </button>

                @let quote = quoteFor(found);
                @let verdict = verdictOf(found);
                <p
                  class="quote"
                  [class.block]="verdict === 'block'"
                  (click)="toggleContext(found.key)"
                >
                  <span class="q-before">{{ quote.before }}</span><span
                    class="q-hit"
                    [class.cut]="verdict === 'cut' || verdict === 'block'"
                  >{{ quote.hit }}</span><span class="q-after">{{ quote.after }}</span>
                </p>

                @if (found.struck) {
                  <span class="hit still"><span class="verdict gone">gone</span></span>
                } @else {
                  <!--
                    THE WHOLE CELL IS THE BUTTON AND THE PILL IS ITS FACE — Owen,
                    2026-09-07: "if i click anywhere near the cut/keep button it
                    should register as a click. the button is small and hard to
                    click, but i like it visually." The pill keeps its 22px; the
                    press it answers to is the row's full height and the column
                    out to the card's edge.
                  -->
                  <button class="hit" (click)="flip(found.key)">
                    <span
                      class="verdict"
                      [class.keep]="verdict === 'keep'"
                      [class.block]="verdict === 'block'"
                    >{{ verdict === 'keep' ? 'KEEP' : verdict === 'block' ? 'BLOCK' : 'CUT' }}</span>
                  </button>
                }
              </div>
            } @empty {
              <p class="none">{{ empty() }}</p>
            }
          </div>

          <footer class="foot">
            <span class="counts">
              <span class="cut-count">{{ cutting().length }} cut</span>
              @if (strikingBlocks().size > 0) {
                <span class="block-count">{{ saidBlocks(strikingBlocks().size) }} struck</span>
              }
              <span class="keep-count">{{ keeping() }} kept</span>
            </span>
            <button class="ghost" [disabled]="live().length === 0" (click)="keepAll()">Keep all</button>
            <button class="ghost" [disabled]="live().length === 0" (click)="cutAll()">Cut all</button>
            <button class="ghost" [disabled]="live().length === 0" (click)="strikeAll()">Strike all blocks</button>
            <button
              class="primary"
              [disabled]="cutting().length === 0 && strikingBlocks().size === 0"
              [title]="landingTitle()"
              (click)="land()"
            >{{ landingLabel() }}</button>
          </footer>
        }
      } @else {
        <div class="body empty"><p>{{ shut() }}</p></div>
        <footer class="foot">
          <button class="ghost" (click)="ui.closeSweep()">Close</button>
        </footer>
      }
    </div>
  `,
  styles: [`
    /*
     * THE HOST IS INERT AND ONLY ITS CHILDREN ARE NOT -- confirm-dialog's rule,
     * kept verbatim across every card in this app. 1200 is the dialog layer; the
     * confirmation keeps 1300 so the guard can still draw over this.
     */
    :host {
      position: fixed; inset: 0; z-index: 1200; display: block; pointer-events: none;

      /*
        THE TWO INKS OF A VERDICT, TRANSLATED INTO THE CHROME'S PALETTE.
        §2.4 asks for "the same red the workbench strikes with" and "the amber
        flag", and the workbench's marks are declared on the BOOK VIEWER's own
        host (--ink-strike, --ink-flag, RENDERER-DESIGN.md §1): they are the
        paper's colours, mixed for a cream sheet, and they exist nowhere outside
        that component. This card is chrome — dark, elevated, a sibling of the
        export dialog — so copying #a23b2a in here would put a paper red on a
        charcoal background at about two to one, which is a strike nobody can
        read. What carries across a surface change is the ROLE, and the shell
        already names both roles: a refusal and a warning. Named as two tokens so
        the four rules that draw a verdict cannot come to disagree about them.
      */
      --sweep-cut: var(--error);
      --sweep-keep: var(--warn);
    }

    .scrim {
      pointer-events: auto;
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }

    /*
      WIDER AND TALLER THAN ITS NEIGHBOURS, and for a reason the neighbours do not
      have: they are FORMS -- six fields and a Save -- and this is a LIST somebody
      reads through. Every other card in this app is 460px because that is a
      comfortable measure for labelled inputs; a census of a hundred and forty
      quoted sentences at that width is a column of three-line rows nobody can
      scan. 860 gives a quotation a real measure with the block name and the
      verdict on either side of it, and 86vh gives the list the height that makes
      scrolling it worth doing.
    */
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
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    /* ── The sweep bar: what is being looked for, and how much of it there is ── */
    .bar {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .chips { display: flex; gap: 6px; flex: 0 0 auto; }
    .chip {
      height: 28px; padding: 0 10px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-default);
      background: var(--bg-input);
      color: var(--text-secondary);
      font-family: var(--font-mono); font-size: 11px; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .chip:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .chip.on {
      background: var(--accent); border-color: var(--accent);
      color: var(--text-inverse);
    }

    .pattern {
      flex: 1; min-width: 0;
      height: 28px; padding: 0 8px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-default);
      background: var(--bg-input);
      color: var(--text-primary);
      font-family: var(--font-mono); font-size: 11px;
    }
    .pattern.on { border-color: var(--accent); }

    .case {
      display: inline-flex; align-items: center; gap: 5px;
      flex: 0 0 auto;
      font-size: 11px; color: var(--text-tertiary);
      cursor: pointer;
      user-select: none;
    }

    .tally {
      flex: 0 0 auto;
      font-size: 11px; color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }

    .problem {
      margin: 0; padding: 10px 14px;
      font-size: 12px; color: var(--warn);
      border-bottom: 1px solid var(--border-subtle);
    }

    /* ── The census ─────────────────────────────────────────────────────────── */
    .list { flex: 1; overflow-y: auto; padding: 4px 0; }
    .none {
      margin: 0; padding: 28px 16px;
      text-align: center;
      font-size: 12px; color: var(--text-tertiary);
    }

    .row {
      display: grid;
      grid-template-columns: 120px 1fr 62px;
      align-items: start;
      gap: 10px;
      padding: 7px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .row:hover { background: var(--bg-hover); }
    /* An opened row is one somebody asked to grow — the quotation is the
       block's wider text until the next click puts the sentence back. */
    .row.open .quote { color: var(--text-primary); }
    /* A struck block's matches are listed and take no verdict: seeing that the
       ones you already cancelled are gone is half of trusting the count. */
    .row.ghost { opacity: 0.45; }

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

    .quote {
      margin: 0;
      font-size: 12px; line-height: 1.55;
      color: var(--text-secondary);
      cursor: pointer;
    }
    .q-before, .q-after { color: var(--text-tertiary); }
    /* A BLOCK VERDICT STRIKES THE WHOLE QUOTATION, not the span: what the row
       shows cancelled is what the landed op cancels (§2.4), and the op is the
       paragraph. */
    .quote.block .q-before, .quote.block .q-after {
      color: var(--sweep-cut);
      text-decoration: line-through;
      text-decoration-thickness: 1px;
      opacity: 0.8;
    }

    /*
      THE PREVIEW NEVER LIES (§2.4). The span wears the proofreader's cancel while
      its verdict is CUT -- the same red the workbench strikes with, struck through
      exactly as the paper would draw it -- and the amber flag while it is kept.
      What the row shows cut is character for character what the landed op removes.
    */
    .q-hit {
      border-radius: 2px;
      padding: 0 1px;
      background: color-mix(in srgb, var(--sweep-keep) 22%, transparent);
      color: var(--text-primary);
    }
    .q-hit.cut {
      background: color-mix(in srgb, var(--sweep-cut) 20%, transparent);
      color: var(--sweep-cut);
      text-decoration: line-through;
      text-decoration-thickness: 1px;
    }

    /* A ghosted row's span wears NEITHER ink. The two inks are verdicts and this
       match has none to give — an amber one would read as "kept", which is a
       decision nobody made about a block that is already cancelled. */
    .row.ghost .q-hit {
      background: var(--bg-active);
      color: var(--text-secondary);
      text-decoration: none;
    }

    /*
      THE HIT CELL — the third column, stretched to the row's own edges. The
      negative margins pull it out over the row's padding and the grid gap, so
      a press anywhere from the quotation's right edge to the card's border,
      top of the row to bottom, lands on the verdict. The pill inside is the
      face and keeps its size; nothing about how the verdict LOOKS changed.
    */
    .hit {
      justify-self: stretch; align-self: stretch;
      display: flex; align-items: flex-start; justify-content: flex-end;
      margin: -7px -14px -7px -10px;
      padding: 7px 14px 7px 10px;
      background: transparent; border: none;
      cursor: pointer;
    }
    .hit.still { cursor: default; }
    .hit:not(.still):hover .verdict { filter: brightness(1.15); }

    .verdict {
      display: inline-flex; align-items: center; justify-content: center;
      height: 22px; min-width: 52px; padding: 0 8px;
      border-radius: var(--radius-sm);
      border: 1px solid color-mix(in srgb, var(--sweep-cut) 45%, transparent);
      background: color-mix(in srgb, var(--sweep-cut) 12%, transparent);
      color: var(--sweep-cut);
      font-size: 10px; font-weight: 600; letter-spacing: 0.06em; line-height: 1;
    }
    .verdict.keep {
      border-color: color-mix(in srgb, var(--sweep-keep) 45%, transparent);
      background: color-mix(in srgb, var(--sweep-keep) 12%, transparent);
      color: var(--sweep-keep);
    }
    /* The whole block goes: the pill fills in, because a filled red pill reads
       as "more than the span" at a glance, which is exactly the difference. */
    .verdict.block {
      border-color: transparent;
      background: color-mix(in srgb, var(--sweep-cut) 85%, transparent);
      color: var(--text-inverse);
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
    .cut-count, .block-count { color: var(--sweep-cut); }
    .keep-count { color: var(--sweep-keep); }

    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border-radius: var(--radius-md);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  transform 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .primary {
      border: none;
      background: var(--accent); color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:active:not(:disabled) { background: var(--accent-active); transform: scale(0.98); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:active:not(:disabled) { background: var(--bg-active); transform: scale(0.98); }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class SweepDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly stage = inject(StageService);
  private readonly stacks = inject(BookStacksService);
  private readonly notices = inject(NoticeService);

  /**
   * The book pane this sitting is about, or null with a sentence beside it.
   *
   * IT IS THE SAME DOOR THE PANELS TAKE (`BookStacksService.bookStackFor`), which
   * is the whole of why this card holds no copy of the book: the rows it counts
   * matches in are the very array the sheet is drawing, so the census and the
   * paper cannot come to different conclusions about what this book says.
   *
   * A VIEW-ONLY TAB IS SHUT OUT HERE rather than at the push. An export view has
   * no position, no stack and nothing to be a delta against, and the viewer's own
   * `push` refuses one with a sentence — but by then this card would have closed
   * and raised a toast saying it had cut a hundred and forty spans, which is the
   * one thing user copy in this app may never do.
   */
  protected readonly pane = computed<BookStack | null>(() => {
    const tab = this.stage.activeDocument();
    if (tab === null || tab.kind !== 'book' || tab.viewOnly === true) return null;
    return this.stacks.bookStackFor(tab.id);
  });

  /** Why there is nothing to sweep — read only where `pane()` is null. */
  protected readonly shut = computed<string>(() => {
    const tab = this.stage.activeDocument();
    if (tab === null || tab.kind !== 'book') {
      return 'The sweep works on the book in front of you, and there is no book in front of you. '
        + 'Open one from its step in the tree and try again.';
    }
    if (tab.viewOnly === true) {
      return 'This tab shows a finished export, which has no changes waiting on it. To sweep the '
        + 'book, open it from its step in the tree.';
    }
    return 'This book is still opening.';
  });

  /** The rows as the sheet is drawing them — the chain and the pending stack replayed in. */
  private readonly rows = computed<readonly ReplayedRow[]>(() => this.pane()?.view()?.rows ?? NO_ROWS);

  /** Which of the three patterns is standing. Exactly one, always (§2.2). */
  protected readonly preset = signal<SweepPreset>('parentheses');
  /** What is in the free field, whether or not the field is the one in force. */
  protected readonly custom = signal('');
  /**
   * OFF BY DEFAULT, which is a decision about what a person is doing here. The two
   * presets contain no letters at all, so the toggle is about the free field —
   * where the ordinary sweep is a phrase somebody half-remembers seeing in the
   * book, not a token they can spell the case of.
   */
  protected readonly matchCase = signal(false);

  /**
   * THE VERDICTS THAT ARE NOT THE DEFAULT ONE — and the emptiness of it is the
   * default posture.
   *
   * §2.3: every fresh scan starts with every match CUT, which is Owen's first
   * workflow (*"i can strike all and then selectively unstrike"*). Holding only
   * the verdicts that DEPART from cut makes that posture the empty map, so
   * "reset the verdicts" and "start again from all-cut" are one operation and
   * cannot drift apart. `Cut all` is this map emptied; `Keep all` and `Strike
   * all blocks` are every live match in it under one word.
   *
   * THREE WORDS SINCE 2026-09-07 (§7): *"the sweep — it should give me the
   * choice of deleting the whole block or just the text."* `block` strikes the
   * paragraph the match sits in; a block with one `block` verdict anywhere in
   * it is struck whole whatever its other matches say (`plan`, core/sweep.ts).
   */
  protected readonly verdicts = signal<ReadonlyMap<string, SweepVerdict>>(new Map());

  /**
   * THE ROWS SOMEBODY OPENED for the block's wider text (§7). A click on the
   * quotation, not a hover: the hover glance was a tooltip over a list a
   * person is trying to read, and Owen asked for it gone. Reset with the
   * verdicts, on their reason — the rows are new.
   */
  protected readonly opened = signal<ReadonlySet<string>>(new Set());

  /** The translated pass's serial run: how many blocks are written, and of how many. */
  protected readonly landing = signal(false);
  protected readonly done = signal(0);
  protected readonly total = signal(0);

  /** The pattern in force, as source. */
  private readonly pattern = computed<string>(() => {
    const which = this.preset();
    if (which === 'parentheses') return PARENTHESES;
    if (which === 'brackets') return BRACKETS;
    return this.custom();
  });

  /**
   * THE CENSUS — every match in the book, or the sentence saying why there is none.
   *
   * A computed over the pane's own replay, so a strike made on the paper behind
   * this card while it is open is a strike this list has already noticed. It costs
   * a walk of the book per pattern change and nothing at all per verdict, which is
   * the right way round: verdicts are what somebody clicks a hundred times.
   */
  private readonly census = computed<{ ok: true; matches: readonly SweepMatch[] }
    | { ok: false; reason: string }>(() => {
    const pane = this.pane();
    if (pane === null) return NOTHING;
    const book = pane.view();
    if (book === null) return NOTHING;
    const source = this.pattern();
    if (source.length === 0) return NOTHING;
    const compiled = compile(source, this.matchCase());
    if (!compiled.ok) return compiled;
    return scan(book.rows, compiled.re);
  });

  /** The sentence under the field, or null while the pattern is one the app can read. */
  protected readonly refusal = computed<string | null>(() => {
    const answer = this.census();
    return answer.ok ? null : answer.reason;
  });

  protected readonly matches = computed<readonly SweepMatch[]>(() => {
    const answer = this.census();
    return answer.ok ? answer.matches : NO_MATCHES;
  });

  /** The matches a verdict can be passed on: everything not already struck (§2.1). */
  protected readonly live = computed<readonly SweepMatch[]>(
    () => this.matches().filter((found) => !found.struck));

  /** The blocks the landing verb would strike whole — any live match in them said so. */
  protected readonly strikingBlocks = computed<ReadonlySet<string>>(() => {
    const said = this.verdicts();
    const out = new Set<string>();
    for (const found of this.live()) {
      if (said.get(found.key) === 'block') out.add(found.id);
    }
    return out;
  });

  /**
   * What the landing verb would actually cut as SPANS — the cut verdicts outside
   * the blocks that are going whole. A span in a struck block is not cut and is
   * not counted: the paragraph is one op and the number on the button must be
   * the number of things that op family takes out.
   */
  protected readonly cutting = computed<readonly SweepMatch[]>(() => {
    const said = this.verdicts();
    const whole = this.strikingBlocks();
    return this.live().filter((found) => (said.get(found.key) ?? 'cut') === 'cut' && !whole.has(found.id));
  });

  protected readonly keeping = computed<number>(() => {
    const said = this.verdicts();
    return this.live().filter((found) => said.get(found.key) === 'keep').length;
  });

  /** The bar's live count, including the ghosts said separately because they decide nothing. */
  protected readonly tally = computed<string>(() => {
    const live = this.live().length;
    const ghosts = this.matches().length - live;
    const said = `${live} ${live === 1 ? 'match' : 'matches'}`;
    return ghosts === 0 ? said : `${said} · ${ghosts} in struck blocks`;
  });

  /** What an empty list means, which is not always the same thing. */
  protected readonly empty = computed<string>(() => {
    if (this.refusal() !== null) return 'Nothing was searched for.';
    if (this.pattern().length === 0) {
      return 'Pick a pair of brackets above, or type a pattern of your own.';
    }
    return 'Nothing in this book matches that pattern.';
  });

  /**
   * The quotation a row draws: its sentence, or the block's wider text while
   * the row is opened. `widen` walks the rows for the one block, per opened
   * row per repaint, which is a few finds against a list somebody is reading
   * and not a map held for thousands of rows nobody opened.
   */
  protected quoteFor(found: SweepMatch): SweepQuote {
    if (!this.opened().has(found.key)) return found.quote;
    return widen(this.rows(), found) ?? found.quote;
  }

  /** The verdict a row wears — `gone` is the ghost's, and it is not a verdict. */
  protected verdictOf(found: SweepMatch): SweepVerdict | 'gone' {
    if (found.struck) return 'gone';
    return this.verdicts().get(found.key) ?? 'cut';
  }

  protected readonly saidBlocks = saidBlocks;

  /** What the primary button says — its numbers, in the order the landing takes them. */
  protected landingLabel(): string {
    const spans = this.cutting().length;
    const whole = this.strikingBlocks().size;
    if (whole === 0) return `Cut ${spans}`;
    if (spans === 0) return `Strike ${saidBlocks(whole)}`;
    return `Cut ${spans}, strike ${saidBlocks(whole)}`;
  }

  protected landingTitle(): string {
    const whole = this.strikingBlocks().size;
    const blocks = new Set(this.cutting().map((found) => found.id)).size;
    const spans = blocks === 0 ? '' : `cut the chosen spans out of ${saidBlocks(blocks)}`;
    const strikes = whole === 0 ? '' : `strike ${saidBlocks(whole)} whole`;
    const does = [spans, strikes].filter((one) => one.length > 0).join(' and ');
    const said = does.charAt(0).toUpperCase() + does.slice(1);
    return this.pane()?.translated() === true
      ? `${said} — the spans are recorded as corrections, the strikes wait with your other edits`
      : `${said}, and put the changes with your other edits`;
  }

  // ── The pattern, and the verdicts ────────────────────────────────────────
  //
  // Every one of these resets the verdicts, and §2.2 is the reason rather than
  // caution: a verdict belongs to a MATCH, the matches are new, and carrying a
  // decision across a re-scan would be carrying it onto a span somebody has never
  // seen. The case toggle is in this list for exactly that reason — it changes
  // which spans exist as surely as retyping the pattern does.

  private resetSitting(): void {
    this.verdicts.set(NO_VERDICTS);
    this.opened.set(NONE_OPEN);
  }

  protected usePreset(which: SweepPreset): void {
    this.preset.set(which);
    this.resetSitting();
  }

  protected typed(said: string): void {
    this.custom.set(said);
    this.preset.set('custom');
    this.resetSitting();
  }

  protected useCase(on: boolean): void {
    this.matchCase.set(on);
    this.resetSitting();
  }

  /**
   * ONE PRESS, THE NEXT WORD: cut → keep → block → cut.
   *
   * KEEP COMES FIRST because it is the press Owen's first workflow makes a
   * hundred times — strike all, then spare the ones that matter — and that
   * press must stay one press. The whole-block verdict is the second press,
   * which is the rarer decision and the one worth a beat more.
   */
  protected flip(key: string): void {
    this.verdicts.update((said) => {
      const next = new Map(said);
      const now = next.get(key) ?? 'cut';
      if (now === 'cut') next.set(key, 'keep');
      else if (now === 'keep') next.set(key, 'block');
      else next.delete(key);
      return next;
    });
  }

  /** The quotation, clicked: the block's wider text in, or back out. */
  protected toggleContext(key: string): void {
    this.opened.update((held) => {
      const next = new Set(held);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  private sayAll(word: SweepVerdict): void {
    if (word === 'cut') {
      this.verdicts.set(NO_VERDICTS);
      return;
    }
    this.verdicts.set(new Map(this.live().map((found) => [found.key, word] as const)));
  }

  protected keepAll(): void {
    this.sayAll('keep');
  }

  protected cutAll(): void {
    this.sayAll('cut');
  }

  protected strikeAll(): void {
    this.sayAll('block');
  }

  /**
   * A ROW TRAVELS — the peek card's own gesture, pulse and all.
   *
   * The card closes on the way, because the point of the trip is to look at the
   * paragraph on the paper and a modal over it would be the one thing in the way.
   * The verdicts go with it: the sweep is a sitting, not a document (§3), and
   * saying so plainly is better than a card that remembers half of one.
   */
  protected travel(pane: BookStack, id: string): void {
    this.ui.closeSweep();
    pane.reveal(id);
  }

  // ── The landing ─────────────────────────────────────────────────────────

  /**
   * THE WHOLE SITTING, LANDED — one gesture, and the count was on the button.
   *
   * The plan is built from the rows THIS INSTANT, not from the rows the scan
   * walked: a strike made on the paper behind the card, or a correction this very
   * run has already written, moves the replay, and an op composed against a stale
   * string would put back text somebody had taken out.
   */
  protected async land(): Promise<void> {
    const pane = this.pane();
    if (pane === null) return;
    const book = pane.view();
    if (book === null) return;
    const chosen = this.cutting();
    const whole = this.strikingBlocks();
    if (chosen.length === 0 && whole.size === 0) return;
    const edits = plan(book.rows, chosen, whole);
    if (edits.length === 0) return;
    if (pane.translated()) {
      await this.record(pane, edits);
      return;
    }
    pane.push(opsFor(edits));
    this.ui.closeSweep();
    const said: string[] = [];
    if (chosen.length > 0) {
      said.push(`Cut ${chosen.length} across ${saidBlocks(edits.length - whole.size)}`);
    }
    if (whole.size > 0) said.push(`struck ${saidBlocks(whole.size)} whole`);
    this.notices.notice.set(`${said.join(', ')} — waiting with your other edits.`);
  }

  /**
   * THE TRANSLATED PASS: the spans are corrections, the emptied blocks are ops.
   *
   * ── Why the halves part company here and nowhere else ───────────────────────
   *
   * *"Translated edits are per-language record corrections"* (docs/RENDERER.md
   * §5). The words of a translated block belong to the records file — the
   * translate step's own payload, and the truth every derived book of it is a pure
   * function of — so a `text` op would put this sentence in the ops chain while
   * the records still held the machine's, and the next materialisation would
   * answer with the machine's. A STRIKE is not about words: it is about the book's
   * structure, a translation has the structure of the book it came from, and it
   * stays an ordinary pending op on both passes.
   *
   * SERIAL, ONE ROUND TRIP AT A TIME, because that is the correction door's own
   * rule: two in flight are two whole-file rewrites of one records file racing,
   * and the loser's paragraph is gone with nothing anywhere saying so. Fifty
   * blocks is fifty round trips of a moment each and the count says where it is.
   *
   * A REFUSAL DOES NOT STOP THE RUN AND IS NOT SWALLOWED. Main's own sentence for
   * each one is already on the notices by the time this sees the false; what this
   * adds is the arithmetic, because forty-nine corrections and one refusal must
   * not be reported as fifty.
   *
   * THE STRIKES GO LAST, after the risky half is over, so that a run that meets
   * trouble has not already put ops on the stack for blocks whose siblings never
   * landed.
   */
  private async record(pane: BookStack, edits: readonly SweepEdit[]): Promise<void> {
    const words: { id: string; text: string }[] = [];
    const strikes: SweepEdit[] = [];
    for (const edit of edits) {
      if (edit.text === null) strikes.push(edit);
      else words.push({ id: edit.id, text: edit.text });
    }

    this.landing.set(true);
    this.total.set(words.length);
    this.done.set(0);
    let refused = 0;
    for (const one of words) {
      const landed = await pane.correct(one.id, one.text);
      if (!landed) refused += 1;
      this.done.update((count) => count + 1);
    }
    this.landing.set(false);

    if (strikes.length > 0) pane.push(opsFor(strikes));
    this.ui.closeSweep();

    const corrected = words.length - refused;
    const said: string[] = [];
    if (corrected > 0) {
      said.push(`Corrected ${saidBlocks(corrected)} — the spans are cut and recorded in this `
        + 'translation.');
    }
    if (strikes.length > 0) {
      said.push(`${saidBlocks(strikes.length)} — struck whole, or emptied of everything but the `
        + `matches — ${strikes.length === 1 ? 'is' : 'are'} struck and waiting with your other edits.`);
    }
    if (refused > 0) {
      said.push(`${saidBlocks(refused)} would not take the correction, and each one said why.`);
    }
    this.notices.notice.set(said.join(' '));
  }
}

/** "58 blocks", "1 block" — the one place the plural is decided. */
function saidBlocks(many: number): string {
  return `${many} ${many === 1 ? 'block' : 'blocks'}`;
}

const NO_ROWS: readonly ReplayedRow[] = [];
const NO_MATCHES: readonly SweepMatch[] = [];
const NO_VERDICTS: ReadonlyMap<string, SweepVerdict> = new Map();
const NONE_OPEN: ReadonlySet<string> = new Set();
/** No pane, no book, no pattern — three ways of having nothing to count. */
const NOTHING = { ok: true, matches: NO_MATCHES } as const;
