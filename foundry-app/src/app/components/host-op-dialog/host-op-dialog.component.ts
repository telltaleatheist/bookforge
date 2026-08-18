import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { HostOpField } from '@shared/host-ops';

import { HostOpsService } from '../../core/host-ops.service';
import { NoticeService } from '../../core/notice.service';
import { UiService } from '../../core/ui.service';

/**
 * ONE LINE OF THE DRAWN FORM — a slice of the host's fields and how wide to cut
 * them.
 *
 * Layout and nothing else: it carries no answer, no validation and no opinion
 * about what any field means, which is what makes it safe for an app that does
 * not know the domain to invent. Nothing outside the template sees it.
 */
interface HostOpRow {
  /** The row's identity for `track` — its first field's own key, which a form's
   *  keys being unique makes unique here too. */
  readonly key: string;
  /** Whether this row is the two-up grid rather than a single full-width field. */
  readonly two: boolean;
  readonly fields: HostOpField[];
}

/**
 * THE HOST'S OWN QUESTIONS, ASKED IN THIS WINDOW — a dialog Foundry draws for an
 * operation it knows nothing about.
 *
 * ── The ruling ──────────────────────────────────────────────────────────────
 *
 * *"Today `bookforge.narrate` raises the BookForge main window and opens its
 * modal there. Owen wants the dialog in the Foundry window, like
 * translate/simplify — and a narrate button on the nav rail besides."*
 * (BookForge → Foundry, 2026-08-18.) Pressing an act in the tree used to throw
 * the person out of the window they were working in and into another
 * application's modal, which is the seam showing through at exactly the moment
 * the whole socket exists to hide it.
 *
 * ── AND NOT ONE STRING IN THIS FILE KNOWS WHAT IT IS ASKING ─────────────────
 *
 * This is the constraint the component is built to, and it is worth stating
 * before anything else: NO SURFACE IN FOUNDRY SAYS "NARRATE". The title is the
 * offer's `label`, every field's words are the host's `label` and `help`, every
 * choice is the host's `options`, and the button says Start because that is the
 * one word true of any act. A host that registers an operation about something
 * else entirely — a proofread, a print run, a thing nobody has thought of —
 * gets a correct dialog out of this file without a line changing.
 *
 * The alternative was Foundry learning the domain: a narration dialog with a
 * voice picker and a device list, kept in step with a host's engine by hand,
 * across a vendored snapshot. That is two applications with one feature between
 * them, and it is the arrangement the socket was invented to avoid.
 *
 * ── FOUR CONTROLS, EXHAUSTIVELY ─────────────────────────────────────────────
 *
 * `select`, `number`, `toggle`, `text` (`HostOpField`). The union is closed so
 * that a fifth kind is a compile error rather than a field that draws as
 * nothing — the failure this codebase always prefers. What is deliberately
 * absent is conditional logic: no field appears because another was set, and
 * nothing here validates one answer against another. A host with a decision tree
 * has a domain, and a form rendered by an app without the domain would sooner or
 * later contradict itself; the escape hatch is the one that always existed — an
 * operation with no `form` opens the host's own window.
 *
 * ── The visual language is the translate dialog's ───────────────────────────
 *
 * Scrim, card, head, body, `.field`/`.label`, `.note`, `.problem`, foot with a
 * ghost and a primary — the same sheet, the same rhythm, the same two-up `.pair`
 * for fields that want half a line each. There is one dialog idiom in this app
 * and a second would be a second thing to learn; a person who has configured a
 * translation should recognise this as the same kind of question even though
 * nothing in it is Foundry's.
 *
 * WHAT IS ITS OWN IS THE LAYOUT OF A FORM NOBODY WROTE BY HAND. Translate's
 * fields are placed one by one by somebody who knows what each of them is; these
 * arrive as a list at runtime, so the placement has to be a RULE over the four
 * kinds instead — see `rows`, and the toggle's own line in the template. The
 * card is a little wider than translate's for the same reason: a form of unknown
 * length pays for the room, and a paired number row needs two halves that are
 * still wide enough to read.
 *
 * ── IT CLOSES ON START, AND THAT IS THE WHOLE OF THE PROGRESS STORY ────────
 *
 * *"Progress already flows back through setHostNodes, so the dialog can close on
 * Start and the tree shows the running step — no second progress UI needed."*
 * So there is no bar here, no log, and no queue tray anywhere in the window
 * (docs/PLAN.md §4, unit 9d: explicitly not wanted). Start hands the answers to
 * the host and the card goes; what happens next is a card in the tree, drawn
 * from the nodes the host pushes.
 *
 * A REFUSAL IS THE ONE THING THAT KEEPS IT OPEN. If the host throws before the
 * work is queued, the person is still looking at the settings they chose, and
 * taking the card away would mean re-answering every question to try again. The
 * sentence is the host's, verbatim, in the card's own `.problem` line.
 */
