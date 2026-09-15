/**
 * cloud-card — the API keys this machine has connected, and what they cost.
 *
 * ── What this card is, in Owen's words ─────────────────────────────────────
 *
 * *"give them the option of connecting an api key for openai or claude instead
 * of using the 27b or the 9b. if the user wants to they can use usage credits
 * from a cloud model… for weaker systems."* (docs/SLOTS.md §1.) So this is the
 * card for the laptop that cannot hold a 9B and has no Crucible to borrow: a key
 * makes translate, simplify, clean and analyse possible at all, and the tiles
 * light with the provider named in their sentence (electron/act-gates.ts).
 *
 * ── EVERY ENABLED ROW IS A SLOT, AND `any` NEVER TAKES ONE ─────────────────
 *
 * docs/SLOTS.md §3: a cloud provider is *"a deliberate per-job choice, never
 * something `any` falls through to"*. The `any` walk steps past them with a
 * sentence, `New jobs wait for: top` cannot name one, and the only way work
 * reaches a provider is the picker on the row — which draws them in a group of
 * their own headed "Cloud — costs credits". That is the whole safety story and
 * it is in the dispatcher, not here; this card's job is to say it out loud.
 *
 * ── THE KEY FIELD IS WRITE-ONLY, AND THE SENTENCE UNDER IT IS A RULE ───────
 *
 * This card has never been told a key and cannot be: `CloudProviderView` carries
 * a boolean where the stored entry carries a credential, and the save sends
 * `apiKey: null` for every row nobody retyped. The line under the box is
 * `CLOUD_KEY_SENTENCE`, declared in shared/slots.ts so that no surface can word
 * it differently: everything else in this app runs on hardware the person is
 * standing next to, and this is the one place where pressing Translate sends
 * their book to a company. It is said beside the box, before the choice.
 *
 * ── THE MODEL IS A TEXT FIELD AND WILL NEVER BE A DROPDOWN ─────────────────
 *
 * Hosted line-ups change monthly. A list compiled into this build would be wrong
 * by the next release and confidently so — offering models that have been
 * retired, hiding the one somebody is paying for. So the box is free text with a
 * plausible placeholder, and the PROOF is Test, which lists the provider's own
 * `/v1/models` and says whether the id in the box is among them. A `GET`, so it
 * costs nothing to press.
 *
 * ── HOSTED, THE SLOTS ARE SOMEBODY ELSE'S ──────────────────────────────────
 *
 * The Servers card's rule exactly (docs/SLOTS.md §3): the vendored app takes its
 * slot list from the host, so the card draws read-only and says where the slots
 * came from. Main refuses the write as well, because a card that only HIDES a
 * control has decorated a door rather than locked it.
 */
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  CLOUD_KEY_SENTENCE,
  CLOUD_PROVIDER_ENDPOINT,
  CLOUD_PROVIDER_LABEL,
  CLOUD_PROVIDER_MODEL_HINT,
} from '@shared/slots';
import type {
  CloudProbe,
  CloudProviderEdit,
  CloudProviderKind,
  CloudProviderView,
  ComputeSlot,
} from '@shared/slots';
import { api } from '../../core/foundry';

/**
 * One row as this card edits it: the view, plus the key somebody may have typed
 * and a local id so `@for`'s `track` survives a reorder.
 *
 * THE LOCAL ID IS NOT THE NAME, `EditableServer`'s reason: tracking by name
 * would destroy and rebuild the input somebody is typing in the moment they
 * change its first character, losing the caret and, on a slow frame, the
 * keystroke.
 */
interface EditableProvider extends CloudProviderView {
  key: number;
  /** A NEW key, or null. Never the stored one — see the module note. */
  apiKey: string | null;
}

