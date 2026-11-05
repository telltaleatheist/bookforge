import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { HostOpField } from '@owen/foundry-core/shared/host-ops';

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
  templateUrl: './host-op-dialog.component.html',
  styleUrl: './host-op-dialog.component.scss',
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
