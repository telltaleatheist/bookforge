/**
 * run-target — which engine this act will run on, and what will run it.
 *
 * ── THE ONE CHOICE, AND THE THING THAT IS NOT A CHOICE ────────────────────
 *
 * Owen, 2026-09-17, on opening OCR and meeting a dialog written before Crucible
 * existed: *"we need to fix all modals to use the chosen crucible server. let
 * the user pick which crucible server to use in the modal."* And on how to draw
 * it: *"if there's only one model, it just lists the model itll use. it doesnt
 * ask the user to pick from a one-item list … if an option is impossible to
 * click, like 'en', or it's already chosen or something, dont present it as an
 * option. it isnt an option. present it as information or dont present it at
 * all."*
 *
 * So this component draws exactly two things and knows the difference between
 * them:
 *
 *   * **THE SERVER IS A CHOICE** — but only when there is more than one, and
 *     only then is it drawn as something to press. `Job.waitFor` has always been
 *     the per-job slot pin, so choosing here is a field on the request the queue
 *     already honours rather than new machinery.
 *   * **THE MODEL IS INFORMATION HERE, FOR A PAGE READ.** It was going to be
 *     buttons, and on 2026-09-17 it was not, because there was no per-run model
 *     in the contract: buttons would have had to write the ENGINE's class
 *     setting. Owen then: *"if theres no per-model override then scrap it."*
 *
 * ── AND FOR THE FOUR TEXT JOBS IT IS A CHOICE NOW (Owen, 2026-10-25) ──────
 *
 * *"put the option the user can pick in a dropdown on the modal that configures
 * the job"*; *"cloud accounts should be listed as an option in every model
 * dropdown if its available, just like 27b or 9b or anything else. however,
 * bookforge should use the last used model as the default. the ideal is that the
 * user wont need to use cloud models because theyre expensive. but it should be
 * there if their system is too weak to run a local model"*; *"keep it at 27b as
 * the max right now"*.
 *
 * There IS a per-run model now — `chosenModel` on the request — and a clean, a
 * translation, a simplify and an analysis no longer read the server's class row
 * at all (crucible-dispatch.ts sizes them, or takes the choice). So for those
 * four acts this component says nothing about the model and does not gate on
 * the class row: the dropdown beside it (job-model.component.ts) is where the
 * model is chosen and said, and a "Runs on" line here would name the row the
 * placement no longer reads. A control that cannot change anything is still not
 * a control — which is why the dropdown arrived with the contract field, not
 * before it.
 *
 * ── AND WHEN THE ACT CANNOT RUN AT ALL, IT SAYS SO HERE ──────────────────
 *
 * The engine's own sentence, not one composed here: a host-mode Crucible with no
 * WSL2 says it cannot serve the class, and a Mac says `dots-ocr` declares no
 * `mlx-darwin` build. {@link ready} carries that verdict out to the dialog so the
 * Start button is off rather than offering a press that ends in a refusal.
 */
import {
  ChangeDetectionStrategy, Component, computed, effect, input, model, output, signal,
} from '@angular/core';

import type { CapabilityRecord } from '@owen/foundry-core/shared/engine-settings';
import { defaultEngineServer } from '@owen/foundry-core/shared/engine-settings';
import type { CrucibleServerView } from '@owen/foundry-core/shared/slots';
import type { ModelClass } from '@owen/foundry-core/shared/types';

/**
 * WHAT EACH ACT IS CALLED when telling somebody a machine cannot do it.
 *
 * Deliberately not `actWords` (core/crucible-words.ts), whose phrasings are
 * NOUNS for a settings row — "Read the pages of a scan", "Analyse claims". These
 * are verb phrases that have to finish the sentence *"X cannot …"*, and a table
 * that tried to serve both would serve one of them badly.
 */
const ACT_WORDS: Readonly<Record<string, string>> = {
  pages: 'read pages',
  decide: 'judge which blocks need cleaning',
  clean: 'clean up text',
  translate: 'translate',
  simplify: 'simplify',
  analysis: 'analyse',
};

/**
 * THE ACTS WHOSE MODEL IS CHOSEN IN THE DIALOG (Owen, 2026-10-25) — the four
 * `JobModelKind`s. Their placement reads no class row, so neither does this
 * component's gate or sentence; see the header.
 */