@Component({
  selector: 'app-cloud-card',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card">
      <div class="card-head">
        <span class="card-title">Cloud providers</span>
        @if (saved()) { <span class="badge">saved</span> }
      </div>

      <p class="detail">
        An OpenAI or Anthropic API key, so translation, simplification, narration cleanup and
        analysis can run on usage credits instead of on a GPU engine. Reading the pages of a
        book never goes to a provider — that stays here or on a Crucible.
      </p>

      @for (row of rows(); track row.key) {
        <div class="provider">
          <div class="row">
            <input class="name" type="text" placeholder="My OpenAI key"
                   [ngModel]="row.name" [name]="'cname' + row.key"
                   (ngModelChange)="edit(row.key, { name: $event })">
            <select class="kind" [ngModel]="row.kind" [name]="'ckind' + row.key"
                    (ngModelChange)="edit(row.key, { kind: $event })">
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
            <label class="toggle">
              <input type="checkbox" [ngModel]="row.enabled" [name]="'con' + row.key"
                     (ngModelChange)="edit(row.key, { enabled: $event })">
              <span>On</span>
            </label>
            <button class="ghost" (click)="drop(row.key)">Remove</button>
          </div>

          <!--
            THE MODEL, AS FREE TEXT. See the module note: a compiled catalog of
            hosted model names is wrong by the next release, so the placeholder
            is one plausible id and Test is the proof.
          -->
          <input class="wide" type="text" [placeholder]="modelHint(row.kind)"
                 [ngModel]="row.model" [name]="'cmodel' + row.key"
                 (ngModelChange)="edit(row.key, { model: $event })">

          <!--
            AND THE ADDRESS, WHICH IS ALMOST ALWAYS EMPTY. An OpenAI-compatible
            host somebody runs themselves goes here; empty means the provider's
            own, which the placeholder names so that "blank" reads as a choice
            rather than as something unfinished.
          -->
          <input class="wide" type="text" [placeholder]="endpointHint(row.kind)"
                 [ngModel]="row.endpoint" [name]="'cend' + row.key"
                 (ngModelChange)="edit(row.key, { endpoint: $event })">

          <div class="row">
            <input class="wide" type="password"
                   [placeholder]="row.keySet ? 'API key: set — type to replace' : 'API key: not set'"
                   [ngModel]="row.apiKey ?? ''" [name]="'ckey' + row.key"
                   (ngModelChange)="edit(row.key, { apiKey: $event })">
            <button class="ghost" [disabled]="testing() === row.key"
                    (click)="test(row.key)">
              {{ testing() === row.key ? 'Testing…' : 'Test' }}
            </button>
          </div>
          <!--
            THE SENTENCE OWEN'S RULE REQUIRES, under the key field and never
            anywhere else. Declared in shared/slots.ts so two surfaces cannot
            word it differently.
          -->
          <p class="small warn-soft">{{ keySentence }}</p>

          @if (probes()[row.key]; as probe) {
            @if (probe.outcome === 'ok') {
              @if (probe.chosenListed) {
                <p class="small ok">
                  {{ probe.chosen }} is one of the {{ probe.models.length }} models this key can
                  use.
                </p>
              } @else {
                <!--
                  A WORKING KEY AND A MODEL THAT IS NOT ON IT ARE DIFFERENT
                  NEWS, so this is a warning beside a successful listing rather
                  than a failure — the fix is the model box, not the key box.
                  Saving is still allowed: a provider may serve a model it does
                  not list, and refusing to store the id somebody typed would
                  make this app the authority on somebody else's catalog.
                -->
                <p class="small warn">{{ notListed(probe.chosen, probe.models) }}</p>
              }
            } @else {
              <p class="small warn">{{ probe.message }}</p>
            }
          }
        </div>
      } @empty {
        <p class="small">No cloud providers. Nothing in this app sends text anywhere.</p>
      }

      <div class="actions">
        <button class="ghost" (click)="add()">Connect a provider</button>
        <button class="primary" [disabled]="saving()" (click)="save()">
          {{ saving() ? 'Saving…' : 'Save' }}
        </button>
      </div>
      @if (problem(); as why) { <p class="warn">{{ why }}</p> }

      @if (cloudSlots().length > 0) {
        <p class="small">
          {{ slotNames() }}
          {{ cloudSlots().length === 1 ? 'is a slot' : 'are slots' }} on the queue page, under
          "Cloud — costs credits". Nothing is sent there unless a job's own row names it: jobs
          set to "any" never fall through to a provider.
        </p>
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
    /* The standing sentence is not a fault, so it is neither red nor invisible:
       it is the one line on this card somebody has to read before they save. */
    .warn-soft { color: var(--text-secondary); }
    .ok { color: var(--ok); }

    .provider {
      display: flex; flex-direction: column; gap: 6px;
      border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
      padding: 8px;
    }
    .row { display: flex; align-items: center; gap: 6px; }
    .name { flex: 1; min-width: 0; }
    .kind { min-width: 0; }
    .wide { flex: 1; min-width: 0; }
    .toggle { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }

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
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class CloudCardComponent {
  protected readonly rows = signal<EditableProvider[]>([]);
  protected readonly cloudSlots = signal<ComputeSlot[]>([]);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly problem = signal<string | null>(null);
  /**
   * WHICH ROW IS BEING TESTED, AND WHICH ROW SAID WHAT — both keyed by the LOCAL
   * id rather than by the name.
   *
   * The Servers card keys its probes by name, which it can because a Crucible
   * row's Test is disabled until a token is stored and a stored row has a
   * settled name. Here the button works on a row that has never been saved and
   * whose name box is being typed in, so a name key would attach the answer to
   * whatever the name was at the moment of the press and then lose it on the
   * next keystroke.
   */
  protected readonly testing = signal<number | null>(null);
  protected readonly probes = signal<Record<number, CloudProbe>>({});

  protected readonly keySentence = CLOUD_KEY_SENTENCE;

  private nextKey = 1;

  constructor() {
    if (!api) return;
    void this.load();
  }

  /** The whole card, re-read from main. */
  private async load(): Promise<void> {
    if (!api) return;
    const view = await api.cloud.settings();
    this.adopt(view.providers);
    this.cloudSlots.set(view.slots.filter((slot) => slot.kind === 'cloud'));
  }

  private adopt(providers: readonly CloudProviderView[]): void {
    this.rows.set(providers.map((provider) => ({
      ...provider,
      key: this.nextKey++,
      apiKey: null,
    })));
  }

  protected modelHint(kind: CloudProviderKind): string {
    return `Model id — e.g. ${CLOUD_PROVIDER_MODEL_HINT[kind]}`;
  }

  protected endpointHint(kind: CloudProviderKind): string {
    return `Address (optional) — ${CLOUD_PROVIDER_ENDPOINT[kind]}`;
  }

  /** The names of the cloud slots, for the sentence under the list. */
  protected slotNames(): string {
    return this.cloudSlots().map((slot) => slot.name).join(', ');
  }

  /** Enough of a listing to recognise it by, and never the whole of a long one. */
  private someOf(models: readonly string[]): string {
    const shown = models.slice(0, 6).join(', ');
    return models.length > 6 ? `${shown}, and ${models.length - 6} more` : shown;
  }

  /**
   * The key works and the model is not on its listing — composed here rather
   * than in the template because it is two sentences with a branch in them, and
   * an Angular expression carrying an escaped apostrophe is a parse error
   * waiting for somebody to reformat the file.
   */
  protected notListed(chosen: string, models: readonly string[]): string {
    const said = chosen.length === 0
      ? 'No model is named yet'
      : `${chosen} is not in this key's listing`;
    return `${said}. It has ${models.length}: ${this.someOf(models)}`;
  }

  protected edit(key: number, patch: Partial<EditableProvider>): void {
    this.saved.set(false);
    this.rows.update((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  protected add(): void {
    this.saved.set(false);
    this.rows.update((rows) => [
      ...rows,
      {
        key: this.nextKey++,
        name: '',
        kind: 'openai' as CloudProviderKind,
        model: '',
        endpoint: '',
        enabled: true,
        keySet: false,
        apiKey: null,
      },
    ]);
  }

  protected drop(key: number): void {
    this.saved.set(false);
    this.rows.update((rows) => rows.filter((row) => row.key !== key));
    this.probes.update((all) => {
      const next = { ...all };
      delete next[key];
      return next;
    });
  }

  /**
   * Save the whole list — `ServersCardComponent.save`'s shape and its rule.
   *
   * ANSWERED WITH WHAT WAS STORED, and the rows are rebuilt from that answer
   * rather than from what was typed: main drops what it cannot store and
   * normalises what it can, and a card that went on showing the typed text would
   * be showing something the next job will not use.
   */
  protected async save(): Promise<void> {
    if (!api) return;
    this.saving.set(true);
    this.problem.set(null);
    try {
      const edits: CloudProviderEdit[] = this.rows().map((row) => ({
        name: row.name,
        kind: row.kind,
        model: row.model,
        endpoint: row.endpoint,
        enabled: row.enabled,
        apiKey: row.apiKey,
      }));
      const view = await api.cloud.save(edits);
      this.adopt(view.providers);
      this.cloudSlots.set(view.slots.filter((slot) => slot.kind === 'cloud'));
      this.saved.set(true);
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Test one row AS IT IS ON SCREEN, saved or not.
   *
   * The key goes one way, into main, and no answer carries it back — so a row
   * somebody has just pasted a key into can be checked before it is written to
   * disk. `apiKey: null` on an untouched row resolves against the stored one of
   * that name, which is what makes the button work on a row nobody has edited.
   */
  protected async test(key: number): Promise<void> {
    const row = this.rows().find((entry) => entry.key === key);
    if (!api || row === undefined) return;
    this.testing.set(key);
    try {
      const probe = await api.cloud.test({
        name: row.name,
        kind: row.kind,
        model: row.model,
        endpoint: row.endpoint,
        enabled: row.enabled,
        apiKey: row.apiKey,
      });
      this.probes.update((all) => ({ ...all, [key]: probe }));
    } finally {
      this.testing.set(null);
    }
  }
}