@Component({
  selector: 'app-host-op-dialog',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="ui.closeHostOp()"></div>

    <div class="card" role="dialog" aria-modal="true" [attr.aria-label]="title()">
      <header class="head">
        <span class="title">{{ title() }}</span>
        <button class="x" (click)="ui.closeHostOp()" title="Close">✕</button>
      </header>

      @if (fields(); as form) {
        <div class="body">
          <!--
            THE HOST'S FIELDS, IN THE HOST'S OWN ORDER. Nothing is sorted,
            grouped or renamed: the order a form is declared in is the order the
            person who wrote it meant it to be read in, and an app that does not
            understand the questions is in no position to rearrange them. The
            rows below are that same sequence with line breaks in it — see
            \`rows\`, which decides only where a line ends.
          -->
          @for (row of rows(); track row.key) {
            <div class="row" [class.two]="row.two">
              @for (field of row.fields; track field.key) {
                <div class="cell">
                  @if (field.kind === 'toggle') {
                    <!--
                      A YES-OR-NO READS ON ONE LINE, IN THE HOST'S OWN WORDS. The
                      other three kinds are a question with an answer box under
                      it, so their words go above as a small caps label; a
                      checkbox IS its answer, and the sentence beside it is what
                      the box means when it is ticked. Put above instead, the
                      label became a heading over an unlabelled square — and
                      because a checkbox will not fill a row, the row split.

                      The \`<label>\` spans the line so the words are the hit
                      target, which is the size a person actually aims at; the
                      box keeps its natural 16px against the global rule that
                      stretches every input to the full width.
                    -->
                    <label class="check">
                      <input
                        type="checkbox"
                        [ngModel]="answers()[field.key]"
                        (ngModelChange)="answer(field.key, $event)"
                        [name]="field.key">
                      <span>{{ field.label }}</span>
                    </label>
                  } @else {
                    <label class="field">
                      <span class="label">{{ field.label }}</span>

                      @switch (field.kind) {
                        @case ('select') {
                          <select
                            [ngModel]="answers()[field.key]"
                            (ngModelChange)="answer(field.key, $event)"
                            [name]="field.key"
                          >
                            @for (choice of field.options ?? []; track choice.value) {
                              <option [value]="choice.value">{{ choice.label }}</option>
                            }
                          </select>
                        }
                        @case ('number') {
                          <input
                            type="number"
                            [attr.min]="field.min"
                            [attr.max]="field.max"
                            [ngModel]="answers()[field.key]"
                            (ngModelChange)="answerNumber(field.key, $event)"
                            [name]="field.key">
                        }
                        @case ('text') {
                          <input
                            type="text"
                            [ngModel]="answers()[field.key]"
                            (ngModelChange)="answer(field.key, $event)"
                            [name]="field.key">
                        }
                      }
                    </label>
                  }
                  <!--
                    THE HOST'S OWN SENTENCE UNDER THE CONTROL, where this app
                    puts its own explanations. Drawn only when there is one — an
                    empty note is a row of space saying nothing — and inside the
                    cell, so that on a two-up row it stays under the half it
                    belongs to rather than under both.

                    OUTSIDE THE \`<label>\`, WHICH MATTERS FOR THE TOGGLE: a note
                    the label swallowed would flip the checkbox when somebody
                    clicked into the sentence explaining it.
                  -->
                  @if (field.help) {
                    <p class="note">{{ field.help }}</p>
                  }
                </div>
              }
            </div>
          }

          @if (form.length === 0) {
            <!--
              A FORM WITH NO FIELDS IS A HOST BUG, and this says so rather than
              drawing an empty card with a Start button. An operation with
              nothing to ask should declare no \`form\` at all and be invoked on
              the click (see \`HostOperationOffer.form\`) — so an empty array is
              the one shape that cannot have been meant.
            -->
            <p class="note">
              This act has no settings to choose. Starting it runs it as it is.
            </p>
          }

          @if (problem(); as reason) {
            <p class="problem">{{ reason }}</p>
          }
        </div>

        <footer class="foot">
          <button class="ghost" (click)="ui.closeHostOp()">Cancel</button>
          <!--
            THE HOST'S OWN WORD FOR WHAT PRESSING DOES, where it declared one.
            Owen: *"the button shouldnt say start if it isnt going to start, it
            should say add to queue"* — and only the host knows which of those
            its invoke will do (\`HostOperationOffer.submitLabel\`).

            THE DEFAULT IS STILL "START", AND STILL NOT THE ACT'S OWN NAME.
            "Narrate" is already the title of this card and the label of the
            button that opened it; a third copy on the primary would be the same
            word three times, and the fallback has to be true of an operation
            this app has never heard of.
          -->
          <button class="primary" [disabled]="busy()" (click)="start()">
            {{ busy() ? working() : submit() }}
          </button>
        </footer>
      } @else {
        <!--
          THE OPERATION IS NOT REGISTERED. Reachable only if a host re-registered
          between the button being drawn and this card opening, which is a state
          worth naming rather than a blank card: the id is the whole of what this
          window has, and an id nothing answers to cannot be run.
        -->
        <div class="body empty">
          <p>
            The app Foundry is running inside no longer offers this act. It may have been
            restarted since this window drew the button — close this and try again.
          </p>
        </div>
        <footer class="foot">
          <button class="ghost" (click)="ui.closeHostOp()">Close</button>
        </footer>
      }
    </div>
  `,
  styles: [`
    /* THE TRANSLATE DIALOG'S OWN SHEET, copied deliberately rather than shared:
       there is one dialog idiom in this app, and these are the numbers that make
       it. A component that pulled them from a common stylesheet would be a
       refactor of five working dialogs bundled into a unit about a socket. */
    :host { position: fixed; inset: 0; z-index: 1200; display: block; }

    .scrim {
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }

    .card {
      position: relative;
      margin: 8vh auto 0;
      /* Sixty pixels wider than the dialogs Foundry wrote itself, and the only
         number in this sheet that departs from them. Those forms are four or
         five fields somebody chose; this one is however many a host declared,
         and the extra width is what keeps a paired number row's two halves and
         a select full of voice names from reading as a column of stubs. */
      width: 520px;
      max-width: calc(100vw - 32px);
      max-height: 82vh;
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

    .body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .body.empty { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
    .body.empty p { margin: 0; }

    /* ONE LINE OF THE FORM. A grid rather than a flex row because the two-up
       case wants halves that stay halves whatever is in them: a select holding
       a long device name and a number holding "1.0" laid out by content would be
       two columns that moved every time a host changed a word. */
    .row { display: grid; grid-template-columns: 1fr; gap: 12px; }
    /* The translate dialog's .pair, under the name the chunking rule gives it.
       A row that holds ONE number still declares two columns, so a lone number
       is a compact box on the left rather than an input the width of a card with
       three characters in it — and it lines up with the paired rows above and
       below it. */
    .row.two { grid-template-columns: 1fr 1fr; }
    /* A control and the sentence explaining it are one thing, so they sit
       tighter than the body's own 14px rhythm — that gap between them would read
       as a break between two unrelated fields. */
    .cell { display: flex; flex-direction: column; gap: 5px; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }

    /* THE CHECKBOX AND ITS WORDS ON ONE LINE. The label fills the row so the
       whole line is clickable; flex:none on the box is what stops the global
       full-width rule on every input from stretching a tick into a bar. */
    .check {
      display: flex; align-items: center; gap: 8px;
      cursor: pointer; font-size: 13px; line-height: 1.4;
      color: var(--text-primary);
    }
    .check input { flex: none; width: 16px; height: 16px; padding: 0; cursor: pointer; }
    /* A toggle's note hangs off the words rather than off the box — 16px of
       checkbox and the 8px beside it — so the explanation starts where the thing
       it explains starts. */
    .check + .note { padding-left: 24px; }

    .note { margin: 0; font-size: 11px; color: var(--text-tertiary); line-height: 1.5; }
    .problem { margin: 0; font-size: 12px; color: var(--warn); }

    .foot {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 16px 16px;
      border-top: 1px solid var(--border-subtle);
    }
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
    .ghost:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:active { background: var(--bg-active); transform: scale(0.98); }
  `],
})
export class HostOpDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly hostOps = inject(HostOpsService);
  private readonly notices = inject(NoticeService);

  /** The host's refusal, when there has been one. Cleared by the next attempt. */
  protected readonly problem = signal<string | null>(null);
  /** True between Start and the host answering — the button says so and refuses twice. */
  protected readonly busy = signal(false);

  /**
   * THE ANSWERS SO FAR, keyed by each field's own `key`.
   *
   * A PLAIN RECORD IN A SIGNAL rather than one signal per field, because the
   * fields are not known until the dialog opens — they are the host's, and a
   * component cannot declare state for a shape it learns at runtime. Replaced
   * rather than mutated on every write, which is what makes the signal's
   * equality check mean anything.
   */
  protected readonly answers = signal<Record<string, unknown>>({});

  /** The offer this dialog is about, looked up by id against the registry. */
  private readonly offer = computed(() => {
    const request = this.ui.hostOpOpen();
    return request === null ? null : this.hostOps.offer(request.operationId);
  });

  /** The card's title: the act's own label, and nothing this app invented. */
  protected readonly title = computed(() => this.offer()?.label ?? 'This act');

  /**
   * What the submit button says at rest — the host's word, or Foundry's default.
   *
   * TRIMMED AND FALLING BACK ON EMPTY, because a host that declares an empty
   * string has declared nothing and a button with no words on it is worse than
   * one with the wrong word.
   */
  protected readonly submit = computed(() => {
    const declared = this.offer()?.submitLabel?.trim() ?? '';
    return declared.length > 0 ? declared : 'Start';
  });

  /**
   * And what it says while the host is answering.
   *
   * DERIVED FROM THE SAME WORD rather than declared separately: a host that says
   * "Add to queue" wants "Adding to queue…" while it waits, and asking it for
   * both would be asking it to conjugate its own verb for a dialog it cannot
   * see. The transformation is the crudest one that reads correctly for the
   * shapes a submit label actually takes ("Start", "Add to queue", "Narrate"),
   * and the ellipsis carries the rest of the meaning.
   */
  protected readonly working = computed(() => {
    const word = this.submit();
    const first = word.split(' ')[0] ?? word;
    const rest = word.slice(first.length);
    const ing = first.endsWith('e') && !first.endsWith('ee')
      ? `${first.slice(0, -1)}ing`
      : `${first}ing`;
    return `${ing}${rest}…`;
  });

  /** The fields to draw, or null for an operation the registry does not hold. */
  protected readonly fields = computed<readonly HostOpField[] | null>(() => {
    const offer = this.offer();
    return offer === null ? null : offer.form ?? [];
  });

  /**
   * THE FIELDS CUT INTO THE LINES THEY ARE DRAWN ON — the whole of this app's
   * opinion about laying out a form it did not write.
   *
   * ── The rule, which is about KINDS and never about names ────────────────────
   *
   * ADJACENT NUMBERS SHARE A LINE, two at a time. Everything else takes a line
   * of its own. That is the entire policy, and it is stated over `HostOpField.
   * kind` because kind is the only thing this app is entitled to know: a rule
   * that read a label or a key would be Foundry guessing at a domain, which is
   * the one thing the socket exists to prevent.
   *
   * It earns its place because a number is the one control that is nearly always
   * shorter than the box drawn for it. A speed, a temperature, a count — three or
   * four characters each, stacked one per line down a card, is a column of stubs
   * with an inch of white space beside every one of them. Selects and text boxes
   * hold names of unknown length and want the whole width; a toggle is a line of
   * prose. So the numbers pair and nothing else does.
   *
   * TWO PER ROW AND NOT THREE, because three narrow columns in a 520px card is
   * where the labels above them start wrapping — and a label that wraps is the
   * splitting this arrangement was written to stop.
   *
   * ── The order is never touched ─────────────────────────────────────────────
   *
   * Fields are taken in the sequence the host declared and only ever grouped with
   * the field they already follow. Nothing is gathered, sorted or hoisted: a form
   * whose numbers are scattered through it stays scattered, because the person
   * who wrote it put them where they read best and this app cannot know why.
   */
  protected readonly rows = computed<readonly HostOpRow[]>(() => {
    const form = this.fields();
    if (form === null) return [];
    const rows: HostOpRow[] = [];
    for (const field of form) {
      const open = rows.length === 0 ? null : rows[rows.length - 1];
      if (field.kind === 'number' && open !== null && open.two && open.fields.length < 2) {
        open.fields.push(field);
        continue;
      }
      rows.push({ key: field.key, two: field.kind === 'number', fields: [field] });
    }
    return rows;
  });

  constructor() {
    /*
     * SEED THE ANSWERS FROM THE DECLARED DEFAULTS, once per opening.
     *
     * ── Why a select needs this and the others could live without it ──────────
     *
     * A select with nothing chosen draws its first option and would send
     * `undefined` for it — the person sees "MP3" and the host is told nothing.
     * So a select with no `default` is seeded with its FIRST OPTION's value,
     * which is what the control is already showing: the answer and the drawing
     * agree from the first frame rather than from the first interaction.
     *
     * The other three seed from `default` where there is one and are otherwise
     * left absent, which is the quietest honest answer in each case — a blank
     * number, an empty text box, an off toggle.
     *
     * KEYED ON THE REQUEST so that opening the same operation from a different
     * row starts fresh. Nothing is remembered between invocations: the host
     * resolves its option lists at mount and a remembered voice could name one
     * that is no longer offered, which is a form that silently starts the wrong
     * run.
     */
    effect(() => {
      const request = this.ui.hostOpOpen();
      untracked(() => {
        this.problem.set(null);
        this.busy.set(false);
        if (request === null) {
          this.answers.set({});
          return;
        }
        const form = this.hostOps.offer(request.operationId)?.form ?? [];
        const seeded: Record<string, unknown> = {};
        for (const field of form) {
          if (field.default !== undefined) {
            seeded[field.key] = field.default;
            continue;
          }
          const first = field.options?.[0];
          if (field.kind === 'select' && first !== undefined) seeded[field.key] = first.value;
          if (field.kind === 'toggle') seeded[field.key] = false;
        }
        this.answers.set(seeded);
      });
    });
  }

  protected answer(key: string, value: unknown): void {
    this.answers.update((held) => ({ ...held, [key]: value }));
  }

  /**
   * A number field's write, with the one coercion this dialog performs.
   *
   * Angular's number input hands back a string on some paths and a number on
   * others; the host declared a `number` and is entitled to one. An unparseable
   * value is dropped rather than sent as `NaN` — a field somebody has emptied is
   * a question they have not answered, and the host's own default is a better
   * answer than a number that is not one.
   */
  protected answerNumber(key: string, value: unknown): void {
    const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    this.answers.update((held) => {
      const next = { ...held };
      if (String(value ?? '').trim().length === 0 || Number.isNaN(parsed)) delete next[key];
      else next[key] = parsed;
      return next;
    });
  }

  /**
   * Hand the answers to the host and get out of the way.
   *
   * THE CARD CLOSES ON SUCCESS AND STAYS ON A REFUSAL — see the class docblock.
   * The refusal is drawn HERE rather than on the window's notice strip, which is
   * the one place this departs from the tree's own invoke: the strip is right for
   * a button that has no card of its own, and wrong for a modal, because a
   * sentence behind a scrim is a sentence nobody reads.
   */
  protected async start(): Promise<void> {
    const request = this.ui.hostOpOpen();
    if (request === null || this.busy()) return;
    this.busy.set(true);
    this.problem.set(null);
    try {
      await this.hostOps.invoke(
        request.operationId, request.projectDir, request.nodeId, this.answers());
      this.ui.closeHostOp();
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      this.problem.set(said);
      /*
       * AND ON THE STRIP AS WELL, because the person may close the card on
       * reading it and the sentence is the only account anybody has of why the
       * work did not start. The strip is dismissed by hand, so it outlives the
       * dialog exactly as long as it is wanted.
       */
      this.notices.notice.set(said);
    } finally {
      this.busy.set(false);
    }
  }
}
