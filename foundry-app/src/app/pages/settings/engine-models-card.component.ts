/**
 * engine-models-card — which model on the engine runs each act.
 *
 * ── The ruling this card exists for ────────────────────────────────────────
 *
 * Owen, 2026-09-16 (*"the Ollama standard"*, crucible `docs/INTENT.md`):
 * Crucible should be set-and-forget like Ollama, and **all configuration happens
 * THROUGH BookForge and Foundry** rather than by interacting with Crucible
 * directly. The person's only direct contact with Crucible is the tray icon and
 * the installer.
 *
 * That REVERSES the PHASE13 ruling of 2026-09-14, which gave Crucible its own
 * operator page and deleted the model list from both apps. This card is half of
 * putting that capability back where Owen now wants it.
 *
 * ── It is a WINDOW, not a store, exactly like the card beside it ──────────
 *
 * Every value here lives in the engine's own `/v1/settings`
 * (crucible `docs/PHASE15-HOST.md` §3.1), and §5.2's rule governs: *"every
 * control in these sections is a request to the engine, and its result is the
 * engine's answer re-read. There is no Save button that writes an app file and
 * syncs later."* So there is no `AppSettings` key behind any of this, no local
 * edit buffer, and each change is one `PUT` whose ANSWER redraws the card.
 *
 * ── WHY IT IS A SECOND CARD AND NOT A COLUMN ON THE FIRST ────────────────
 *
 * `engine-settings-card` answers *where* a class runs — this machine's card, or
 * an account you connect. This answers *which model* runs it locally. They are
 * different questions with different vocabularies and, decisively, **different
 * class lists**: routing is the four llm classes (PHASE15 §1 — `pages` can never
 * go upstream), while a local model is chosen for all five acts Foundry has.
 * Putting a five-row control inside a four-row table would mean one row with an
 * empty half and a reader wondering what it means.
 *
 * ── THERE IS NO "OLDER ENGINE" FACE ──────────────────────────────────────
 *
 * This card had one, and Owen removed the reason for it on 2026-09-16:
 * *"Nothing is legacy because nothing exists publicly."* Every engine sends the
 * two local-model fields, the SDK refuses a document without them by name, and
 * a face for a server that cannot exist was a branch nobody would ever see and
 * everybody reading this file had to understand.
 *
 * ── `null` IS A CHOICE AND IS DRAWN AS ONE ───────────────────────────────
 *
 * The SDK states it: *"null restores the engine's automatic decision"*. So the
 * first option is **Choose automatically**, a thing somebody can deliberately
 * pick and come back to — not a blank that reads as "unset". Nothing here treats
 * a null assignment as a gap to fill in.
 *
 * ── AND THE FIT FIGURE IS AN ESTIMATE, SAID OUT LOUD ─────────────────────
 *
 * `LocalModelChoice.fits` excludes the KV cache (see that type's own note, which
 * carries the measured numbers). A model can report that it fits and then fail
 * to load. This card therefore never writes "will fit"; it prints the engine's
 * estimate, labels it one, and says what it leaves out. The underlying defect is
 * Crucible's and is Owen's to rule on — papering over it here with a margin of
 * this app's invention would hide the evidence that argument needs.
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  LLM_CLASSES,
  defaultEngineServer,
  type CapabilityRecord,
  type LocalModelChoice,
  type SettingsDocument,
} from '@shared/engine-settings';
import type { CrucibleCatalogRow, CruciblePullProgress } from '@shared/model-wire';
import type { CrucibleServerView } from '@shared/slots';
import { MODEL_CLASSES, type ModelClass } from '@shared/types';
import { actWords, shortfallWords, sizeWords } from '../../core/crucible-words';
import { api } from '../../core/foundry';

/**
 * The reserved value of the "let the engine decide" option.
 *
 * It cannot collide with a model id, which is why it is not the empty string: a
 * select whose "none" value is `''` cannot tell "nobody picked" from "picked the
 * automatic one", and those are the two states this control exists to separate.
 */
