/**
 * llm-card — the model every language job starts from, and the way back into setup.
 *
 * ── WHY THIS IS A SETTING NOW AND WAS NOT BEFORE ────────────────────────────
 *
 * The translate, simplify and analyse dialogs have always shown a model field
 * seeded from one hardcoded constant, `qwen3.8:27b` — Owen's ruling that 27b is
 * the standard for every task. That is the right standard and the wrong
 * DEFAULT for a machine that cannot hold it: seventeen gigabytes of weights on
 * an eight-gigabyte card is a translation that fails or crawls, and the person
 * it fails for has no way of knowing that the number in that field is the
 * reason. So setup measures the machine and writes what fits here, and the
 * three dialogs open with it.
 *
 * IT IS STILL ONLY A SEED. Each dialog's field remains editable and still sends
 * whatever is in it, so a different model for one book stays a per-run choice
 * and does not quietly become a new default.
 *
 * ── AND WHICH KIND OF SERVER ANSWERS ───────────────────────────────────────
 *
 * Owen, 2026-09-08: *"lets build in vllm batching. ollama batching doesnt work.
 * its an unfinished feature ollama tried to implement but isnt accessible on the
 * mac or pc."* A vLLM runs the requests in flight TOGETHER — which is what makes
 * the pools in Translate, Simplify and Clean text worth having — so this card
 * carries the choice, and it is a choice about the MACHINE rather than about a
 * book: one server is up, and the three dialogs open against whichever it is.
 *
 * BOTH SERVERS' SETTINGS ARE KEPT AT ONCE and only one is in effect, so trying
 * vLLM for an evening and going back costs nobody a retyped address. The Ollama
 * URL is still setup's to write (it can install and pull); the vLLM pair is
 * typed here, because nothing in this app starts a vLLM — BookForge's arbiter
 * owns that server's life, and foundry only ever uses what it is pointed at.
 *
 * ── AND THE BUTTON THAT RE-OPENS SETUP ──────────────────────────────────────
 *
 * Every step of the first-run wizard is skippable, which is only a real offer
 * if there is a way back. This card holds it, and names what was skipped —
 * "the analysis worker was skipped" is something a person can act on, and
 * "setup was not completed" is not.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { CLEAN_TEXT_MODELS, type LlmServerKind } from '@shared/pipeline';
import type { SetupState } from '@shared/types';
import { api } from '../../core/foundry';
import { UiService } from '../../core/ui.service';

@Component({
  selector: 'app-llm-card',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card">
      <div class="card-head">
        <span class="card-title">Language model</span>
        @if (saved()) { <span class="badge">saved</span> }
      </div>
      <p class="detail">
        What Translate, Simplify and Analyse open with. Each of those still has its own field, so
        a different model for one book stays a choice about that book.
      </p>

      <label class="field">
        <span class="label">Server</span>
        <select name="server" [ngModel]="server()" (ngModelChange)="server.set($event)">
          <option value="ollama">Ollama — one request at a time</option>
          <option value="vllm">vLLM — batches the requests in flight</option>
        </select>
      </label>
      <p class="small">
        vLLM runs the requests together instead of one behind another, which is where the speed in
        Translate, Simplify and Clean text is. Foundry never starts or stops either server.
      </p>

      @if (server() === 'vllm') {
        <label class="field">
          <span class="label">vLLM URL</span>
          <input type="text" placeholder="http://localhost:8000/v1" name="vllmUrl"
                 [ngModel]="vllmUrl()" (ngModelChange)="vllmUrl.set($event)">
        </label>
        <label class="field">
          <span class="label">Served model</span>
          <input type="text" placeholder="leave empty to use whatever it is serving"
                 name="vllmModel"
                 [ngModel]="vllmModel()" (ngModelChange)="vllmModel.set($event)">
        </label>
        <p class="small">
          A vLLM serves one model. Leave the name empty and the run asks the server what it is
          serving, uses that and records it; type one and the run also checks that it is what this
          machine expected.
        </p>
      }

      <label class="field">
        <span class="label">Default model</span>
        <input type="text" placeholder="qwen3.5:4b" name="model"
               [ngModel]="model()" (ngModelChange)="model.set($event)">
      </label>
      <!--
        THE PICKER THE CLEAN TEXT DIALOG SHOWS, same list, same rule about a tag
        that is not on it: a stored model from another day rides at the top as
        itself rather than being silently replaced by the default when this card
        is saved.
      -->
      <label class="field">
        <span class="label">Clean text model</span>
        <select name="cleanModel"
                [ngModel]="cleanModel()" (ngModelChange)="cleanModel.set($event)">
          @if (unlistedClean(); as stored) {
            <option [value]="stored">{{ stored }}</option>
          }
          @for (choice of cleanModels; track choice.tag) {
            <option [value]="choice.tag">{{ choice.label }}</option>
          }
        </select>
      </label>
      <p class="small">
        Clean text runs its own model: the narration cleanup is a different job from
        translating a book, and a bigger model is slower at it rather than better.
      </p>
      @if (server() === 'ollama') {
        <p class="small mono">Ollama: {{ ollama() }}</p>
      } @else {
        <!--
          SAID PLAINLY RATHER THAN HIDDEN. The two fields above are Ollama tags
          and a vLLM has never heard of either; blanking them would lose what
          this machine goes back to, and leaving them looking live would be the
          card claiming a model that will not run.
        -->
        <p class="small">
          The two model names above are Ollama's and are kept for when this machine goes back to
          it. While the server is vLLM, every language job uses the served model.
        </p>
      }

      <div class="actions">
        <button class="primary" [disabled]="saving()" (click)="save()">
          {{ saving() ? 'Saving…' : 'Save' }}
        </button>
        <button class="ghost" (click)="openSetup()">Run first-run setup again</button>
      </div>

      @if (state(); as setup) {
        @if (!setup.completed) {
          <p class="warn">Setup has not been run on this machine yet.</p>
        } @else if (setup.skipped.length > 0) {
          <p class="warn">Skipped during setup: {{ setup.skipped.join(', ') }}.</p>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card-head { display: flex; align-items: center; gap: 8px; }
    .card-title { font-family: var(--font-display); font-weight: 600; font-size: 13px; flex: 1; }
    .badge {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--ok); background: var(--ok-soft); border-radius: 999px; padding: 2px 8px;
    }
    .detail { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .small { font-size: 11px; color: var(--text-tertiary); margin: 0; }
    .mono { font-family: var(--font-mono); word-break: break-all; }
    .warn { color: var(--warn); font-size: 12px; margin: 0; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }

    .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .primary { border: none; background: var(--accent); color: var(--text-inverse); }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost { background: var(--bg-input); border: 1px solid var(--border-default); color: var(--text-primary); }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
  `],
})
export class LlmCardComponent {
  private readonly ui = inject(UiService);

  protected readonly model = signal('');
  protected readonly cleanModel = signal('');
  protected readonly ollama = signal('');
  protected readonly server = signal<LlmServerKind>('ollama');
  protected readonly vllmUrl = signal('');
  protected readonly vllmModel = signal('');
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly state = signal<SetupState | null>(null);

  /** The tags the cleanup offers — the Clean text dialog's own list, verbatim. */
  protected readonly cleanModels = CLEAN_TEXT_MODELS;

  /**
   * The stored cleanup model when the list does not contain it, so the box shows
   * what is actually saved. Null while nothing is loaded yet, because an empty
   * option would be a row with no name in it.
   */
  protected readonly unlistedClean = computed(() => {
    const chosen = this.cleanModel().trim();
    if (chosen.length === 0) return null;
    return CLEAN_TEXT_MODELS.some((choice) => choice.tag === chosen) ? null : chosen;
  });

  constructor() {
    if (!api) return;
    void this.load();
  }

  private async load(): Promise<void> {
    if (!api) return;
    /*
     * `llm.servers()` AND NOT `llm.defaults()` FOR THE URLS. `defaults` answers
     * what a JOB opens with and has already resolved the choice away — under
     * vLLM its `ollama` field is the vLLM's URL and its two models are the one
     * served id. This card edits what is STORED, where both servers exist at
     * once, so it reads the stored set; `defaults` still answers for the two
     * Ollama model fields, which is the only thing it is asked for here.
     */
    const [defaults, servers, state] = await Promise.all([
      api.llm.defaults(),
      api.llm.servers(),
      api.setup.state(),
    ]);
    this.server.set(servers.server);
    this.ollama.set(servers.ollamaUrl);
    this.vllmUrl.set(servers.vllmUrl);
    this.vllmModel.set(servers.vllmModel);
    this.model.set(servers.server === 'vllm' ? '' : defaults.model);
    this.cleanModel.set(servers.server === 'vllm' ? '' : defaults.cleanModel);
    this.state.set(state);
  }

  /**
   * Answered with what main STORED, never with what was typed. `clampModelTag`
   * refuses a name with whitespace in it and falls back to the standing
   * default, and a field that went on showing the refused text would be a
   * field disagreeing with the next job.
   */
  protected async save(): Promise<void> {
    if (!api) return;
    this.saving.set(true);
    this.saved.set(false);
    try {
      /*
       * THE OLLAMA TAGS ARE ONLY WRITTEN WHILE OLLAMA IS THE SERVER. Under vLLM
       * the two fields are blank by construction (see `load`), and `setModel`
       * answers a blank with the standing default — so saving from here would
       * quietly overwrite whatever this machine goes back to with a constant.
       */
      if (this.server() === 'ollama') {
        this.model.set(await api.llm.setModel(this.model()));
        this.cleanModel.set(await api.llm.setCleanModel(this.cleanModel()));
      }
      const servers = await api.llm.setServers({
        server: this.server(),
        vllmUrl: this.vllmUrl(),
        vllmModel: this.vllmModel(),
      });
      this.vllmUrl.set(servers.vllmUrl);
      this.vllmModel.set(servers.vllmModel);
      this.saved.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  protected openSetup(): void {
    this.ui.openSetup();
  }
}