const DIALOG_CHOSEN: ReadonlySet<string> = new Set(['clean', 'translate', 'simplify', 'analysis']);
import { api, hosted } from '../../core/foundry';

@Component({
  selector: 'app-run-target',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './run-target.component.html',
  styleUrl: './run-target.component.scss',
})
export class RunTargetComponent {
  /** Read in the template: hosted, the host's queue owns the placement. */
  protected readonly hosted = hosted;

  /** Which act this dialog is about — the engine's own class name. */
  readonly act = input.required<ModelClass>();

  /** The chosen engine's name. Two-way: the dialog puts it on the request. */
  readonly server = model<string>('');

  /**
   * MAY THIS ACT BE STARTED AT ALL on the chosen engine.
   *
   * An output rather than something the dialog re-derives, because the answer
   * costs a network read and the dialog would otherwise be making a second one
   * to learn what this component already knows.
   */
  readonly ready = output<boolean>();

  protected readonly servers = signal<CrucibleServerView[]>([]);

  /**
   * WHICH ENGINE CAN ACTUALLY DO THIS ACT, or null when none can.
   *
   * Read once per open from the cached capability mirror the act gates decide
   * on -- no network, already loopback-ranked. It does two jobs: it picks the
   * DEFAULT, and when somebody presses an engine that cannot serve the class it
   * is what lets the refusal name the one that can instead of saying "choose
   * another engine" and leaving them to find it.
   */
  private readonly capable = signal<string | null>(null);

  /**
   * THE ENGINES, SPLIT INTO BALANCED ROWS OF AT MOST THREE.
   *
   * Owen gave this by enumeration on 2026-09-17 — *"Two splits the row of
   * buttons into two. Three splits into three. Four splits into two rows of two
   * buttons each. Five splits into a row of two, and under it, a row of theee.
   * Six is split into two rows of three."* — which is one rule: no row wider
   * than three, rows as equal as they can be, and the SHORT row first.
   *
   *   1 → [1]        4 → [2, 2]      7 → [2, 2, 3]
   *   2 → [2]        5 → [2, 3]      8 → [2, 3, 3]
   *   3 → [3]        6 → [3, 3]      9 → [3, 3, 3]
   *
   * Short row first is the half that is only visible at five: 2 above 3, not 3
   * above 2. It is what makes a growing list settle downwards instead of
   * re-flowing the row somebody is already reading.
   */
  protected readonly rows = computed<CrucibleServerView[][]>(() => {
    const all = this.servers();
    if (all.length === 0) return [];
    const count = Math.ceil(all.length / 3);
    const base = Math.floor(all.length / count);
    // The rows that get one extra. They are the LAST ones, which is what puts
    // the short row on top.
    const bigger = all.length % count;
    const out: CrucibleServerView[][] = [];
    let at = 0;
    for (let row = 0; row < count; row += 1) {
      const width = base + (row >= count - bigger ? 1 : 0);
      out.push(all.slice(at, at + width));
      at += width;
    }
    return out;
  });
  private readonly capability = signal<CapabilityRecord | null>(null);
  private readonly problem = signal<string | null>(null);

  /** The row for this act on the chosen engine, once its capability is read. */
  private readonly row = computed(() => {
    const record = this.capability();
    if (record === null) return null;
    return record.classes.find((entry) => entry.capability === this.act()) ?? null;
  });

  protected readonly runnable = computed(() => {
    // Hosted, the host accepts the row and places it. There is no capability of
    // ours to consult, and consulting one would dark a button that works.
    if (hosted()) return true;
    if (this.servers().length === 0) return false;
    // A text job places without the class row (crucible-dispatch.ts), so only a
    // server that could not be asked at all stops it here.
    if (DIALOG_CHOSEN.has(this.act())) return this.problem() === null;
    const row = this.row();
    // Unread is not refused: a capability that has not answered yet must not
    // dark the button, or every dialog opens disabled for a moment and a person
    // presses nothing because it looked broken.
    return row === null ? this.problem() === null : row.enabled;
  });