const AUTOMATIC = 'automatic-choice';

@Component({
  selector: 'app-engine-models-card',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (servers().length > 0) {
      <div class="card">
        <div class="card-head">
          <span class="card-title">Which model runs each act</span>
          @if (working()) { <span class="small">working…</span> }
        </div>

        <p class="detail">
          Chosen on the GPU engine, not here — this is a window onto its own settings, and
          BookForge shows the same answers. Leave an act on Choose automatically and the engine
          picks for itself.
        </p>

        @if (servers().length > 1) {
          <label class="field">
            <span class="label">Engine</span>
            <select [ngModel]="chosen()" name="models-engine" (ngModelChange)="choose($event)">
              @for (server of servers(); track server.name) {
                <option [value]="server.name">{{ server.name }}</option>
              }
            </select>
          </label>
        }

        @if (problem(); as why) { <p class="warn">{{ why }}</p> }

        @if (support()) {
            <!--
              ROWS RATHER THAN A SELECT, and that is Owen's own shape: *"it can
              show them other models available, but theyll be grayed out but
              clickable if they cant run it."* A native option element cannot be
              both — the disabled attribute greys it AND stops the click, and styling one
              greyed while leaving it selectable is not reliable across
              platforms. It also had nowhere to put the numbers, which 3b wants
              ON the row.
            -->
            @for (row of rows(); track row.cls) {
              <div class="act-head">
                <span class="who">{{ row.act }}</span>
                @if (row.shortfall; as short) { <span class="small warnish">{{ short }}</span> }
              </div>

              <button class="pick" type="button" [disabled]="working()"
                      [class.chosen]="row.selected === automatic"
                      (click)="assign(row.cls, automatic)">
                <span class="tick">{{ row.selected === automatic ? '●' : '○' }}</span>
                <span class="pick-name">Choose automatically</span>
                <span class="small">the engine decides</span>
              </button>

              @for (choice of row.choices; track choice.id) {
                <!--
                  A MODEL THAT DOES NOT FIT IS STILL PRESSABLE. The estimate
                  excludes the KV cache so it is not a verdict; somebody may be
                  about to free memory; and the ENGINE refuses by name
                  (local_model_does_not_fit, 409). Greyed says "expect this to
                  be refused", not "you may not ask".
                -->
                <button class="pick" type="button" [disabled]="working()"
                        [class.chosen]="row.selected === choice.id"
                        [class.wont-fit]="!choice.fits"
                        (click)="assign(row.cls, choice.id)">
                  <span class="tick">{{ row.selected === choice.id ? '●' : '○' }}</span>
                  <span class="pick-name">{{ choice.id }}</span>
                  <span class="small mono">{{ choiceWords(choice) }}</span>
                </button>
              }

              @if (row.choices.length === 0) {
                <p class="small">
                  This engine offers no model for {{ row.act.toLowerCase() }}.
                </p>
              }
              @if (row.reason; as why) { <p class="act-why small">{{ why }}</p> }
              @if (row.needsAccount) {
                <!--
                  3c: NOTHING ON THIS CARD FITS, so the honest next step is the
                  card below. Owen: *"if nothing fits their card, it should give
                  them the option of using api keys for claude or openai."* It
                  POINTS rather than growing a key field — the key belongs in the
                  engine, written once, by the card that owns that door.
                -->
                <p class="small">
                  Nothing on this engine's card can run it. An Anthropic or OpenAI account can —
                  "Where the text work runs", just above, is where the key goes, and it is stored
                  in the engine rather than in Foundry.
                </p>
              }
            }

            <!--
              SAID ONCE, UNDER THE WHOLE TABLE, rather than beside every row.
              It is one fact about every figure above, and repeating it five
              times would make it read as a per-model caveat rather than as the
              property of the measurement that it is.
            -->
            <p class="small">
              The sizes are the engine's estimate of the WEIGHTS only — they do not include the
              KV cache, which a long context on a large model adds several gigabytes to. A model
              can be offered as fitting and still run out of memory when it loads.
            </p>

            <!-- ── What is on that machine, and what it could fetch ───────── -->
            <div class="card-head stock-head">
              <span class="card-title">Models on that engine</span>
              @if (catalogProblem() === null && stock().length > 0) {
                <span class="small">{{ installedWords() }}</span>
              }
            </div>
            @if (catalogProblem(); as why) { <p class="warn">{{ why }}</p> }
            @for (row of stock(); track row.id) {
              <div class="stock">
                <span class="dotstate" [attr.data-ok]="row.installed"></span>
                <span class="who">{{ row.name || row.id }}</span>
                <span class="small mono">{{ stockWords(row) }}</span>
                @if (pullOf(row.id); as run) {
                  <span class="small">{{ pullWords(run) }}</span>
                } @else if (!row.installed) {
                  <button class="ghost" type="button" [disabled]="pulling()"
                          (click)="fetch(row)">Fetch</button>
                } @else {
                  <!--
                    OWEN ASKED FOR THIS AND IS SHORT OF DISK: *"they sohuld have
                    a way to delete models from crucible, too. probably through
                    bookforge/foundry settings"*. It supersedes PHASE15 §3.5a,
                    which said neither app calls the remove door — but NOT the
                    condition on it, *"an app does not call this on a user's
                    behalf without saying so on screen"*, which is why the press
                    goes through a card carrying the figure.
                  -->
                  <button class="ghost" type="button" [disabled]="removing() === row.id"
                          (click)="remove(row)">
                    {{ removing() === row.id ? 'Removing…' : 'Remove' }}
                  </button>
                }
              </div>
              @if (pullOf(row.id); as run) {
                @if (run.error; as bad) { <p class="small bad">{{ bad.message }}</p> }
              }
            }
            <p class="small">
              A download's size is not known before it runs: these weights are a whole repository
              rather than a list of files, and the engine does not state a total. What is already
              on that machine is measured and shown above.
            </p>
        }
      </div>
    }
  `,
  styles: `
    .card {
      background: var(--bg-raised);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card-head { display: flex; align-items: baseline; gap: 10px; }
    .card-title { font-family: var(--font-display); font-weight: 600; font-size: 13px; }
    .detail { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
    .small { margin: 0; font-size: 11px; line-height: 1.5; color: var(--text-tertiary); }
    .warn { margin: 0; font-size: 12px; color: var(--error); }
    .field { display: flex; align-items: center; gap: 8px; }
    .label { font-size: 11px; color: var(--text-tertiary); }
    .act-head { display: flex; align-items: baseline; gap: 8px; margin-top: 6px; }
    .warnish { color: var(--warn); }
    /* One choice. A button rather than an option element so it can be greyed
       AND pressed — see the template's note on Owen's wording. */
    .pick {
      display: flex; align-items: baseline; gap: 8px; width: 100%;
      font: inherit; font-size: 12px; text-align: left;
      background: transparent; color: var(--text-primary);
      border: 1px solid transparent; border-radius: var(--radius-sm);
      padding: 3px 6px; cursor: pointer;
    }
    .pick:hover:not(:disabled) { background: var(--bg-sunken); }
    .pick.chosen { border-color: var(--border-subtle); background: var(--bg-sunken); }
    .pick:disabled { cursor: default; }
    .tick { color: var(--text-tertiary); }
    .pick.chosen .tick { color: var(--accent); }
    .pick-name { flex: 1; min-width: 0; }
    /* GREYED BUT NOT DISABLED. The dimming says "expect the engine to refuse
       this"; the button stays pressable because the estimate is not a verdict
       and the engine is what refuses, by name. */
    .pick.wont-fit .pick-name, .pick.wont-fit .small { color: var(--text-tertiary); }
    .act { display: flex; align-items: center; gap: 10px; }
    .who { font-size: 12px; color: var(--text-primary); min-width: 160px; }
    select {
      font: inherit;
      font-size: 12px;
      background: var(--bg-input);
      color: var(--text-primary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 4px 6px;
    }
    select.wide { flex: 1; min-width: 0; }
    .stock-head { margin-top: 4px; }
    .stock { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .stock .who { min-width: 0; flex: 1; }
    .mono { font-family: var(--font-mono); }
    .bad { color: var(--error); }
    .dotstate {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--text-tertiary); flex-shrink: 0;
    }
    .dotstate[data-ok="true"] { background: var(--ok); }
    button.ghost {
      font: inherit; font-size: 11px;
      background: transparent; color: var(--text-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 3px 10px; cursor: pointer;
    }
    button.ghost:disabled { opacity: 0.5; cursor: default; }
  `,
})
export class EngineModelsCardComponent {
  protected readonly automatic = AUTOMATIC;
  protected readonly servers = signal<CrucibleServerView[]>([]);
  protected readonly chosen = signal('');
  protected readonly doc = signal<SettingsDocument | null>(null);
  protected readonly working = signal(false);
  protected readonly problem = signal<string | null>(null);

  protected readonly support = computed(() => this.doc()?.localModels ?? null);

  /*
   * ── THE STOCK PANEL (step 2) ──────────────────────────────────────────
   *
   * `catalog` is every subject the engine knows, INCLUDING BookForge's voices
   * and RVC models — main reports the whole disk on purpose, because somebody
   * looking at storage is asking about the whole disk. The CARD narrows it,
   * and narrows it to `model`: a Foundry settings page listing voices would be
   * the noise Owen objected to, and the acts this app has are all served by
   * models.
   */
  /**
   * THE CAPABILITY RECORD — where the REASONS and the shortfall live.
   *
   * The settings document's choice rows carry only id / estimate / fits /
   * installed. What a person needs when a class will not run is the server's own
   * sentence about WHY, and that is per-class and lives here: *"no qwen3.8
   * variant fits: the smallest needs 20.1 GiB and there is 5.0 GiB available"*.
   * Rendered rather than re-composed — 0.6.7 puts the term breakdown into this
   * same string, and an app that rebuilt it from parts would print a worse
   * version of a sentence it already has.
   */
  protected readonly capability = signal<CapabilityRecord | null>(null);
  protected readonly catalog = signal<CrucibleCatalogRow[]>([]);
  protected readonly catalogProblem = signal<string | null>(null);
  /** Pulls in flight or just finished, by subject id. Cleared on a fresh read. */
  private readonly pulls = signal<Record<string, CruciblePullProgress>>({});

  /** Which row is being removed, so only its own button says so. */
  protected readonly removing = signal<string | null>(null);

  protected readonly stock = computed(
    () => this.catalog().filter((row) => row.kind === 'model'));
  protected readonly pulling = computed(
    () => Object.values(this.pulls()).some((run) => run.state === 'running'));

  /**
   * "45.6 GB of models on that machine" — the one figure this screen can state
   * without qualification, because it is measured rather than estimated.
   *
   * A row whose `installedBytes` is null contributes nothing rather than being
   * guessed at; on a healthy engine those are exactly the not-installed rows,
   * which weigh nothing.
   */
  protected readonly installedWords = computed(() => {
    const rows = this.stock().filter((row) => row.installed);
    const known = rows.filter((row) => row.installedBytes !== null);
    const total = known.reduce((sum, row) => sum + (row.installedBytes ?? 0), 0);
    const unmeasured = rows.length - known.length;
    const tail = unmeasured > 0 ? `, plus ${unmeasured} whose size it did not state` : '';
    return `${rows.length} installed — ${sizeWords(total)}${tail}`;
  });

  /**
   * One row per act, in {@link MODEL_CLASSES} order.
   *
   * A class the engine serves that Foundry has no act for — `tts`, `asr`,
   * `align`, `rvc`, `denoise`, all BookForge's — is not drawn, on the same rule
   * the engine step's capability table follows: a Foundry settings page listing
   * a voice engine is the noise Owen objected to, in the other direction.
   */
  protected readonly rows = computed(() => {
    const local = this.support();
    // Null only until the first read lands, or after one that failed — the
    // failure is drawn on its own line and this draws no rows for it.
    if (local === null) return [];
    const cap = this.capability();
    return MODEL_CLASSES.map((cls) => {
      const klass = cap?.classes.find((row) => row.capability === cls) ?? null;
      const choices = local.choices[cls];
      /*
       * THE REASON IS DRAWN ONLY WHEN IT IS NEWS. On a class that runs, the
       * server's sentence is a restatement of the row above it ("X fits: it
       * needs 20.1 GiB and there is 21.0 available") — true, and five of them
       * under five working pickers is noise nobody reads. When the class will
       * NOT run it is the only thing on screen that says why.
       */
      const failing = klass !== null && !klass.enabled;
      return {
        cls,
        act: actWords(cls),
        selected: local.assigned[cls] ?? AUTOMATIC,
        choices,
        reason: failing ? klass.reason : null,
        shortfall: failing ? shortfallWords(klass.shortfallBytes) : null,
        /*
         * 3c's TEST, and it is about the CLASS rather than about any model:
         * the engine says it cannot serve this, AND it is one of the classes
         * that may route upstream at all (`pages` cannot — PHASE15 §1 — so a
         * card offering an account for it would be offering something the
         * server refuses by name).
         */
        needsAccount: failing && (LLM_CLASSES as readonly string[]).includes(cls),
      };
    });
  });

  constructor() {
    effect(() => { void this.load(); }, { allowSignalWrites: true });

    /*
     * EVERY FRAME OF EVERY PULL, filtered to the engine this card is looking
     * at. Main broadcasts to all windows and names the server on each frame, so
     * a card watching the Mac does not draw the PC's download — and a person
     * with both cards open in two windows sees each one's own work.
     */
    api?.crucible.onPullProgress((progress) => {
      if (progress.server !== this.chosen()) return;
      this.pulls.update((all) => ({ ...all, [progress.id]: progress }));
      /*
       * A LANDED PULL CHANGES BOTH HALVES OF THIS CARD: the row becomes
       * installed, and the assignment picker gains a model it may now choose.
       * So the whole card re-reads rather than patching the row in place —
       * the engine is the truth and this is a window onto it.
       */
      if (progress.state === 'done') void this.load();
    });
  }

  private async load(): Promise<void> {
    if (!api) return;
    const view = await api.crucible.settings();
    this.servers.set(view.servers);
    if (this.chosen().length === 0) {
      this.chosen.set(defaultEngineServer(view.servers)?.name ?? '');
    }
    if (this.chosen().length > 0) {
      await this.read();
      await this.readCatalog();
    }
  }

  /**
   * The stock, read separately from the settings document and failing
   * separately.
   *
   * TWO READS AND TWO PROBLEM LINES, deliberately. `/v1/settings` and
   * `/v1/catalog` are different doors and an engine can answer one and not the
   * other — and the halves are independently useful: knowing what is installed
   * is worth having when the assignment door is unreachable, and the assignment
   * picker works on an engine whose catalog read failed. Folding them into one
   * try would black out both halves over either failure.
   */
  private async readCatalog(): Promise<void> {
    if (!api) return;
    try {
      this.catalog.set(await api.crucible.catalog(this.chosen()));
      this.catalogProblem.set(null);
    } catch (err) {
      this.catalog.set([]);
      this.catalogProblem.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** One read. A failure is DRAWN and the document cleared — never swallowed. */
  private async read(): Promise<void> {
    if (!api) return;
    this.working.set(true);
    try {
      const [document, capability] = await Promise.all([
        api.crucible.engineSettings(this.chosen()),
        api.crucible.engineCapability(this.chosen()),
      ]);
      this.doc.set(document);
      this.capability.set(capability);
      this.problem.set(null);
    } catch (err) {
      /*
       * BOTH GO TOGETHER. A document kept beside a capability record that failed
       * to read would draw five working pickers and no reason under the class
       * that cannot run — the one sentence this card exists to show.
       */
      this.doc.set(null);
      this.capability.set(null);
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.working.set(false);
    }
  }

  protected choose(name: string): void {
    this.chosen.set(name);
    /*
     * THE PULLS GO WITH THE ENGINE. They are keyed by subject id, and two
     * engines can be fetching the same model — so carrying the map across would
     * draw the PC's progress on the Mac's row. A pull that is still running is
     * not lost: main keeps following it and its next frame names its own
     * server, which this card ignores until it is looking at that engine again.
     */
    this.pulls.set({});
    void this.read();
    void this.readCatalog();
  }

  /** The pull for this row, or null. Keyed by id, which is unique per engine. */
  protected pullOf(id: string): CruciblePullProgress | null {
    return this.pulls()[id] ?? null;
  }

  /**
   * What is known about one row's bytes — and "not installed" says nothing
   * about size, because nothing knows it.
   *
   * `expectedBytes` is null for every model (the contract: the weights are a
   * whole-repo snapshot no manifest sizes, *"never an estimate"*), so there is
   * no honest figure to put beside a Fetch button. Saying so once under the
   * list is better than five rows each claiming "unknown".
   */
  protected stockWords(row: CrucibleCatalogRow): string {
    if (!row.installed) return 'not installed';
    return row.installedBytes === null
      ? 'installed, size not stated'
      : `installed · ${sizeWords(row.installedBytes)}`;
  }

  /**
   * A pull in words — and it survives having NO DENOMINATOR, which is the
   * ordinary case here rather than the edge.
   *
   * The server states `bytesTotal` only where a manifest declared one, and for
   * a model it does not. So the running sentence counts UP rather than showing
   * a percentage: a bar that invented a denominator would be a bar that jumps
   * when the real total arrives, or never moves off an imagined one.
   */
  protected pullWords(run: CruciblePullProgress): string {
    switch (run.state) {
      case 'done': return run.skipped === null ? 'fetched' : run.skipped;
      case 'failed': return 'could not be fetched';
      case 'cancelled': return 'stopped';
      default: break;
    }
    if (run.bytes !== null) {
      const done = sizeWords(run.bytes.done);
      return run.bytes.total === null
        ? `fetching — ${done} so far`
        : `fetching — ${done} of ${sizeWords(run.bytes.total)}`;
    }
    if (run.step !== null) {
      return `${run.step.name} (${run.step.index} of ${run.step.total})`;
    }
    return 'starting…';
  }

  /**
   * DELETE ONE MODEL'S WEIGHTS FROM THAT MACHINE.
   *
   * ASKED FIRST, ALWAYS, and main composes the question because main is what
   * knows the size — deciding about 17.3 GB is a different decision from
   * deciding about "a file". `keep` is the dismissal and the default, so Escape
   * and the scrim both leave the weights alone.
   *
   * THE CARD RE-READS AFTERWARDS rather than dropping the row locally. Removing
   * a model can change the ASSIGNMENT half too — the engine may have been using
   * it for a class — and the engine is the truth about both. A row struck out
   * optimistically would be this app claiming a deletion the server may have
   * refused.
   */
  protected async remove(row: CrucibleCatalogRow): Promise<void> {
    if (!api || this.removing() !== null) return;
    const answer = await api.crucible.confirmRemoveModel({
      server: this.chosen(),
      id: row.id,
      name: row.name,
      bytes: row.installedBytes,
    });
    if (answer !== 'remove') return;
    this.removing.set(row.id);
    try {
      await api.crucible.removeModel(this.chosen(), row.kind, row.id);
      this.catalogProblem.set(null);
      await this.load();
    } catch (err) {
      /*
       * THE SERVER'S OWN SENTENCE, unshortened. Its four refusals are four
       * different things to do — `subject_in_use` names what is holding the
       * weights, `subject_remove_failed` names the file that would not go — and
       * a card that collapsed them into "could not remove" would throw away the
       * half that says what to do next.
       */
      this.catalogProblem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.removing.set(null);
    }
  }

  /**
   * ONE PRESS, ONE PULL. The button is gone while any pull on this engine is
   * running — one machine, one disk, one network, and two concurrent
   * multi-gigabyte fetches onto one card is not a thing to make easy.
   *
   * A REFUSAL TO START is drawn on the catalog's own problem line rather than
   * invented into a progress frame: nothing was fetched, so there is no pull to
   * report the state of.
   */
  protected async fetch(row: CrucibleCatalogRow): Promise<void> {
    if (!api || this.pulling()) return;
    try {
      await api.crucible.pull(this.chosen(), row.kind, row.id);
      this.catalogProblem.set(null);
    } catch (err) {
      this.catalogProblem.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * "qwen3.8-27b-4bit — 20.1 GB, installed" — and the word for the figure is
   * never "fits".
   *
   * A model the engine says does NOT fit is still LISTED and still selectable.
   * Three reasons, and the third is the one that decides it: the estimate
   * excludes the KV cache and is therefore not a verdict; a person may be about
   * to free memory or change the desktop allowance; and **the engine refuses by
   * name** (`local_model_does_not_fit`, 409). A picker that hid the row would be
   * this app enforcing a rule it holds a worse copy of, and the person would be
   * left wondering where the model went.
   */
  protected choiceWords(choice: LocalModelChoice): string {
    const size = `${sizeWords(choice.memoryBytesEstimate)} est.`;
    const room = choice.fits ? size : `${size} · larger than this card`;
    return choice.installed ? room : `${room} · not installed`;
  }

  /**
   * ONE PRESS, ONE PUT, AND THE ANSWER REDRAWS.
   *
   * The engine's refusals are the ones a person sees — `local_model_unknown`,
   * `local_model_not_selectable`, `local_model_does_not_fit`,
   * `capability_undecided` — printed as they arrive. Nothing is validated here
   * first: this app's copy of what the engine will accept is necessarily worse
   * than the engine's, and a refusal it pre-empted wrongly is a control that
   * does nothing with no sentence to explain it.
   */
  protected async assign(cls: ModelClass, value: string): Promise<void> {
    if (!api || this.working()) return;
    this.working.set(true);
    try {
      const model = value === AUTOMATIC ? null : value;
      this.doc.set(await api.crucible.engineSettingsPut(this.chosen(), {
        localModels: { [cls]: model },
      }));
      /*
       * THE CAPABILITY IS RE-READ, because choosing a model can change it:
       * a class whose selection moved to something that does not fit becomes a
       * class the engine will not serve, and the PUT answers with the settings
       * document alone. Without this the reason line would describe the previous
       * choice.
       */
      this.capability.set(await api.crucible.engineCapability(this.chosen()));
      this.problem.set(null);
    } catch (err) {
      /*
       * THE DOCUMENT IS RE-READ RATHER THAN LEFT AS IT WAS. A refusal applies
       * nothing (§3.2), so the engine still holds what it held — but the SELECT
       * is now showing the value the person picked, which the engine rejected.
       * Re-reading is what puts the control back in step with the machine.
       */
      this.problem.set(err instanceof Error ? err.message : String(err));
      await this.read();
    } finally {
      this.working.set(false);
    }
  }
}