  /**
   * THE SENTENCE UNDER THE CHIPS, and every arm of it is a fact rather than an
   * offer.
   *
   * The engine's own `reason` is used verbatim when it will not serve the class,
   * for the reason act-gates gives: a host-mode Crucible and a Mac with no
   * `mlx-darwin` build each say something this app could not have composed, and
   * both say what to do about it.
   */
  protected readonly says = computed(() => {
    /*
     * THE NAME IS NOT IN THIS LINE ANY MORE. It used to be, at one server, on
     * the argument that somebody who has never opened Settings should be told
     * which machine this is. There is a button above saying exactly that now,
     * on every count of servers — so repeating it here would print the name
     * twice, six pixels apart.
     */
    if (this.problem() !== null) return `Could not be asked what it runs: ${this.problem()}`;
    // The dropdown beside this says the model for a text job; see the header.
    if (DIALOG_CHOSEN.has(this.act())) return null;
    const row = this.row();
    if (row === null) return 'Asking what it runs…';
    const model = row.selected.length > 0 ? row.selected : 'a model it chooses itself';
    return `Runs on ${model}`;
  });

  /** What a refusal MEANS, in this app's words. See the template's note. */
  protected readonly cannot = computed(() => {
    const chosen = this.server();
    const named = chosen.length > 0 ? `"${chosen}"` : 'That engine';
    if (this.problem() !== null) return `${named} could not be asked what it can do.`;
    const act = ACT_WORDS[this.act()] ?? 'run this';
    /*
     * NAME THE ENGINE THAT CAN, rather than telling somebody to go and find it.
     * "Choose another engine" is advice this component is in a position to take
     * itself -- it knows which one, and when there is only one other it is
     * asking a person to press the single remaining button.
     */
    const elsewhere = this.capable();
    if (elsewhere !== null && elsewhere !== chosen) {
      return `${named} cannot ${act}. "${elsewhere}" can.`;
    }
    return `${named} cannot ${act}, and no other connected engine can either.`;
  });

  /**
   * The engine's own sentence, kept verbatim except for a leading LABEL.
   *
   * `disabled:` is not part of the explanation; it is the field's name leaking
   * into its value, and it reads as the first word of a sentence that then does
   * not parse. Stripping a known prefix is not rewording — every word the server
   * wrote about WHY survives.
   */
  protected readonly reason = computed(() => {
    if (this.problem() !== null) return this.problem();
    const row = this.row();
    if (row === null || row.enabled || row.reason === null) return null;
    const said = row.reason.trim();
    const cut = said.toLowerCase().startsWith('disabled:') ? said.slice('disabled:'.length) : said;
    const trimmed = cut.trim();
    return trimmed.length > 0 ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : null;
  });

  constructor() {
    void this.load();
    // The chosen engine changed, so everything said about it is about the wrong
    // machine until the next read lands.
    effect(() => {
      const name = this.server();
      if (name.length === 0) return;
      void this.readCapability(name);
    });
    effect(() => { this.ready.emit(this.runnable()); });
  }

  private async load(): Promise<void> {
    if (!api) return;
    const view = await api.crucible.settings();
    this.servers.set(view.servers);
    /*
     * ── THE DEFAULT IS AN ENGINE THAT CAN DO THE WORK ────────────────────────
     *
     * It was `defaultEngineServer` alone: loopback-and-enabled, then the first
     * enabled, then the first at all. That is the right rule for the SETTINGS
     * window, where the question is "whose settings am I editing" and every
     * registered engine is a legitimate answer.
     *
     * It is the wrong rule here, and Owen met the difference: he opened an OCR
     * on an engine that cannot read pages and got *"crucible@example-mac-studio
     * cannot read pages — choose another engine."* Telling somebody to choose
     * again is a screen admitting it chose badly and handing the problem back.
     *
     * So the capable engine wins, and `defaultEngineServer` stays as the
     * fallback for when none is — because a card with nothing selected is worse
     * than one selected on an engine that will explain itself.
     */
    const capable = await api.crucible.serves(this.act());
    this.capable.set(capable?.server ?? null);
    if (this.server().length === 0) {
      this.server.set(capable?.server ?? defaultEngineServer(view.servers)?.name ?? '');
    }
  }

  private async readCapability(name: string): Promise<void> {
    if (!api) return;
    this.capability.set(null);
    this.problem.set(null);
    try {
      this.capability.set(await api.crucible.engineCapability(name));
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    }
  }
}
